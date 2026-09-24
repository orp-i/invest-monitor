import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigManager, ConfigRegistry } from "@invest/config";
import { createAdapterRegistry, tradierStocksAdapter, type AdapterContext } from "@invest/adapters";
import { CollectorScheduler } from "@invest/collector";
import { createStorageDriver } from "@invest/storage";
import { CandleSchema, computeFreshness } from "@invest/domain";
import { handleRequest } from "../../apps/server/src/app.js";
import { applyTradierEnvironment } from "../../apps/server/src/tradier-config.js";

const paths: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

async function setup(token: string, environment = "live") {
  vi.stubEnv("TRADIER_ACCESS_TOKEN", token);
  vi.stubEnv("TRADIER_ENVIRONMENT", environment);
  const path = await mkdtemp(join(tmpdir(), "tradier-market-")); paths.push(path);
  const storage = createStorageDriver("node-sqlite", join(path, "test.sqlite")); await storage.open(); await storage.migrate();
  const configManager = new ConfigManager("config/portfolio.yaml", 350, async config => {
    // Only Tradier search participates; fixtures never contact external APIs.
    const scoped = { ...config, sources: config.sources.map(source => source.adapter === "tradier-stocks" ? source : { ...source, enabled: false }) };
    const registry = new ConfigRegistry(scoped, await storage.getUserInstruments());
    return applyTradierEnvironment(registry.appConfig());
  });
  const snapshot = await configManager.loadInitial();
  await storage.syncConfigInstruments(snapshot.config.instruments.map(instrument => ({ ...instrument, origin: "config" as const, shadowed: false })), Date.now());
  const sent: string[] = [];
  const httpClient = {
    profile: () => ({ maxRedirects: 0, connectTimeoutMs: 1000, requestTimeoutMs: 2000 }),
    request: async (request: { url: string }) => {
      sent.push(request.url);
      const url = new URL(request.url);
      const body = url.pathname.endsWith("/search") ? { securities: { security: { symbol: "IAU", type: "etf", description: "Gold ETF (test)", exchange: "P" } } } : { quotes: { quote: { symbol: url.searchParams.get("symbols"), type: "etf", last: 110.25, trade_date: Date.now() - (environment === "sandbox" ? 900000 : 1000) } } };
      return { ok: true, value: { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)), receivedAt: new Date().toISOString(), serverDate: null, clockSkewMs: null, egressProfileUsed: "vpn", url: url.href } };
    },
  } as unknown as AdapterContext["httpClient"];
  const adapters = createAdapterRegistry();
  const scheduler = new CollectorScheduler(storage, httpClient, adapters, async ref => ref === "env:TRADIER_ACCESS_TOKEN" ? token || null : null);
  await scheduler.applySnapshot(snapshot);
  return { storage, configManager, scheduler, httpClient, adapters, sent, authMode: "off", authToken: null };
}

describe("Tradier market-data workspace integration", () => {
  it("loads MA seed candles using storage indices while returning only the 240 requested candles", async () => {
    const deps = await setup("fixture-only-token");
    try {
      const candles = Array.from({ length: 439 }, (_, i) => {
        const at = new Date(Date.UTC(2024, 0, i + 1)).toISOString(), close = String(i + 1);
        return CandleSchema.parse({ instrumentId: "aapl-usd", sourceId: "tradier-stocks-history", timeframe: "1d", openTime: at, closeTime: at, open: close, high: close, low: close, close, volume: null, tradeCount: null, session: "regular", quoteAsset: "USD", convertedTo: null, freshness: computeFreshness(at, at, 300, new Date(at), "eod") });
      });
      await deps.storage.appendCandles(candles);
      const result = await api("GET", "/api/candles?instrumentId=aapl-usd&sourceId=tradier-stocks-history&timeframe=1d&limit=240&indicators=ma", undefined, deps);
      expect(result.status).toBe(200); expect(result.body.candles).toHaveLength(240);
      expect(result.body.candles[0]).toMatchObject({ close: "200", ma: { 200: "100.5" } });
      expect(deps.sent).toHaveLength(0);
      await deps.storage.setCandleWarnings("aapl-usd", "tradier-stocks-history", ["2025-10-06: invalid OHLC"], Date.now());
      await deps.storage.close(); await deps.storage.open(); await deps.storage.migrate();
      const reopened = await api("GET", "/api/candles?instrumentId=aapl-usd&sourceId=tradier-stocks-history&timeframe=1d&limit=240&indicators=ma", undefined, deps);
      expect(reopened.body.warnings).toEqual(["2025-10-06: invalid OHLC"]);
      expect(await deps.storage.getCandleWarnings("gld-usd", "tradier-stocks-history")).toEqual([]);
    } finally { await deps.storage.close(); }
  });
  it("shows actionable missing-token setup and avoids requests while unconfigured", async () => {
    const deps = await setup("");
    try {
      const view = await api("GET", "/api/view", undefined, deps);
      expect(view.status).toBe(200);
      const metals = view.body.sections.find((section: any) => section.id === "metals");
      expect(metals.panels.map((panel: any) => panel.instrumentId)).toEqual(expect.arrayContaining(["gld-usd", "xau-usd"]));
      expect(metals.panels.find((panel: any) => panel.instrumentId === "gld-usd").title).toContain("USD/股");
      expect(metals.panels.find((panel: any) => panel.instrumentId === "xau-usd").title).toContain("金衡盎司");
      const equity = view.body.sections.find((section: any) => section.id === "equity");
      expect(equity.panels[0].availableCapabilities).not.toContain("quote");
      expect(equity.panels[0].widgets.find((widget: any) => widget.kind === "quote-card").options.unavailableReason).toContain("TRADIER_ACCESS_TOKEN");
      const search = await api("GET", "/api/instruments/search?q=AAPL", undefined, deps);
      expect(search.status).toBe(200);
      expect(search.body.sources.find((source: any) => source.sourceId === "tradier-stocks")).toMatchObject({ available: false, unavailableReason: { code: "auth-missing" } });
      expect(deps.sent).toHaveLength(0);
    } finally { await deps.storage.close(); }
  });

  it.each(["live", "sandbox"])("searches and saves an ETF with separate history, then values manual holdings in %s", async environment => {
    const deps = await setup("fixture-only-token", environment);
    try {
      const search = await api("GET", "/api/instruments/search?q=IAU", undefined, deps);
      const candidate = search.body.candidates.find((candidate: any) => candidate.sourceId === "tradier-stocks");
      expect(candidate).toMatchObject({ providerSymbol: "IAU", assetClass: "equity", quoteAsset: "USD" });
      const saved = await api("POST", "/api/instruments", { candidates: [candidate] }, deps);
      expect(saved.status).toBe(201);
      const instrument = saved.body.instrument;
      expect(instrument.sourceBindings).toEqual([
        expect.objectContaining({ sourceId: "tradier-stocks", capabilities: ["quote"], cadenceSeconds: 30, staleAfterSeconds: environment === "live" ? 120 : 1200 }),
        expect.objectContaining({ sourceId: "tradier-stocks-history", capabilities: ["candle"], cadenceSeconds: 21600 }),
      ]);
      await deps.scheduler.applySnapshot(deps.configManager.snapshot);
      const source = deps.configManager.snapshot.config.sources.find(source => source.id === "tradier-stocks")!;
      const context: AdapterContext = { source, binding: instrument.sourceBindings[0], instrument, httpClient: deps.httpClient, authToken: "fixture-only-token", now: new Date().toISOString(), requestId: "valuation", capability: "quote", clockSkewToleranceMs: 2000 };
      const fetched = await tradierStocksAdapter.fetch(context, source.params, new AbortController().signal);
      expect(fetched.ok).toBe(true); if (!fetched.ok) return;
      const parsed = tradierStocksAdapter.parse(fetched.value, context);
      expect(parsed.ok).toBe(true); if (!parsed.ok) return;
      const normalized = tradierStocksAdapter.normalize(parsed.value, context);
      expect(normalized.ok).toBe(true); if (!normalized.ok || normalized.value.kind !== "quote") return;
      await deps.storage.appendQuotes([normalized.value.value]);
      const transaction = await api("POST", "/api/transactions", { accountId: "manual", instrumentId: instrument.id, type: "buy", quantity: "2", price: "100", fees: "1", currency: "USD", tradeAtMs: Date.now() - 86400000 }, deps);
      expect(transaction.status).toBe(201);
      const positions = await api("GET", "/api/positions", undefined, deps);
      expect(positions.body.positions[0]).toMatchObject({ markSourceId: "tradier-stocks", markPrice: "110.25", costBasis: "201", marketValue: "220.5", unrealizedPnl: "19.5", freshness: { status: environment === "live" ? "live" : "delayed" } });
      const view = await api("GET", "/api/view", undefined, deps);
      const panel = view.body.sections.find((section: any) => section.id === "equity").panels.find((panel: any) => panel.instrumentId === instrument.id);
      expect(panel.widgets.find((widget: any) => widget.kind === "candlestick").dataEndpoint).toContain("sourceId=tradier-stocks-history&timeframe=1d");
      expect(JSON.stringify(view.body)).not.toContain("fixture-only-token");
    } finally { await deps.storage.close(); }
  }, 10000);
});

async function api(method: string, url: string, body: unknown, deps: unknown) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  request.method = method; request.url = url; request.headers = { "x-requested-with": "XMLHttpRequest" };
  let status = 0, text = "";
  const response = { set statusCode(value: number) { status = value; }, setHeader() {}, end(value: string) { text = value; } };
  await handleRequest(request, response as never, deps as never);
  return { status, body: JSON.parse(text) };
}
