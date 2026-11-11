const ALLOWED_WEB_PROTOCOLS = new Set([
  'http:',
  'https:',
  'about:',
  'blob:',
  'data:',
  'file:',
  'antigravity-media:',
]);

/**
 * Allows only safe web/internal protocols and blocks external OS schemes
 * such as `sslocal://`, `intent://`, `mailto:`, etc. that trigger OS app-picker prompts.
 */
export function isAllowedWebUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_WEB_PROTOCOLS.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

