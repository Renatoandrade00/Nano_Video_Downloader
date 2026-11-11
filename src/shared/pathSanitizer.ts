import path from 'node:path';

const INVALID_FS_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const DEFAULT_MAX_FILENAME_LEN = 120;
const SAFE_MAX_FULL_PATH_LEN = 240;

/**
 * Sanitizes a single filesystem segment (folder or filename stem) deterministically
 * across Windows, macOS, and Linux.
 */
export function sanitizeSegment(raw: string, fallback = 'Item', maxLen = DEFAULT_MAX_FILENAME_LEN): string {
  const normalized = raw
    .normalize('NFC')
    .replace(INVALID_FS_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  let safe = normalized.length > 0 ? normalized : fallback;
  if (WINDOWS_RESERVED_NAMES.test(safe)) {
    safe = `_${safe}`;
  }
  if (safe.length > maxLen) {
    safe = safe.slice(0, maxLen).replace(/[. ]+$/g, '').trim();
  }
  return safe.length > 0 ? safe : fallback;
}

export function padTwoDigits(index: number): string {
  const positive = Math.max(1, Math.floor(index));
  return String(positive).padStart(2, '0');
}

export function formatCourseFolder(courseTitle: string): string {
  return sanitizeSegment(courseTitle, 'Curso', 90);
}

export function formatModuleFolder(moduleOrder: number): string {
  return `Modulo_${padTwoDigits(moduleOrder)}`;
}

export function formatLessonFileName(lessonOrder: number, lessonTitle: string, maxStemLength = 120): string {
  const prefix = `Aula_${padTwoDigits(lessonOrder)} - `;
  const availableTitleLen = Math.max(12, maxStemLength - prefix.length);
  const safeTitle = sanitizeSegment(lessonTitle, 'Aula', availableTitleLen);
  return `${prefix}${safeTitle}.mp4`;
}

export interface LessonPathInput {
  libraryRootDir: string;
  courseTitle: string;
  moduleOrder: number;
  lessonOrder: number;
  lessonTitle: string;
}

/**
 * Builds the structured local path required by RF-11:
 * /{Nome_Curso}/{Modulo_XX}/{Aula_YY - Titulo}.mp4
 * Ensures the full path stays within Windows-safe length limits by trimming the lesson title if needed.
 */
export function buildStructuredLessonPath(input: LessonPathInput): string {
  const courseFolder = formatCourseFolder(input.courseTitle);
  const moduleFolder = formatModuleFolder(input.moduleOrder);
  const baseDir = path.join(input.libraryRootDir, courseFolder, moduleFolder);

  const overhead = baseDir.length + 1 + '.mp4'.length;
  const maxStemAllowed = Math.max(24, Math.min(120, SAFE_MAX_FULL_PATH_LEN - overhead));
  const fileName = formatLessonFileName(input.lessonOrder, input.lessonTitle, maxStemAllowed);

  return path.join(baseDir, fileName);
}

