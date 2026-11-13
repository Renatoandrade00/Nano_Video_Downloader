import fs from 'node:fs';
import path from 'node:path';
import { isAllowedWebUrl } from '../../shared/urlGuard';
import {
  MediaDescriptor,
  PurchaseRecord,
  RemoteAttachmentNode,
  RemoteCourseTree,
  RemoteLessonNode,
  RemoteModuleNode,
  normalizeTransactionStatus,
} from './platformAdapter';

const purchasesCache = new Map<string, { at: number; data: PurchaseRecord[] }>();
const clubUrlCache = new Map<string, string>();

function extractClubProductBase(url: string): string | null {
  const m = url.match(/(https?:\/\/[^/]+(?:\/[^/]+)?\/club\/[^/]+\/products\/\d+)/i);
  return m ? m[1] : null;
}

function getElectron() {
  // Dynamic import so unit tests running in plain Node/Vitest never crash loading Electron
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as typeof import('electron');
}

async function safeLoadUrl(win: Electron.BrowserWindow, url: string): Promise<void> {
  try {
    await win.loadURL(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // OIDC / SPA redirects in Hotmart trigger ERR_ABORTED (-3) before landing on the target page
    if (!msg.includes('ERR_ABORTED') && !msg.includes('(-3)')) {
      throw err;
    }
  }
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
    return { responses, detach: () => { } };
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

function writeSyncDebugLog(entry: Record<string, unknown>): void {
  try {
    const userData = getElectron().app.getPath('userData');
    const logPath = path.join(userData, 'hotmart-sync-debug.log');
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} ${JSON.stringify(entry)}\n`,
      'utf8',
    );
  } catch {
    // Non-fatal diagnostic log
  }
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
        const explicitlyBlocked =
          obj.blocked === true ||
          obj.isBlocked === true ||
          obj.expired === true ||
          obj.isExpired === true ||
          obj.refunded === true ||
          obj.canceled === true ||
          obj.cancelled === true ||
          obj.hasAccess === false ||
          obj.accessible === false ||
          purchase?.blocked === true ||
          membership?.blocked === true;

        const explicitAccessTrue =
          obj.hasAccess === true ||
          obj.accessible === true ||
          obj.isBlocked === false ||
          obj.blocked === false;

        const rawCandidate =
          purchase?.status ??
          purchase?.transactionStatus ??
          obj.purchaseStatus ??
          obj.transactionStatus ??
          obj.accessStatus ??
          obj.subscriptionStatus ??
          membership?.status ??
          obj.status;

        const rawStatus = explicitlyBlocked
          ? 'BLOCKED'
          : rawCandidate !== undefined
            ? extractStatusString(rawCandidate)
            : explicitAccessTrue
              ? 'ACTIVE'
              : 'ACTIVE';

        let normalizedStatus = normalizeTransactionStatus(rawStatus);
        if (normalizedStatus === 'REVOKED' && !explicitlyBlocked && explicitAccessTrue) {
          normalizedStatus = 'AUTHORIZED';
        }

        writeSyncDebugLog({
          extId,
          title: String(titleCandidate).trim(),
          rawStatus,
          normalizedStatus,
          explicitlyBlocked,
          explicitAccessTrue,
          clubCandidate: clubCandidate ?? null,
          statusSnapshot: {
            purchaseStatus: purchase?.status ?? null,
            objPurchaseStatus: obj.purchaseStatus ?? null,
            objTransactionStatus: obj.transactionStatus ?? null,
            objAccessStatus: obj.accessStatus ?? null,
            objStatus: obj.status ?? null,
            hasAccess: obj.hasAccess ?? null,
            blocked: obj.blocked ?? obj.isBlocked ?? null,
          },
        });

        const coverCandidate =
          product?.cover ?? product?.coverImage ?? obj.coverUrl ?? obj.image ?? obj.thumbnail;
        found.push({
          externalCourseId: extId,
          courseTitle: String(titleCandidate).trim(),
          purchaseRef: String(
            purchase?.transaction ?? obj.transaction ?? obj.purchaseRef ?? 'HM-LIVE',
          ),
          rawStatus,
          normalizedStatus,
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
  const cached = purchasesCache.get(partitionName);
  if (cached && Date.now() - cached.at < 45_000) {
    return cached.data;
  }

  const { win } = createHiddenSessionWindow(partitionName);
  const interceptor = attachJsonInterceptor(win, /hotmart\.com/i);

  try {
    await safeLoadUrl(win, 'https://consumer.hotmart.com');

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const currentUrl = win.webContents.getURL();
      if (/sso\.hotmart\.com\/login/i.test(currentUrl)) {
        throw new Error('Sessão Hotmart expirada. Clique em Sair e reconecte via WebBridge.');
      }

      const jsonPurchases = extractPurchasesFromJson(interceptor.responses);
      if (jsonPurchases.length > 0) {
        purchasesCache.set(partitionName, { at: Date.now(), data: jsonPurchases });
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

function findModuleArray(root: unknown): Array<Record<string, unknown>> | null {
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) continue;
    if (Array.isArray(cur) && cur.length > 0 && typeof cur[0] === 'object' && cur[0] !== null) {
      const first = cur[0] as Record<string, unknown>;
      if (
        Array.isArray(first.pages) ||
        Array.isArray(first.lessons) ||
        Array.isArray(first.contents) ||
        Array.isArray(first.children) ||
        Array.isArray(first.items) ||
        Array.isArray(first.topics)
      ) {
        return cur as Array<Record<string, unknown>>;
      }
    }
    if (typeof cur === 'object' && !Array.isArray(cur)) {
      for (const v of Object.values(cur as Record<string, unknown>)) {
        if (v && typeof v === 'object') queue.push(v);
      }
    }
  }
  return null;
}

function extractClubTreeFromJson(
  responses: CapturedJsonResponse[],
  courseExternalId: string,
  resolvedBaseUrl: string,
): RemoteCourseTree | null {
  for (const res of responses) {
    const body = res.body as Record<string, unknown> | Array<Record<string, unknown>>;
    const directModules = Array.isArray(body)
      ? body
      : (body?.modules as Array<Record<string, unknown>> | undefined) ??
      ((body?.data as Record<string, unknown> | undefined)?.modules as
        | Array<Record<string, unknown>>
        | undefined);

    const modulesArray =
      Array.isArray(directModules) &&
      directModules.length > 0 &&
      (Array.isArray(directModules[0]?.pages) ||
        Array.isArray(directModules[0]?.lessons) ||
        Array.isArray(directModules[0]?.contents) ||
        Array.isArray(directModules[0]?.children) ||
        Array.isArray(directModules[0]?.items) ||
        Array.isArray(directModules[0]?.topics))
        ? directModules
        : findModuleArray(body);

    if (!modulesArray || modulesArray.length === 0) continue;

    const clubProductBase = extractClubProductBase(resolvedBaseUrl);
    const baseOrigin = (() => {
      try {
        return new URL(resolvedBaseUrl).origin;
      } catch {
        return resolvedBaseUrl.replace(/\/+$/, '');
      }
    })();

    const modules: RemoteModuleNode[] = modulesArray.map((mod, mIdx) => {
      const pages = (mod.pages ??
        mod.lessons ??
        mod.contents ??
        mod.children ??
        mod.items ??
        mod.topics ??
        []) as Array<Record<string, unknown>>;
      const lessons: RemoteLessonNode[] = pages.map((p, lIdx) => {
        const pageId = String(p.hash ?? p.id ?? p.pageId ?? `${mIdx}_${lIdx}`);
        const lessonUrl =
          typeof p.url === 'string' && p.url.startsWith('http')
            ? p.url
            : clubProductBase
              ? `${clubProductBase}/content/${pageId}`
              : `${baseOrigin}/lesson/${pageId}`;
        const locked = Boolean(p.locked ?? p.isLocked ?? p.dripLocked);
        const hasMedia = p.hasMedia !== false && p.type !== 'TEXT';
        const rawAtts = (p.attachments ?? p.files ?? p.materials ?? p.downloads ?? []) as Array<Record<string, unknown>>;
        const attachments = rawAtts
          .map((att, aIdx) => {
            const fileName = String(att.name ?? att.fileName ?? att.file_name ?? att.title ?? `Material_${aIdx + 1}.pdf`);
            const fileUrl = String(att.url ?? att.fileUrl ?? att.file_url ?? att.downloadUrl ?? '');
            const ext = fileName.includes('.') ? fileName.split('.').pop()! : 'pdf';
            return {
              externalAttachmentId: String(att.id ?? `${pageId}_att_${aIdx}`),
              fileName,
              fileUrl,
              fileType: String(att.type ?? att.fileType ?? ext),
              fileSize: typeof att.size === 'number' ? att.size : undefined,
            };
          })
          .filter((att) => Boolean(att.fileUrl));

        const isAvailable = hasMedia || attachments.length > 0;

        return {
          externalLessonId: lessonUrl,
          orderIndex: Number(p.order ?? p.sequence ?? lIdx + 1),
          title: String(p.name ?? p.title ?? `Aula ${lIdx + 1}`).trim(),
          durationSec: Number(p.duration ?? p.durationSec ?? 0),
          hasVideo: hasMedia,
          availabilityStatus: locked
            ? 'LOCKED_DRIP'
            : isAvailable
              ? 'AVAILABLE'
              : 'NO_VIDEO',
          attachments,
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
  const cacheKey = `${partitionName}:${courseExternalId}`;
  const cachedUrl = clubUrlCache.get(cacheKey);
  if (cachedUrl) {
    return cachedUrl;
  }

  const { win } = createHiddenSessionWindow(partitionName);
  const interceptor = attachJsonInterceptor(win, /hotmart\.com/i);
  let resolvedUrl: string | null = null;
  let matchedTitle: string | null = null;
  let clickedAccess = false;

  const acceptCandidateUrl = (candidate: string) => {
    if (!candidate || !isAllowedWebUrl(candidate)) return;
    if (
      /club\.hotmart\.com|hotmart\.club|go\.hotmart\.com|\/club\//i.test(candidate) &&
      !/sso\.hotmart\.com/i.test(candidate)
    ) {
      resolvedUrl = candidate;
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    acceptCandidateUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-navigate', (_e, url) => acceptCandidateUrl(url));
  win.webContents.on('did-navigate-in-page', (_e, url) => acceptCandidateUrl(url));

  try {
    await safeLoadUrl(win, 'https://consumer.hotmart.com');
    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) {
      if (resolvedUrl) {
        clubUrlCache.set(cacheKey, resolvedUrl);
        writeSyncDebugLog({ event: 'resolveNumericCourseUrl', courseExternalId, resolvedUrl });
        return resolvedUrl;
      }

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
            if (!matchedTitle) {
              const t = product?.name ?? obj.productName ?? obj.courseName ?? obj.name ?? obj.title;
              if (typeof t === 'string' && t.trim().length > 0) {
                matchedTitle = t.trim();
              }
            }
            const url = extractClubUrlFromNode(obj);
            if (url && /club\.hotmart\.com|hotmart\.club|go\.hotmart\.com/i.test(url)) {
              writeSyncDebugLog({ event: 'resolveNumericCourseUrlJson', courseExternalId, url });
              return url;
            }
          }
          for (const v of Object.values(obj)) {
            if (v && typeof v === 'object') queue.push(v);
          }
        }
      }

      if (!clickedAccess) {
        const actionResult = (await win.webContents.executeJavaScript(
          `(() => {
            const id = ${JSON.stringify(courseExternalId)};
            const title = ${JSON.stringify(matchedTitle ?? '')}.toLowerCase();
            const links = Array.from(document.querySelectorAll('a[href]'));
            const direct = links.find(a => a.href.includes(id) || a.href.includes('club.hotmart.com') || a.href.includes('go.hotmart.com'));
            if (direct) return { href: direct.href, clicked: false };
            if (!title) return { href: null, clicked: false };
            const cards = Array.from(document.querySelectorAll('article, section, li, [class*="card"], [class*="Card"], div'));
            const card = cards.find(c => (c.textContent || '').toLowerCase().includes(title) && /acessar|access/i.test(c.textContent || ''));
            if (!card) return { href: null, clicked: false };
            const btn = Array.from(card.querySelectorAll('button, a')).find(el => /acessar|access/i.test(el.textContent || ''));
            if (btn) {
              btn.click();
              return { href: btn.getAttribute('href') || null, clicked: true };
            }
            return { href: null, clicked: false };
          })()`,
          true,
        )) as { href: string | null; clicked: boolean };

        if (actionResult.href && /^https?:\/\//i.test(actionResult.href)) {
          acceptCandidateUrl(actionResult.href);
          if (resolvedUrl) return resolvedUrl;
        }
        if (actionResult.clicked) {
          clickedAccess = true;
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    interceptor.detach();
    if (!win.isDestroyed()) win.close();
  }

  writeSyncDebugLog({
    event: 'resolveNumericCourseUrlFallback',
    courseExternalId,
    matchedTitle,
    clickedAccess,
    apiUrls: interceptor.responses.map((r) => r.url).slice(0, 15),
  });
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
    await safeLoadUrl(win, clubUrl);

    let clickedStart = false;
    const startMs = Date.now();
    const deadline = startMs + 16000;
    while (Date.now() < deadline) {
      const currentUrl = win.webContents.getURL();
      if (/sso\.hotmart\.com\/login/i.test(currentUrl)) {
        throw new Error('Sessão Hotmart expirada ao abrir Hotmart Club.');
      }

      const jsonTree = extractClubTreeFromJson(
        interceptor.responses,
        courseExternalId,
        currentUrl || clubUrl,
      );
      if (jsonTree && jsonTree.modules.length > 0) {
        return jsonTree;
      }

      if (!clickedStart && Date.now() - startMs > 2500) {
        clickedStart = (await win.webContents.executeJavaScript(
          `(() => {
            const btns = Array.from(document.querySelectorAll('a, button'));
            const target = btns.find(el => /continuar assistindo|começar|iniciar curso|acessar conteúdo|ver aulas|assistir/i.test((el.textContent || '').trim()));
            if (target) { target.click(); return true; }
            return false;
          })()`,
          true,
        )) as boolean;
      }

      const domTree = (await win.webContents.executeJavaScript(
        `(() => {
          const title = document.title || 'Curso Hotmart';
          const links = Array.from(document.querySelectorAll('a[href*="/lesson/"], a[href*="/content/"], a[href*="/page/"], a[href*="/products/"][href*="/content"]'));
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

    writeSyncDebugLog({
      event: 'fetchLiveHotmartCatalogFailed',
      courseExternalId,
      clubUrl,
      finalUrl: win.webContents.getURL(),
      clickedStart,
      apiResponses: interceptor.responses.map((r) => ({
        url: r.url,
        keys:
          r.body && typeof r.body === 'object' && !Array.isArray(r.body)
            ? Object.keys(r.body as Record<string, unknown>).slice(0, 12)
            : Array.isArray(r.body)
              ? `array(${r.body.length})`
              : typeof r.body,
      })),
    });

    throw new Error(`Não foi possível mapear os módulos em ${clubUrl}.`);
  } finally {
    interceptor.detach();
    if (!win.isDestroyed()) win.close();
  }
}

async function extractAttachmentsFromLessonPage(
  win: Electron.BrowserWindow,
  responses: CapturedJsonResponse[],
  pageId: string,
): Promise<RemoteAttachmentNode[]> {
  const result: RemoteAttachmentNode[] = [];
  const seenUrls = new Set<string>();

  // 1. Extrair payloads JSON embutidos no HTML do Next.js (__NEXT_DATA__ e scripts JSON)
  try {
    const inlineJsonList = (await win.webContents.executeJavaScript(
      `(() => {
        const payloads = [];
        const nextScript = document.getElementById('__NEXT_DATA__');
        if (nextScript && nextScript.textContent) {
          try { payloads.push(JSON.parse(nextScript.textContent)); } catch(e) {}
        }
        const jsonScripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const s of jsonScripts) {
          if (s !== nextScript && s.textContent && s.textContent.length > 5) {
            try { payloads.push(JSON.parse(s.textContent)); } catch(e) {}
          }
        }
        return payloads;
      })()`,
      true,
    )) as unknown[];

    for (const inlineBody of inlineJsonList) {
      if (inlineBody) {
        responses.push({ url: 'inline:__NEXT_DATA__', body: inlineBody });
      }
    }
  } catch {
    // Ignore inline extraction failures
  }

  // 2. Procurar recursivamente em todas as respostas JSON (Next.js props e XHR)
  for (const r of responses) {
    const queue: unknown[] = [r.body];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) continue;
      if (Array.isArray(cur)) {
        for (const item of cur) queue.push(item);
      } else if (typeof cur === 'object') {
        const obj = cur as Record<string, unknown>;
        let rawUrl = String(
          obj.url ??
            obj.fileUrl ??
            obj.file_url ??
            obj.downloadUrl ??
            obj.download_url ??
            obj.directUrl ??
            obj.signedUrl ??
            obj.link ??
            obj.href ??
            obj.src ??
            '',
        );
        const rawName = String(
          obj.name ??
            obj.fileName ??
            obj.file_name ??
            obj.title ??
            obj.originalFileName ??
            obj.original_file_name ??
            '',
        );

        if (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) {
          rawUrl = `https://hotmart.com${rawUrl}`;
        }

        const isPdfOrMaterial =
          rawUrl.toLowerCase().includes('.pdf') ||
          rawName.toLowerCase().includes('.pdf') ||
          obj.type === 'ATTACHMENT' ||
          obj.type === 'FILE' ||
          obj.type === 'MATERIAL' ||
          obj.mediaType === 'DOCUMENT' ||
          Boolean(obj.fileMembershipAttachmentId);

        if (isPdfOrMaterial && rawUrl.startsWith('http') && !seenUrls.has(rawUrl)) {
          seenUrls.add(rawUrl);
          const fileName = rawName.length > 0 ? rawName : 'Material.pdf';
          const ext = fileName.includes('.') ? fileName.split('.').pop()! : 'pdf';
          result.push({
            externalAttachmentId: String(obj.id ?? obj.fileMembershipAttachmentId ?? `${pageId}_att_${result.length}`),
            fileName,
            fileUrl: rawUrl,
            fileType: String(obj.type ?? ext),
            fileSize: typeof obj.size === 'number' ? obj.size : undefined,
          });
        }
        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object') queue.push(v);
        }
      }
    }
  }

  // 3. Extração no DOM (clicando na aba Materiais e aguardando renderização)
  try {
    const domAtts = (await win.webContents.executeJavaScript(
      `(() => {
        const items = [];
        // Clicar na aba de Materiais se houver
        const allElements = Array.from(document.querySelectorAll('button, [role="tab"], a, div, span, li'));
        const matTab = allElements.find(el => {
          const t = (el.textContent || '').trim();
          const isTab = el.tagName === 'BUTTON' || el.getAttribute('role') === 'tab' || /tab/i.test(el.className || '');
          return isTab && /materiais/i.test(t);
        }) || allElements.find(el => {
          const t = (el.textContent || '').trim();
          return /^materiais(\\s*\\d+)?$/i.test(t) && el.children.length <= 4;
        });

        if (matTab) {
          try { matTab.click(); } catch(e) {}
        }

        // Links de arquivos diretos
        const links = Array.from(document.querySelectorAll('a[href*=".pdf"], a[download], a[href*="attachment"], a[href*="material"], a[href*="download"], a[href*="s3"], a[href*="cloudfront"]'));
        for (const a of links) {
          const href = a.href || '';
          if (!href.startsWith('http')) continue;
          const text = (a.textContent || '').trim();
          const name = text.match(/([^\\n\\r]+\\.(pdf|zip|rar|docx?|xlsx?))/i)?.[1] ||
                       a.getAttribute('download') ||
                       text ||
                       'Material.pdf';
          items.push({ name: name.replace(/\\s+/g, ' ').trim(), url: href });
        }

        // Blocos/Cards de materiais com texto .pdf (conforme visto na Hotmart)
        const nodes = Array.from(document.querySelectorAll('div, li, section, p'));
        for (const node of nodes) {
          const text = node.textContent || '';
          if (text.includes('.pdf') && (text.includes('Download') || text.includes('KB') || text.includes('MB'))) {
            const btn = node.querySelector('a, button');
            const pdfMatch = text.match(/([^\\n\\r\\t]+\\.pdf)/i);
            if (pdfMatch && btn) {
              const name = pdfMatch[1].trim();
              const url = btn.tagName === 'A' ? btn.href : (btn.getAttribute('data-url') || btn.getAttribute('data-href'));
              if (url && url.startsWith('http')) {
                items.push({ name, url });
              }
            }
          }
        }
        return items;
      })()`,
      true,
    )) as Array<{ name: string; url: string }> | null;

    if (domAtts) {
      for (const da of domAtts) {
        if (!seenUrls.has(da.url)) {
          seenUrls.add(da.url);
          const ext = da.name.includes('.') ? da.name.split('.').pop()! : 'pdf';
          result.push({
            externalAttachmentId: String(`${pageId}_dom_${result.length}`),
            fileName: da.name,
            fileUrl: da.url,
            fileType: ext,
          });
        }
      }
    }
  } catch {
    // Ignore DOM extraction errors
  }

  return result;
}

export async function resolveLiveHotmartLessonMedia(
  partitionName: string,
  lessonExternalId: string,
  courseExternalId?: string,
): Promise<MediaDescriptor> {
  let targetUrl = lessonExternalId;
  const legacyMatch = lessonExternalId.match(/^https?:\/\/hotmart\.com\/lesson\/([^/?#]+)/i);
  if (legacyMatch && courseExternalId && /^\d+$/.test(courseExternalId)) {
    const clubUrl = await resolveNumericCourseUrl(partitionName, courseExternalId);
    const clubProductBase = extractClubProductBase(clubUrl);
    if (clubProductBase) {
      targetUrl = `${clubProductBase}/content/${legacyMatch[1]}`;
    }
  }

  const { win, webSession } = createHiddenSessionWindow(partitionName);
  const interceptor = attachJsonInterceptor(win, /hotmart\.com|cloudfront|amazonaws/i);

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
    await safeLoadUrl(win, targetUrl);

    let clickedPlay = false;
    let openedEmbed = false;
    const startMs = Date.now();
    const deadline = startMs + 22000;
    while (Date.now() < deadline) {
      const currentUrl = win.webContents.getURL();
      if (/sso\.hotmart\.com\/login/i.test(currentUrl) && Date.now() - startMs > 3500) {
        throw new Error('Sessão Hotmart expirada. Por favor, reconecte sua conta na aba Contas & Cofre.');
      }

      if (foundMedia) {
        const media = foundMedia as MediaDescriptor;
        const attachments = await extractAttachmentsFromLessonPage(win, interceptor.responses, lessonExternalId);
        return { ...media, attachments };
      }
      if (sawDrmLicense) {
        const attachments = await extractAttachmentsFromLessonPage(win, interceptor.responses, lessonExternalId);
        return { kind: 'DRM_UNSUPPORTED', attachments };
      }

      if (!openedEmbed && Date.now() - startMs > 5500) {
        const embedUrl = (await win.webContents.executeJavaScript(
          `(() => {
            const ifr = Array.from(document.querySelectorAll('iframe')).find(f => /play\\.hotmart\\.com\\/embed/i.test(f.src || ''));
            return ifr ? ifr.src : null;
          })()`,
          true,
        )) as string | null;
        if (embedUrl) {
          openedEmbed = true;
          clickedPlay = false;
          await safeLoadUrl(win, embedUrl);
          continue;
        }
      }

      if (!clickedPlay && Date.now() - startMs > 2500) {
        clickedPlay = (await win.webContents.executeJavaScript(
          `(() => {
            const btn = document.querySelector('button[aria-label*="play" i], button[title*="play" i], .vjs-big-play-button, [data-testid*="play" i], video');
            if (btn) { btn.click(); return true; }
            return false;
          })()`,
          true,
        )) as boolean;
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
        const attachments = await extractAttachmentsFromLessonPage(win, interceptor.responses, lessonExternalId);
        return {
          kind: videoSrc.includes('.m3u8')
            ? 'HLS'
            : videoSrc.includes('.mpd')
              ? 'DASH'
              : 'DIRECT',
          manifestUrl: videoSrc,
          attachments,
        };
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    const attachments = await extractAttachmentsFromLessonPage(win, interceptor.responses, lessonExternalId);

    if (!sawDrmLicense) {
      const domDebug = (await win.webContents.executeJavaScript(
        `(() => ({
          iframes: Array.from(document.querySelectorAll('iframe')).map(f => f.src).slice(0, 6),
          hasVideoTag: Boolean(document.querySelector('video')),
        }))()`,
        true,
      )) as { iframes: string[]; hasVideoTag: boolean };
      writeSyncDebugLog({
        event: 'resolveLiveHotmartLessonMediaNoVideo',
        targetUrl,
        finalUrl: win.webContents.getURL(),
        ...domDebug,
      });
    }

    return sawDrmLicense
      ? { kind: 'DRM_UNSUPPORTED', attachments }
      : { kind: attachments.length > 0 ? 'DIRECT' : 'NO_VIDEO', attachments };
  } finally {
    interceptor.detach();
    webSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, null);
    if (!win.isDestroyed()) win.close();
  }
}

export async function resolveLiveHotmartLessonAttachments(
  partitionName: string,
  lessonExternalId: string,
  courseExternalId?: string,
): Promise<RemoteAttachmentNode[]> {
  let targetUrl = lessonExternalId;
  const legacyMatch = lessonExternalId.match(/^https?:\/\/hotmart\.com\/lesson\/([^/?#]+)/i);
  if (legacyMatch && courseExternalId && /^\d+$/.test(courseExternalId)) {
    const clubUrl = await resolveNumericCourseUrl(partitionName, courseExternalId);
    const clubProductBase = extractClubProductBase(clubUrl);
    if (clubProductBase) {
      targetUrl = `${clubProductBase}/content/${legacyMatch[1]}`;
    }
  }

  const { win } = createHiddenSessionWindow(partitionName);
  const interceptor = attachJsonInterceptor(win, /hotmart\.com|cloudfront|amazonaws/i);

  try {
    await safeLoadUrl(win, targetUrl);

    const startMs = Date.now();
    const deadline = startMs + 10000;
    while (Date.now() < deadline) {
      const currentUrl = win.webContents.getURL();
      if (/sso\.hotmart\.com\/login/i.test(currentUrl) && Date.now() - startMs > 3500) {
        throw new Error('Sessão Hotmart expirada. Por favor, reconecte sua conta na aba Contas & Cofre.');
      }

      await win.webContents
        .executeJavaScript(
          `(() => {
            const els = Array.from(document.querySelectorAll('button, a, [role="tab"], div, span, li'));
            const matTab = els.find(el => {
              const t = (el.textContent || '').trim();
              return /^materiais(\\s*\\d+)?$/i.test(t) && el.children.length <= 2;
            });
            if (matTab) {
              try { matTab.click(); } catch(e) {}
            }
          })()`,
          true,
        )
        .catch(() => {});

      const atts = await extractAttachmentsFromLessonPage(win, interceptor.responses, lessonExternalId);
      if (atts.length > 0) {
        writeSyncDebugLog({
          event: 'resolveLiveHotmartLessonAttachmentsSuccess',
          targetUrl,
          finalUrl: win.webContents.getURL(),
          foundCount: atts.length,
          files: atts.map((a) => a.fileName),
        });
        return atts;
      }
      await new Promise((r) => setTimeout(r, 600));
    }

    const domDebug = (await win.webContents
      .executeJavaScript(
        `(() => {
          const els = Array.from(document.querySelectorAll('button, a, [role="tab"], div, span, li'));
          const mat = els.filter(e => /materiais/i.test(e.textContent || '')).map(e => e.textContent.trim().slice(0, 30));
          const pdfs = els.filter(e => (e.textContent || '').includes('.pdf')).map(e => e.textContent.trim().slice(0, 50));
          return {
            title: document.title,
            matCount: mat.length,
            matSamples: mat.slice(0, 5),
            pdfCount: pdfs.length,
            pdfSamples: pdfs.slice(0, 5),
          };
        })()`,
        true,
      )
      .catch(() => ({ title: 'error', matCount: 0, matSamples: [], pdfCount: 0, pdfSamples: [] }))) as Record<string, unknown>;

    const fallbackAtts = await extractAttachmentsFromLessonPage(win, interceptor.responses, lessonExternalId);
    writeSyncDebugLog({
      event: 'resolveLiveHotmartLessonAttachmentsResult',
      targetUrl,
      finalUrl: win.webContents.getURL(),
      responsesCount: interceptor.responses.length,
      foundCount: fallbackAtts.length,
      ...domDebug,
    });
    return fallbackAtts;
  } finally {
    interceptor.detach();
    if (!win.isDestroyed()) win.close();
  }
}

