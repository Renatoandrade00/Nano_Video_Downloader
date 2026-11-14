import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CourseSyncAuditor } from '../src/main/storage/courseSyncAuditor';
import { VaultDatabase } from '../src/main/vault/database';

describe('CourseSyncAuditor — Smart Sync & Course Audit (1-Clique)', () => {
  let tmpDir: string;
  let db: VaultDatabase;
  let mockQueue: any;
  let auditor: CourseSyncAuditor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano_sync_audit_test_'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = new VaultDatabase(dbPath);

    mockQueue = {
      enqueueLessons: vi.fn().mockResolvedValue({ enqueuedJobIds: ['job_1', 'job_2'], rejected: [] }),
      downloadAttachment: vi.fn().mockResolvedValue({ ok: true }),
    };

    auditor = new CourseSyncAuditor(db, () => tmpDir, mockQueue);

    const now = new Date().toISOString();

    // Setup mock course in database
    db.upsertAccount({
      id: 'acc_1',
      platform: 'hotmart',
      externalUserId: 'user_1',
      emailHash: 'hash_1',
      status: 'CONNECTED',
      credentialRef: 'cred_1',
      lastVerifiedAt: now,
    });

    db.upsertCourse({
      id: 'course_test_1',
      accountId: 'acc_1',
      externalCourseId: 'ext_c1',
      title: 'Curso de Teste Inteligente',
      sanitizedFolder: 'Curso de Teste Inteligente',
      licenseStatus: 'AUTHORIZED',
      licenseCheckedAt: now,
      coverLocalPath: null,
    });

    db.upsertCourseTree('course_test_1', [
      {
        module: {
          id: 'mod_1',
          courseId: 'course_test_1',
          externalModuleId: 'ext_m1',
          title: 'Modulo 01 — Fundamentos',
          sanitizedFolder: 'Modulo_01',
          orderIndex: 1,
        },
        lessons: [
          {
            id: 'lesson_1_1',
            moduleId: 'mod_1',
            externalLessonId: 'ext_l1',
            title: 'Introducao ao Curso',
            orderIndex: 1,
            hasVideo: true,
            durationSec: 600,
            availabilityStatus: 'AVAILABLE',
            localFilePath: null,
            attachments: [
              {
                id: 'att_1',
                lessonId: 'lesson_1_1',
                externalAttachmentId: 'ext_a1',
                fileName: 'Apostila 01.pdf',
                fileUrl: 'https://example.com/att1.pdf',
                fileType: 'pdf',
                fileSize: 1024,
                localFilePath: null,
              },
            ],
          },
          {
            id: 'lesson_1_2',
            moduleId: 'mod_1',
            externalLessonId: 'ext_l2',
            title: 'Conceitos Basicos',
            orderIndex: 2,
            hasVideo: true,
            durationSec: 900,
            availabilityStatus: 'AVAILABLE',
            localFilePath: null,
          },
        ],
      },
      {
        module: {
          id: 'mod_2',
          courseId: 'course_test_1',
          externalModuleId: 'ext_m2',
          title: 'Modulo 02 — Avancado',
          sanitizedFolder: 'Modulo_02',
          orderIndex: 2,
        },
        lessons: [
          {
            id: 'lesson_2_1',
            moduleId: 'mod_2',
            externalLessonId: 'ext_l3',
            title: 'Aprofundamento',
            orderIndex: 1,
            hasVideo: true,
            durationSec: 1200,
            availabilityStatus: 'AVAILABLE',
            localFilePath: null,
            attachments: [
              {
                id: 'att_2',
                lessonId: 'lesson_2_1',
                externalAttachmentId: 'ext_a2',
                fileName: 'Guia Avancado.pdf',
                fileUrl: 'https://example.com/att2.pdf',
                fileType: 'pdf',
                fileSize: 2048,
                localFilePath: null,
              },
            ],
          },
        ],
      },
    ]);
  });

  it('detects which files already exist on disk and reports pending items accurately', async () => {
    // Cria pasta física do curso
    const courseFolder = path.join(tmpDir, 'Curso de Teste Inteligente');
    const mod1Folder = path.join(courseFolder, 'Modulo_01');
    const mod1Mat = path.join(mod1Folder, 'Materiais');
    fs.mkdirSync(mod1Mat, { recursive: true });

    // Salva a Aula 01 e a Apostila 01 no disco
    fs.writeFileSync(path.join(mod1Folder, 'Aula_01 - Introducao ao Curso.mp4'), 'Dummy Video Content');
    fs.writeFileSync(path.join(mod1Mat, 'Apostila 01.pdf'), 'Dummy PDF Content');

    const result = await auditor.auditCourseSync('course_test_1');

    expect(result.totalLessons).toBe(3);
    expect(result.syncedLessons).toBe(1);
    expect(result.pendingLessons).toBe(2);

    expect(result.totalAttachments).toBe(2);
    expect(result.syncedAttachments).toBe(1);
    expect(result.pendingAttachments).toBe(1);

    expect(result.pendingLessonIds).toContain('lesson_1_2');
    expect(result.pendingLessonIds).toContain('lesson_2_1');
    expect(result.pendingLessonIds).not.toContain('lesson_1_1');

    expect(result.pendingAttachmentIds).toContain('att_2');
    expect(result.pendingAttachmentIds).not.toContain('att_1');

    // Módulo 1: 1 aula salva de 2, 1 PDF salvo de 1
    const mod1Audit = result.modules.find((m) => m.moduleId === 'mod_1');
    expect(mod1Audit).toBeDefined();
    expect(mod1Audit?.syncedLessons).toBe(1);
    expect(mod1Audit?.pendingLessons).toBe(1);
    expect(mod1Audit?.syncedAttachments).toBe(1);

    // Módulo 2: 0 aulas salvas de 1, 0 PDF salvo de 1
    const mod2Audit = result.modules.find((m) => m.moduleId === 'mod_2');
    expect(mod2Audit?.syncedLessons).toBe(0);
    expect(mod2Audit?.pendingLessons).toBe(1);
  });

  it('enqueues only pending items when downloadPending is triggered', async () => {
    // Salva a Aula 01 no disco
    const courseFolder = path.join(tmpDir, 'Curso de Teste Inteligente');
    const mod1Folder = path.join(courseFolder, 'Modulo_01');
    fs.mkdirSync(mod1Folder, { recursive: true });
    fs.writeFileSync(path.join(mod1Folder, 'Aula_01 - Introducao ao Curso.mp4'), 'Dummy MP4');

    const res = await auditor.downloadPending('course_test_1', '1080p', {
      downloadVideos: true,
      downloadAttachments: true,
    });

    // Deve ter chamado queue.enqueueLessons com as 2 aulas pendentes (lesson_1_2 e lesson_2_1)
    expect(mockQueue.enqueueLessons).toHaveBeenCalledTimes(1);
    const enqueuedLessonsPassed = mockQueue.enqueueLessons.mock.calls[0][0];
    expect(enqueuedLessonsPassed).toHaveLength(2);
    expect(enqueuedLessonsPassed).toContain('lesson_1_2');
    expect(enqueuedLessonsPassed).toContain('lesson_2_1');
    expect(enqueuedLessonsPassed).not.toContain('lesson_1_1');

    // Deve ter chamado downloadAttachment para o 1 PDF pendente (att_2)
    expect(mockQueue.downloadAttachment).toHaveBeenCalledWith('att_2');
    expect(res.enqueuedLessons).toBe(2);
    expect(res.enqueuedAttachments).toBe(2);
  });
});
