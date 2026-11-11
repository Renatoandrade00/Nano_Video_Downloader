import { LessonAvailability, LicenseStatus, PlatformId } from '../../shared/types';

export interface DecryptedSession {
  platform: PlatformId;
  externalUserId: string;
  email: string;
  bearerToken?: string;
  cookies: Array<{ name: string; value: string; domain: string }>;
  discoveredApiUrls?: string[];
  partitionName?: string;
  expiresAt?: string;
}

export interface WebBridgeConfig {
  platform: PlatformId;
  loginUrl: string;
  successUrlPatterns: RegExp[];
  cookieDomains: string[];
  bearerStorageKeys: string[];
}

export type RawTransactionStatus =
  | 'COMPLETED'
  | 'ACTIVE'
  | 'APPROVED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'CANCELED'
  | 'CHARGEBACK'
  | 'BLOCKED'
  | string;

export interface PurchaseRecord {
  externalCourseId: string;
  courseTitle: string;
  purchaseRef: string;
  rawStatus: RawTransactionStatus;
  normalizedStatus: LicenseStatus;
  coverUrl?: string;
}

export interface OwnershipResult {
  externalCourseId: string;
  normalizedStatus: LicenseStatus;
  rawStatus: RawTransactionStatus;
  purchaseRef: string;
  checkedAt: string;
}

export interface RemoteLessonNode {
  externalLessonId: string;
  orderIndex: number;
  title: string;
  durationSec: number;
  hasVideo: boolean;
  availabilityStatus: LessonAvailability;
}

export interface RemoteModuleNode {
  externalModuleId: string;
  orderIndex: number;
  title: string;
  lessons: RemoteLessonNode[];
}

export interface RemoteCourseTree {
  externalCourseId: string;
  title: string;
  modules: RemoteModuleNode[];
}

export interface MediaDescriptor {
  kind: 'HLS' | 'DASH' | 'DIRECT' | 'DRM_UNSUPPORTED' | 'NO_VIDEO';
  manifestUrl?: string;
  headers?: Record<string, string>;
  directContentLength?: number;
}

export interface IPlatformAdapter {
  readonly platformId: PlatformId;
  getLoginConfig(): WebBridgeConfig;
  fetchPurchases(session: DecryptedSession): Promise<PurchaseRecord[]>;
  verifyCourseOwnership(
    session: DecryptedSession,
    courseExternalId: string,
  ): Promise<OwnershipResult>;
  fetchCourseCatalog(
    session: DecryptedSession,
    courseExternalId: string,
  ): Promise<RemoteCourseTree>;
  resolveLessonMedia(
    session: DecryptedSession,
    courseExternalId: string,
    lessonExternalId: string,
  ): Promise<MediaDescriptor>;
}

export function normalizeTransactionStatus(rawStatus: RawTransactionStatus): LicenseStatus {
  const upper = rawStatus.trim().toUpperCase();
  if (upper === 'COMPLETED' || upper === 'ACTIVE' || upper === 'APPROVED') {
    return 'AUTHORIZED';
  }
  return 'REVOKED';
}

export function buildAuthHeaders(session: DecryptedSession): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'NanoVideoDownloader/1.0 (GoogleAntigravity)',
  };
  if (session.bearerToken) {
    headers.Authorization = `Bearer ${session.bearerToken}`;
  }
  if (session.cookies.length > 0) {
    headers.Cookie = session.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  return headers;
}

