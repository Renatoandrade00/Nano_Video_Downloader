import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildStructuredLessonPath } from '../../shared/pathSanitizer';
import {
  DownloadJobRecord,
  JobCompletedEvent,
  JobProgressEvent,
  JobState,
  ModuleProgressEvent,
  RejectedEnqueueItem,
  ResolutionOption,
  TrackType,
} from '../../shared/types';
import { FetchLike } from '../adapters/hotmartAdapter';
import { AdapterRegistry } from '../adapters/registry';
import { AuthManager } from '../auth/authManager';
import { InspectedMediaPlan, MediaStreamInspector, SegmentDownloadTask } from '../media/mediaInspector';
import { decryptAes128Buffer, DecryptionAndRemuxer } from '../media/remuxer';
import { OwnershipVerifier } from '../ownership/ownershipVerifier';
import { VaultDatabase } from '../vault/database';
import { SecretStore } from '../vault/secretStore';
import { BandwidthLimiter } from './tokenBucket';

export interface QueueEvents {
  onJobProgress?: (event: JobProgressEvent) => void;
  onModuleProgress?: (event: ModuleProgressEvent) => void;
  onJobCompleted?: (event: JobCompletedEvent) => void;
}

export interface QueueConfig {
  stagingRootDir: string;
  getLibraryRootDir: () => string;
  maxConcurrentLessons?: number;
  maxChunksPerLesson?: number;
  maxSegmentRetries?: number;
  fetchFn?: FetchLike;
}

export class QueueAndChunkManager {
  private readonly db: VaultDatabase;
  private readonly auth: AuthManager;
  private readonly adapters: AdapterRegistry;
  private readonly ownership: OwnershipVerifier;
  private readonly inspector: MediaStreamInspector;
  private readonly remuxer: DecryptionAndRemuxer;
  private readonly secrets: SecretStore;
  private readonly limiter: BandwidthLimiter;
  private readonly events: QueueEvents;
  private readonly config: Required<Omit<QueueConfig, 'fetchFn'>> & { fetchFn: FetchLike };

  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeLessonIds = new Set<string>();
  private readonly lastEmitByJob = new Map<string, number>();
  private readonly speedByJob = new Map<string, { bytes: number; windowStartMs: number; bps: number }>();
  private readonly keyCache = new Map<string, Buffer>();
  private pumping = false;

  constructor(
    db: VaultDatabase,
    auth: AuthManager,
    adapters: AdapterRegistry,
    ownership: OwnershipVerifier,
    inspector: MediaStreamInspector,
    remuxer: DecryptionAndRemuxer,
    secrets: SecretStore,
    limiter: BandwidthLimiter,
    config: QueueConfig,
    events: QueueEvents = {},
  ) {
    this.db = db;
    this.auth = auth;
    this.adapters = adapters;
    this.ownership = ownership;
    this.inspector = inspector;
    this.remuxer = remuxer;
    this.secrets = secrets;
    this.limiter = limiter;
    this.events = events;
    this.config = {
      stagingRootDir: config.stagingRootDir,
      getLibraryRootDir: config.getLibraryRootDir,
      maxConcurrentLessons: config.maxConcurrentLessons ?? 2,
      maxChunksPerLesson: config.maxChunksPerLesson ?? 4,
      maxSegmentRetries: config.maxSegmentRetries ?? 5,
      fetchFn: config.fetchFn ?? fetch,
    };
    fs.mkdirSync(this.config.stagingRootDir, { recursive: true });
  }

  listJobs(): DownloadJobRecord[] {
    return this.db.listJobs();
  }

  setBandwidthLimit(bytesPerSec: number | null): number | null {
    this.limiter.setLimit(bytesPerSec);
    return this.limiter.getLimit();
  }

  async enqueueLessons(
    lessonIds: string[],
    resolution: ResolutionOption,
  ): Promise<{ enqueuedJobIds: string[]; rejected: RejectedEnqueueItem[] }> {
    const enqueuedJobIds: string[] = [];
    const rejected: RejectedEnqueueItem[] = [];
    const verifiedCourses = new Map<string, { authorized: boolean; reason?: string }>();

    for (const lessonId of lessonIds) {
      const ctx = this.db.getLessonContext(lessonId);
      if (!ctx) {
        rejected.push({ lessonId, reason: 'LESSON_NOT_FOUND' });
        continue;
      }
      if (!ctx.lesson.hasVideo || ctx.lesson.availabilityStatus !== 'AVAILABLE') {
        rejected.push({ lessonId, reason: ctx.lesson.availabilityStatus });
        continue;
      }

      let courseAccess = verifiedCourses.get(ctx.course.id);
      if (!courseAccess) {
        courseAccess = await this.ownership.verifyCourseAccess(ctx.course.id);
        verifiedCourses.set(ctx.course.id, courseAccess);
      }
      if (!courseAccess.authorized) {
        rejected.push({ lessonId, reason: courseAccess.reason ?? 'OWNERSHIP_DENIED' });
        continue;
      }

      const existing = this.db.getJobByLessonId(lessonId);
      if (existing && (existing.state === 'DOWNLOADING' || existing.state === 'REMUXING' || existing.state === 'QUEUED')) {
        enqueuedJobIds.push(existing.id);
        continue;
      }

      const jobId = existing?.id ?? `job_${crypto.randomUUID().slice(0, 8)}`;
      const stagingDir = path.join(this.config.stagingRootDir, `${jobId}.antigravity-media`);
      fs.mkdirSync(stagingDir, { recursive: true });

      const job: DownloadJobRecord = {
        id: jobId,
        lessonId,
        targetResolution: resolution,
        streamType: existing?.streamType ?? null,
        state: 'QUEUED',
        totalSegments: existing?.totalSegments ?? 0,
        completedSegments: existing?.completedSegments ?? 0,
        totalBytes: existing?.totalBytes ?? 0,
        downloadedBytes: existing?.downloadedBytes ?? 0,
        stagingDir,
        errorCode: null,
        updatedAt: new Date().toISOString(),
      };
      this.db.upsertJob(job);
      enqueuedJobIds.push(jobId);
      this.emitProgress(job, ctx.module.id, ctx.course.id, true);
    }

    this.schedulePump();
    return { enqueuedJobIds, rejected };
  }

  control(action: 'pause' | 'resume' | 'cancel', jobId?: string): void {
    const jobs = jobId ? [this.db.getJob(jobId)].filter((j): j is DownloadJobRecord => Boolean(j)) : this.db.listJobs();

    for (const job of jobs) {
      if (action === 'pause') {
        if (job.state === 'DOWNLOADING' || job.state === 'QUEUED' || job.state === 'VERIFYING_OWNERSHIP' || job.state === 'INSPECTING_MEDIA') {
          this.activeControllers.get(job.id)?.abort();
          this.db.updateJobState(job.id, 'PAUSED');
          this.emitProgressByJobId(job.id, true);
        }
      } else if (action === 'resume') {
        if (job.state === 'PAUSED' || job.state === 'FAILED') {
          this.db.updateJobState(job.id, 'QUEUED', null);
          this.emitProgressByJobId(job.id, true);
        }
      } else if (action === 'cancel') {
        if (job.state !== 'COMPLETED') {
          this.activeControllers.get(job.id)?.abort();
          this.db.updateJobState(job.id, 'CANCELED');
          this.db.resetCheckpoints(job.id);
          if (fs.existsSync(job.stagingDir)) {
            fs.rmSync(job.stagingDir, { recursive: true, force: true });
          }
          this.emitProgressByJobId(job.id, true);
        }
      }
    }

    if (action === 'resume') {
      this.schedulePump();
    }
  }

  /**
   * Drains queued jobs up to `maxConcurrentLessons` (used directly by tests too).
   */
  async waitUntilIdle(): Promise<void> {
    while (this.activeLessonIds.size > 0 || this.db.listJobs().some((j) => j.state === 'QUEUED')) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private schedulePump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      this.pumpQueue();
    });
  }

  private pumpQueue(): void {
    if (this.activeLessonIds.size >= this.config.maxConcurrentLessons) return;
    const queued = this.db
      .listJobs()
      .filter((j) => j.state === 'QUEUED')
      .reverse();

    for (const job of queued) {
      if (this.activeLessonIds.size >= this.config.maxConcurrentLessons) break;
      if (this.activeLessonIds.has(job.id)) continue;

      this.activeLessonIds.add(job.id);
      void this.runJob(job.id).finally(() => {
        this.activeLessonIds.delete(job.id);
        this.activeControllers.delete(job.id);
        this.speedByJob.delete(job.id);
        this.schedulePump();
      });
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(jobId, controller);

    const job = this.db.getJob(jobId);
    if (!job) return;
    const ctx = this.db.getLessonContext(job.lessonId);
    if (!ctx) {
      this.db.updateJobState(jobId, 'FAILED', 'LESSON_CONTEXT_MISSING');
      return;
    }

    try {
      // 1. Revalidate ownership before starting/resuming (RF-03, RF-04)
      this.db.updateJobState(jobId, 'VERIFYING_OWNERSHIP');
      this.emitProgressByJobId(jobId, true);

      const access = await this.ownership.verifyCourseAccess(ctx.course.id);
      if (!access.authorized) {
        this.ownership.revokeCourseDownloads(ctx.course.id, access.reason ?? 'REVOKED');
        this.emitProgressByJobId(jobId, true);
        return;
      }

      if (controller.signal.aborted) return;

      // 2. Inspect media manifest (RF-06, RF-07)
      this.db.updateJobState(jobId, 'INSPECTING_MEDIA');
      this.emitProgressByJobId(jobId, true);

      const session = this.auth.getDecryptedSession(ctx.account.id);
      if (!session) {
        this.db.updateJobState(jobId, 'PAUSED', 'SESSION_EXPIRED');
        this.emitProgressByJobId(jobId, true);
        return;
      }

      const adapter = this.adapters.get(ctx.account.platform);
      const descriptor = await adapter.resolveLessonMedia(
        session,
        ctx.course.externalCourseId,
        ctx.lesson.externalLessonId,
      );

      if (descriptor.kind === 'DRM_UNSUPPORTED') {
        this.db.setLessonAvailability(ctx.lesson.id, 'DRM_UNSUPPORTED');
        this.db.updateJobState(jobId, 'FAILED', 'DRM_UNSUPPORTED');
        this.emitProgressByJobId(jobId, true);
        return;
      }

      const plan = await this.inspector.inspect(descriptor, job.targetResolution);
      fs.mkdirSync(job.stagingDir, { recursive: true });
      this.writeSignedStagingManifest(jobId, job.stagingDir, plan);

      // Initialize checkpoints if not yet created; preserve already-downloaded checkpoints on resume (RNF-04)
      const existingCheckpoints = this.db.listSegmentCheckpoints(jobId);
      if (existingCheckpoints.length !== plan.segments.length) {
        if (existingCheckpoints.length > 0) {
          this.db.resetCheckpoints(jobId);
        }
        this.db.initSegmentCheckpoints(
          jobId,
          plan.segments.map((s) => ({ trackType: s.trackType, segmentIndex: s.segmentIndex })),
        );
      }

      this.db.updateJobState(jobId, 'DOWNLOADING', null, {
        streamType: plan.streamType,
        totalSegments: plan.segments.length,
        totalBytes: plan.estimatedTotalBytes,
      });
      this.emitProgressByJobId(jobId, true);

      // Download init segments once if present
      const initFiles = await this.downloadInitSegments(plan, job.stagingDir, controller.signal);

      // 3. Download remaining segments (RNF-04: skip already DOWNLOADED segments)
      const checkpointMap = new Map(
        this.db
          .listSegmentCheckpoints(jobId)
          .map((c) => [`${c.trackType}:${c.segmentIndex}`, c]),
      );

      const pendingTasks = plan.segments.filter((seg) => {
        const cp = checkpointMap.get(`${seg.trackType}:${seg.segmentIndex}`);
        if (!cp || cp.status !== 'DOWNLOADED') return true;
        const segFile = getSegmentFilePath(job.stagingDir, seg.trackType, seg.segmentIndex);
        return !fs.existsSync(segFile);
      });

      await this.downloadSegmentsConcurrently(
        jobId,
        ctx.module.id,
        ctx.course.id,
        job.stagingDir,
        plan,
        pendingTasks,
        controller.signal,
      );

      if (controller.signal.aborted) return;

      // 4. Remuxing + Watermark + Atomic promotion (RF-09, RF-11, RNF-02, RNF-03)
      this.db.updateJobState(jobId, 'REMUXING');
      this.emitProgressByJobId(jobId, true);

      const targetFilePath = buildStructuredLessonPath({
        libraryRootDir: this.config.getLibraryRootDir(),
        courseTitle: ctx.course.title,
        moduleOrder: ctx.module.orderIndex,
        lessonOrder: ctx.lesson.orderIndex,
        lessonTitle: ctx.lesson.title,
      });

      const videoCount = plan.segments.filter((s) => s.trackType === 'VIDEO').length;
      const audioCount = plan.segments.filter((s) => s.trackType === 'AUDIO').length;
      const muxedCount = plan.segments.filter((s) => s.trackType === 'MUXED').length;

      const remuxResult = await this.remuxer.remuxLesson({
        jobId,
        stagingDir: job.stagingDir,
        targetFilePath,
        streamType: plan.streamType,
        tracks: {
          hasSeparateAudio: videoCount > 0 && audioCount > 0,
          videoCount,
          audioCount,
          muxedCount,
          initFiles,
        },
        metadata: {
          courseTitle: ctx.course.title,
          moduleTitle: ctx.module.title,
          lessonTitle: ctx.lesson.title,
          platform: ctx.account.platform,
          accountEmailHash: ctx.account.emailHash,
          purchaseRef: access.purchaseRef ?? 'AUTHORIZED',
        },
      });

      this.db.saveWatermark(remuxResult.watermark);
      this.db.setLessonLocalFile(ctx.lesson.id, remuxResult.finalPath);
      this.db.updateJobState(jobId, 'COMPLETED', null);
      this.emitProgressByJobId(jobId, true);

      this.events.onJobCompleted?.({
        jobId,
        lessonId: ctx.lesson.id,
        localFilePath: remuxResult.finalPath,
      });
      this.emitModuleProgress(ctx.module.id, ctx.course.id);
    } catch (err) {
      const latest = this.db.getJob(jobId);
      if (!latest || latest.state === 'PAUSED' || latest.state === 'CANCELED' || latest.state === 'REVOKED') {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const isNetworkOrTransient =
        message.includes('NETWORK') ||
        message.includes('TIMEOUT') ||
        message.includes('ECONN') ||
        message.includes('HTTP_');

      this.db.updateJobState(
        jobId,
        isNetworkOrTransient ? 'PAUSED' : 'FAILED',
        message.slice(0, 180),
      );
      this.emitProgressByJobId(jobId, true);
    }
  }

  private async downloadInitSegments(
    plan: InspectedMediaPlan,
    stagingDir: string,
    signal: AbortSignal,
  ): Promise<Partial<Record<TrackType, string>>> {
    const initFiles: Partial<Record<TrackType, string>> = {};
    const seen = new Map<TrackType, string>();
    for (const seg of plan.segments) {
      if (seg.initSegmentUri && !seen.has(seg.trackType)) {
        seen.set(seg.trackType, seg.initSegmentUri);
      }
    }
    for (const [trackType, uri] of seen.entries()) {
      const target = path.join(stagingDir, `init_${trackType}.seg`);
      if (!fs.existsSync(target)) {
        const bytes = await this.fetchBytesWithRetry(uri, plan.headers, undefined, signal);
        fs.writeFileSync(target, bytes);
      }
      initFiles[trackType] = target;
    }
    return initFiles;
  }

  private async downloadSegmentsConcurrently(
    jobId: string,
    moduleId: string,
    courseId: string,
    stagingDir: string,
    plan: InspectedMediaPlan,
    tasks: SegmentDownloadTask[],
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = 0;
    const workerCount = Math.min(this.config.maxChunksPerLesson, Math.max(1, tasks.length));

    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < tasks.length) {
        if (signal.aborted) return;
        const task = tasks[cursor++];
        if (!task) return;

        let buf = await this.fetchBytesWithRetry(task.uri, plan.headers, task.byteRange, signal);
        if (task.hlsKey && task.hlsKey.method === 'AES-128' && task.hlsKey.uri) {
          const keyBytes = await this.getHlsKey(task.hlsKey.uri, plan.headers, signal);
          buf = await decryptAes128Buffer(buf, keyBytes, task.segmentIndex, task.hlsKey.iv);
        }

        if (signal.aborted) return;

        const segPath = getSegmentFilePath(stagingDir, task.trackType, task.segmentIndex);
        const partPath = `${segPath}.part`;
        fs.writeFileSync(partPath, buf);
        fs.renameSync(partPath, segPath);

        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        this.db.markSegmentDownloaded(jobId, task.trackType, task.segmentIndex, buf.length, hash);
        this.recordBytesForSpeed(jobId, buf.length);

        const updatedJob = this.db.getJob(jobId);
        if (updatedJob) {
          this.emitProgress(updatedJob, moduleId, courseId, false);
        }
      }
    });

    await Promise.all(workers);
  }

  private async getHlsKey(
    keyUri: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const cached = this.keyCache.get(keyUri);
    if (cached) return cached;
    const keyBuf = await this.fetchBytesWithRetry(keyUri, headers, undefined, signal);
    this.keyCache.set(keyUri, keyBuf);
    return keyBuf;
  }

  private async fetchBytesWithRetry(
    uri: string,
    baseHeaders: Record<string, string>,
    byteRange: { start: number; end: number } | undefined,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const headers: Record<string, string> = { ...baseHeaders };
    if (byteRange) {
      headers.Range = `bytes=${byteRange.start}-${byteRange.end}`;
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.config.maxSegmentRetries; attempt++) {
      if (signal.aborted) {
        throw new Error('ABORTED');
      }
      try {
        const res = await this.config.fetchFn(uri, { headers, signal });
        if (!res.ok) {
          throw new Error(`HTTP_${res.status}`);
        }
        const chunks: Buffer[] = [];
        if (res.body) {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              await this.limiter.consume(value.byteLength, signal);
              chunks.push(Buffer.from(value));
            }
          }
          return Buffer.concat(chunks);
        }
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        await this.limiter.consume(buf.length, signal);
        return buf;
      } catch (err) {
        lastErr = err;
        if (signal.aborted) throw new Error('ABORTED');
        if (attempt < this.config.maxSegmentRetries) {
          const jitter = Math.floor(Math.random() * 150);
          const backoffMs = Math.min(8000, 250 * 2 ** attempt) + jitter;
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`NETWORK_SEGMENT_FAILED:${reason}`);
  }

  private writeSignedStagingManifest(
    jobId: string,
    stagingDir: string,
    plan: InspectedMediaPlan,
  ): void {
    const payload = JSON.stringify({
      jobId,
      streamType: plan.streamType,
      selectedResolution: plan.selectedResolution,
      totalSegments: plan.segments.length,
    });
    const sig = this.secrets.signForLocalMachine(payload);
    fs.writeFileSync(
      path.join(stagingDir, 'manifest.lock.json'),
      JSON.stringify({ payload, machineSignature: sig }, null, 2),
    );
  }

  private recordBytesForSpeed(jobId: string, byteCount: number): void {
    const now = Date.now();
    const cur = this.speedByJob.get(jobId);
    if (!cur || now - cur.windowStartMs > 2000) {
      this.speedByJob.set(jobId, {
        bytes: byteCount,
        windowStartMs: now,
        bps: byteCount,
      });
    } else {
      cur.bytes += byteCount;
      const elapsedSec = Math.max(0.2, (now - cur.windowStartMs) / 1000);
      cur.bps = Math.round(cur.bytes / elapsedSec);
    }
  }

  private emitProgressByJobId(jobId: string, force: boolean): void {
    const job = this.db.getJob(jobId);
    if (!job) return;
    const ctx = this.db.getLessonContext(job.lessonId);
    if (!ctx) return;
    this.emitProgress(job, ctx.module.id, ctx.course.id, force);
  }

  private emitProgress(
    job: DownloadJobRecord,
    moduleId: string,
    courseId: string,
    force: boolean,
  ): void {
    const now = Date.now();
    const last = this.lastEmitByJob.get(job.id) ?? 0;
    if (!force && now - last < 250) {
      return;
    }
    this.lastEmitByJob.set(job.id, now);

    const percent =
      job.state === 'COMPLETED'
        ? 100
        : job.totalSegments > 0
          ? Math.min(99, Math.round((job.completedSegments / job.totalSegments) * 100))
          : 0;

    const bps = this.speedByJob.get(job.id)?.bps ?? 0;
    this.events.onJobProgress?.({
      jobId: job.id,
      lessonId: job.lessonId,
      moduleId,
      courseId,
      state: job.state,
      completedSegments: job.completedSegments,
      totalSegments: job.totalSegments,
      bytesPerSec: bps,
      etaSec: null,
      percent,
      errorCode: job.errorCode,
    });
  }

  private emitModuleProgress(moduleId: string, courseId: string): void {
    const tree = this.db.getCourseTreeDetails(courseId);
    const mod = tree?.modules.find((m) => m.id === moduleId);
    if (!mod) return;

    const totalLessons = mod.lessons.filter((l) => l.hasVideo).length;
    const completedLessons = mod.lessons.filter((l) => Boolean(l.localFilePath)).length;
    const overallPercent =
      totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

    this.events.onModuleProgress?.({
      moduleId,
      courseId,
      completedLessons,
      totalLessons,
      overallPercent,
    });
  }
}

export function getSegmentFilePath(
  stagingDir: string,
  trackType: TrackType,
  segmentIndex: number,
): string {
  const prefix = trackType === 'VIDEO' ? 'v' : trackType === 'AUDIO' ? 'a' : 'm';
  return path.join(stagingDir, `${prefix}_${String(segmentIndex).padStart(4, '0')}.seg`);
}

