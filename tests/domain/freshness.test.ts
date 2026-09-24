import { describe, expect, it } from "vitest";
import {
  computeFreshness,
  InstrumentSchema,
  QuoteSchema,
} from "@invest/domain";

const instrument = InstrumentSchema.parse({
  id: "btc-usd",
  assetClass: "crypto",
  symbol: "BTC/USD",
  displayName: "Bitcoin",
  venue: "aggregate",
  baseAsset: "BTC",
  quoteAsset: "USD",
  precision: { priceScale: 2, quantityScale: 8 },
  underlyingId: null,
  metadata: {},
});

describe("clock-skew-aware freshness", () => {
  it("uses receivedAt and downgrades authoritative quality for a future capturedAt", () => {
    const receivedAt = "2026-08-23T00:00:00.000Z";
    const capturedAt = "2026-08-23T00:00:30.000Z";
    const freshness = computeFreshness(
      capturedAt,
      receivedAt,
      120,
      new Date(receivedAt),
      "realtime",
      2_000,
    );
    const quote = QuoteSchema.parse({
      instrumentId: instrument.id,
      sourceId: "binance-vision",
      providerSymbol: "BTCUSDT",
      price: "100",
      bid: null,
      ask: null,
      mid: null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      previousClose: null,
      volume: null,
      quoteAsset: "USD",
      convertedTo: null,
      capturedAt,
      receivedAt,
      freshness,
      quality: "authoritative",
      rawRef: null,
    });

    expect(quote.freshness.clockSkewMs).toBe(30_000);
    expect(quote.freshness.skewSuspected).toBe(true);
    expect(quote.freshness.freshnessBasis).toBe("receivedAt");
    expect(quote.quality).toBe("indicative");
  });

  it("keeps the normal capturedAt basis when provider time is behind receipt", () => {
    const capturedAt = "2026-08-23T00:00:00.000Z";
    const receivedAt = "2026-08-23T00:00:01.000Z";
    const freshness = computeFreshness(
      capturedAt,
      receivedAt,
      120,
      new Date("2026-08-23T00:00:02.000Z"),
      "realtime",
      2_000,
    );

    expect(freshness.clockSkewMs).toBe(-1_000);
    expect(freshness.skewSuspected).toBe(false);
    expect(freshness.freshnessBasis).toBe("capturedAt");
    expect(freshness.isStale).toBe(false);
    expect(freshness.status).toBe("live");

    const quote = QuoteSchema.parse({
      instrumentId: instrument.id,
      sourceId: "binance-vision",
      providerSymbol: "BTCUSDT",
      price: "100",
      bid: null,
      ask: null,
      mid: null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      previousClose: null,
      volume: null,
      quoteAsset: "USD",
      convertedTo: null,
      capturedAt,
      receivedAt,
      freshness,
      quality: "authoritative",
      rawRef: null,
    });
    expect(quote.quality).toBe("authoritative");
  });

  it("marks a source stale after staleAfterSeconds even when capturedAt is 30 seconds in the future", () => {
    const freshness = computeFreshness(
      "2026-08-23T00:00:30.000Z",
      "2026-08-23T00:00:00.000Z",
      120,
      new Date("2026-08-23T00:02:01.000Z"),
      "realtime",
      2_000,
    );

    expect(freshness.freshnessBasis).toBe("receivedAt");
    expect(freshness.isStale).toBe(true);
    expect(freshness.status).toBe("stale");
  });
});
