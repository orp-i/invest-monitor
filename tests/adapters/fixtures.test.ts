import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  binanceVisionAdapter,
  coinGeckoAdapter,
  goldApiAdapter,
  massiveStocksAdapter,
  type AdapterContext,
} from "@invest/adapters";
import { CandleSchema, InstrumentSchema, SourceBindingSchema, SourceErrorSchema, SourceId, SourceBindingSchema as BindingSchema } from "@invest/domain";
import { SourceConfigSchema } from "@invest/config";

async function fixture(name: string): Promise<Uint8Array> {
  return new TextEncoder().encode(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

function context(
  sourceId: "coingecko" | "binance-vision" | "gold-api",
  capability: "quote" | "candle",
  providerSymbol: string,
  quoteAsset: string,
): AdapterContext {
  const source = SourceConfigSchema.parse({
    id: sourceId,
    adapter: sourceId,
    baseUrl: "https://example.invalid",
    authRef: null,
    egressProfile: "corp",
    userAgent: "fixture-test",
    followRedirects: true,
    capabilities: capability === "quote" ? ["quote", "candle"] : ["quote", "candle"],
    params: sourceId === "coingecko"
      ? { vsCurrency: "usd", days: 1 }
      : sourceId === "binance-vision"
        ? { interval: "1m", limit: 10 }
        : { metal: "XAU", quoteAsset: "USD", unit: "troy_ounce" },
    rateLimit: { requestsPerSecond: 1, burst: 1, quotaPerDay: null, retryAfterHeader: true },
    enabled: true,
  });
  const binding = BindingSchema.parse({
    sourceId,
    instrumentId: sourceId === "gold-api" ? "xau-usd" : "btc-usd",
    enabled: true,
    priority: 1,
    capabilities: capability === "quote" ? ["quote", "candle"] : ["quote", "candle"],
    providerSymbol,
    quoteAsset,
    conversion: null,
    params: sourceId === "gold-api" ? { metal: "XAU", quoteAsset: "USD", unit: "troy_ounce" } : {},
    cadenceSeconds: 30,
    staleAfterSeconds: 120,
    egressProfile: "corp",
  });
  const instrument = InstrumentSchema.parse({
    id: binding.instrumentId,
    assetClass: sourceId === "gold-api" ? "preciousMetal" : "crypto",
    symbol: sourceId === "gold-api" ? "XAU/USD" : "BTC/USD",
    displayName: sourceId === "gold-api" ? "Gold" : "Bitcoin",
    venue: null,
    baseAsset: sourceId === "gold-api" ? "XAU" : "BTC",
    quoteAsset: "USD",
    contractMultiplier: "1",
    underlyingId: null,
    precision: { priceScale: 2, quantityScale: 8 },
    tags: [],
    active: true,
    metadata: {},
  });
  return {
    source,
    binding,
    instrument,
    httpClient: {} as AdapterContext["httpClient"],
    authToken: null,
    now: "2026-08-22T14:25:00.000Z",
    clockSkewToleranceMs: 2_000,
    requestId: `fixture-${sourceId}-${capability}`,
    capability,
  };
}

function massiveContext(capability: "quote" | "candle"): AdapterContext {
  const source = SourceConfigSchema.parse({
    id: capability === "quote" ? "massive-stocks" : "massive-stocks-history",
    adapter: "massive-stocks",
    baseUrl: "https://api.massive.com",
    authRef: "env:MASSIVE_API_KEY",
    egressProfile: "corp",
    userAgent: "fixture-test",
    followRedirects: true,
    capabilities: [capability],
    params: { adjusted: true, timeframe: "1d", historyYears: 5, limit: 50_000 },
    rateLimit: { requestsPerSecond: 1, burst: 1, quotaPerDay: null, retryAfterHeader: true },
    enabled: true,
  });
  const binding = SourceBindingSchema.parse({
    sourceId: source.id,
    instrumentId: "aapl-usd",
    enabled: true,
    priority: 1,
    capabilities: [capability],
    providerSymbol: "AAPL",
    quoteAsset: "USD",
    conversion: null,
    params: {},
    cadenceSeconds: capability === "quote" ? 30 : 21_600,
    staleAfterSeconds: capability === "quote" ? 1_200 : 604_800,
    egressProfile: "corp",
  });
  const instrument = InstrumentSchema.parse({
    id: "aapl-usd",
    assetClass: "equity",
    symbol: "AAPL",
    displayName: "Apple Inc.",
    venue: "NASDAQ",
    baseAsset: "AAPL",
    quoteAsset: "USD",
    contractMultiplier: "1",
    underlyingId: null,
    precision: { priceScale: 2, quantityScale: 6 },
    tags: ["equity", "us"],
    active: true,
    metadata: { timezone: "America/New_York" },
  });
  return {
    source,
    binding,
    instrument,
    httpClient: {} as AdapterContext["httpClient"],
    authToken: "fixture-massive-key",
    now: capability === "quote"
      ? new Date(1_787_343_300_000).toISOString()
      : new Date(1_787_400_900_000).toISOString(),
    clockSkewToleranceMs: 2_000,
    requestId: `fixture-massive-${capability}`,
    capability,
  };
}

function response(body: Uint8Array) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body,
    url: "https://fixture.invalid",
    receivedAt: "2026-08-22T14:25:00.000Z",
    serverDate: null,
    clockSkewMs: null,
  };
}

describe("M0 adapter fixtures", () => {
  it("parses and normalizes CoinGecko USD quote", async () => {
    const ctx = context("coingecko", "quote", "bitcoin", "USD");
    const parsed = coinGeckoAdapter.parse(response(await fixture("coingecko-simple-price.json")), ctx);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = coinGeckoAdapter.normalize(parsed.value, ctx);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok || normalized.value.kind !== "quote") return;
    expect(normalized.value.value.price).toBe("77009");
    expect(normalized.value.value.quoteAsset).toBe("USD");
    expect(normalized.value.value.quality).toBe("indicative");
  });

  it("parses Binance ticker without converting USDT to USD", async () => {
    const ctx = context("binance-vision", "quote", "BTCUSDT", "USDT");
    const parsed = binanceVisionAdapter.parse(response(await fixture("binance-ticker-24hr.json")), ctx);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = binanceVisionAdapter.normalize(parsed.value, ctx);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok || normalized.value.kind !== "quote") return;
    expect(normalized.value.value.price).toBe("77017.59");
    expect(normalized.value.value.bid).toBe("77017.58");
    expect(normalized.value.value.ask).toBe("77017.6");
    expect(normalized.value.value.mid).toBe("77017.59");
    expect(normalized.value.value.quoteAsset).toBe("USDT");
    expect(normalized.value.value.convertedTo).toBeNull();
  });

  it("normalizes Binance millisecond candles with decimal strings", async () => {
    const ctx = context("binance-vision", "candle", "BTCUSDT", "USDT");
    const parsed = binanceVisionAdapter.parse(response(await fixture("binance-klines.json")), ctx);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = binanceVisionAdapter.normalize(parsed.value, ctx);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok || normalized.value.kind !== "candles") return;
    expect(normalized.value.value).toHaveLength(1);
    expect(normalized.value.value[0]?.open).toBe("77000.1");
    expect(normalized.value.value[0]?.volume).toBe("12.3456");
    expect(normalized.value.value[0]?.quoteAsset).toBe("USDT");
  });

  it("converts Gold API JSON number price to a plain decimal string", async () => {
    const ctx = context("gold-api", "quote", "XAU", "USD");
    const parsed = goldApiAdapter.parse(response(await fixture("gold-api-price.json")), ctx);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = goldApiAdapter.normalize(parsed.value, ctx);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok || normalized.value.kind !== "quote") return;
    expect(normalized.value.value.price).toBe("4604.399902");
    expect(normalized.value.value.quoteAsset).toBe("USD");
    expect(typeof normalized.value.value.price).toBe("string");
  });

  it("labels Binance daily candles correctly and excludes today's unfinished candle", () => {
    const original = context("binance-vision", "candle", "BTCUSDT", "USDT");
    const ctx = { ...original, binding: { ...original.binding, params: { interval: "1d" } } };
    const day = (date: string) => { const time = Date.parse(date); return [time, "100", "110", "90", "105", "10", time + 86400000 - 1, "0", 5, "0", "0"]; };
    const parsed = binanceVisionAdapter.parse(response(new TextEncoder().encode(JSON.stringify([day("2026-08-21T00:00:00Z"), day("2026-08-22T00:00:00Z")]))), ctx);
    expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    const result = binanceVisionAdapter.normalize(parsed.value, ctx);
    expect(result.ok).toBe(true); if (!result.ok || result.value.kind !== "candles") return;
    expect(result.value.value).toHaveLength(1);expect(result.value.value[0]).toMatchObject({ timeframe: "1d", openTime: "2026-08-21T00:00:00.000Z" });
  });

  it("returns SourceError for malformed payloads instead of throwing", async () => {
    const ctx = context("gold-api", "quote", "XAU", "USD");
    const parsed = goldApiAdapter.parse(response(new TextEncoder().encode("not-json")), ctx);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(SourceErrorSchema.parse(parsed.error).kind).toBe("parse");
  });
});

describe("M1 Massive Stocks adapter fixtures", () => {
  it("normalizes a 15-minute-delayed AAPL snapshot without labeling it live", async () => {
    const ctx = massiveContext("quote");
    const parsed = massiveStocksAdapter.parse(response(await fixture("massive-stock-snapshot.json")), ctx);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = massiveStocksAdapter.normalize(parsed.value, ctx);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok || normalized.value.kind !== "quote") return;
    expect(normalized.value.value.price).toBe("226.41");
    expect(normalized.value.value.bid).toBe("226.4");
    expect(normalized.value.value.ask).toBe("226.42");
    expect(normalized.value.value.mid).toBe("226.41");
    expect(normalized.value.value.quoteAsset).toBe("USD");
    expect(normalized.value.value.quality).toBe("authoritative");
    expect(normalized.value.value.freshness.status).toBe("delayed");
    expect(normalized.value.value.freshness.status).not.toBe("live");
  });

  it("normalizes daily aggregate history into canonical decimal candles", async () => {
    const ctx = massiveContext("candle");
    const parsed = massiveStocksAdapter.parse(response(await fixture("massive-stock-aggregates.json")), ctx);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = massiveStocksAdapter.normalize(parsed.value, ctx);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok || normalized.value.kind !== "candles") return;
    expect(normalized.value.value).toHaveLength(2);
    expect(normalized.value.value[1]?.timeframe).toBe("1d");
    expect(normalized.value.value[1]?.open).toBe("225.11");
    expect(normalized.value.value[1]?.volume).toBe("41234567");
    expect(normalized.value.value[1]?.quoteAsset).toBe("USD");
    expect(normalized.value.value[1]?.freshness.status).toBe("delayed");
  });

  it("uses a Bearer header and never places the credential in the URL", async () => {
    const ctx = massiveContext("quote");
    let requestOptions: { url: string; headers?: Record<string, string> } | null = null;
    const body = await fixture("massive-stock-snapshot.json");
    const httpClient = {
      profile: () => ({ maxRedirects: 3, connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 }),
      request: async (options: { url: string; headers?: Record<string, string> }) => {
        requestOptions = options;
        return { ok: true as const, value: response(body) };
      },
    } as unknown as AdapterContext["httpClient"];
    const fetched = await massiveStocksAdapter.fetch({ ...ctx, httpClient }, ctx.source.params, new AbortController().signal);
    expect(fetched.ok).toBe(true);
    expect(requestOptions).not.toBeNull();
    const captured = requestOptions as unknown as { url: string; headers?: Record<string, string> };
    expect(captured.url).not.toContain("fixture-massive-key");
    expect(captured.url).not.toContain("apiKey=");
    expect(captured.headers?.authorization).toBe("Bearer fixture-massive-key");
  });

  it("builds the configured five-year aggregate range without exposing the credential", async () => {
    const ctx = massiveContext("candle");
    let requestOptions: { url: string; headers?: Record<string, string> } | null = null;
    const body = await fixture("massive-stock-aggregates.json");
    const httpClient = {
      profile: () => ({ maxRedirects: 3, connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 }),
      request: async (options: { url: string; headers?: Record<string, string> }) => {
        requestOptions = options;
        return { ok: true as const, value: response(body) };
      },
    } as unknown as AdapterContext["httpClient"];
    const fetched = await massiveStocksAdapter.fetch({ ...ctx, httpClient }, ctx.source.params, new AbortController().signal);
    expect(fetched.ok).toBe(true);
    expect(requestOptions).not.toBeNull();
    const captured = requestOptions as unknown as { url: string; headers?: Record<string, string> };
    const url = new URL(captured.url);
    expect(url.pathname).toBe("/v2/aggs/ticker/AAPL/range/1/day/2021-08-22/2026-08-22");
    expect(url.searchParams.get("adjusted")).toBe("true");
    expect(url.searchParams.get("sort")).toBe("asc");
    expect(url.searchParams.get("limit")).toBe("50000");
    expect(url.searchParams.has("apiKey")).toBe(false);
    expect(captured.headers?.authorization).toBe("Bearer fixture-massive-key");
  });

  it("fails closed before HTTP when the Massive credential is missing", async () => {
    const ctx = massiveContext("quote");
    const fetched = await massiveStocksAdapter.fetch(
      { ...ctx, authToken: null },
      ctx.source.params,
      new AbortController().signal,
    );
    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;
    expect(fetched.error.kind).toBe("auth");
    expect(fetched.error.causeCode).toBe("MISSING_AUTH");
  });
});
