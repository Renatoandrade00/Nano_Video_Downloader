import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditWatermarkRecord, PlatformId, StreamType, TrackType } from '../../shared/types';
import { SecretStore } from '../vault/secretStore';
import { HlsKeyInfo } from './hlsParser';

export interface RemuxInput {
  jobId: string;
  stagingDir: string;
  targetFilePath: string;
  streamType: StreamType;
  tracks: {
    hasSeparateAudio: boolean;
    videoCount: number;
    audioCount: number;
    muxedCount: number;
    initFiles?: Partial<Record<TrackType, string>>;
  };
  metadata: {
    courseTitle: string;
    moduleTitle: string;
    lessonTitle: string;
    platform: PlatformId;
    accountEmailHash: string;
    purchaseRef: string;
  };
  ffmpegPath?: string;
}

export interface RemuxResult {
  finalPath: string;
  watermark: AuditWatermarkRecord;
}

export async function decryptAes128Buffer(
  encrypted: Buffer,
  keyBytes: Buffer,
  segmentIndex: number,
  ivHex?: string,
): Promise<Buffer> {
  let iv: Buffer;
  if (ivHex) {
    const clean = ivHex.replace(/^0x/i, '').padStart(32, '0');
    iv = Buffer.from(clean, 'hex');
  } else {
    iv = Buffer.alloc(16, 0);
    iv.writeUInt32BE(segmentIndex, 12);
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function concatSegmentFilesStreaming(
  stagingDir: string,
  prefix: string,
  count: number,
  outFile: string,
  initFile?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outFile, { highWaterMark: 64 * 1024 });
    writeStream.on('error', reject);

    const filesToCopy: string[] = [];
    if (initFile && fs.existsSync(initFile)) {
      filesToCopy.push(initFile);
    }
    for (let i = 0; i < count; i++) {
      const segPath = path.join(stagingDir, `${prefix}_${String(i).padStart(4, '0')}.seg`);
      if (!fs.existsSync(segPath)) {
        writeStream.destroy();
        reject(new Error(`Missing segment file: ${segPath}`));
        return;
      }
      filesToCopy.push(segPath);
    }

    let idx = 0;
    const pumpNext = () => {
      if (idx >= filesToCopy.length) {
        writeStream.end(() => resolve());
        return;
      }
      const readStream = fs.createReadStream(filesToCopy[idx++], { highWaterMark: 64 * 1024 });
      readStream.on('error', (err) => {
        writeStream.destroy();
        reject(err);
      });
      readStream.on('end', pumpNext);
      readStream.pipe(writeStream, { end: false });
    };

    pumpNext();
  });
}

export class DecryptionAndRemuxer {
  private readonly secrets: SecretStore;
  private readonly ffmpegBin: string;
  private remuxChain: Promise<void> = Promise.resolve();

  constructor(secrets: SecretStore, ffmpegBin = 'ffmpeg') {
    this.secrets = secrets;
    this.ffmpegBin = ffmpegBin;
  }

  /**
   * Serializes remuxing (1 active remux at a time with low CPU priority) so host CPU
   * stays comfortably under the 60% idle threshold (RNF-03) and RAM is freed after each lesson.
   */
  remuxLesson(input: RemuxInput): Promise<RemuxResult> {
    const task = this.remuxChain.then(() => this.executeRemux(input));
    this.remuxChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async executeRemux(input: RemuxInput): Promise<RemuxResult> {
    const workFiles: string[] = [];
    const watermarkId = crypto.randomUUID();
    const stampedAt = new Date().toISOString();
    const watermarkPayload = {
      watermarkId,
      ownerHash: input.metadata.accountEmailHash,
      platform: input.metadata.platform,
      purchaseRef: input.metadata.purchaseRef,
      stampedAt,
    };
    const machineSignature = this.secrets.signForLocalMachine(JSON.stringify(watermarkPayload));

    try {
      const ffmpegArgs: string[] = ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '1'];

      if (input.tracks.hasSeparateAudio) {
        const videoStreamFile = path.join(input.stagingDir, 'merged_video.bin');
        const audioStreamFile = path.join(input.stagingDir, 'merged_audio.bin');
        workFiles.push(videoStreamFile, audioStreamFile);

        await concatSegmentFilesStreaming(
          input.stagingDir,
          'v',
          input.tracks.videoCount,
          videoStreamFile,
          input.tracks.initFiles?.VIDEO,
        );
        await concatSegmentFilesStreaming(
          input.stagingDir,
          'a',
          input.tracks.audioCount,
          audioStreamFile,
          input.tracks.initFiles?.AUDIO,
        );
        ffmpegArgs.push('-i', videoStreamFile, '-i', audioStreamFile, '-map', '0:v:0', '-map', '1:a:0');
      } else {
        const muxedFile = path.join(input.stagingDir, 'merged_muxed.bin');
        workFiles.push(muxedFile);

        await concatSegmentFilesStreaming(
          input.stagingDir,
          'm',
          input.tracks.muxedCount,
          muxedFile,
          input.tracks.initFiles?.MUXED,
        );
        ffmpegArgs.push('-i', muxedFile);
      }

      const tempMp4 = path.join(input.stagingDir, 'remuxed_output.mp4');
      workFiles.push(tempMp4);

      const commentTag = JSON.stringify({
        ...watermarkPayload,
        sig: machineSignature.slice(0, 32),
      });

      ffmpegArgs.push(
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-metadata',
        `title=${input.metadata.lessonTitle}`,
        '-metadata',
        `album=${input.metadata.courseTitle} - ${input.metadata.moduleTitle}`,
        '-metadata',
        `comment=${commentTag}`,
        tempMp4,
      );

      await this.runFfmpeg(input.ffmpegPath ?? this.ffmpegBin, ffmpegArgs);

      const stat = fs.statSync(tempMp4);
      if (stat.size < 1024) {
        throw new Error('Generated MP4 file is unexpectedly small or empty.');
      }

      fs.mkdirSync(path.dirname(input.targetFilePath), { recursive: true });
      moveFileAtomic(tempMp4, input.targetFilePath);

      return {
        finalPath: input.targetFilePath,
        watermark: {
          jobId: input.jobId,
          watermarkId,
          accountHash: input.metadata.accountEmailHash,
          purchaseRef: input.metadata.purchaseRef,
          machineSignature,
          stampedAt,
        },
      };
    } finally {
      for (const wf of workFiles) {
        if (fs.existsSync(wf)) {
          try {
            fs.unlinkSync(wf);
          } catch {
            // Best-effort cleanup
          }
        }
      }
      if (fs.existsSync(input.stagingDir)) {
        try {
          fs.rmSync(input.stagingDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  private runFfmpeg(bin: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      if (child.pid) {
        try {
          os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // Priority tuning is best-effort
        }
      }

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) {
          stderr += chunk.toString('utf8');
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg remux exited with code ${code}: ${stderr.trim()}`));
        }
      });
    });
  }
}

function moveFileAtomic(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

export type SegmentDecryptor = (buf: Buffer, keyInfo: HlsKeyInfo, index: number) => Promise<Buffer>;

