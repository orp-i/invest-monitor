import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdapterRegistry, tradierStocksAdapter as adapter, type AdapterContext } from "@invest/adapters";
import { parseConfigText } from "@invest/config";
import { CollectorScheduler } from "@invest/collector";
import { applyTradierEnvironment } from "../../apps/server/src/tradier-config.js";
import type { RawHttpResponse, HttpRequestOptions } from "@invest/egress";

// Synthetic values following Tradier's documented quotes/search/history shapes.
const now = "2026-09-04T14:30:00.000Z";
const lastTrade = Date.parse(now) - 1000;
const sample = { quotes: { quote: { symbol: "AAPL", type: "stock", last: 175.23, bid: 175.2, ask: 175.24, trade_date: lastTrade, bid_date: Date.parse(now), open: 174, high: 178, low: 172, prevclose: 173, volume: 10000 } } };
const raw = (body: unknown, status = 200, headers = {}): RawHttpResponse => ({ status, headers, body: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)), receivedAt: now, serverDate: now, clockSkewMs: 0, egressProfileUsed: "vpn", url: "https://api.tradier.com/v1/markets/quotes" });

async function context(capability: "quote" | "candle" = "quote", environment = "live") {
  const loaded = parseConfigText(await readFile("config/portfolio.yaml", "utf8"));
  if (!loaded.ok) throw Error(loaded.issues.map(issue => issue.message).join(";"));
  const config = applyTradierEnvironment(loaded.config, { TRADIER_ENVIRONMENT: environment });
  const sourceId = capability === "quote" ? "tradier-stocks" : "tradier-stocks-history";
  const instrument = config.instruments.find(instrument => instrument.id === "aapl-usd")!;
  const requests: HttpRequestOptions[] = [];
  const ctx: AdapterContext = { source: config.sources.find(source => source.id === sourceId)!, binding: instrument.sourceBindings.find(binding => binding.sourceId === sourceId)!, instrument, now, clockSkewToleranceMs: 2000, capability, requestId: "tradier-fixture", authToken: "fixture-token", httpClient: { profile: () => ({ maxRedirects: 0, connectTimeoutMs: 1000, requestTimeoutMs: 2000 }), request: async (options: HttpRequestOptions) => { requests.push(options); return { ok: true, value: raw(sample) }; } } as unknown as AdapterContext["httpClient"] };
  return { ctx, requests, config };
}

function normalize(body: unknown, ctx: AdapterContext) {
  const parsed = adapter.parse(raw(body), ctx);
  if (!parsed.ok) return parsed;
  return adapter.normalize(parsed.value, ctx);
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Tradier US stocks and ETF market data", () => {
  it("uses the correct live/sandbox endpoints and sends credentials only as a header", async () => {
    for (const environment of ["live", "sandbox"]) {
      const { ctx, requests, config } = await context("quote", environment);
      expect((await adapter.fetch(ctx, ctx.source.params, new AbortController().signal)).ok).toBe(true);
      const sent = requests[0]!;
      const url = new URL(sent.url);
      expect(url.hostname).toBe(environment === "live" ? "api.tradier.com" : "sandbox.tradier.com");
      expect(url.pathname).toBe("/v1/markets/quotes");
      expect(url.searchParams.get("symbols")).toBe("AAPL");
      expect(sent.headers).toMatchObject({ authorization: "Bearer fixture-token", accept: "application/json" });
      expect(sent.followRedirects).toBe(false);
      expect(sent.url).not.toContain("fixture-token");
      const scheduler = new CollectorScheduler({} as never, {} as never, createAdapterRegistry(), async () => "fixture-token");
      await scheduler.applySnapshot({ config, generation: 1, sha256: "test", loadedAt: now });
      expect(scheduler.sourceFreshnessClass(ctx.source.id)).toBe(environment === "live" ? "realtime" : "delayed");
      expect(scheduler.sourceFreshnessClass("tradier-stocks-history")).toBe("eod");
    }
  });

  it("preserves decimal tokens and uses the last execution time even with newer bid/ask data", async () => {
    const { ctx } = await context();
    const body = JSON.stringify(sample).replace('175.23', '175.230000000000000001').replace('10000', '9007199254740993');
    const result = normalize(body, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "quote") return;
    expect(result.value.value).toMatchObject({ price: "175.230000000000000001", volume: "9007199254740993", capturedAt: new Date(lastTrade).toISOString(), freshness: { status: "live" } });
    const closed = normalize({ quotes: { quote: { ...sample.quotes.quote, trade_date: lastTrade - 86400000 } } }, ctx);
    expect(closed.ok && closed.value.kind === "quote" && closed.value.value.freshness).toMatchObject({ status: "live", dataLagMs: 0, tradeReferenceAt: new Date(lastTrade - 86400000).toISOString() });
  });

  it("marks sandbox as delayed, retains missing bid/ask as null and never uses a zero last price", async () => {
    const { ctx } = await context("quote", "sandbox");
    const result = normalize({ quotes: { quote: [{ ...sample.quotes.quote, trade_date: lastTrade - 900000, bid: 0, ask: null }] } }, ctx);
    expect(result.ok && result.value.kind === "quote" && result.value.value).toMatchObject({ bid: null, ask: null, freshness: { status: "delayed", staleAfterSeconds: 1200 } });
    for (const quote of [{ ...sample.quotes.quote, last: 0 }, { ...sample.quotes.quote, trade_date: null }, { ...sample.quotes.quote, symbol: "MSFT" }, { ...sample.quotes.quote, type: "option" }]) expect(normalize({ quotes: { quote } }, ctx).ok).toBe(false);
    expect(normalize({ quotes: null }, ctx).ok).toBe(false);
  });

  it("does not request when credentials are missing or a credential destination is unsafe", async () => {
    const { ctx, requests } = await context();
    expect(await adapter.fetch({ ...ctx, authToken: null }, ctx.source.params, new AbortController().signal)).toMatchObject({ ok: false, error: { code: "auth-missing" } });
    for (const baseUrl of ["https://evil.invalid/v1", "http://api.tradier.com/v1", "https://api.tradier.com:444/v1", "https://api.tradier.com/v1?token=x"]) {
      expect((await adapter.fetch({ ...ctx, source: { ...ctx.source, baseUrl } }, ctx.source.params, new AbortController().signal)).ok).toBe(false);
    }
    expect(requests).toHaveLength(0);
    expect(adapter.parse(raw('{ invalid JSON with secret }'), ctx)).toMatchObject({ ok: false, error: { causeCode: "INVALID_RESPONSE" } });
    expect(JSON.stringify(adapter.parse(raw('{ invalid JSON with secret }'), ctx))).not.toContain("with secret");
  });

  it("searches stocks and ETFs, preserves class-share symbols and handles singleton/empty responses", async () => {
    const { ctx } = await context();
    const security = { symbol: "BRK/B", description: "Berkshire Hathaway", type: "stock", exchange: "N" };
    const responses = [{ securities: { security } }, { securities: { security: [security, { ...security, symbol: "GLD", type: "etf" }, { ...security, symbol: "VIX", type: "index" }] } }, { securities: null }];
    for (const body of responses) {
      const searchCtx = { ...ctx, httpClient: { ...ctx.httpClient, profile: ctx.httpClient.profile, request: async () => ({ ok: true, value: raw(body) }) } as AdapterContext["httpClient"] };
      const result = await adapter.searchInstruments!("BRK", searchCtx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.map(item => item.providerSymbol)).toEqual(body.securities === null ? [] : Array.isArray(body.securities.security) ? ["BRK/B", "GLD"] : ["BRK/B"]);
      expect(result.value.every(item => item.assetClass === "equity" && item.quoteAsset === "USD" && item.capabilities.join() === "quote")).toBe(true);
      if (result.value.length) expect(result.value[0]).toMatchObject({ providerSymbol: "BRK/B", baseAsset: "BRK.B", symbol: "BRK.B" });
    }
  });

  it("loads daily history separately and excludes incomplete New York dates", async () => {
    const { ctx, requests } = await context("candle");
    await adapter.fetch(ctx, ctx.source.params, new AbortController().signal);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/v1/markets/history");
    expect(url.searchParams.get("interval")).toBe("daily");
    expect(url.searchParams.get("end")).toBe("2026-09-04");
    const bar = { date: "2026-09-03", open: 173, high: 176, low: 171, close: 175.23, volume: 10000 };
    const body = { history: { day: [{ ...bar, date: "2026-09-04" }, bar, { ...bar, date: "2026-09-02" }] } };
    const result = normalize(body, { ...ctx, now: "2026-09-05T01:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "candles") return;
    expect(result.value.value.map(row => row.openTime)).toEqual(["2026-09-02T00:00:00.000Z", "2026-09-03T00:00:00.000Z"]);
    expect(result.value.value.every(row => row.session === "regular")).toBe(true);
    const mixed = normalize({ history: { day: [bar, {...bar,date:"2026-09-02",close:170}] } }, ctx);
    expect(mixed).toMatchObject({ok:true,value:{kind:"candles",value:[expect.objectContaining({close:"175.23"})],warnings:[expect.stringContaining("2026-09-02")]}});
    expect(normalize({ history: { day: bar } }, ctx).ok).toBe(true);
    expect(normalize({ history: null }, ctx)).toMatchObject({ ok: true, value: { kind: "candles", value: [] } });
    expect(normalize({ history: {} }, ctx).ok).toBe(false);
    expect(normalize({ history: { day: { ...bar, date: "2026-02-30" } } }, ctx).ok).toBe(false);
    expect(normalize({ history: { day: { ...bar, high: 100 } } }, ctx)).toMatchObject({ ok: true, value: { kind: "candles", value: [], warnings: [expect.stringContaining("2026-09-03")] } });
  });

  it("shares market-data pacing across quote and history requests and sanitizes HTTP errors", async () => {
    const { ctx } = await context();
    const times: number[] = [];
    const httpClient = { profile: ctx.httpClient.profile, request: async () => { times.push(Date.now()); return { ok: true, value: raw("private provider message", times.length === 1 ? 429 : 401, { "retry-after": "2" }) }; } } as unknown as AdapterContext["httpClient"];
    const first = await adapter.fetch({ ...ctx, httpClient }, ctx.source.params, new AbortController().signal);
    const second = await adapter.fetch({ ...ctx, httpClient, source: { ...ctx.source, id: "tradier-stocks-history" }, capability: "candle" }, ctx.source.params, new AbortController().signal);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1900);
    expect(first).toMatchObject({ ok: false, error: { kind: "rate_limited", retryAfterSeconds: 2 } });
    expect(second).toMatchObject({ ok: false, error: { kind: "auth", httpStatus: 401 } });
    expect(JSON.stringify([first, second])).not.toContain("private provider message");
  });

  it("validates environment and rejects unsafe source URLs before loading configuration", async () => {
    const text = await readFile("config/portfolio.yaml", "utf8");
    const { config } = await context();
    expect(() => applyTradierEnvironment(config, { TRADIER_ENVIRONMENT: "paper" })).toThrow("TRADIER_ENVIRONMENT");
    expect(parseConfigText(text.replace('https://api.tradier.com/v1', 'http://api.tradier.com/v1')).ok).toBe(false);
    expect(parseConfigText(text.replace('https://api.tradier.com/v1', 'https://malicious.invalid/v1')).ok).toBe(false);
  });
});
