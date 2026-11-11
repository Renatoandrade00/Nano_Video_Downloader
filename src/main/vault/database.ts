import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AccountRecord,
  AccountStatus,
  AppSettings,
  AuditWatermarkRecord,
  CourseRecord,
  CourseTreeDetails,
  DownloadJobRecord,
  JobState,
  LessonAvailability,
  LessonRecord,
  LessonWithProgress,
  LicenseStatus,
  ModuleRecord,
  ModuleWithLessons,
  PlaybackProgressRecord,
  ResolutionOption,
  SegmentCheckpointRecord,
  SegmentStatus,
  StreamType,
  TrackType,
} from '../../shared/types';
import { VAULT_SCHEMA_SQL } from './schema';

export class VaultDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(VAULT_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // --- Accounts ---

  upsertAccount(account: AccountRecord): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, platform, external_user_id, email_hash, credential_ref, status, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           external_user_id = excluded.external_user_id,
           email_hash = excluded.email_hash,
           credential_ref = excluded.credential_ref,
           status = excluded.status,
           last_verified_at = excluded.last_verified_at`,
      )
      .run(
        account.id,
        account.platform,
        account.externalUserId,
        account.emailHash,
        account.credentialRef,
        account.status,
        account.lastVerifiedAt,
      );
  }

  listAccounts(): AccountRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY platform ASC, last_verified_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapAccount);
  }

  getAccount(accountId: string): AccountRecord | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapAccount(row) : null;
  }

  updateAccountStatus(accountId: string, status: AccountStatus, verifiedAt: string): void {
    this.db
      .prepare('UPDATE accounts SET status = ?, last_verified_at = ? WHERE id = ?')
      .run(status, verifiedAt, accountId);
  }

  deleteAccount(accountId: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  }

  // --- Courses, Modules, Lessons ---

  upsertCourse(course: CourseRecord): void {
    this.db
      .prepare(
        `INSERT INTO courses (id, account_id, external_course_id, title, sanitized_folder, license_status, license_checked_at, cover_local_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, external_course_id) DO UPDATE SET
           title = excluded.title,
           sanitized_folder = excluded.sanitized_folder,
           license_status = excluded.license_status,
           license_checked_at = excluded.license_checked_at,
           cover_local_path = COALESCE(excluded.cover_local_path, courses.cover_local_path)`,
      )
      .run(
        course.id,
        course.accountId,
        course.externalCourseId,
        course.title,
        course.sanitizedFolder,
        course.licenseStatus,
        course.licenseCheckedAt,
        course.coverLocalPath,
      );
  }

  getCourse(courseId: string): CourseRecord | null {
    const row = this.db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapCourse(row) : null;
  }

  getCourseByExternal(accountId: string, externalCourseId: string): CourseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM courses WHERE account_id = ? AND external_course_id = ?')
      .get(accountId, externalCourseId) as Record<string, unknown> | undefined;
    return row ? mapCourse(row) : null;
  }

  listCoursesByAccount(accountId: string): CourseRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM courses WHERE account_id = ? ORDER BY title ASC')
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(mapCourse);
  }

  listAllCourses(): CourseRecord[] {
    const rows = this.db.prepare('SELECT * FROM courses ORDER BY title ASC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map(mapCourse);
  }

  updateCourseLicense(courseId: string, licenseStatus: LicenseStatus, checkedAt: string): void {
    this.db
      .prepare('UPDATE courses SET license_status = ?, license_checked_at = ? WHERE id = ?')
      .run(licenseStatus, checkedAt, courseId);
  }

  upsertCourseTree(
    courseId: string,
    modules: Array<{
      module: ModuleRecord;
      lessons: LessonRecord[];
    }>,
  ): void {
    this.runInTransaction(() => {
      const modStmt = this.db.prepare(
        `INSERT INTO modules (id, course_id, external_module_id, order_index, title, sanitized_folder)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(course_id, external_module_id) DO UPDATE SET
           order_index = excluded.order_index,
           title = excluded.title,
           sanitized_folder = excluded.sanitized_folder`,
      );
      const lessonStmt = this.db.prepare(
        `INSERT INTO lessons (id, module_id, external_lesson_id, order_index, title, duration_sec, has_video, availability_status, local_file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(module_id, external_lesson_id) DO UPDATE SET
           order_index = excluded.order_index,
           title = excluded.title,
           duration_sec = excluded.duration_sec,
           has_video = excluded.has_video,
           availability_status = excluded.availability_status,
           local_file_path = COALESCE(lessons.local_file_path, excluded.local_file_path)`,
      );

      for (const item of modules) {
        modStmt.run(
          item.module.id,
          courseId,
          item.module.externalModuleId,
          item.module.orderIndex,
          item.module.title,
          item.module.sanitizedFolder,
        );
        const existingMod = this.db
          .prepare('SELECT id FROM modules WHERE course_id = ? AND external_module_id = ?')
          .get(courseId, item.module.externalModuleId) as { id: string };

        for (const lesson of item.lessons) {
          lessonStmt.run(
            lesson.id,
            existingMod.id,
            lesson.externalLessonId,
            lesson.orderIndex,
            lesson.title,
            lesson.durationSec,
            lesson.hasVideo ? 1 : 0,
            lesson.availabilityStatus,
            lesson.localFilePath,
          );
        }
      }
    });
  }

  getCourseTreeDetails(courseId: string): CourseTreeDetails | null {
    const course = this.getCourse(courseId);
    if (!course) return null;

    const moduleRows = this.db
      .prepare('SELECT * FROM modules WHERE course_id = ? ORDER BY order_index ASC')
      .all(courseId) as Array<Record<string, unknown>>;

    const modules: ModuleWithLessons[] = moduleRows.map((modRow) => {
      const mod = mapModule(modRow);
      const lessonRows = this.db
        .prepare('SELECT * FROM lessons WHERE module_id = ? ORDER BY order_index ASC')
        .all(mod.id) as Array<Record<string, unknown>>;

      const lessons: LessonWithProgress[] = lessonRows.map((lRow) => {
        const lesson = mapLesson(lRow);
        const progress = this.getPlaybackProgress(lesson.id);
        const job = this.getJobByLessonId(lesson.id);
        return { ...lesson, progress, job };
      });

      return { ...mod, lessons };
    });

    return { course, modules };
  }

  listOfflineCourses(): CourseTreeDetails[] {
    const courses = this.listAllCourses();
    const result: CourseTreeDetails[] = [];
    for (const course of courses) {
      const details = this.getCourseTreeDetails(course.id);
      if (!details) continue;
      const hasOfflineLesson = details.modules.some((m) =>
        m.lessons.some((l) => Boolean(l.localFilePath)),
      );
      if (hasOfflineLesson) {
        const filteredModules = details.modules
          .map((m) => ({
            ...m,
            lessons: m.lessons.filter((l) => Boolean(l.localFilePath)),
          }))
          .filter((m) => m.lessons.length > 0);
        result.push({ course: details.course, modules: filteredModules });
      }
    }
    return result;
  }

  getLessonContext(lessonId: string): {
    lesson: LessonRecord;
    module: ModuleRecord;
    course: CourseRecord;
    account: AccountRecord;
  } | null {
    const lRow = this.db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId) as
      | Record<string, unknown>
      | undefined;
    if (!lRow) return null;
    const lesson = mapLesson(lRow);

    const mRow = this.db.prepare('SELECT * FROM modules WHERE id = ?').get(lesson.moduleId) as
      | Record<string, unknown>
      | undefined;
    if (!mRow) return null;
    const mod = mapModule(mRow);

    const course = this.getCourse(mod.courseId);
    if (!course) return null;

    const account = this.getAccount(course.accountId);
    if (!account) return null;

    return { lesson, module: mod, course, account };
  }

  setLessonLocalFile(lessonId: string, localFilePath: string | null): void {
    this.db
      .prepare('UPDATE lessons SET local_file_path = ? WHERE id = ?')
      .run(localFilePath, lessonId);
  }

  setLessonAvailability(lessonId: string, availability: LessonAvailability): void {
    this.db
      .prepare('UPDATE lessons SET availability_status = ? WHERE id = ?')
      .run(availability, lessonId);
  }

  // --- Download Jobs & Segment Checkpoints ---

  upsertJob(job: DownloadJobRecord): void {
    this.db
      .prepare(
        `INSERT INTO download_jobs (
           id, lesson_id, target_resolution, stream_type, state,
           total_segments, completed_segments, total_bytes, downloaded_bytes,
           staging_dir, error_code, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lesson_id) DO UPDATE SET
           target_resolution = excluded.target_resolution,
           stream_type = excluded.stream_type,
           state = excluded.state,
           total_segments = excluded.total_segments,
           completed_segments = excluded.completed_segments,
           total_bytes = excluded.total_bytes,
           downloaded_bytes = excluded.downloaded_bytes,
           staging_dir = excluded.staging_dir,
           error_code = excluded.error_code,
           updated_at = excluded.updated_at`,
      )
      .run(
        job.id,
        job.lessonId,
        job.targetResolution,
        job.streamType,
        job.state,
        job.totalSegments,
        job.completedSegments,
        job.totalBytes,
        job.downloadedBytes,
        job.stagingDir,
        job.errorCode,
        job.updatedAt,
      );
  }

  getJob(jobId: string): DownloadJobRecord | null {
    const row = this.db.prepare('SELECT * FROM download_jobs WHERE id = ?').get(jobId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapJob(row) : null;
  }

  getJobByLessonId(lessonId: string): DownloadJobRecord | null {
    const row = this.db.prepare('SELECT * FROM download_jobs WHERE lesson_id = ?').get(lessonId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapJob(row) : null;
  }

  listJobs(): DownloadJobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM download_jobs ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapJob);
  }

  listJobsByCourse(courseId: string): DownloadJobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT dj.* FROM download_jobs dj
         JOIN lessons l ON l.id = dj.lesson_id
         JOIN modules m ON m.id = l.module_id
         WHERE m.course_id = ?`,
      )
      .all(courseId) as Array<Record<string, unknown>>;
    return rows.map(mapJob);
  }

  updateJobState(
    jobId: string,
    state: JobState,
    errorCode: string | null = null,
    extra?: Partial<Pick<DownloadJobRecord, 'streamType' | 'totalSegments' | 'completedSegments' | 'totalBytes' | 'downloadedBytes'>>,
  ): void {
    const now = new Date().toISOString();
    const current = this.getJob(jobId);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE download_jobs SET
           state = ?,
           error_code = ?,
           stream_type = ?,
           total_segments = ?,
           completed_segments = ?,
           total_bytes = ?,
           downloaded_bytes = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        errorCode,
        extra?.streamType ?? current.streamType,
        extra?.totalSegments ?? current.totalSegments,
        extra?.completedSegments ?? current.completedSegments,
        extra?.totalBytes ?? current.totalBytes,
        extra?.downloadedBytes ?? current.downloadedBytes,
        now,
        jobId,
      );
  }

  initSegmentCheckpoints(
    jobId: string,
    segments: Array<{ trackType: TrackType; segmentIndex: number }>,
  ): void {
    this.runInTransaction(() => {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO segment_checkpoints (job_id, track_type, segment_index, status, byte_size, checksum_sha256)
         VALUES (?, ?, ?, 'PENDING', 0, NULL)`,
      );
      for (const seg of segments) {
        stmt.run(jobId, seg.trackType, seg.segmentIndex);
      }
      const counts = this.getSegmentCounts(jobId);
      this.db
        .prepare(
          'UPDATE download_jobs SET total_segments = ?, completed_segments = ?, updated_at = ? WHERE id = ?',
        )
        .run(counts.total, counts.completed, new Date().toISOString(), jobId);
    });
  }

  markSegmentDownloaded(
    jobId: string,
    trackType: TrackType,
    segmentIndex: number,
    byteSize: number,
    checksumSha256: string,
  ): { completed: number; total: number; downloadedBytes: number } {
    return this.runInTransaction(() => {
      this.db
        .prepare(
          `UPDATE segment_checkpoints
           SET status = 'DOWNLOADED', byte_size = ?, checksum_sha256 = ?
           WHERE job_id = ? AND track_type = ? AND segment_index = ?`,
        )
        .run(byteSize, checksumSha256, jobId, trackType, segmentIndex);

      const counts = this.getSegmentCounts(jobId);
      this.db
        .prepare(
          `UPDATE download_jobs
           SET completed_segments = ?, downloaded_bytes = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(counts.completed, counts.downloadedBytes, new Date().toISOString(), jobId);

      return counts;
    });
  }

  listSegmentCheckpoints(jobId: string): SegmentCheckpointRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM segment_checkpoints WHERE job_id = ? ORDER BY track_type ASC, segment_index ASC',
      )
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      jobId: String(r.job_id),
      trackType: r.track_type as TrackType,
      segmentIndex: Number(r.segment_index),
      status: r.status as SegmentStatus,
      byteSize: Number(r.byte_size),
      checksumSha256: r.checksum_sha256 ? String(r.checksum_sha256) : null,
    }));
  }

  resetCheckpoints(jobId: string): void {
    this.db.prepare('DELETE FROM segment_checkpoints WHERE job_id = ?').run(jobId);
  }

  private getSegmentCounts(jobId: string): {
    total: number;
    completed: number;
    downloadedBytes: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'DOWNLOADED' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(CASE WHEN status = 'DOWNLOADED' THEN byte_size ELSE 0 END), 0) AS downloaded_bytes
         FROM segment_checkpoints WHERE job_id = ?`,
      )
      .get(jobId) as { total: number; completed: number; downloaded_bytes: number };
    return {
      total: Number(row.total),
      completed: Number(row.completed),
      downloadedBytes: Number(row.downloaded_bytes),
    };
  }

  // --- Playback Progress ---

  getPlaybackProgress(lessonId: string): PlaybackProgressRecord | null {
    const row = this.db
      .prepare('SELECT * FROM playback_progress WHERE lesson_id = ?')
      .get(lessonId) as Record<string, unknown> | undefined;
    return row ? mapProgress(row) : null;
  }

  savePlaybackProgress(
    lessonId: string,
    positionSec: number,
    speed: number,
    isWatched: boolean,
  ): PlaybackProgressRecord {
    const now = new Date().toISOString();
    const existing = this.getPlaybackProgress(lessonId);
    const finalWatched = existing?.isWatched ? true : isWatched;
    const watchedAt = finalWatched ? existing?.watchedAt ?? now : null;

    this.db
      .prepare(
        `INSERT INTO playback_progress (lesson_id, last_position_sec, playback_speed, is_watched, watched_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lesson_id) DO UPDATE SET
           last_position_sec = excluded.last_position_sec,
           playback_speed = excluded.playback_speed,
           is_watched = excluded.is_watched,
           watched_at = excluded.watched_at,
           updated_at = excluded.updated_at`,
      )
      .run(lessonId, Math.max(0, Math.floor(positionSec)), speed, finalWatched ? 1 : 0, watchedAt, now);

    return this.getPlaybackProgress(lessonId)!;
  }

  setWatchedExplicit(lessonId: string, watched: boolean): PlaybackProgressRecord {
    const now = new Date().toISOString();
    const existing = this.getPlaybackProgress(lessonId);
    const pos = existing?.lastPositionSec ?? 0;
    const speed = existing?.playbackSpeed ?? 1.0;
    const watchedAt = watched ? existing?.watchedAt ?? now : null;

    this.db
      .prepare(
        `INSERT INTO playback_progress (lesson_id, last_position_sec, playback_speed, is_watched, watched_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lesson_id) DO UPDATE SET
           is_watched = excluded.is_watched,
           watched_at = excluded.watched_at,
           updated_at = excluded.updated_at`,
      )
      .run(lessonId, pos, speed, watched ? 1 : 0, watchedAt, now);

    return this.getPlaybackProgress(lessonId)!;
  }

  // --- Audit Watermarks ---

  saveWatermark(record: AuditWatermarkRecord): void {
    this.db
      .prepare(
        `INSERT INTO audit_watermarks (job_id, watermark_id, account_hash, purchase_ref, machine_signature, stamped_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           watermark_id = excluded.watermark_id,
           account_hash = excluded.account_hash,
           purchase_ref = excluded.purchase_ref,
           machine_signature = excluded.machine_signature,
           stamped_at = excluded.stamped_at`,
      )
      .run(
        record.jobId,
        record.watermarkId,
        record.accountHash,
        record.purchaseRef,
        record.machineSignature,
        record.stampedAt,
      );
  }

  getWatermarkByJobId(jobId: string): AuditWatermarkRecord | null {
    const row = this.db
      .prepare('SELECT * FROM audit_watermarks WHERE job_id = ?')
      .get(jobId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      jobId: String(row.job_id),
      watermarkId: String(row.watermark_id),
      accountHash: String(row.account_hash),
      purchaseRef: String(row.purchase_ref),
      machineSignature: String(row.machine_signature),
      stampedAt: String(row.stamped_at),
    };
  }

  // --- Settings ---

  getSettings(defaultSettings: AppSettings): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      libraryRootDir: map.get('libraryRootDir') ?? defaultSettings.libraryRootDir,
      bandwidthLimitBytesPerSec: map.has('bandwidthLimitBytesPerSec')
        ? (JSON.parse(map.get('bandwidthLimitBytesPerSec')!) as number | null)
        : defaultSettings.bandwidthLimitBytesPerSec,
      defaultResolution:
        (map.get('defaultResolution') as ResolutionOption | undefined) ??
        defaultSettings.defaultResolution,
    };
  }

  saveSetting(key: keyof AppSettings, value: unknown): void {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, serialized);
  }

  private runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function mapAccount(row: Record<string, unknown>): AccountRecord {
  return {
    id: String(row.id),
    platform: row.platform as AccountRecord['platform'],
    externalUserId: String(row.external_user_id),
    emailHash: String(row.email_hash),
    credentialRef: String(row.credential_ref),
    status: row.status as AccountStatus,
    lastVerifiedAt: String(row.last_verified_at),
  };
}

function mapCourse(row: Record<string, unknown>): CourseRecord {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    externalCourseId: String(row.external_course_id),
    title: String(row.title),
    sanitizedFolder: String(row.sanitized_folder),
    licenseStatus: row.license_status as LicenseStatus,
    licenseCheckedAt: String(row.license_checked_at),
    coverLocalPath: row.cover_local_path ? String(row.cover_local_path) : null,
  };
}

function mapModule(row: Record<string, unknown>): ModuleRecord {
  return {
    id: String(row.id),
    courseId: String(row.course_id),
    externalModuleId: String(row.external_module_id),
    orderIndex: Number(row.order_index),
    title: String(row.title),
    sanitizedFolder: String(row.sanitized_folder),
  };
}

function mapLesson(row: Record<string, unknown>): LessonRecord {
  return {
    id: String(row.id),
    moduleId: String(row.module_id),
    externalLessonId: String(row.external_lesson_id),
    orderIndex: Number(row.order_index),
    title: String(row.title),
    durationSec: Number(row.duration_sec),
    hasVideo: Number(row.has_video) === 1,
    availabilityStatus: row.availability_status as LessonAvailability,
    localFilePath: row.local_file_path ? String(row.local_file_path) : null,
  };
}

function mapJob(row: Record<string, unknown>): DownloadJobRecord {
  return {
    id: String(row.id),
    lessonId: String(row.lesson_id),
    targetResolution: row.target_resolution as ResolutionOption,
    streamType: row.stream_type ? (row.stream_type as StreamType) : null,
    state: row.state as JobState,
    totalSegments: Number(row.total_segments),
    completedSegments: Number(row.completed_segments),
    totalBytes: Number(row.total_bytes),
    downloadedBytes: Number(row.downloaded_bytes),
    stagingDir: String(row.staging_dir),
    errorCode: row.error_code ? String(row.error_code) : null,
    updatedAt: String(row.updated_at),
  };
}

function mapProgress(row: Record<string, unknown>): PlaybackProgressRecord {
  return {
    lessonId: String(row.lesson_id),
    lastPositionSec: Number(row.last_position_sec),
    playbackSpeed: Number(row.playback_speed),
    isWatched: Number(row.is_watched) === 1,
    watchedAt: row.watched_at ? String(row.watched_at) : null,
    updatedAt: String(row.updated_at),
  };
}

