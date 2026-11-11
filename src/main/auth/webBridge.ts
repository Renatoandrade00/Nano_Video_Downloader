import { BrowserWindow, session } from 'electron';
import { isAllowedWebUrl } from '../../shared/urlGuard';
import { DecryptedSession, WebBridgeConfig } from '../adapters/platformAdapter';

export interface WebBridgeResult {
  bearerToken?: string;
  cookies: Array<{ name: string; value: string; domain: string }>;
  discoveredApiUrls?: string[];
  partitionName?: string;
  email?: string;
  externalUserId?: string;
}

/**
 * Antigravity WebBridge: isolated login BrowserWindow that lets the user sign in
 * directly on Hotmart or Kiwify without the app ever reading plaintext passwords.
 */
export async function openIsolatedWebBridgeLogin(
  config: WebBridgeConfig,
  partitionId: string,
  parentWindow?: BrowserWindow | null,
): Promise<WebBridgeResult> {
  const partitionName = `persist:webbridge-${config.platform}-${partitionId}`;
  const webSession = session.fromPartition(partitionName);

  // Swallow custom schemes like `sslocal://` silently so Windows never opens
  // the "Você precisa de um novo app para abrir este link" dialog.
  for (const scheme of ['sslocal', 'intent', 'hotmart', 'kiwify']) {
    if (!webSession.protocol.isProtocolHandled(scheme)) {
      webSession.protocol.handle(scheme, () => new Response('', { status: 204 }));
    }
  }

  return new Promise<WebBridgeResult>((resolve, reject) => {
    let settled = false;
    let capturedBearerFromHeader: string | undefined;
    const discoveredApiUrls = new Set<string>();
    const trackedWindows = new Set<BrowserWindow>();

    const onBeforeSendHeaders = (
      details: Electron.OnBeforeSendHeadersListenerDetails,
      callback: (beforeSendResponse: Electron.BeforeSendResponse) => void,
    ) => {
      const authHeader =
        details.requestHeaders.Authorization ?? details.requestHeaders.authorization;
      if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (token.length > 20) {
          capturedBearerFromHeader = token;
        }
      }
      if (
        (details.resourceType === 'xhr' || details.resourceType === 'other') &&
        /(purchase|course|club|product|member|subscription|order|my-courses)/i.test(details.url) &&
        discoveredApiUrls.size < 30
      ) {
        discoveredApiUrls.add(details.url);
      }
      callback({ requestHeaders: details.requestHeaders });
    };

    webSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://*/*'] },
      onBeforeSendHeaders,
    );

    const win = new BrowserWindow({
      width: 620,
      height: 780,
      title: `Conectar ${config.platform.toUpperCase()} — Antigravity WebBridge`,
      parent: parentWindow ?? undefined,
      modal: Boolean(parentWindow),
      autoHideMenuBar: true,
      webPreferences: {
        partition: partitionName,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    trackedWindows.add(win);

    let capturePending = false;

    const cleanupAndResolve = (result: WebBridgeResult) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      webSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, null);
      for (const w of trackedWindows) {
        if (!w.isDestroyed()) {
          w.close();
        }
      }
      resolve(result);
    };

    const tryCaptureSession = async (targetWin: BrowserWindow, currentUrl: string) => {
      if (settled || capturePending || targetWin.isDestroyed()) return;
      if (/sso\.hotmart\.com\/login/i.test(currentUrl)) return;
      const matched = config.successUrlPatterns.some((re) => re.test(currentUrl));
      if (!matched) return;

      capturePending = true;
      try {
        // Wait briefly for SPA XHR requests to emit Authorization headers
        if (!capturedBearerFromHeader) {
          await new Promise((r) => setTimeout(r, 1200));
        }
        if (settled || targetWin.isDestroyed()) return;

        const allCookies = await webSession.cookies.get({});
        const relevantCookies = allCookies
          .filter((c) =>
            config.cookieDomains.some((dom) => c.domain?.includes(dom.replace(/^\./, ''))),
          )
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain ?? '',
          }));

        let bearerToken: string | undefined = capturedBearerFromHeader;
        let email: string | undefined;
        let externalUserId: string | undefined;

        if (!bearerToken) {
          try {
            const storageProbe = (await targetWin.webContents.executeJavaScript(
              `(() => {
                const keys = ${JSON.stringify(config.bearerStorageKeys)};
                let token = null;
                for (const k of keys) {
                  token = window.localStorage.getItem(k) || window.sessionStorage.getItem(k);
                  if (token) break;
                }
                if (!token) {
                  for (const store of [window.localStorage, window.sessionStorage]) {
                    for (let i = 0; i < store.length; i++) {
                      const val = store.getItem(store.key(i) || '') || '';
                      if (/^eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\./.test(val)) {
                        token = val;
                        break;
                      }
                      try {
                        const obj = JSON.parse(val);
                        if (obj && typeof obj.access_token === 'string') {
                          token = obj.access_token;
                          break;
                        }
                        if (obj && typeof obj.token === 'string') {
                          token = obj.token;
                          break;
                        }
                      } catch {}
                    }
                    if (token) break;
                  }
                }
                return { token };
              })()`,
              true,
            )) as { token?: string | null };

            if (storageProbe?.token) {
              bearerToken = storageProbe.token.replace(/^Bearer\s+/i, '');
            }
          } catch {
            // Storage probe is best-effort; HttpOnly session cookies remain authoritative.
          }
        }

        if (relevantCookies.length === 0 && !bearerToken) {
          return;
        }

        console.log(
          `[WebBridge] Sessão capturada em ${currentUrl} (cookies=${relevantCookies.length}, bearer=${Boolean(bearerToken)}, apis=${discoveredApiUrls.size})`,
        );

        cleanupAndResolve({
          bearerToken,
          cookies: relevantCookies,
          discoveredApiUrls: [...discoveredApiUrls],
          partitionName,
          email,
          externalUserId,
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearInterval(pollTimer);
          webSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, null);
          for (const w of trackedWindows) {
            if (!w.isDestroyed()) w.close();
          }
          reject(err);
        }
      } finally {
        capturePending = false;
      }
    };

    const attachMonitors = (targetWin: BrowserWindow) => {
      targetWin.webContents.on('did-navigate', (_event, url) => {
        void tryCaptureSession(targetWin, url);
      });
      targetWin.webContents.on('did-navigate-in-page', (_event, url) => {
        void tryCaptureSession(targetWin, url);
      });
      targetWin.webContents.on('did-finish-load', () => {
        void tryCaptureSession(targetWin, targetWin.webContents.getURL());
      });
      targetWin.webContents.on('did-create-window', (childWin) => {
        trackedWindows.add(childWin);
        attachMonitors(childWin);
      });
    };

    const pollTimer = setInterval(() => {
      if (settled) return;
      for (const w of trackedWindows) {
        if (!w.isDestroyed()) {
          void tryCaptureSession(w, w.webContents.getURL());
        }
      }
    }, 1500);

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });

    // Block external non-HTTP(S) protocols (e.g. sslocal://, intent://) on all frames and popups
    win.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedWebUrl(url)) {
        event.preventDefault();
      }
    });
    win.webContents.on('will-frame-navigate', (details) => {
      if (!isAllowedWebUrl(details.url)) {
        details.preventDefault();
      }
    });
    win.webContents.on('will-redirect', (event, url) => {
      if (!isAllowedWebUrl(url)) {
        event.preventDefault();
      }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedWebUrl(url)) {
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            partition: partitionName,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    });

    attachMonitors(win);

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        clearInterval(pollTimer);
        webSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, null);
        reject(new Error('Janela de autenticação WebBridge fechada antes da conclusão do login.'));
      }
    });

    void win.loadURL(config.loginUrl);
  });
}

export function buildSessionRecord(
  config: WebBridgeConfig,
  captured: WebBridgeResult,
): DecryptedSession {
  return {
    platform: config.platform,
    externalUserId: captured.externalUserId ?? `${config.platform}-user`,
    email: captured.email ?? `${config.platform}-member`,
    bearerToken: captured.bearerToken,
    cookies: captured.cookies,
    discoveredApiUrls: captured.discoveredApiUrls,
    partitionName: captured.partitionName,
  };
}

