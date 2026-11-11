import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultDatabase } from '../src/main/vault/database';
import { createTestProtector, SecretStore } from '../src/main/vault/secretStore';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('SecureVault & VaultDatabase (RNF-01, RF-12, RF-13)', () => {
  it('encrypts/decrypts credentials with AES-256-GCM and verifies machine signatures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-vault-'));
    tempDirs.push(dir);

    const store = new SecretStore(dir, createTestProtector('unit-test-secret'));
    const secretPayload = { bearerToken: 'super-secret-jwt', cookies: [{ name: 'sid', value: 'abc', domain: '.hotmart.com' }] };
    store.encryptJson('cred_1', secretPayload);

    const rawFile = fs.readFileSync(path.join(dir, 'secrets', 'cred_1.cred.json'), 'utf8');
    expect(rawFile).not.toContain('super-secret-jwt');

    const restored = store.decryptJson<typeof secretPayload>('cred_1');
    expect(restored).toEqual(secretPayload);

    const sig = store.signForLocalMachine('payload-123');
    expect(store.verifyLocalMachineSignature('payload-123', sig)).toBe(true);
    expect(store.verifyLocalMachineSignature('payload-tampered', sig)).toBe(false);
  });

  it('persists offline courses and playback progress (is_watched) for airplane mode', () => {
    const db = new VaultDatabase(':memory:');
    const now = new Date().toISOString();

    db.upsertAccount({
      id: 'acc1',
      platform: 'hotmart',
      externalUserId: 'u1',
      emailHash: 'hash1',
      credentialRef: 'cred_1',
      status: 'CONNECTED',
      lastVerifiedAt: now,
    });

    db.upsertCourse({
      id: 'c1',
      accountId: 'acc1',
      externalCourseId: 'ext_c1',
      title: 'Curso Offline',
      sanitizedFolder: 'Curso Offline',
      licenseStatus: 'AUTHORIZED',
      licenseCheckedAt: now,
      coverLocalPath: null,
    });

    db.upsertCourseTree('c1', [
      {
        module: {
          id: 'm1',
          courseId: 'c1',
          externalModuleId: 'ext_m1',
          orderIndex: 1,
          title: 'Modulo Um',
          sanitizedFolder: 'Modulo_01',
        },
        lessons: [
          {
            id: 'l1',
            moduleId: 'm1',
            externalLessonId: 'ext_l1',
            orderIndex: 1,
            title: 'Aula Baixada',
            durationSec: 600,
            hasVideo: true,
            availabilityStatus: 'AVAILABLE',
            localFilePath: '/tmp/Curso Offline/Modulo_01/Aula_01 - Aula Baixada.mp4',
          },
          {
            id: 'l2',
            moduleId: 'm1',
            externalLessonId: 'ext_l2',
            orderIndex: 2,
            title: 'Aula Nao Baixada',
            durationSec: 600,
            hasVideo: true,
            availabilityStatus: 'AVAILABLE',
            localFilePath: null,
          },
        ],
      },
    ]);

    db.savePlaybackProgress('l1', 550, 1.5, true);

    const offline = db.listOfflineCourses();
    expect(offline).toHaveLength(1);
    expect(offline[0].modules[0].lessons).toHaveLength(1);
    expect(offline[0].modules[0].lessons[0].id).toBe('l1');
    expect(offline[0].modules[0].lessons[0].progress?.isWatched).toBe(true);
    expect(offline[0].modules[0].lessons[0].progress?.playbackSpeed).toBe(1.5);
    db.close();
  });
});

