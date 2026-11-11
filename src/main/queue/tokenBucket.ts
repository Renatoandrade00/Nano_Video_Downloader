/**
 * Global Token Bucket bandwidth limiter (RF-10) ensuring sub-second reactivity
 * when the user adjusts or removes the transfer rate cap.
 */
export class BandwidthLimiter {
  private bytesPerSec: number | null;
  private tokens: number;
  private lastRefillMs: number;

  constructor(bytesPerSec: number | null = null) {
    this.bytesPerSec = bytesPerSec && bytesPerSec > 0 ? bytesPerSec : null;
    this.tokens = this.bytesPerSec ?? Number.POSITIVE_INFINITY;
    this.lastRefillMs = Date.now();
  }

  setLimit(bytesPerSec: number | null): void {
    this.bytesPerSec = bytesPerSec && bytesPerSec > 0 ? bytesPerSec : null;
    this.lastRefillMs = Date.now();
    this.tokens = this.bytesPerSec ?? Number.POSITIVE_INFINITY;
  }

  getLimit(): number | null {
    return this.bytesPerSec;
  }

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.bytesPerSec === null || bytes <= 0) {
      return;
    }

    let remaining = bytes;
    while (remaining > 0) {
      if (signal?.aborted) {
        throw new Error('ABORTED');
      }
      if (this.bytesPerSec === null) {
        return;
      }

      this.refill();
      const burstCap = Math.max(this.bytesPerSec, 64 * 1024);
      if (this.tokens >= 1) {
        const take = Math.min(remaining, this.tokens, burstCap);
        this.tokens -= take;
        remaining -= take;
        if (remaining <= 0) return;
      }

      const rate = this.bytesPerSec;
      const needed = Math.min(remaining, burstCap);
      const waitMs = Math.min(250, Math.max(10, Math.ceil((needed / rate) * 1000)));
      await delayAbortable(waitMs, signal);
    }
  }

  private refill(): void {
    if (this.bytesPerSec === null) return;
    const now = Date.now();
    const elapsedSec = Math.max(0, (now - this.lastRefillMs) / 1000);
    this.lastRefillMs = now;
    const cap = Math.max(this.bytesPerSec, 64 * 1024);
    this.tokens = Math.min(cap, this.tokens + elapsedSec * this.bytesPerSec);
  }
}

function delayAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ABORTED'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

