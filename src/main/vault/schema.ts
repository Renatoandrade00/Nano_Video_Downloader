export const VAULT_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('hotmart', 'kiwify')),
    external_user_id TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    credential_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('CONNECTED', 'EXPIRED', 'DISCONNECTED')),
    last_verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_course_id TEXT NOT NULL,
    title TEXT NOT NULL,
    sanitized_folder TEXT NOT NULL,
    license_status TEXT NOT NULL CHECK (license_status IN ('AUTHORIZED', 'REVOKED')),
    license_checked_at TEXT NOT NULL,
    cover_local_path TEXT,
    UNIQUE(account_id, external_course_id)
);

CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    external_module_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    sanitized_folder TEXT NOT NULL,
    UNIQUE(course_id, external_module_id)
);

CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    external_lesson_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    has_video INTEGER NOT NULL DEFAULT 1,
    availability_status TEXT NOT NULL CHECK (availability_status IN ('AVAILABLE', 'LOCKED_DRIP', 'NO_VIDEO', 'DRM_UNSUPPORTED')),
    local_file_path TEXT,
    UNIQUE(module_id, external_lesson_id)
);

CREATE TABLE IF NOT EXISTS download_jobs (
    id TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
    target_resolution TEXT NOT NULL,
    stream_type TEXT CHECK (stream_type IN ('HLS', 'DASH', 'DIRECT')),
    state TEXT NOT NULL CHECK (state IN (
        'QUEUED', 'VERIFYING_OWNERSHIP', 'INSPECTING_MEDIA',
        'DOWNLOADING', 'PAUSED', 'REMUXING', 'COMPLETED', 'FAILED', 'REVOKED', 'CANCELED'
    )),
    total_segments INTEGER NOT NULL DEFAULT 0,
    completed_segments INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    staging_dir TEXT NOT NULL,
    error_code TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segment_checkpoints (
    job_id TEXT NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
    track_type TEXT NOT NULL CHECK (track_type IN ('VIDEO', 'AUDIO', 'MUXED')),
    segment_index INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'DOWNLOADED')),
    byte_size INTEGER NOT NULL DEFAULT 0,
    checksum_sha256 TEXT,
    PRIMARY KEY (job_id, track_type, segment_index)
);

CREATE TABLE IF NOT EXISTS playback_progress (
    lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    last_position_sec INTEGER NOT NULL DEFAULT 0,
    playback_speed REAL NOT NULL DEFAULT 1.0,
    is_watched INTEGER NOT NULL DEFAULT 0,
    watched_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_watermarks (
    job_id TEXT PRIMARY KEY REFERENCES download_jobs(id) ON DELETE CASCADE,
    watermark_id TEXT NOT NULL,
    account_hash TEXT NOT NULL,
    purchase_ref TEXT NOT NULL,
    machine_signature TEXT NOT NULL,
    stamped_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON download_jobs(state);
CREATE INDEX IF NOT EXISTS idx_checkpoints_pending ON segment_checkpoints(job_id, status);
`;

