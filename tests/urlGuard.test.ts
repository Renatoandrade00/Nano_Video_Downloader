import { describe, expect, it } from 'vitest';
import { isAllowedWebUrl } from '../src/shared/urlGuard';

describe('urlGuard (WebBridge external protocol blocker)', () => {
  it('blocks custom OS schemes like sslocal:// and intent://', () => {
    expect(isAllowedWebUrl('sslocal://open')).toBe(false);
    expect(isAllowedWebUrl('intent://login#Intent')).toBe(false);
    expect(isAllowedWebUrl('hotmart://launch')).toBe(false);
    expect(isAllowedWebUrl('mailto:user@example.com')).toBe(false);
    expect(isAllowedWebUrl('not-a-valid-url')).toBe(false);
  });

  it('allows standard HTTP(S), internal file, and antigravity-media URLs', () => {
    expect(isAllowedWebUrl('https://sso.hotmart.com/login')).toBe(true);
    expect(isAllowedWebUrl('http://localhost:5173')).toBe(true);
    expect(isAllowedWebUrl('about:blank')).toBe(true);
    expect(isAllowedWebUrl('antigravity-media://lesson/l1')).toBe(true);
  });
});

