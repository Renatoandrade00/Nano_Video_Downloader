import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import { AppSettings, PlatformId, ResolutionOption } from '../../shared/types';
import { AuthManager } from '../auth/authManager';
import { CatalogCrawler } from '../catalog/catalogCrawler';
import { QueueAndChunkManager } from '../queue/queueManager';
import { VaultDatabase } from '../vault/database';

export interface IpcDependencies {
  db: VaultDatabase;
  auth: AuthManager;
  catalog: CatalogCrawler;
  queue: QueueAndChunkManager;
  defaultSettings: AppSettings;
  getMainWindow: () => BrowserWindow | null;
}

export function registerIpcHandlers(deps: IpcDependencies): void {
  ipcMain.handle('auth:listAccounts', () => deps.auth.listAccounts());

  ipcMain.handle('auth:connect', async (_event, platform: PlatformId) => {
    return deps.auth.connectPlatform(platform);
  });

  ipcMain.handle('auth:disconnect', (_event, accountId: string) => {
    deps.auth.disconnectAccount(accountId);
    return { ok: true };
  });

  ipcMain.handle('catalog:sync', async (_event, accountId: string) => {
    return deps.catalog.syncAccountCourses(accountId);
  });

  ipcMain.handle('catalog:getOffline', () => {
    return deps.db.listOfflineCourses();
  });

  ipcMain.handle('course:getDetails', async (_event, courseId: string, forceRemote = false) => {
    return deps.catalog.getCourseDetails(courseId, forceRemote);
  });

  ipcMain.handle('queue:listJobs', () => deps.queue.listJobs());

  ipcMain.handle(
    'queue:enqueue',
    async (_event, lessonIds: string[], resolution: ResolutionOption) => {
      return deps.queue.enqueueLessons(lessonIds, resolution);
    },
  );

  ipcMain.handle(
    'queue:control',
    (_event, action: 'pause' | 'resume' | 'cancel', jobId?: string) => {
      deps.queue.control(action, jobId);
      return { ok: true };
    },
  );

  ipcMain.handle('queue:clearFailed', () => {
    const deletedCount = deps.queue.clearFailed();
    return { deletedCount };
  });

  ipcMain.handle('queue:setBandwidthLimit', (_event, bytesPerSec: number | null) => {
    deps.db.saveSetting('bandwidthLimitBytesPerSec', bytesPerSec);
    const activeLimit = deps.queue.setBandwidthLimit(bytesPerSec);
    return { activeLimit };
  });

  ipcMain.handle('player:openLesson', (_event, lessonId: string) => {
    const ctx = deps.db.getLessonContext(lessonId);
    if (!ctx || !ctx.lesson.localFilePath || !fs.existsSync(ctx.lesson.localFilePath)) {
      throw new Error('Arquivo offline não encontrado no armazenamento local.');
    }
    const progress = deps.db.getPlaybackProgress(lessonId) ?? {
      lessonId,
      lastPositionSec: 0,
      playbackSpeed: 1.0,
      isWatched: false,
      watchedAt: null,
      updatedAt: new Date().toISOString(),
    };
    const job = deps.db.getJobByLessonId(lessonId);
    const watermark = job ? deps.db.getWatermarkByJobId(job.id) : null;

    return {
      fileUrl: `antigravity-media://lesson/${encodeURIComponent(lessonId)}`,
      localFilePath: ctx.lesson.localFilePath,
      lesson: ctx.lesson,
      progress,
      watermark,
    };
  });

  ipcMain.handle(
    'player:saveProgress',
    (
      _event,
      lessonId: string,
      positionSec: number,
      speed: number,
      forceWatched?: boolean,
    ) => {
      const ctx = deps.db.getLessonContext(lessonId);
      const duration = ctx?.lesson.durationSec ?? 0;
      const reachedNinetyPercent = duration > 0 && positionSec / duration >= 0.9;
      const isWatched = Boolean(forceWatched || reachedNinetyPercent);

      const saved = deps.db.savePlaybackProgress(lessonId, positionSec, speed, isWatched);
      return { isWatched: saved.isWatched };
    },
  );

  ipcMain.handle('settings:get', () => deps.db.getSettings(deps.defaultSettings));

  ipcMain.handle('settings:setLibraryDir', (_event, dirPath: string) => {
    fs.mkdirSync(dirPath, { recursive: true });
    deps.db.saveSetting('libraryRootDir', dirPath);
    return deps.db.getSettings(deps.defaultSettings);
  });

  ipcMain.handle('settings:pickLibraryDir', async () => {
    const win = deps.getMainWindow();
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Selecionar pasta da Biblioteca Offline',
    };
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (res.canceled || res.filePaths.length === 0) {
      return null;
    }
    return res.filePaths[0];
  });
}
