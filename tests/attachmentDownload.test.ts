import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
});

describe('Attachment / PDF Download (Melhoria)', () => {
  it('downloads lesson attachments (PDFs) into structured Materiais folder and updates database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-att-test-'));
    tempDirs.push(dir);

    const stagingDir = path.join(dir, 'staging');
    const libraryDir = path.join(dir, 'library');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });

    const db = new VaultDatabase(path.join(dir, 'vault.db'));
    const secretStore = new SecretStore(dir, createTestProtector('unit-att-secret'));

    const mockAdapter = {
      platformId: 'hotmart' as const,
      getLoginConfig: () => ({
        platform: 'hotmart' as const,
        loginUrl: 'https://sso.hotmart.com/login',
        successUrlPatterns: [/club/],
        cookieDomains: ['hotmart.com'],
        bearerStorageKeys: ['token'],
      }),
      async fetchPurchases() {
        return [];
      },
      async verifyCourseOwnership(_session: any, id: string) {
        return {
          externalCourseId: id,
          rawStatus: 'COMPLETED',
          normalizedStatus: 'AUTHORIZED' as const,
          purchaseRef: 'HM-ATT-REF',
          checkedAt: new Date().toISOString(),
        };
      },
      async fetchCourseCatalog() {
        throw new Error('unused');
      },
      async resolveLessonMedia() {
        return { kind: 'NO_VIDEO' as const };
      },
    };

    const registry = new AdapterRegistry([mockAdapter]);
    const authManager = new AuthManager(db, secretStore, registry);
    const ownership = new OwnershipVerifier(db, authManager, registry);
    const inspector = new MediaStreamInspector();
    const remuxer = new DecryptionAndRemuxer(stagingDir);
    const limiter = new BandwidthLimiter(null);

    secretStore.encryptJson('cred_att', {
      platform: 'hotmart',
      externalUserId: 'user_att',
      email: 'user@test.com',
      cookies: [],
    });

    const pdfBuffer = Buffer.from('%PDF-1.4 Mock PDF content for test');

    const mockFetch = (async (url: string | URL | Request) => {
      if (String(url).includes('fake-apostila.pdf')) {
        return new Response(pdfBuffer, {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const queue = new QueueAndChunkManager(
      db,
      authManager,
      registry,
      ownership,
      inspector,
      remuxer,
      secretStore,
      limiter,
      {
        stagingRootDir: stagingDir,
        getLibraryRootDir: () => libraryDir,
        fetchFn: mockFetch,
      },
    );

    const now = new Date().toISOString();
    db.upsertAccount({
      id: 'acc_att',
      platform: 'hotmart',
      externalUserId: 'user_att',
      emailHash: 'hash_att',
      credentialRef: 'cred_att',
      status: 'CONNECTED',
      lastVerifiedAt: now,
    });

    db.upsertCourse({
      id: 'c_att',
      accountId: 'acc_att',
      externalCourseId: 'ext_c_att',
      title: 'Curso de Arquitetura',
      sanitizedFolder: 'Curso de Arquitetura',
      licenseStatus: 'AUTHORIZED',
      licenseCheckedAt: now,
      coverLocalPath: null,
    });

    db.upsertCourseTree('c_att', [
      {
        module: {
          id: 'm_att',
          courseId: 'c_att',
          externalModuleId: 'ext_m_att',
          orderIndex: 1,
          title: 'Modulo de Introducao',
          sanitizedFolder: 'Modulo_01',
        },
        lessons: [
          {
            id: 'l_att_1',
            moduleId: 'm_att',
            externalLessonId: 'ext_l_att_1',
            orderIndex: 1,
            title: 'Aula com Material PDF',
            durationSec: 100,
            hasVideo: false,
            availabilityStatus: 'AVAILABLE',
            localFilePath: null,
            attachments: [
              {
                id: 'att_sample_1',
                lessonId: 'l_att_1',
                externalAttachmentId: 'ext_att_sample_1',
                fileName: 'Apostila_Modulo_1.pdf',
                fileUrl: 'https://cdn.exemplo.com/fake-apostila.pdf',
                fileType: 'pdf',
                fileSize: pdfBuffer.length,
                localFilePath: null,
              },
            ],
          },
        ],
      },
    ]);

    // Executa o download do anexo
    const result = await queue.downloadAttachment('att_sample_1');
    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(fs.readFileSync(result.path!, 'utf8')).toContain('%PDF-1.4');

    // Confere se o caminho está estruturado na subpasta Materiais
    expect(result.path).toContain(path.join('Modulo_01', 'Materiais', 'Aula_01 - Apostila_Modulo_1.pdf'));

    // Confere se o banco de dados foi atualizado
    const updatedAtt = db.getAttachment('att_sample_1');
    expect(updatedAtt?.localFilePath).toBe(result.path);

    // Confere se a biblioteca offline agora lista a aula com o material salvo
    const offlineCourses = db.listOfflineCourses();
    expect(offlineCourses).toHaveLength(1);
    expect(offlineCourses[0].modules[0].lessons[0].attachments?.[0].localFilePath).toBe(result.path);

    db.close();
  });
});
