export class TokenBucket {
  private tokens: number;
  private lastRefillMs = Date.now();

  public constructor(
    private readonly requestsPerSecond: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
  }

  public async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(25, Math.ceil((1 - this.tokens) / this.requestsPerSecond * 1000));
      await waitFor(waitMs, signal);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.requestsPerSecond);
    this.lastRefillMs = now;
  }
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}
