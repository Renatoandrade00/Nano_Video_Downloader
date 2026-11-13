export type PlatformId = 'hotmart' | 'kiwify';

export type AccountStatus = 'CONNECTED' | 'EXPIRED' | 'DISCONNECTED';

export type LicenseStatus = 'AUTHORIZED' | 'REVOKED';

export type ResolutionOption = '1080p' | '720p' | '480p' | '360p';

export type StreamType = 'HLS' | 'DASH' | 'DIRECT';

export type LessonAvailability =
  | 'AVAILABLE'
  | 'LOCKED_DRIP'
  | 'NO_VIDEO'
  | 'DRM_UNSUPPORTED';

export type JobState =
  | 'QUEUED'
  | 'VERIFYING_OWNERSHIP'
  | 'INSPECTING_MEDIA'
  | 'DOWNLOADING'
  | 'PAUSED'
  | 'REMUXING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REVOKED'
  | 'CANCELED';

export type TrackType = 'VIDEO' | 'AUDIO' | 'MUXED';

export type SegmentStatus = 'PENDING' | 'DOWNLOADED';

export interface AccountRecord {
  id: string;
  platform: PlatformId;
  externalUserId: string;
  emailHash: string;
  credentialRef: string;
  status: AccountStatus;
  lastVerifiedAt: string;
}

export interface CourseRecord {
  id: string;
  accountId: string;
  externalCourseId: string;
  title: string;
  sanitizedFolder: string;
  licenseStatus: LicenseStatus;
  licenseCheckedAt: string;
  coverLocalPath: string | null;
}

export interface ModuleRecord {
  id: string;
  courseId: string;
  externalModuleId: string;
  orderIndex: number;
  title: string;
  sanitizedFolder: string;
}

export interface LessonRecord {
  id: string;
  moduleId: string;
  externalLessonId: string;
  orderIndex: number;
  title: string;
  durationSec: number;
  hasVideo: boolean;
  availabilityStatus: LessonAvailability;
  localFilePath: string | null;
  attachments?: LessonAttachmentRecord[];
}

export interface DownloadJobRecord {
  id: string;
  lessonId: string;
  targetResolution: ResolutionOption;
  streamType: StreamType | null;
  state: JobState;
  totalSegments: number;
  completedSegments: number;
  totalBytes: number;
  downloadedBytes: number;
  stagingDir: string;
  errorCode: string | null;
  updatedAt: string;
}

export interface SegmentCheckpointRecord {
  jobId: string;
  trackType: TrackType;
  segmentIndex: number;
  status: SegmentStatus;
  byteSize: number;
  checksumSha256: string | null;
}

export interface PlaybackProgressRecord {
  lessonId: string;
  lastPositionSec: number;
  playbackSpeed: number;
  isWatched: boolean;
  watchedAt: string | null;
  updatedAt: string;
}

export interface AuditWatermarkRecord {
  jobId: string;
  watermarkId: string;
  accountHash: string;
  purchaseRef: string;
  machineSignature: string;
  stampedAt: string;
}

export interface LessonAttachmentRecord {
  id: string;
  lessonId: string;
  externalAttachmentId: string;
  fileName: string;
  fileUrl: string;
  fileType: string;
  fileSize: number | null;
  localFilePath: string | null;
}

export interface LessonWithProgress extends LessonRecord {
  progress: PlaybackProgressRecord | null;
  job: DownloadJobRecord | null;
  attachments?: LessonAttachmentRecord[];
}

export interface ModuleWithLessons extends ModuleRecord {
  lessons: LessonWithProgress[];
}

export interface CourseTreeDetails {
  course: CourseRecord;
  modules: ModuleWithLessons[];
}

export interface RejectedEnqueueItem {
  lessonId: string;
  reason: string;
}

export interface JobProgressEvent {
  jobId: string;
  lessonId: string;
  moduleId: string;
  courseId: string;
  state: JobState;
  completedSegments: number;
  totalSegments: number;
  bytesPerSec: number;
  etaSec: number | null;
  percent: number;
  errorCode: string | null;
}

export interface ModuleProgressEvent {
  moduleId: string;
  courseId: string;
  completedLessons: number;
  totalLessons: number;
  overallPercent: number;
}

export interface JobCompletedEvent {
  jobId: string;
  lessonId: string;
  localFilePath: string;
}

export interface OwnershipRevokedEvent {
  courseId: string;
  reason: string;
  affectedJobIds: string[];
}

export interface NetworkStatusEvent {
  online: boolean;
}

export interface PlayerOpenResult {
  fileUrl: string;
  localFilePath: string;
  lesson: LessonRecord;
  progress: PlaybackProgressRecord;
  watermark: AuditWatermarkRecord | null;
}

export interface AppSettings {
  libraryRootDir: string;
  bandwidthLimitBytesPerSec: number | null;
  defaultResolution: ResolutionOption;
}

export interface NanoElectronBridge {
  auth: {
    listAccounts(): Promise<AccountRecord[]>;
    connect(platform: PlatformId): Promise<AccountRecord>;
    disconnect(accountId: string): Promise<{ ok: true }>;
  };
  catalog: {
    sync(accountId: string): Promise<CourseRecord[]>;
    listCourses(): Promise<CourseRecord[]>;
    getOffline(): Promise<CourseTreeDetails[]>;
    getCourseDetails(courseId: string, forceRemote?: boolean): Promise<CourseTreeDetails>;
  };
  queue: {
    listJobs(): Promise<DownloadJobRecord[]>;
    enqueue(
      lessonIds: string[],
      resolution: ResolutionOption,
      options?: { downloadVideos?: boolean; downloadAttachments?: boolean },
    ): Promise<{ enqueuedJobIds: string[]; enqueuedAttachmentCount?: number; rejected: RejectedEnqueueItem[] }>;
    control(action: 'pause' | 'resume' | 'cancel', jobId?: string): Promise<{ ok: true }>;
    clearFailed(): Promise<{ deletedCount: number }>;
    setBandwidthLimit(bytesPerSec: number | null): Promise<{ activeLimit: number | null }>;
  };
  attachments: {
    openAttachment(attachmentId: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  };
  player: {
    openLesson(lessonId: string): Promise<PlayerOpenResult>;
    saveProgress(
      lessonId: string,
      positionSec: number,
      speed: number,
      forceWatched?: boolean,
    ): Promise<{ isWatched: boolean }>;
  };
  settings: {
    get(): Promise<AppSettings>;
    setLibraryDir(dirPath: string): Promise<AppSettings>;
    pickLibraryDir(): Promise<string | null>;
  };
  events: {
    onNetworkStatus(cb: (event: NetworkStatusEvent) => void): () => void;
    onOwnershipRevoked(cb: (event: OwnershipRevokedEvent) => void): () => void;
    onJobProgress(cb: (event: JobProgressEvent) => void): () => void;
    onModuleProgress(cb: (event: ModuleProgressEvent) => void): () => void;
    onJobCompleted(cb: (event: JobCompletedEvent) => void): () => void;
  };
}

