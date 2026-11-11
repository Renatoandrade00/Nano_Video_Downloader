import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultDatabase } from '../src/main/vault/database';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Electron Offline E2E Verification (T5.4, MVP-03)', () => {
  it('boots real Electron app with outbound network blocked, loads offline UI, streams 206 range, and persists watched progress', () => {
    const mainEntry = path.resolve(__dirname, '..', 'dist', 'main', 'index.js');
    expect(fs.existsSync(mainEntry)).toBe(true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-electron-e2e-'));
    tempDirs.push(dir);

    const vaultDir = path.join(dir, 'vault');
    const mp4Path = path.join(
      dir,
      'library',
      'Curso Offline E2E',
      'Modulo_01',
      'Aula_01 - Aula Modo Aviao.mp4',
    );
    fs.mkdirSync(path.dirname(mp4Path), { recursive: true });

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
        'color=c=0x0f172a:s=640x360:r=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        mp4Path,
      ],
      { stdio: 'pipe' },
    );

    const dbPath = path.join(vaultDir, 'library.db');
    const db = new VaultDatabase(dbPath);
    const now = new Date().toISOString();
    db.upsertAccount({
      id: 'acc_e2e',
      platform: 'hotmart',
      externalUserId: 'usr_e2e',
      emailHash: 'hash_e2e',
      credentialRef: 'cred_e2e',
      status: 'CONNECTED',
      lastVerifiedAt: now,
    });
    db.upsertCourse({
      id: 'c_e2e',
      accountId: 'acc_e2e',
      externalCourseId: 'ext_c_e2e',
      title: 'Curso Offline E2E',
      sanitizedFolder: 'Curso Offline E2E',
      licenseStatus: 'AUTHORIZED',
      licenseCheckedAt: now,
      coverLocalPath: null,
    });
    db.upsertCourseTree('c_e2e', [
      {
        module: {
          id: 'm_e2e',
          courseId: 'c_e2e',
          externalModuleId: 'ext_m_e2e',
          orderIndex: 1,
          title: 'Modulo Offline',
          sanitizedFolder: 'Modulo_01',
        },
        lessons: [
          {
            id: 'l_e2e',
            moduleId: 'm_e2e',
            externalLessonId: 'ext_l_e2e',
            orderIndex: 1,
            title: 'Aula Modo Aviao',
            durationSec: 600,
            hasVideo: true,
            availabilityStatus: 'AVAILABLE',
            localFilePath: mp4Path,
          },
        ],
      },
    ]);
    db.close();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronBinary = require('electron') as string;
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    childEnv.NANO_USER_DATA_DIR = dir;
    childEnv.NANO_OFFLINE_E2E = '1';

    const res = spawnSync(electronBinary, ['.'], {
      cwd: path.resolve(__dirname, '..'),
      env: childEnv,
      encoding: 'utf8',
      timeout: 30000,
    });

    if (res.status !== 0) {
      throw new Error(
        `Electron E2E failed (code ${res.status}):\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
      );
    }

    const match = /NANO_E2E_RESULT:(\{.*\})/.exec(res.stdout);
    expect(match).not.toBeNull();
    const report = JSON.parse(match![1]) as {
      courseCount: number;
      lessonTitle: string;
      rangeStatus: number;
      rangeBytes: number;
      videoDuration: number;
      isWatched: boolean;
      playbackSpeed: number;
    };

    expect(report.courseCount).toBe(1);
    expect(report.lessonTitle).toBe('Aula Modo Aviao');
    expect(report.rangeStatus).toBe(206);
    expect(report.rangeBytes).toBe(512);
    expect(report.videoDuration).toBeGreaterThan(1);
    expect(report.isWatched).toBe(true);
    expect(report.playbackSpeed).toBe(1.75);

    const dbVerify = new VaultDatabase(dbPath);
    try {
      const saved = dbVerify.getPlaybackProgress('l_e2e');
      expect(saved?.isWatched).toBe(true);
      expect(saved?.playbackSpeed).toBe(1.75);
      expect(saved?.lastPositionSec).toBe(550);
    } finally {
      dbVerify.close();
    }
  }, 45000);
});

