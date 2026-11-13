import {
  fetchLiveHotmartCatalog,
  fetchLiveHotmartPurchases,
  resolveLiveHotmartLessonMedia,
} from './hotmartLiveSession';
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

  private shouldUseLiveElectronSession(session: DecryptedSession): boolean {
    return Boolean(
      session.partitionName &&
        this.apiBaseUrl === 'https://api-club.hotmart.com' &&
        this.fetchFn === fetch &&
        process.env.NANO_OFFLINE_E2E !== '1' &&
        Boolean(process.versions.electron),
    );
  }

  getLoginConfig(): WebBridgeConfig {
    return {
      platform: 'hotmart',
      loginUrl: 'https://sso.hotmart.com/login',
      successUrlPatterns: [
        /consumer\.hotmart\.com/i,
        /purchase\.hotmart\.com/i,
        /\.club\.hotmart\.com/i,
        /club\.hotmart\.com/i,
        /app\.hotmart\.com/i,
        /hub\.hotmart\.com/i,
        /my\.hotmart\.com/i,
        /hotmart\.com\/.*minhas-compras/i,
        /hotmart\.com\/.*my-purchases/i,
        /hotmart\.com\/.*my-courses/i,
      ],
      cookieDomains: ['hotmart.com', '.hotmart.com'],
      bearerStorageKeys: ['hmAccessToken', 'access_token', 'token'],
    };
  }

  async fetchPurchases(session: DecryptedSession): Promise<PurchaseRecord[]> {
    if (this.shouldUseLiveElectronSession(session) && session.partitionName) {
      return fetchLiveHotmartPurchases(session.partitionName);
    }

    const candidateUrls = [
      `${this.apiBaseUrl}/my-courses`,
      ...(session.discoveredApiUrls ?? []).filter((u) =>
        /(purchase|my-courses|products|subscriptions|club)/i.test(u),
      ),
    ];

    let lastStatus = 0;
    let lastUrl = candidateUrls[0];

    for (const url of candidateUrls) {
      lastUrl = url;
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: buildAuthHeaders(session),
      });
      lastStatus = res.status;
      if (!res.ok) {
        if (res.status === 404 && candidateUrls.length > 1) {
          continue;
        }
        throw new Error(`Hotmart purchases lookup failed (${res.status}) at ${url}`);
      }

      const payload = (await res.json()) as {
        items?: Array<Record<string, unknown>>;
        data?: Array<Record<string, unknown>>;
        content?: Array<Record<string, unknown>>;
      };

      const items = payload.items ?? payload.data ?? payload.content ?? [];
      if (items.length === 0 && candidateUrls.length > 1 && url !== candidateUrls[candidateUrls.length - 1]) {
        continue;
      }

      return items.map((item) => {
        const product = (item.product as Record<string, unknown> | undefined) ?? {};
        const purchase = (item.purchase as Record<string, unknown> | undefined) ?? {};
        const rawStatus = String(item.status ?? purchase.status ?? 'ACTIVE');
        return {
          externalCourseId: String(
            item.courseId ?? item.productId ?? product.id ?? item.id ?? '',
          ),
          courseTitle: String(
            item.title ?? item.name ?? product.name ?? 'Curso Hotmart',
          ),
          purchaseRef: String(
            item.purchaseRef ?? item.transaction ?? purchase.transaction ?? 'HM-REF',
          ),
          rawStatus,
          normalizedStatus: normalizeTransactionStatus(rawStatus),
          coverUrl:
            typeof (item.coverUrl ?? product.coverImage) === 'string'
              ? String(item.coverUrl ?? product.coverImage)
              : undefined,
        };
      });
    }

    throw new Error(`Hotmart /my-courses failed with HTTP ${lastStatus} (${lastUrl})`);
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
    if (this.shouldUseLiveElectronSession(session) && session.partitionName) {
      return fetchLiveHotmartCatalog(session.partitionName, courseExternalId);
    }

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
          attachments?: Array<{
            id?: string | number;
            name?: string;
            fileName?: string;
            file_name?: string;
            url?: string;
            fileUrl?: string;
            type?: string;
            size?: number;
          }>;
          files?: Array<{
            id?: string | number;
            name?: string;
            fileName?: string;
            file_name?: string;
            url?: string;
            fileUrl?: string;
            type?: string;
            size?: number;
          }>;
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
          const rawAtts = page.attachments ?? page.files ?? [];
          const attachments = rawAtts
            .map((att, aIdx) => {
              const fileName = att.name ?? att.fileName ?? att.file_name ?? `Material_${aIdx + 1}.pdf`;
              const ext = fileName.includes('.') ? fileName.split('.').pop()! : 'pdf';
              return {
                externalAttachmentId: String(att.id ?? `${page.id}_att_${aIdx}`),
                fileName,
                fileUrl: att.url ?? att.fileUrl ?? '',
                fileType: att.type ?? ext,
                fileSize: att.size,
              };
            })
            .filter((att) => Boolean(att.fileUrl));

          const isAvailable = hasVideo || attachments.length > 0;
          return {
            externalLessonId: String(page.id),
            orderIndex: page.order ?? lIdx + 1,
            title: page.name,
            durationSec: page.durationSec ?? 0,
            hasVideo,
            availabilityStatus: page.locked
              ? 'LOCKED_DRIP'
              : isAvailable
                ? 'AVAILABLE'
                : 'NO_VIDEO',
            attachments,
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
    if (this.shouldUseLiveElectronSession(session) && session.partitionName) {
      return resolveLiveHotmartLessonMedia(
        session.partitionName,
        lessonExternalId,
        courseExternalId,
      );
    }

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

