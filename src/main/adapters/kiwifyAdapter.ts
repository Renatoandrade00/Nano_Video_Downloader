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
import { FetchLike } from './hotmartAdapter';

export class KiwifyAdapter implements IPlatformAdapter {
  readonly platformId = 'kiwify' as const;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(
    apiBaseUrl = 'https://members-api.kiwify.com.br',
    fetchFn: FetchLike = fetch,
  ) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
  }

  getLoginConfig(): WebBridgeConfig {
    return {
      platform: 'kiwify',
      loginUrl: 'https://dashboard.kiwify.com.br/login',
      successUrlPatterns: [
        /members\.kiwify\.com\.br/i,
        /dashboard\.kiwify\.com\.br\/courses/i,
      ],
      cookieDomains: ['kiwify.com.br', '.kiwify.com.br'],
      bearerStorageKeys: ['kiwify_token', 'access_token', 'token'],
    };
  }

  async fetchPurchases(session: DecryptedSession): Promise<PurchaseRecord[]> {
    const res = await this.fetchFn(`${this.apiBaseUrl}/purchases`, {
      method: 'GET',
      headers: buildAuthHeaders(session),
    });
    if (!res.ok) {
      throw new Error(`Kiwify /purchases failed with HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{
        course_id?: string;
        course_name?: string;
        order_id?: string;
        status?: string;
        cover_image?: string;
      }>;
    };

    return (payload.data ?? []).map((item) => {
      const rawStatus = item.status ?? 'UNKNOWN';
      return {
        externalCourseId: String(item.course_id ?? ''),
        courseTitle: item.course_name ?? 'Curso Kiwify',
        purchaseRef: item.order_id ?? 'KW-REF',
        rawStatus,
        normalizedStatus: normalizeTransactionStatus(rawStatus),
        coverUrl: item.cover_image,
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
      `${this.apiBaseUrl}/courses/${encodeURIComponent(courseExternalId)}`,
      {
        method: 'GET',
        headers: buildAuthHeaders(session),
      },
    );
    if (!res.ok) {
      throw new Error(`Kiwify catalog failed with HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      name?: string;
      modules?: Array<{
        id: string;
        order?: number;
        name: string;
        lessons?: Array<{
          id: string;
          order?: number;
          title: string;
          duration?: number;
          type?: string;
          released?: boolean;
        }>;
      }>;
    };

    return {
      externalCourseId: courseExternalId,
      title: payload.name ?? 'Curso Kiwify',
      modules: (payload.modules ?? []).map((mod, mIdx) => ({
        externalModuleId: String(mod.id),
        orderIndex: mod.order ?? mIdx + 1,
        title: mod.name,
        lessons: (mod.lessons ?? []).map((lesson, lIdx) => {
          const hasVideo = lesson.type ? lesson.type === 'video' : true;
          const locked = lesson.released === false;
          const rawAtts = ((lesson as Record<string, unknown>).attachments ??
            (lesson as Record<string, unknown>).files ??
            []) as Array<Record<string, unknown>>;
          const attachments = rawAtts
            .map((att, aIdx) => {
              const fileName = String(
                att.name ?? att.fileName ?? att.file_name ?? att.title ?? `Material_${aIdx + 1}.pdf`,
              );
              const fileUrl = String(att.url ?? att.fileUrl ?? att.file_url ?? '');
              const ext = fileName.includes('.') ? fileName.split('.').pop()! : 'pdf';
              return {
                externalAttachmentId: String(att.id ?? `${lesson.id}_att_${aIdx}`),
                fileName,
                fileUrl,
                fileType: String(att.type ?? att.fileType ?? ext),
                fileSize:
                  typeof att.file_size === 'number'
                    ? att.file_size
                    : typeof att.size === 'number'
                      ? att.size
                      : undefined,
              };
            })
            .filter((att) => Boolean(att.fileUrl));

          const isAvailable = hasVideo || attachments.length > 0;
          return {
            externalLessonId: String(lesson.id),
            orderIndex: lesson.order ?? lIdx + 1,
            title: lesson.title,
            durationSec: lesson.duration ?? 0,
            hasVideo,
            availabilityStatus: locked
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
    const res = await this.fetchFn(
      `${this.apiBaseUrl}/courses/${encodeURIComponent(courseExternalId)}/lessons/${encodeURIComponent(lessonExternalId)}/stream`,
      {
        method: 'GET',
        headers: buildAuthHeaders(session),
      },
    );
    if (!res.ok) {
      throw new Error(`Kiwify media lookup failed with HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      stream_url?: string;
      format?: 'HLS' | 'DASH' | 'DIRECT';
      drm?: boolean;
      content_length?: number;
    };
    if (payload.drm) {
      return { kind: 'DRM_UNSUPPORTED' };
    }
    if (!payload.stream_url) {
      return { kind: 'NO_VIDEO' };
    }
    const kind =
      payload.format ??
      (payload.stream_url.includes('.m3u8')
        ? 'HLS'
        : payload.stream_url.includes('.mpd')
          ? 'DASH'
          : 'DIRECT');
    return {
      kind,
      manifestUrl: payload.stream_url,
      headers: buildAuthHeaders(session),
      directContentLength: payload.content_length,
    };
  }
}

