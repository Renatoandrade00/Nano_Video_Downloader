import { app, BrowserWindow, net, protocol, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AppSettings } from '../shared/types';
import { AdapterRegistry } from './adapters/registry';
import { isAllowedWebUrl } from '../shared/urlGuard';
import { AuthManager } from './auth/authManager';
import { CatalogCrawler } from './catalog/catalogCrawler';
import { registerIpcHandlers } from './ipc/handlers';
import { MediaStreamInspector } from './media/mediaInspector';
import { DecryptionAndRemuxer } from './media/remuxer';
import { OwnershipVerifier } from './ownership/ownershipVerifier';
import { QueueAndChunkManager } from './queue/queueManager';
import { BandwidthLimiter } from './queue/tokenBucket';
import { VaultDatabase } from './vault/database';
import { createElectronOsProtector, createTestProtector, SecretStore } from './vault/secretStore';
import { enableOfflineE2ECheck } from './offlineSmokeCheck';

if (process.env.NANO_USER_DATA_DIR) {
  app.setPath('userData', process.env.NANO_USER_DATA_DIR);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'antigravity-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let db: VaultDatabase | null = null;

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function registerLocalMediaProtocol(vaultDb: VaultDatabase): void {
  protocol.handle('antigravity-media', (request) => {
    const parsedUrl = new URL(request.url);
    const lessonId = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
    const ctx = vaultDb.getLessonContext(lessonId);

    if (!ctx?.lesson.localFilePath || !fs.existsSync(ctx.lesson.localFilePath)) {
      return new Response('Not found', { status: 404 });
    }

    const filePath = ctx.lesson.localFilePath;
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const rangeHeader = request.headers.get('range');

    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(fileSize - 1, Number(match[2])) : fileSize - 1;
        if (start >= fileSize || start > end) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` },
          });
        }
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize),
            'Content-Type': 'video/mp4',
          },
        });
      }
    }

    const stream = fs.createReadStream(filePath);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(fileSize),
        'Content-Type': 'video/mp4',
      },
    });
  });
}

function resolveFfmpegBin(): string {
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (process.resourcesPath) {
    const packagedBin = path.join(process.resourcesPath, 'bin', exeName);
    if (fs.existsSync(packagedBin)) {
      return packagedBin;
    }
  }
  try {
    const appRoot = app.getAppPath();
    const localBin = path.join(appRoot, 'bin', exeName);
    if (fs.existsSync(localBin)) {
      return localBin;
    }
  } catch {
    // Non-electron/fallback
  }
  return 'ffmpeg';
}

function createWindow(): void {
  const isHeadlessE2E = process.env.NANO_OFFLINE_E2E === '1';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: !isHeadlessE2E,
    title: 'Nano Video Downloader — Google Antigravity',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isHeadlessE2E) {
    enableOfflineE2ECheck(mainWindow);
  } else {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      mainWindow?.focus();
      app.focus({ steal: true });
    });
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedWebUrl(url)) {
      event.preventDefault();
    }
  });
  contents.on('will-frame-navigate', (details) => {
    if (!isAllowedWebUrl(details.url)) {
      details.preventDefault();
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedWebUrl(url)) {
      event.preventDefault();
    }
  });
});

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');
  const vaultDir = path.join(userDataDir, 'vault');
  const defaultLibraryDir = path.join(app.getPath('videos'), 'NanoVideoDownloader');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(defaultLibraryDir, { recursive: true });

  const defaultSettings: AppSettings = {
    libraryRootDir: defaultLibraryDir,
    bandwidthLimitBytesPerSec: null,
    defaultResolution: '1080p',
  };

  const protector = safeStorage.isEncryptionAvailable()
    ? createElectronOsProtector(safeStorage)
    : createTestProtector(userDataDir);

  const secrets = new SecretStore(vaultDir, protector);
  db = new VaultDatabase(path.join(vaultDir, 'library.db'));
  const adapters = new AdapterRegistry();
  const auth = new AuthManager(db, secrets, adapters);

  const ownership = new OwnershipVerifier(db, auth, adapters, (event) => {
    broadcast('ownership:revoked', event);
  });
  const catalog = new CatalogCrawler(db, auth, adapters, ownership);
  const inspector = new MediaStreamInspector();
  const remuxer = new DecryptionAndRemuxer(secrets, resolveFfmpegBin());
  const settings = db.getSettings(defaultSettings);
  const limiter = new BandwidthLimiter(settings.bandwidthLimitBytesPerSec);

  const queue = new QueueAndChunkManager(
    db,
    auth,
    adapters,
    ownership,
    inspector,
    remuxer,
    secrets,
    limiter,
    {
      stagingRootDir: path.join(vaultDir, 'staging'),
      getLibraryRootDir: () => db!.getSettings(defaultSettings).libraryRootDir,
    },
    {
      onJobProgress: (e) => broadcast('queue:jobProgress', e),
      onModuleProgress: (e) => broadcast('queue:moduleProgress', e),
      onJobCompleted: (e) => broadcast('queue:jobCompleted', e),
    },
  );

  registerLocalMediaProtocol(db);
  registerIpcHandlers({
    db,
    auth,
    catalog,
    queue,
    defaultSettings,
    getMainWindow: () => mainWindow,
  });

  createWindow();

  // Broadcast initial online/offline status periodically or on focus
  setInterval(() => {
    broadcast('network:statusChanged', { online: net.isOnline() });
  }, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    db?.close();
    app.quit();
  }
});
