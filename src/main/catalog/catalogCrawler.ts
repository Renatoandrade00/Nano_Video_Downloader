import crypto from 'node:crypto';
import { formatCourseFolder, formatModuleFolder } from '../../shared/pathSanitizer';
import { CourseRecord, CourseTreeDetails, LessonRecord, ModuleRecord } from '../../shared/types';
import { AdapterRegistry } from '../adapters/registry';
import { AuthManager } from '../auth/authManager';
import { OwnershipVerifier } from '../ownership/ownershipVerifier';
import { VaultDatabase } from '../vault/database';

export class CatalogCrawler {
  private readonly db: VaultDatabase;
  private readonly auth: AuthManager;
  private readonly adapters: AdapterRegistry;
  private readonly ownership: OwnershipVerifier;

  constructor(
    db: VaultDatabase,
    auth: AuthManager,
    adapters: AdapterRegistry,
    ownership: OwnershipVerifier,
  ) {
    this.db = db;
    this.auth = auth;
    this.adapters = adapters;
    this.ownership = ownership;
  }

  /**
   * Queries `/my-courses` or `/purchases` (RF-03) and persists courses with normalized license status.
   * Revoked courses immediately invalidate any in-flight downloads (RF-04).
   */
  async syncAccountCourses(accountId: string): Promise<CourseRecord[]> {
    const account = this.db.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    const session = this.auth.getDecryptedSession(accountId);
    if (!session) {
      throw new Error('Sessão expirada ou desconectada. Reconecte via WebBridge.');
    }

    const adapter = this.adapters.get(account.platform);
    const purchases = await adapter.fetchPurchases(session);
    const now = new Date().toISOString();

    for (const p of purchases) {
      const existing = this.db.getCourseByExternal(accountId, p.externalCourseId);
      const courseId = existing?.id ?? `course_${crypto.randomUUID().slice(0, 8)}`;

      this.db.upsertCourse({
        id: courseId,
        accountId,
        externalCourseId: p.externalCourseId,
        title: p.courseTitle,
        sanitizedFolder: formatCourseFolder(p.courseTitle),
        licenseStatus: p.normalizedStatus,
        licenseCheckedAt: now,
        coverLocalPath: p.coverUrl ?? null,
      });

      if (p.normalizedStatus === 'REVOKED') {
        this.ownership.revokeCourseDownloads(courseId, p.rawStatus);
      }
    }

    this.db.updateAccountStatus(accountId, 'CONNECTED', now);
    return this.db.listCoursesByAccount(accountId);
  }

  /**
   * Verifies ownership before loading/refreshing module and lesson tree (RF-03, RF-05).
   */
  async getCourseDetails(courseId: string, forceRemote = false): Promise<CourseTreeDetails> {
    const existing = this.db.getCourseTreeDetails(courseId);
    if (!existing) {
      throw new Error(`Course not found: ${courseId}`);
    }

    if (!forceRemote && existing.modules.length > 0) {
      return existing;
    }

    const access = await this.ownership.verifyCourseAccess(courseId);
    if (!access.authorized) {
      throw new Error(`Acesso negado ao curso (${access.reason ?? 'REVOKED'}).`);
    }

    const account = this.db.getAccount(existing.course.accountId);
    const session = account ? this.auth.getDecryptedSession(account.id) : null;
    if (!account || !session) {
      throw new Error('Sessão indisponível para carregar catálogo remoto.');
    }

    const adapter = this.adapters.get(account.platform);
    const tree = await adapter.fetchCourseCatalog(session, existing.course.externalCourseId);

    const mapped = tree.modules.map((m) => {
      const modId = `mod_${crypto.randomUUID().slice(0, 8)}`;
      const modRecord: ModuleRecord = {
        id: modId,
        courseId,
        externalModuleId: m.externalModuleId,
        orderIndex: m.orderIndex,
        title: m.title,
        sanitizedFolder: formatModuleFolder(m.orderIndex),
      };
      const lessons: LessonRecord[] = m.lessons.map((l) => ({
        id: `les_${crypto.randomUUID().slice(0, 8)}`,
        moduleId: modId,
        externalLessonId: l.externalLessonId,
        orderIndex: l.orderIndex,
        title: l.title,
        durationSec: l.durationSec,
        hasVideo: l.hasVideo,
        availabilityStatus: l.availabilityStatus,
        localFilePath: null,
      }));
      return { module: modRecord, lessons };
    });

    this.db.upsertCourseTree(courseId, mapped);
    return this.db.getCourseTreeDetails(courseId)!;
  }
}

