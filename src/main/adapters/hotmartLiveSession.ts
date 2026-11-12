import { isAllowedWebUrl } from '../../shared/urlGuard';
import {
  MediaDescriptor,
  PurchaseRecord,
  RemoteCourseTree,
  RemoteLessonNode,
  RemoteModuleNode,
  normalizeTransactionStatus,
} from './platformAdapter';

function getElectron() {
  // Dynamic import so unit tests running in plain Node/Vitest never crash loading Electron
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as typeof import('electron');
}

function createHiddenSessionWindow(partitionName: string) {
  const { BrowserWindow, session } = getElectron();
  const webSession = session.fromPartition(partitionName);

  for (const scheme of ['sslocal', 'intent', 'hotmart', 'kiwify']) {
    if (!webSession.protocol.isProtocolHandled(scheme)) {
      webSession.protocol.handle(scheme, () => new Response('', { status: 204 }));
    }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    webPreferences: {
      partition: partitionName,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedWebUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-frame-navigate', (details) => {
    if (!isAllowedWebUrl(details.url)) details.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedWebUrl(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedWebUrl(url)) return { action: 'deny' };
    return { action: 'deny' };
  });

  return { win, webSession };
}

interface CapturedJsonResponse {
  url: string;
  body: unknown;
}

function attachJsonInterceptor(
  win: Electron.BrowserWindow,
  urlFilter: RegExp,
): { responses: CapturedJsonResponse[]; detach: () => void } {
  const responses: CapturedJsonResponse[] = [];
  const pendingIds = new Map<string, string>();
  const dbg = win.webContents.debugger;

  try {
    dbg.attach('1.3');
    void dbg.sendCommand('Network.enable');
  } catch {
    return { responses, detach: () => {} };
  }

  const onMessage = async (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => {
    if (method === 'Network.responseReceived') {
      const response = params.response as
        | { url?: string; mimeType?: string; status?: number }
        | undefined;
      const reqId = String(params.requestId ?? '');
      if (
        response?.url &&
        response.status &&
        response.status >= 200 &&
        response.status < 300 &&
        (response.mimeType ?? '').includes('json') &&
        urlFilter.test(response.url)
      ) {
        pendingIds.set(reqId, response.url);
      }
    } else if (method === 'Network.loadingFinished') {
      const reqId = String(params.requestId ?? '');
      const url = pendingIds.get(reqId);
      if (!url) return;
      pendingIds.delete(reqId);
      try {
        const res = (await dbg.sendCommand('Network.getResponseBody', {
          requestId: reqId,
        })) as { body?: string; base64Encoded?: boolean };
        if (res.body) {
          const text = res.base64Encoded
            ? Buffer.from(res.body, 'base64').toString('utf8')
            : res.body;
          responses.push({ url, body: JSON.parse(text) });
        }
      } catch {
        // Ignore transient debugger body read failures
      }
    }
  };

  dbg.on('message', onMessage);

  return {
    responses,
    detach: () => {
      dbg.off('message', onMessage);
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch {
        // Ignore detach errors on destroyed windows
      }
    },
  };
}

function extractStatusString(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const nested = obj.value ?? obj.code ?? obj.status ?? obj.name ?? obj.label;
    if (typeof nested === 'string' && nested.trim().length > 0) {
      return nested.trim();
    }
  }
  return 'ACTIVE';
}

function extractClubUrlFromNode(obj: Record<string, unknown>): string | undefined {
  const product = (obj.product as Record<string, unknown> | undefined) ?? undefined;
  const membership = (obj.membership as Record<string, unknown> | undefined) ?? undefined;
  const club = (obj.club as Record<string, unknown> | undefined) ?? undefined;
  const candidates = [
    obj.clubUrl,
    obj.accessUrl,
    obj.membershipUrl,
    obj.redirectUrl,
    obj.url,
    product?.clubUrl,
    product?.accessUrl,
    product?.url,
    membership?.url,
    club?.url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) {
      return c;
    }
  }
  const subdomain = obj.subdomain ?? club?.subdomain ?? product?.subdomain;
  if (typeof subdomain === 'string' && subdomain.trim().length > 0) {
    return `https://${subdomain.trim()}.club.hotmart.com`;
  }
  return undefined;
}

function extractPurchasesFromJson(responses: CapturedJsonResponse[]): PurchaseRecord[] {
  const found: PurchaseRecord[] = [];
  const seenIds = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const obj = node as Record<string, unknown>;
    const product = (obj.product as Record<string, unknown> | undefined) ?? undefined;
    const purchase = (obj.purchase as Record<string, unknown> | undefined) ?? undefined;
    const membership = (obj.membership as Record<string, unknown> | undefined) ?? undefined;

    const titleCandidate =
      product?.name ??
      obj.productName ??
      obj.courseName ??
      obj.name ??
      obj.title;

    const clubCandidate = extractClubUrlFromNode(obj);

    const idCandidate =
      (typeof clubCandidate === 'string' && clubCandidate.includes('club.hotmart.com')
        ? clubCandidate
        : undefined) ??
      product?.id ??
      obj.productId ??
      obj.courseId ??
      obj.ucode;

    const looksLikePurchaseItem =
      Boolean(titleCandidate) &&
      Boolean(idCandidate) &&
      (Boolean(product) ||
        Boolean(purchase) ||
        Boolean(obj.transaction) ||
        Boolean(obj.subdomain) ||
        (typeof clubCandidate === 'string' && clubCandidate.includes('hotmart.com')));

    if (looksLikePurchaseItem) {
      const extId = String(idCandidate);
      if (!seenIds.has(extId)) {
        seenIds.add(extId);
        const rawStatus = extractStatusString(
          purchase?.status ??
            purchase?.transactionStatus ??
            obj.purchaseStatus ??
            obj.transactionStatus ??
            obj.accessStatus ??
            obj.status,
        );
        const coverCandidate =
          product?.cover ?? product?.coverImage ?? obj.coverUrl ?? obj.image ?? obj.thumbnail;
        found.push({
          externalCourseId: extId,
          courseTitle: String(titleCandidate).trim(),
          purchaseRef: String(
            purchase?.transaction ?? obj.transaction ?? obj.purchaseRef ?? 'HM-LIVE',
          ),
          rawStatus,
          normalizedStatus: normalizeTransactionStatus(rawStatus),
          coverUrl: typeof coverCandidate === 'string' ? coverCandidate : undefined,
        });
      }
    }

    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };

  for (const r of responses) {
    walk(r.body);
  }
  return found;
}

export async function fetchLiveHotmartPurchases(
  partitionName: string,
): Promise<PurchaseRecord[]> {
  const { win } = createHiddenSessionWindow(partitionName);
  const interceptor = attachJsonInterceptor(win, /hotmart\.com/i);

  try {
    await win.loadURL('https://consumer.hotmart.com');

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const currentUrl = win.webContents.getURL();
      if (/sso\.hotmart\.com\/login/i.test(currentUrl)) {
        throw new Error('Sessão Hotmart expirada. Clique em Sair e reconecte via WebBridge.');
      }

      const jsonPurchases = extractPurchasesFromJson(interceptor.responses);
      if (jsonPurchases.length > 0) {
        return jsonPurchases;
      }

      // DOM fallback on Hotmart "Minhas compras" page
      const domItems = (await win.webContents.executeJavaScript(
        `(() => {
          const results = [];
          const links = Array.from(document.querySelectorAll('a[href*="club.hotmart.com"], a[href*="go.hotmart.com"], a[href*="/product/"]'));
          for (const a of links) {
            const href = a.href || '';
            const card = a.closest('article, section, li, [class*="card"], [class*="Card"], div') || a.parentElement;
            const heading = card ? card.querySelector('h1, h2, h3, h4, p, strong') : null;
            const title = (heading?.textContent || a.textContent || '').trim();
            if (!title || title.length < 3 || /^acessar$/i.test(title)) continue;
            const img = card ? card.querySelector('img') : null;
            results.push({
              href,
              title,
              coverUrl: img?.src || undefined,
            });
          }
          return results;
        })()`,
        true,
      )) as Array<{ href: string; title: string; coverUrl?: string }>;

      if (domItems.length > 0) {
        const dedup = new Map<string, PurchaseRecord>();
        for (const item of domItems) {
          if (!dedup.has(item.href)) {
            dedup.set(item.href, {
              externalCourseId: item.href,
              courseTitle: item.title,
              purchaseRef: 'HM-CONSUMER-WEB',
              rawStatus: 'ACTIVE',
              normalizedStatus: 'AUTHORIZED',
              coverUrl: item.coverUrl,
            });
          }
        }
        if (dedup.size > 0) {
          return [...dedup.values()];
        }
      }

      await new Promise((r) => setTimeout(r, 600));
    }

    throw new Error(
      'Nenhum curso encontrado na página Minhas Compras da Hotmart. Verifique se a sessão ainda está ativa.',
    );
  } finally {
    interceptor.detach();
    if (!win.isDestroyed()) win.close();
  }
}

function extractClubTreeFromJson(
  responses: CapturedJsonResponse[],
  courseExternalId: string,
): RemoteCourseTree | null {
  for (const res of responses) {
    const body = res.body as Record<string, unknown> | Array<Record<string, unknown>>;
    const modulesArray = Array.isArray(body)
      ? body
      : (body?.modules as Array<Record<string, unknown>> | undefined) ??
        ((body?.data as Record<string, unknown> | undefined)?.modules as
          | Array<Record<string, unknown>>
          | undefined);

    if (!Array.isArray(modulesArray) || modulesArray.length === 0) continue;

    const first = modulesArray[0];
    const hasPages = Array.isArray(first?.pages) || Array.isArray(first?.lessons);
    if (!hasPages) continue;

    const modules: RemoteModuleNode[] = modulesArray.map((mod, mIdx) => {
      const pages = (mod.pages ?? mod.lessons ?? []) as Array<Record<string, unknown>>;
      const lessons: RemoteLessonNode[] = pages.map((p, lIdx) => {
        const pageId = String(p.hash ?? p.id ?? p.pageId ?? `${mIdx}_${lIdx}`);
        const baseClubUrl = courseExternalId.startsWith('http')
          ? courseExternalId.replace(/\/+$/, '')
          : `https://${courseExternalId}.club.hotmart.com`;
        const lessonUrl =
          typeof p.url === 'string' && p.url.startsWith('http')
            ? p.url
            : `${baseClubUrl}/lesson/${pageId}`;
        const locked = Boolean(p.locked ?? p.isLocked ?? p.dripLocked);
        const hasMedia = p.hasMedia !== false && p.type !== 'TEXT';

        return {
          externalLessonId: lessonUrl,
          orderIndex: Number(p.order ?? p.sequence ?? lIdx + 1),
          title: String(p.name ?? p.title ?? `Aula ${lIdx + 1}`).trim(),
          durationSec: Number(p.duration ?? p.durationSec ?? 0),
          hasVideo: hasMedia,
          availabilityStatus: locked
            ? 'LOCKED_DRIP'
            : hasMedia
              ? 'AVAILABLE'
              : 'NO_VIDEO',
        };
      });

      return {
        externalModuleId: String(mod.id ?? mod.module_id ?? mIdx + 1),
        orderIndex: Number(mod.order ?? mod.sequence ?? mIdx + 1),
        title: String(mod.name ?? mod.title ?? `Módulo ${mIdx + 1}`).trim(),
        lessons,
      };
    });

    return {
      externalCourseId: courseExternalId,
      title: String((!Array.isArray(body) && (body?.name ?? body?.title)) || 'Curso Hotmart'),
      modules,
    };
  }
  return null;
}

async function resolveNumericCourseUrl(
  partitionName: string,
  courseExternalId: string,
): Promise<string> {
  const { win } = createHiddenSessionWindow(partitionName);
  const interceptor = attachJsonInterceptor(win, /hotmart\.com/i);
  let resolvedPopupUrl: string | null = null;

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedWebUrl(url) && !resolvedPopupUrl) {
      resolvedPopupUrl = url;
    }
    return { action: 'deny' };
  });

  try {
    await win.loadURL('https://consumer.hotmart.com');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      for (const r of interceptor.responses) {
        const queue: unknown[] = [r.body];
        while (queue.length > 0) {
          const cur = queue.shift();
          if (!cur || typeof cur !== 'object') continue;
          if (Array.isArray(cur)) {
            queue.push(...cur);
            continue;
          }
          const obj = cur as Record<string, unknown>;
          const product = (obj.product as Record<string, unknown> | undefined) ?? undefined;
          const idMatch =
            String(product?.id ?? obj.productId ?? obj.courseId ?? obj.ucode ?? '') ===
            courseExternalId;
          if (idMatch) {
            const url = extractClubUrlFromNode(obj);
            if (url) return url;
          }
          for (const v of Object.values(obj)) {
            if (v && typeof v === 'object') queue.push(v);
          }
        }
      }

      const domHref = (await win.webContents.executeJavaScript(
        `(() => {
          const id = ${JSON.stringify(courseExternalId)};
          const links = Array.from(document.querySelectorAll('a[href]'));
          const exact = links.find(a => a.href.includes(id) || a.href.includes('club.hotmart.com') || a.href.includes('go.hotmart.com'));
          return exact ? exact.href : null;
        })()`,
        true,
      )) as string | null;

      if (resolvedPopupUrl) return resolvedPopupUrl;
      if (domHref && /^https?:\/\//i.test(domHref)) return domHref;

      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    interceptor.detach();
    if (!win.isDestroyed()) win.close();
  }

  return `https://consumer.hotmart.com`;
}

export async function fetchLiveHotmartCatalog(
  partitionName: string,
  courseExternalId: string,
): Promise<RemoteCourseTree> {
  const clubUrl = courseExternalId.startsWith('http')
    ? courseExternalId
    : /^\d+$/.test(courseExternalId)
      ? await resolveNumericCourseUrl(partitionName, courseExternalId)
      : `https://${courseExternalId}.club.hotmart.com`;

  const { win } = createHiddenSessionWindow(partitionName);
  const interceptor = attachJsonInterceptor(win, /hotmart\.com/i);

  try {
    await win.loadURL(clubUrl);

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const currentUrl = win.webContents.getURL();
      if (/sso\.hotmart\.com\/login/i.test(currentUrl)) {
        throw new Error('Sessão Hotmart expirada ao abrir Hotmart Club.');
      }

      const jsonTree = extractClubTreeFromJson(interceptor.responses, courseExternalId);
      if (jsonTree && jsonTree.modules.length > 0) {
        return jsonTree;
      }

      const domTree = (await win.webContents.executeJavaScript(
        `(() => {
          const title = document.title || 'Curso Hotmart';
          const links = Array.from(document.querySelectorAll('a[href*="/lesson/"], a[href*="/content/"], a[href*="/page/"]'));
          if (!links.length) return null;
          const lessons = links.map((a, idx) => ({
            url: a.href,
            title: (a.textContent || '').trim() || ('Aula ' + (idx + 1)),
          }));
          return { title, lessons };
        })()`,
        true,
      )) as { title: string; lessons: Array<{ url: string; title: string }> } | null;

      if (domTree && domTree.lessons.length > 0) {
        const seen = new Set<string>();
        const uniqueLessons: RemoteLessonNode[] = [];
        for (const l of domTree.lessons) {
          if (seen.has(l.url)) continue;
          seen.add(l.url);
          uniqueLessons.push({
            externalLessonId: l.url,
            orderIndex: uniqueLessons.length + 1,
            title: l.title,
            durationSec: 0,
            hasVideo: true,
            availabilityStatus: 'AVAILABLE',
          });
        }
        return {
          externalCourseId: courseExternalId,
          title: domTree.title,
          modules: [
            {
              externalModuleId: 'mod_dom_1',
              orderIndex: 1,
              title: 'Conteúdo do Curso',
              lessons: uniqueLessons,
            },
          ],
        };
      }

      await new Promise((r) => setTimeout(r, 600));
    }

    throw new Error(`Não foi possível mapear os módulos em ${clubUrl}.`);
  } finally {
    interceptor.detach();
    if (!win.isDestroyed()) win.close();
  }
}

export async function resolveLiveHotmartLessonMedia(
  partitionName: string,
  lessonExternalId: string,
): Promise<MediaDescriptor> {
  const { win, webSession } = createHiddenSessionWindow(partitionName);

  let foundMedia: MediaDescriptor | null = null;
  let sawDrmLicense = false;

  const onBeforeSendHeaders = (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (resp: Electron.BeforeSendResponse) => void,
  ) => {
    const url = details.url;
    if (/(\.m3u8(\?|$)|master\.m3u8|playlist\.m3u8)/i.test(url) && !foundMedia) {
      foundMedia = {
        kind: 'HLS',
        manifestUrl: url,
        headers: { ...details.requestHeaders },
      };
    } else if (/\.mpd(\?|$)/i.test(url) && !foundMedia) {
      foundMedia = {
        kind: 'DASH',
        manifestUrl: url,
        headers: { ...details.requestHeaders },
      };
    } else if (/\.mp4(\?|$)/i.test(url) && !foundMedia) {
      foundMedia = {
        kind: 'DIRECT',
        manifestUrl: url,
        headers: { ...details.requestHeaders },
      };
    } else if (/(widevine|fairplay|playready|drm.*license)/i.test(url)) {
      sawDrmLicense = true;
    }
    callback({ requestHeaders: details.requestHeaders });
  };

  webSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, onBeforeSendHeaders);

  try {
    await win.loadURL(lessonExternalId);

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (foundMedia) {
        return foundMedia;
      }
      if (sawDrmLicense) {
        return { kind: 'DRM_UNSUPPORTED' };
      }

      // Check <video src="..."> directly in case direct MP4 or blob-less source is present
      const videoSrc = (await win.webContents.executeJavaScript(
        `(() => {
          const v = document.querySelector('video');
          if (!v) return null;
          const src = v.currentSrc || v.src || '';
          return src && !src.startsWith('blob:') ? src : null;
        })()`,
        true,
      )) as string | null;

      if (videoSrc) {
        return {
          kind: videoSrc.includes('.m3u8')
            ? 'HLS'
            : videoSrc.includes('.mpd')
              ? 'DASH'
              : 'DIRECT',
          manifestUrl: videoSrc,
        };
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    return sawDrmLicense ? { kind: 'DRM_UNSUPPORTED' } : { kind: 'NO_VIDEO' };
  } finally {
    webSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, null);
    if (!win.isDestroyed()) win.close();
  }
}

