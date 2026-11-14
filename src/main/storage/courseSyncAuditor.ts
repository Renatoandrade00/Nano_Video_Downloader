import fs from 'node:fs';
import path from 'node:path';
import { formatCourseFolder, padTwoDigits } from '../../shared/pathSanitizer';
import {
  CourseSyncAuditResult,
  ModuleSyncAudit,
  ResolutionOption,
} from '../../shared/types';
import { QueueAndChunkManager } from '../queue/queueManager';
import { VaultDatabase } from '../vault/database';

export class CourseSyncAuditor {
  constructor(
    private readonly db: VaultDatabase,
    private readonly getLibraryRootDir: () => string,
    private readonly queue: QueueAndChunkManager,
  ) {}

  /**
   * Realiza a varredura e auditoria completa da pasta local e do Google Drive,
   * comparando todos os arquivos já salvos com a totalidade do catálogo do curso.
   */
  async auditCourseSync(courseId: string): Promise<CourseSyncAuditResult> {
    const details = this.db.getCourseTreeDetails(courseId);
    if (!details) {
      throw new Error(`Curso não encontrado: ${courseId}`);
    }

    const { course, modules } = details;
    const libraryRootDir = this.getLibraryRootDir();
    const courseFolderDefault = path.join(libraryRootDir, formatCourseFolder(course.title));

    // Busca pasta do curso no disco (tentando o título formatado ou variações existentes)
    let courseDir = courseFolderDefault;
    if (!fs.existsSync(courseDir) && fs.existsSync(libraryRootDir)) {
      const entries = fs.readdirSync(libraryRootDir, { withFileTypes: true });
      const found = entries.find(
        (e) =>
          e.isDirectory() &&
          (e.name.toLowerCase().includes('extensivo') ||
            e.name.toLowerCase().includes('mike school') ||
            e.name.toLowerCase().includes(course.title.toLowerCase().slice(0, 15))),
      );
      if (found) {
        courseDir = path.join(libraryRootDir, found.name);
      }
    }

    // Mapeamento recursivo de todos os arquivos físicos no diretório do curso
    const diskFiles = this.collectFilesRecursively(courseDir);

    const moduleAudits: ModuleSyncAudit[] = [];

    let totalLessons = 0;
    let syncedLessons = 0;
    let totalAttachments = 0;
    let syncedAttachments = 0;

    const pendingLessonIds: string[] = [];
    const pendingAttachmentIds: string[] = [];

    for (const mod of modules) {
      const lessons = mod.lessons;
      const modPad = padTwoDigits(mod.orderIndex);

      // Filtra arquivos pertencentes a este módulo (aceita Modulo_01, Modulo 01, etc.)
      const modFiles = diskFiles.filter((f) => {
        const lower = f.fullPath.toLowerCase();
        return (
          lower.includes(`modulo_${modPad}`) ||
          lower.includes(`modulo ${modPad}`) ||
          lower.includes(`modulo_${mod.orderIndex}`) ||
          lower.includes(`modulo ${mod.orderIndex}`)
        );
      });

      let modSyncedLessons = 0;
      let modSyncedAtts = 0;

      // 1. Auditoria de Aulas (Vídeos)
      for (const lesson of lessons) {
        totalLessons++;
        let isSynced = false;

        // Verifica se já aponta para arquivo local válido
        if (lesson.localFilePath && fs.existsSync(lesson.localFilePath)) {
          const stats = fs.statSync(lesson.localFilePath);
          if (stats.size > 0) {
            isSynced = true;
          }
        }

        // Se ainda não estava vinculado, tenta localizar no disco pelo padrão de nomes
        if (!isSynced && modFiles.length > 0) {
          const lessonPad = padTwoDigits(lesson.orderIndex);
          const matched = modFiles.find((f) => {
            if (!f.name.endsWith('.mp4') && !f.name.endsWith('.mov') && !f.name.endsWith('.mkv')) {
              return false;
            }
            const nameLower = f.name.toLowerCase();
            return (
              nameLower.includes(`aula_${lessonPad}`) ||
              nameLower.includes(`aula ${lessonPad}`) ||
              nameLower.includes(`aula_${lesson.orderIndex} `) ||
              nameLower.includes(`aula ${lesson.orderIndex} `) ||
              (lesson.title && nameLower.includes(lesson.title.toLowerCase().slice(0, 16)))
            );
          });

          if (matched && matched.size > 0) {
            isSynced = true;
            this.db.setLessonLocalFile(lesson.id, matched.fullPath);
          }
        }

        if (isSynced) {
          syncedLessons++;
          modSyncedLessons++;
        } else {
          pendingLessonIds.push(lesson.id);
        }

        // 2. Auditoria de Anexos da Aula (PDFs)
        const atts = lesson.attachments || [];
        for (const att of atts) {
          totalAttachments++;
          let isAttSynced = false;

          if (att.localFilePath && fs.existsSync(att.localFilePath)) {
            const stats = fs.statSync(att.localFilePath);
            if (stats.size > 0) {
              isAttSynced = true;
            }
          }

          if (!isAttSynced && modFiles.length > 0) {
            const lessonPad = padTwoDigits(lesson.orderIndex);
            const matchedAtt = modFiles.find((f) => {
              if (!f.name.endsWith('.pdf')) return false;
              const nameLower = f.name.toLowerCase();
              const attLower = att.fileName.toLowerCase();
              return (
                nameLower === attLower ||
                nameLower.includes(attLower.slice(0, 20)) ||
                (nameLower.includes(`aula_${lessonPad}`) && nameLower.includes('.pdf')) ||
                (nameLower.includes(`aula ${lessonPad}`) && nameLower.includes('.pdf'))
              );
            });

            if (matchedAtt && matchedAtt.size > 0) {
              isAttSynced = true;
              this.db.updateAttachmentLocalPath(att.id, matchedAtt.fullPath);
            }
          }

          if (isAttSynced) {
            syncedAttachments++;
            modSyncedAtts++;
          } else {
            pendingAttachmentIds.push(att.id);
          }
        }
      }

      const modTotalLessons = lessons.length;
      const modTotalAtts = lessons.reduce((acc: number, l) => acc + (l.attachments?.length || 0), 0);

      moduleAudits.push({
        moduleId: mod.id,
        moduleTitle: mod.title,
        orderIndex: mod.orderIndex,
        totalLessons: modTotalLessons,
        syncedLessons: modSyncedLessons,
        pendingLessons: Math.max(0, modTotalLessons - modSyncedLessons),
        totalAttachments: modTotalAtts,
        syncedAttachments: modSyncedAtts,
        pendingAttachments: Math.max(0, modTotalAtts - modSyncedAtts),
        isFullySynced:
          modSyncedLessons >= modTotalLessons && modSyncedAtts >= modTotalAtts,
      });
    }

    const totalItems = totalLessons + totalAttachments;
    const syncedItems = syncedLessons + syncedAttachments;
    const overallPercent = totalItems > 0 ? Math.round((syncedItems / totalItems) * 100) : 100;

    return {
      courseId,
      courseTitle: course.title,
      storagePath: courseDir,
      totalLessons,
      syncedLessons,
      pendingLessons: Math.max(0, totalLessons - syncedLessons),
      totalAttachments,
      syncedAttachments,
      pendingAttachments: Math.max(0, totalAttachments - syncedAttachments),
      overallPercent,
      pendingLessonIds,
      pendingAttachmentIds,
      modules: moduleAudits,
    };
  }

  /**
   * Enfileira com 1 clique todos os itens pendentes do curso (aulas e/ou PDFs)
   * que ainda NÃO estão salvos na pasta.
   */
  async downloadPending(
    courseId: string,
    resolution: ResolutionOption = '1080p',
    options?: { downloadVideos?: boolean; downloadAttachments?: boolean },
  ): Promise<{ enqueuedLessons: number; enqueuedAttachments: number; rejectedCount: number }> {
    const audit = await this.auditCourseSync(courseId);

    const willDownloadVideos = options?.downloadVideos ?? true;
    const willDownloadAttachments = options?.downloadAttachments ?? true;

    let enqueuedLessons = 0;
    let rejectedCount = 0;

    // 1. Enfileira apenas as aulas que ainda faltam
    if (willDownloadVideos && audit.pendingLessonIds.length > 0) {
      const enqueueRes = await this.queue.enqueueLessons(audit.pendingLessonIds, resolution, {
        downloadVideos: true,
        downloadAttachments: false, // O QueueManager já processa os vídeos
      });
      enqueuedLessons = enqueueRes.enqueuedJobIds.length;
      rejectedCount = enqueueRes.rejected.length;
    }

    // 2. Dispara o download dos PDFs que ainda faltam
    let enqueuedAttachments = 0;
    if (willDownloadAttachments && audit.pendingAttachmentIds.length > 0) {
      for (const attId of audit.pendingAttachmentIds) {
        // Dispara o download em background através do queueManager
        void this.queue.downloadAttachment(attId);
        enqueuedAttachments++;
      }
    }

    return {
      enqueuedLessons,
      enqueuedAttachments,
      rejectedCount,
    };
  }

  private collectFilesRecursively(
    dir: string,
    list: Array<{ fullPath: string; name: string; size: number }> = [],
  ): Array<{ fullPath: string; name: string; size: number }> {
    if (!fs.existsSync(dir)) return list;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.collectFilesRecursively(full, list);
        } else if (entry.isFile()) {
          try {
            const stats = fs.statSync(full);
            list.push({ fullPath: full, name: entry.name, size: stats.size });
          } catch {
            // Ignora arquivos inacessíveis
          }
        }
      }
    } catch {
      // Ignora erro de leitura de diretório
    }
    return list;
  }
}
