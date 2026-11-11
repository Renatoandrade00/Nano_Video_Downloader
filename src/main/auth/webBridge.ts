import { BrowserWindow, session } from 'electron';
import { isAllowedWebUrl } from '../../shared/urlGuard';
import { DecryptedSession, WebBridgeConfig } from '../adapters/platformAdapter';

export interface WebBridgeResult {
  bearerToken?: string;
  cookies: Array<{ name: string; value: string; domain: string }>;
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
    const win = new BrowserWindow({
      width: 520,
      height: 740,
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

    const tryCaptureSession = async (currentUrl: string) => {
      if (settled) return;
      const matched = config.successUrlPatterns.some((re) => re.test(currentUrl));
      if (!matched) return;

      try {
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

        let bearerToken: string | undefined;
        let email: string | undefined;
        let externalUserId: string | undefined;

        try {
          const storageProbe = (await win.webContents.executeJavaScript(
            `(() => {
              const keys = ${JSON.stringify(config.bearerStorageKeys)};
              let token = null;
              for (const k of keys) {
                token = window.localStorage.getItem(k) || window.sessionStorage.getItem(k);
                if (token) break;
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

        if (relevantCookies.length === 0 && !bearerToken) {
          return;
        }

        settled = true;
        win.close();
        resolve({
          bearerToken,
          cookies: relevantCookies,
          email,
          externalUserId,
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          win.close();
          reject(err);
        }
      }
    };

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

    win.webContents.on('did-navigate', (_event, url) => {
      void tryCaptureSession(url);
    });
    win.webContents.on('did-navigate-in-page', (_event, url) => {
      void tryCaptureSession(url);
    });

    win.on('closed', () => {
      if (!settled) {
        settled = true;
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
  };
}

