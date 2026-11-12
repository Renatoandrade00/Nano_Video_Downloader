import { contextBridge, ipcRenderer } from 'electron';
import {
  JobCompletedEvent,
  JobProgressEvent,
  ModuleProgressEvent,
  NanoElectronBridge,
  NetworkStatusEvent,
  OwnershipRevokedEvent,
  PlatformId,
  ResolutionOption,
} from '../shared/types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: NanoElectronBridge = {
  auth: {
    listAccounts: () => ipcRenderer.invoke('auth:listAccounts'),
    connect: (platform: PlatformId) => ipcRenderer.invoke('auth:connect', platform),
    disconnect: (accountId: string) => ipcRenderer.invoke('auth:disconnect', accountId),
  },
  catalog: {
    sync: (accountId: string) => ipcRenderer.invoke('catalog:sync', accountId),
    listCourses: () => ipcRenderer.invoke('catalog:listCourses'),
    getOffline: () => ipcRenderer.invoke('catalog:getOffline'),
    getCourseDetails: (courseId: string, forceRemote?: boolean) =>
      ipcRenderer.invoke('course:getDetails', courseId, forceRemote),
  },
  queue: {
    listJobs: () => ipcRenderer.invoke('queue:listJobs'),
    enqueue: (lessonIds: string[], resolution: ResolutionOption) =>
      ipcRenderer.invoke('queue:enqueue', lessonIds, resolution),
    control: (action: 'pause' | 'resume' | 'cancel', jobId?: string) =>
      ipcRenderer.invoke('queue:control', action, jobId),
    clearFailed: () => ipcRenderer.invoke('queue:clearFailed'),
    setBandwidthLimit: (bytesPerSec: number | null) =>
      ipcRenderer.invoke('queue:setBandwidthLimit', bytesPerSec),
  },
  player: {
    openLesson: (lessonId: string) => ipcRenderer.invoke('player:openLesson', lessonId),
    saveProgress: (
      lessonId: string,
      positionSec: number,
      speed: number,
      forceWatched?: boolean,
    ) => ipcRenderer.invoke('player:saveProgress', lessonId, positionSec, speed, forceWatched),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setLibraryDir: (dirPath: string) => ipcRenderer.invoke('settings:setLibraryDir', dirPath),
    pickLibraryDir: () => ipcRenderer.invoke('settings:pickLibraryDir'),
  },
  events: {
    onNetworkStatus: (cb: (e: NetworkStatusEvent) => void) =>
      subscribe('network:statusChanged', cb),
    onOwnershipRevoked: (cb: (e: OwnershipRevokedEvent) => void) =>
      subscribe('ownership:revoked', cb),
    onJobProgress: (cb: (e: JobProgressEvent) => void) => subscribe('queue:jobProgress', cb),
    onModuleProgress: (cb: (e: ModuleProgressEvent) => void) =>
      subscribe('queue:moduleProgress', cb),
    onJobCompleted: (cb: (e: JobCompletedEvent) => void) => subscribe('queue:jobCompleted', cb),
  },
};

contextBridge.exposeInMainWorld('antigravity', bridge);

