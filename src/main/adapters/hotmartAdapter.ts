import {
  buildAuthHeaders,
  DecryptedSession,
  IPlatformAdapter,
  MediaDescriptor,
  normalizeTransactionStatus,
  OwnershipResult,
  PurchaseRecord,
  RemoteCourseTree,
  WebBridgeConfig,
} from './platformAdapter';

export type FetchLike = typeof fetch;

export class HotmartAdapter implements IPlatformAdapter {
  readonly platformId = 'hotmart' as const;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(
    apiBaseUrl = 'https://api-club.hotmart.com',
    fetchFn: FetchLike = fetch,
  ) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
  }

  getLoginConfig(): WebBridgeConfig {
    return {
      platform: 'hotmart',
      loginUrl: 'https://sso.hotmart.com/login',
      successUrlPatterns: [
        /consumer\.hotmart\.com/i,
        /club\.hotmart\.com/i,
        /app\.hotmart\.com/i,
      ],
      cookieDomains: ['hotmart.com', '.hotmart.com'],
      bearerStorageKeys: ['hmAccessToken', 'access_token', 'token'],
    };
  }

  async fetchPurchases(session: DecryptedSession): Promise<PurchaseRecord[]> {
    const res = await this.fetchFn(`${this.apiBaseUrl}/my-courses`, {
      method: 'GET',
      headers: buildAuthHeaders(session),
    });
    if (!res.ok) {
      throw new Error(`Hotmart /my-courses failed with HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      items?: Array<{
        productId?: string | number;
        courseId?: string | number;
        name?: string;
        title?: string;
        transaction?: string;
        purchaseRef?: string;
        status?: string;
        coverUrl?: string;
      }>;
    };

    const items = payload.items ?? [];
    return items.map((item) => {
      const rawStatus = item.status ?? 'UNKNOWN';
      return {
        externalCourseId: String(item.courseId ?? item.productId ?? ''),
        courseTitle: item.title ?? item.name ?? 'Curso Hotmart',
        purchaseRef: item.purchaseRef ?? item.transaction ?? 'HM-REF',
        rawStatus,
        normalizedStatus: normalizeTransactionStatus(rawStatus),
        coverUrl: item.coverUrl,
      };
    });
  }

  async verifyCourseOwnership(
    session: DecryptedSession,
    courseExternalId: string,
  ): Promise<OwnershipResult> {
    const purchases = await this.fetchPurchases(session);
    const match = purchases.find((p) => p.externalCourseId === courseExternalId);
    const checkedAt = new Date().toISOString();
    if (!match) {
      return {
        externalCourseId: courseExternalId,
        normalizedStatus: 'REVOKED',
        rawStatus: 'NOT_FOUND',
        purchaseRef: '',
        checkedAt,
      };
    }
    return {
      externalCourseId: courseExternalId,
      normalizedStatus: match.normalizedStatus,
      rawStatus: match.rawStatus,
      purchaseRef: match.purchaseRef,
      checkedAt,
    };
  }

  async fetchCourseCatalog(
    session: DecryptedSession,
    courseExternalId: string,
  ): Promise<RemoteCourseTree> {
    const res = await this.fetchFn(
      `${this.apiBaseUrl}/courses/${encodeURIComponent(courseExternalId)}/modules`,
      {
        method: 'GET',
        headers: buildAuthHeaders(session),
      },
    );
    if (!res.ok) {
      throw new Error(`Hotmart catalog failed with HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      courseTitle?: string;
      modules?: Array<{
        id: string | number;
        order?: number;
        name: string;
        pages?: Array<{
          id: string | number;
          order?: number;
          name: string;
          durationSec?: number;
          hasMedia?: boolean;
          locked?: boolean;
        }>;
      }>;
    };

    return {
      externalCourseId: courseExternalId,
      title: payload.courseTitle ?? 'Curso Hotmart',
      modules: (payload.modules ?? []).map((mod, mIdx) => ({
        externalModuleId: String(mod.id),
        orderIndex: mod.order ?? mIdx + 1,
        title: mod.name,
        lessons: (mod.pages ?? []).map((page, lIdx) => {
          const hasVideo = page.hasMedia !== false;
          return {
            externalLessonId: String(page.id),
            orderIndex: page.order ?? lIdx + 1,
            title: page.name,
            durationSec: page.durationSec ?? 0,
            hasVideo,
            availabilityStatus: page.locked
              ? 'LOCKED_DRIP'
              : hasVideo
                ? 'AVAILABLE'
                : 'NO_VIDEO',
          };
        }),
      })),
    };
  }

  async resolveLessonMedia(
    session: DecryptedSession,
    courseExternalId: string,
    lessonExternalId: string,
  ): Promise<MediaDescriptor> {
    const res = await this.fetchFn(
      `${this.apiBaseUrl}/courses/${encodeURIComponent(courseExternalId)}/lessons/${encodeURIComponent(lessonExternalId)}/media`,
      {
        method: 'GET',
        headers: buildAuthHeaders(session),
      },
    );
    if (!res.ok) {
      throw new Error(`Hotmart media lookup failed with HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      type?: 'HLS' | 'DASH' | 'DIRECT' | 'DRM' | 'NONE';
      url?: string;
      drmProtected?: boolean;
      contentLength?: number;
    };

    if (payload.drmProtected || payload.type === 'DRM') {
      return { kind: 'DRM_UNSUPPORTED' };
    }
    if (!payload.url || payload.type === 'NONE') {
      return { kind: 'NO_VIDEO' };
    }
    const kind =
      payload.type ??
      (payload.url.includes('.m3u8')
        ? 'HLS'
        : payload.url.includes('.mpd')
          ? 'DASH'
          : 'DIRECT');
    return {
      kind,
      manifestUrl: payload.url,
      headers: buildAuthHeaders(session),
      directContentLength: payload.contentLength,
    };
  }
}

