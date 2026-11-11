import { describe, expect, it } from 'vitest';
import { BandwidthLimiter } from '../src/main/queue/tokenBucket';

describe('BandwidthLimiter (RF-10)', () => {
  it('throttles consumption when limited and releases immediately when set to unlimited', async () => {
    const limiter = new BandwidthLimiter(64 * 1024); // 64 KB/s
    const start = Date.now();
    await limiter.consume(64 * 1024); // initial bucket burst
    await limiter.consume(32 * 1024); // requires ~500ms refill
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);

    limiter.setLimit(null);
    const fastStart = Date.now();
    await limiter.consume(10 * 1024 * 1024);
    expect(Date.now() - fastStart).toBeLessThan(50);
  });
});

