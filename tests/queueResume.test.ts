import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchLike } from '../src/main/adapters/hotmartAdapter';
import { IPlatformAdapter, PurchaseRecord } from '../src/main/adapters/platformAdapter';
import { AdapterRegistry } from '../src/main/adapters/registry';
import { AuthManager } from '../src/main/auth/authManager';
import { MediaStreamInspector } from '../src/main/media/mediaInspector';
import { DecryptionAndRemuxer } from '../src/main/media/remuxer';
import { OwnershipVerifier } from '../src/main/ownership/ownershipVerifier';
import { QueueAndChunkManager } from '../src/main/queue/queueManager';
import { BandwidthLimiter } from '../src/main/queue/tokenBucket';
import { VaultDatabase } from '../src/main/vault/database';
import { createTestProtector, SecretStore } from '../src/main/vault/secretStore';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function generate300TsSegments(workDir: string): Buffer[] {
  const tsPath = path.join(workDir, 'source.ts');
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-f',
      'mpegts',
      tsPath,
    ],
    { stdio: 'pipe' },
  );

  const raw = fs.readFileSync(tsPath);
  const packetSize = 188;
  const totalPackets = Math.floor(raw.length / packetSize);
  const packetsPerChunk = Math.max(1, Math.floor(totalPackets / 300));
  const segments: Buffer[] = [];

  let offset = 0;
  for (let i = 0; i < 300; i++) {
    const end =
      i === 299 ? raw.length : Math.min(raw.length, offset + packetsPerChunk * packetSize);
    segments.push(raw.subarray(offset, end));
    offset = end;
  }
  return segments;
}

describe('QueueAndChunkManager + FFmpeg Remuxer Resilience (RNF-04, RF-09, RNF-02)', () => {
  it('drops connection at segment 145/300, resumes from 145 without re-downloading 0..144, and remuxes valid watermarked MP4', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-resume-'));
    tempDirs.push(dir);

    const segments = generate300TsSegments(dir);
    expect(segments).toHaveLength(300);

    const mediaPlaylist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:1',
      ...segments.map((_, idx) => `#EXTINF:0.013,\nseg_${idx}.ts`),
      '#EXT-X-ENDLIST',
    ].join('\n');

    let networkDown = false;
    let dropTriggeredOnce = false;
    const fetchedInRun1: number[] = [];
    const fetchedInRun2: number[] = [];
    let isRun2 = false;

    const mockFetch: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('master.m3u8')) {
        return new Response(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n1080p.m3u8\n',
          { status: 200 },
        );
      }
      if (url.endsWith('1080p.m3u8')) {
        return new Response(mediaPlaylist, { status: 200 });
      }
      const segMatch = /seg_(\d+)\.ts$/.exec(url);
      if (segMatch) {
        const idx = Number(segMatch[1]);
        if (!isRun2 && idx === 145 && !dropTriggeredOnce) {
          dropTriggeredOnce = true;
          networkDown = true;
        }
        if (networkDown) {
          throw new Error('NETWORK_CONNECTION_LOST');
        }
        if (isRun2) {
          fetchedInRun2.push(idx);
        } else {
          fetchedInRun1.push(idx);
        }
        return new Response(new Uint8Array(segments[idx]), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };

    const mockAdapter: IPlatformAdapter = {
      platformId: 'hotmart',
      getLoginConfig: () => ({
        platform: 'hotmart',
        loginUrl: 'https://sso.hotmart.com/login',
        successUrlPatterns: [/club/],
        cookieDomains: ['hotmart.com'],
        bearerStorageKeys: ['token'],
      }),
      async fetchPurchases(): Promise<PurchaseRecord[]> {
        return [
          {
            externalCourseId: 'c_100',
            courseTitle: 'Curso Engenharia',
            purchaseRef: 'HM-ORDER-777',
            rawStatus: 'COMPLETED',
            normalizedStatus: 'AUTHORIZED',
          },
        ];
      },
      async verifyCourseOwnership(_session, id) {
        return {
          externalCourseId: id,
          rawStatus: 'COMPLETED',
          normalizedStatus: 'AUTHORIZED',
          purchaseRef: 'HM-ORDER-777',
          checkedAt: new Date().toISOString(),
        };
      },
      async fetchCourseCatalog() {
        throw new Error('unused');
      },
      async resolveLessonMedia() {
        return {
          kind: 'HLS',
          manifestUrl: 'https://cdn.example.com/lesson/master.m3u8',
        };
      },
    };

    const vaultDir = path.join(dir, 'vault');
    const libraryDir = path.join(dir, 'library');
    const db = new VaultDatabase(path.join(vaultDir, 'library.db'));
    try {
      const secrets = new SecretStore(vaultDir, createTestProtector('resume-test'));
      const adapters = new AdapterRegistry([mockAdapter]);
      const auth = new AuthManager(db, secrets, adapters, async () => ({
        bearerToken: 'tok-ok',
        cookies: [],
        email: 'comprador@example.com',
        externalUserId: 'buyer-42',
      }));

      const account = await auth.connectPlatform('hotmart');
      const now = new Date().toISOString();
      db.upsertCourse({
        id: 'course_1',
        accountId: account.id,
        externalCourseId: 'c_100',
        title: 'Curso Engenharia',
        sanitizedFolder: 'Curso Engenharia',
        licenseStatus: 'AUTHORIZED',
        licenseCheckedAt: now,
        coverLocalPath: null,
      });
      db.upsertCourseTree('course_1', [
        {
          module: {
            id: 'mod_1',
            courseId: 'course_1',
            externalModuleId: 'm_1',
            orderIndex: 1,
            title: 'Fundamentos',
            sanitizedFolder: 'Modulo_01',
          },
          lessons: [
            {
              id: 'les_1',
              moduleId: 'mod_1',
              externalLessonId: 'l_1',
              orderIndex: 1,
              title: 'Aula 1080p Resiliente',
              durationSec: 4,
              hasVideo: true,
              availabilityStatus: 'AVAILABLE',
              localFilePath: null,
            },
          ],
        },
      ]);

      const ownership = new OwnershipVerifier(db, auth, adapters);
      const inspector = new MediaStreamInspector(mockFetch);
      const remuxer = new DecryptionAndRemuxer(secrets, 'ffmpeg');
      const limiter = new BandwidthLimiter(null);

      const queue = new QueueAndChunkManager(
        db,
        auth,
        adapters,
        ownership,
        inspector,
        remuxer,
        secrets,
        limiter,
        {
          stagingRootDir: path.join(vaultDir, 'staging'),
          getLibraryRootDir: () => libraryDir,
          maxConcurrentLessons: 1,
          maxChunksPerLesson: 1,
          maxSegmentRetries: 0,
          fetchFn: mockFetch,
        },
      );

      const enq = await queue.enqueueLessons(['les_1'], '1080p');
      expect(enq.enqueuedJobIds).toHaveLength(1);
      const jobId = enq.enqueuedJobIds[0];

      await queue.waitUntilIdle();

      const pausedJob = db.getJob(jobId)!;
      expect(pausedJob.state).toBe('PAUSED');
      expect(pausedJob.completedSegments).toBe(145);
      expect(pausedJob.totalSegments).toBe(300);
      expect(fetchedInRun1).toHaveLength(145);

      // Restore network and resume from segment 145
      networkDown = false;
      isRun2 = true;
      queue.control('resume', jobId);
      await queue.waitUntilIdle();

      const doneJob = db.getJob(jobId)!;
      expect(doneJob.state).toBe('COMPLETED');
      expect(doneJob.completedSegments).toBe(300);
      expect(fetchedInRun2[0]).toBe(145);
      expect(fetchedInRun2).toHaveLength(155); // Only segments 145..299!

      const expectedPath = path.join(
        libraryDir,
        'Curso Engenharia',
        'Modulo_01',
        'Aula_01 - Aula 1080p Resiliente.mp4',
      );
      expect(fs.existsSync(expectedPath)).toBe(true);

      // Verify watermark metadata and valid MP4 streams via ffprobe
      const probeJson = execFileSync(
        'ffprobe',
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', expectedPath],
        { encoding: 'utf8' },
      );
      const probe = JSON.parse(probeJson) as {
        streams: Array<{ codec_type: string }>;
        format: { tags?: { comment?: string; title?: string } };
      };

      expect(probe.streams.some((s) => s.codec_type === 'video')).toBe(true);
      expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true);
      expect(probe.format.tags?.title).toBe('Aula 1080p Resiliente');
      expect(probe.format.tags?.comment).toContain('HM-ORDER-777');
      expect(db.getWatermarkByJobId(jobId)?.purchaseRef).toBe('HM-ORDER-777');
    } finally {
      db.close();
    }
  }, 60000);
});

