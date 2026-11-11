import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IPlatformAdapter, PurchaseRecord } from '../src/main/adapters/platformAdapter';
import { AdapterRegistry } from '../src/main/adapters/registry';
import { AuthManager } from '../src/main/auth/authManager';
import { OwnershipVerifier } from '../src/main/ownership/ownershipVerifier';
import { VaultDatabase } from '../src/main/vault/database';
import { createTestProtector, SecretStore } from '../src/main/vault/secretStore';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('OwnershipVerifier (RF-03, RF-04, MVP-01)', () => {
  it('authorizes COMPLETED/ACTIVE purchases and revokes in-flight jobs immediately when REFUNDED', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-own-'));
    tempDirs.push(dir);

    let remoteStatus = 'COMPLETED';
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
            externalCourseId: 'hc_100',
            courseTitle: 'Curso Teste',
            purchaseRef: 'TX-999',
            rawStatus: remoteStatus,
            normalizedStatus: remoteStatus === 'COMPLETED' ? 'AUTHORIZED' : 'REVOKED',
          },
        ];
      },
      async verifyCourseOwnership(_session, courseExternalId) {
        return {
          externalCourseId: courseExternalId,
          rawStatus: remoteStatus,
          normalizedStatus: remoteStatus === 'COMPLETED' ? 'AUTHORIZED' : 'REVOKED',
          purchaseRef: 'TX-999',
          checkedAt: new Date().toISOString(),
        };
      },
      async fetchCourseCatalog() {
        throw new Error('not needed');
      },
      async resolveLessonMedia() {
        throw new Error('not needed');
      },
    };

    const db = new VaultDatabase(path.join(dir, 'vault.db'));
    const secrets = new SecretStore(dir, createTestProtector('own-test'));
    const adapters = new AdapterRegistry([mockAdapter]);
    const auth = new AuthManager(db, secrets, adapters, async () => ({
      bearerToken: 'tok-123',
      cookies: [],
      email: 'aluno@example.com',
      externalUserId: 'usr-1',
    }));

    const account = await auth.connectPlatform('hotmart');
    const now = new Date().toISOString();
    db.upsertCourse({
      id: 'c1',
      accountId: account.id,
      externalCourseId: 'hc_100',
      title: 'Curso Teste',
      sanitizedFolder: 'Curso Teste',
      licenseStatus: 'AUTHORIZED',
      licenseCheckedAt: now,
      coverLocalPath: null,
    });
    db.upsertCourseTree('c1', [
      {
        module: {
          id: 'm1',
          courseId: 'c1',
          externalModuleId: 'hm1',
          orderIndex: 1,
          title: 'Mod 1',
          sanitizedFolder: 'Modulo_01',
        },
        lessons: [
          {
            id: 'l1',
            moduleId: 'm1',
            externalLessonId: 'hl1',
            orderIndex: 1,
            title: 'Aula 1',
            durationSec: 100,
            hasVideo: true,
            availabilityStatus: 'AVAILABLE',
            localFilePath: null,
          },
        ],
      },
    ]);

    const stagingDir = path.join(dir, 'staging', 'job_1.antigravity-media');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'v_0000.seg'), Buffer.from('partial'));

    db.upsertJob({
      id: 'job_1',
      lessonId: 'l1',
      targetResolution: '1080p',
      streamType: 'HLS',
      state: 'PAUSED',
      totalSegments: 10,
      completedSegments: 1,
      totalBytes: 0,
      downloadedBytes: 7,
      stagingDir,
      errorCode: null,
      updatedAt: now,
    });

    const revokedEvents: string[] = [];
    const verifier = new OwnershipVerifier(db, auth, adapters, (ev) => {
      revokedEvents.push(...ev.affectedJobIds);
    });

    const okCheck = await verifier.verifyCourseAccess('c1');
    expect(okCheck.authorized).toBe(true);
    expect(db.getJob('job_1')?.state).toBe('PAUSED');

    // Simulate refund on platform
    remoteStatus = 'REFUNDED';
    const revokedCheck = await verifier.verifyCourseAccess('c1');
    expect(revokedCheck.authorized).toBe(false);
    expect(db.getCourse('c1')?.licenseStatus).toBe('REVOKED');
    expect(db.getJob('job_1')?.state).toBe('REVOKED');
    expect(revokedEvents).toEqual(['job_1']);
    expect(fs.existsSync(stagingDir)).toBe(false);

    db.close();
  });
});

