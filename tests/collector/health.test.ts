import { describe, expect, it } from "vitest";
import { SourceErrorSchema } from "@invest/domain";
import { HealthTracker } from "@invest/collector";

describe("source clock skew health", () => {
  it("keeps a rolling per-source median and raises an explicit skew status", () => {
    const tracker = new HealthTracker(2_000);
    const first = tracker.recordSuccess("binance-vision", "quote", 10, 30_000);
    const second = tracker.recordSuccess("binance-vision", "candle", 12, 31_000);

    expect(first.clockSkewMedianMs).toBe(30_000);
    expect(second.clockSkewMedianMs).toBe(30_500);
    expect(second.clockSkewStatus).toBe("suspected");
    expect(second.clockSkewToleranceMs).toBe(2_000);
  });

  it("retains the last offset observation across a failed request", () => {
    const tracker = new HealthTracker(2_000);
    tracker.recordSuccess("gold-api", "quote", 10, 30_000);
    const error = SourceErrorSchema.parse({
      kind: "timeout",
      sourceId: "gold-api",
      capability: "quote",
      message: "timeout",
      httpStatus: null,
      retryable: true,
      retryAfterSeconds: null,
      requestId: "health-test",
      observedAt: "2026-08-23T00:00:00.000Z",
      causeCode: null,
    });

    const health = tracker.recordFailure("gold-api", "quote", error);
    expect(health.clockSkewMedianMs).toBe(30_000);
    expect(health.clockSkewStatus).toBe("suspected");
  });
});
