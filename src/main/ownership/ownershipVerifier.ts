import fs from 'node:fs';
import { OwnershipRevokedEvent } from '../../shared/types';
import { AdapterRegistry } from '../adapters/registry';
import { AuthManager } from '../auth/authManager';
import { VaultDatabase } from '../vault/database';

export interface OwnershipCheckOutcome {
  authorized: boolean;
  reason?: string;
  purchaseRef?: string;
}

export class OwnershipVerifier {
  private readonly db: VaultDatabase;
  private readonly auth: AuthManager;
  private readonly adapters: AdapterRegistry;
  private readonly onRevoked?: (event: OwnershipRevokedEvent) => void;

  constructor(
    db: VaultDatabase,
    auth: AuthManager,
    adapters: AdapterRegistry,
    onRevoked?: (event: OwnershipRevokedEvent) => void,
  ) {
    this.db = db;
    this.auth = auth;
    this.adapters = adapters;
    this.onRevoked = onRevoked;
  }

  /**
   * Verifies active/completed purchase ownership for a course (RF-03).
   * If expired/refunded/canceled, immediately revokes pending downloads and cleans staging (RF-04).
   */
  async verifyCourseAccess(courseId: string): Promise<OwnershipCheckOutcome> {
    const course = this.db.getCourse(courseId);
    if (!course) {
      return { authorized: false, reason: 'COURSE_NOT_FOUND' };
    }
    const account = this.db.getAccount(course.accountId);
    if (!account || account.status === 'DISCONNECTED') {
      return { authorized: false, reason: 'ACCOUNT_DISCONNECTED' };
    }
    const session = this.auth.getDecryptedSession(account.id);
    if (!session) {
      this.db.updateAccountStatus(account.id, 'EXPIRED', new Date().toISOString());
      return { authorized: false, reason: 'SESSION_MISSING' };
    }

    const adapter = this.adapters.get(account.platform);
    const result = await adapter.verifyCourseOwnership(session, course.externalCourseId);

    this.db.updateCourseLicense(course.id, result.normalizedStatus, result.checkedAt);
    this.db.updateAccountStatus(account.id, 'CONNECTED', result.checkedAt);

    if (result.normalizedStatus !== 'AUTHORIZED') {
      this.revokeCourseDownloads(course.id, result.rawStatus);
      return {
        authorized: false,
        reason: `LICENSE_${result.rawStatus}`,
      };
    }

    return {
      authorized: true,
      purchaseRef: result.purchaseRef,
    };
  }

  revokeCourseDownloads(courseId: string, reason: string): string[] {
    const jobs = this.db.listJobsByCourse(courseId);
    const affectedJobIds: string[] = [];

    for (const job of jobs) {
      if (job.state !== 'COMPLETED' && job.state !== 'REVOKED' && job.state !== 'CANCELED') {
        this.db.updateJobState(job.id, 'REVOKED', `OWNERSHIP_REVOKED:${reason}`);
        this.db.resetCheckpoints(job.id);
        if (job.stagingDir && fs.existsSync(job.stagingDir)) {
          fs.rmSync(job.stagingDir, { recursive: true, force: true });
        }
        affectedJobIds.push(job.id);
      }
    }

    if (affectedJobIds.length > 0 && this.onRevoked) {
      this.onRevoked({
        courseId,
        reason,
        affectedJobIds,
      });
    }
    return affectedJobIds;
  }
}

