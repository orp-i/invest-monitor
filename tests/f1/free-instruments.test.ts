import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  binanceVisionAdapter,
  coinGeckoAdapter,
  goldApiAdapter,
  massiveStocksAdapter,
  createAdapterRegistry,
  type AdapterContext,
} from "@invest/adapters";
import { ConfigManager, ConfigRegistry, SourceConfigSchema, loadConfigFile } from "@invest/config";
import { InstrumentSchema, SourceBindingSchema, type InstrumentCandidate } from "@invest/domain";
import { createStorageDriver, type StoredInstrumentConfig } from "@invest/storage";
import { handleRequest } from "../../apps/server/src/app.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("F1 instrument discovery", () => {
  it("merges the doge endpoint by YAML source order and keeps missing Massive visible with enablement steps", async () => {
    const directory = await temporaryDirectory("invest-f1-search-api-");
    const configPath = join(directory, "portfolio.yaml");
    await writeFile(configPath, dogeSearchConfig(), "utf8");
    const configManager = new ConfigManager(configPath);
    await configManager.loadInitial();
    const exchangeInfo = await jsonFixture("binance-exchange-info-search.json");
    let requests = 0;
    const httpClient = {
      profile: () => ({ maxRedirects: 3, connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 }),
      request: async (options: { url: string }) => {
        requests += 1;
        const payload = options.url.includes("exchangeInfo")
          ? exchangeInfo
          : { coins: [{ id: "dogecoin", symbol: "doge", name: "Dogecoin", market_cap_rank: 9 }] };
        return {
          ok: true as const,
          value: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode(JSON.stringify(payload)),
            url: options.url,
            receivedAt: "2026-08-26T00:00:00.000Z",
            serverDate: null,
            clockSkewMs: null,
            egressProfileUsed: "vpn" as const,
          },
        };
      },
    };
    const previousKey = process.env.MASSIVE_API_KEY;
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    delete process.env.MASSIVE_API_KEY;
    try {
      const result = await invokeApi("GET", "/api/instruments/search?q=doge", undefined, {
        configManager,
        adapters: createAdapterRegistry(),
        httpClient,
        authMode: "off",
        authToken: null,
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        candidates: [
          expect.objectContaining({ sourceId: "coingecko", providerSymbol: "dogecoin", quoteAsset: "USD" }),
          expect.objectContaining({ sourceId: "binance-vision", providerSymbol: "DOGEUSDT", quoteAsset: "USDT" }),
          expect.objectContaining({ sourceId: "binance-vision", providerSymbol: "DOGEUSDC", quoteAsset: "USDC" }),
          expect.objectContaining({ sourceId: "binance-vision", providerSymbol: "DOGEFDUSD", quoteAsset: "FDUSD" }),
        ],
        groups: [expect.objectContaining({ baseAsset: "DOGE" })],
        sources: expect.arrayContaining([
          expect.objectContaining({
            sourceId: "massive-stocks",
            available: false,
            unavailableReason: expect.objectContaining({ code: "auth-missing", steps: expect.arrayContaining([expect.stringContaining("MASSIVE_API_KEY")]) }),
          }),
        ]),
      });
      expect(requests).toBe(2);
    } finally {
      debug.mockRestore();
      if (previousKey === undefined) delete process.env.MASSIVE_API_KEY;
      else process.env.MASSIVE_API_KEY = previousKey;
    }
  });

  it("skips malformed Binance symbols while returning all native DOGE quote pairs from the 24h exchangeInfo cache", async () => {
    const coinGecko = searchContext("coingecko", {
      coins: [{ id: "dogecoin", symbol: "doge", name: "Dogecoin", market_cap_rank: 9 }],
    });
    const binance = searchContext("binance-vision", await jsonFixture("binance-exchange-info-search.json"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    try {
      const coinGeckoResult = await coinGeckoAdapter.searchInstruments?.("doge", coinGecko.context);
      const firstBinanceResult = await binanceVisionAdapter.searchInstruments?.("doge", binance.context);
      const secondBinanceResult = await binanceVisionAdapter.searchInstruments?.("doge", binance.context);
      const allBinanceResult = await binanceVisionAdapter.searchInstruments?.("", binance.context);

      expect(coinGeckoResult?.ok).toBe(true);
      expect(firstBinanceResult?.ok).toBe(true);
      expect(secondBinanceResult?.ok).toBe(true);
      expect(allBinanceResult?.ok).toBe(true);
      if (!coinGeckoResult?.ok || !firstBinanceResult?.ok || !allBinanceResult?.ok) return;
      expect(coinGeckoResult.value[0]).toMatchObject({ providerSymbol: "dogecoin", baseAsset: "DOGE", quoteAsset: "USD" });
      expect(firstBinanceResult.value).toEqual([
        expect.objectContaining({ providerSymbol: "DOGEUSDT", baseAsset: "DOGE", quoteAsset: "USDT" }),
        expect.objectContaining({ providerSymbol: "DOGEUSDC", baseAsset: "DOGE", quoteAsset: "USDC" }),
        expect.objectContaining({ providerSymbol: "DOGEFDUSD", baseAsset: "DOGE", quoteAsset: "FDUSD" }),
      ]);
      expect(allBinanceResult.value.map((candidate) => candidate.providerSymbol)).toEqual([
        "DOGEUSDT",
        "DOGEUSDC",
        "DOGEFDUSD",
      ]);
      expect(debug).toHaveBeenCalledWith(
        "[instrument-search] rejected invalid candidate",
        { sourceId: "binance-vision", providerSymbol: "1MBABYDOGEUSDT" },
      );
      expect(debug).toHaveBeenCalledWith(
        "[instrument-search] rejected invalid candidate",
        { sourceId: "binance-vision", providerSymbol: "1000SATSUSDT" },
      );
      expect(debug).toHaveBeenCalledWith(
        "[instrument-search] rejected invalid candidate",
        { sourceId: "binance-vision", providerSymbol: "币安人生USDT" },
      );
      expect(binance.requests()).toBe(1);
    } finally {
      debug.mockRestore();
    }
  });

  it("keeps the search endpoint at 200 and preserves healthy source results when one adapter throws", async () => {
    const throwing = searchContext("coingecko", { coins: [] });
    const healthy = searchContext("binance-vision", { symbols: [] });
    const adapters = createAdapterRegistry();
    adapters.register({
      ...coinGeckoAdapter,
      searchInstruments: async () => {
        throw new Error("synthetic search failure");
      },
    });
    adapters.register({
      ...binanceVisionAdapter,
      searchInstruments: async () => ({
        ok: true as const,
        value: [
          binanceDogeCandidate("DOGEUSDT", "USDT"),
          binanceDogeCandidate("DOGEUSDC", "USDC"),
        ],
      }),
    });

    const result = await invokeApi("GET", "/api/instruments/search?q=doge", undefined, {
      configManager: {
        snapshot: {
          generation: 11,
          config: { sources: [throwing.context.source, healthy.context.source] },
        },
      },
      adapters,
      httpClient: healthy.context.httpClient,
      authMode: "off",
      authToken: null,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      generation: 11,
      candidates: [
        expect.objectContaining({ sourceId: "binance-vision", providerSymbol: "DOGEUSDT" }),
        expect.objectContaining({ sourceId: "binance-vision", providerSymbol: "DOGEUSDC" }),
      ],
      sources: [
        expect.objectContaining({
          sourceId: "coingecko",
          available: false,
          unavailableReason: expect.objectContaining({ code: "search-failed", message: "synthetic search failure" }),
        }),
        expect.objectContaining({ sourceId: "binance-vision", available: true, candidates: expect.any(Array) }),
      ],
    });
  });

  it("ranks an exact gold-api XAG match before earlier CoinGecko substring matches", async () => {
    const coinGecko = searchContext("coingecko", { coins: [] });
    const gold = searchContext("gold-api", []);
    const adapters = createAdapterRegistry();
    adapters.register({
      ...coinGeckoAdapter,
      searchInstruments: async () => ({
        ok: true as const,
        value: [
          coinGeckoXagSubstringCandidate("matrixdock-silver", "MDXAG", 1605),
          coinGeckoXagSubstringCandidate("0xagenteve", "OXAGENT", 6066),
          coinGeckoXagSubstringCandidate("hexagon", "HEXAGON", 6851),
        ],
      }),
    });
    adapters.register({
      ...goldApiAdapter,
      searchInstruments: async () => ({ ok: true as const, value: [xagCandidate()] }),
    });

    const result = await invokeApi("GET", "/api/instruments/search?q=XAG", undefined, {
      configManager: {
        snapshot: {
          generation: 12,
          config: { sources: [coinGecko.context.source, gold.context.source] },
        },
      },
      adapters,
      httpClient: coinGecko.context.httpClient,
      authMode: "off",
      authToken: null,
    });

    expect(result.status).toBe(200);
    const candidates = result.body.candidates as InstrumentCandidate[];
    expect(candidates.map((candidate) => `${candidate.sourceId}:${candidate.providerSymbol}`)).toEqual([
      "gold-api:XAG",
      "coingecko:matrixdock-silver",
      "coingecko:0xagenteve",
      "coingecko:hexagon",
    ]);
  });

  it("exposes only the five metals and reports missing Massive auth as a SourceError", async () => {
    const gold = searchContext("gold-api", ["XAU", "XAG", "XPT", "XPD", "HG", "BTC", "ETH"]);
    const goldResult = await goldApiAdapter.searchInstruments?.("", gold.context);
    expect(goldResult?.ok).toBe(true);
    if (!goldResult?.ok) return;
    expect(goldResult.value.map((candidate) => candidate.baseAsset)).toEqual(["XAU", "XAG", "XPT", "XPD", "HG"]);

    const massive = searchContext("massive-stocks", { results: [] }, null);
    const massiveResult = await massiveStocksAdapter.searchInstruments?.("AAPL", massive.context);
    expect(massiveResult?.ok).toBe(false);
    if (!massiveResult || massiveResult.ok) return;
    expect(massiveResult.error).toMatchObject({ kind: "auth", code: "auth-missing", causeCode: "MISSING_AUTH" });
    expect(massive.requests()).toBe(0);
  });
});

describe("F1 storage and registry", () => {
  it("migrates legacy instrument rows to config origin without losing data", async () => {
    const directory = await temporaryDirectory("invest-f1-origin-migration-");
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_ms INTEGER NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES (1, 'clock-skew-observability', 1);
      INSERT INTO schema_migrations VALUES (2, 'egress-observability', 2);
      CREATE TABLE instruments (
        id TEXT PRIMARY KEY, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, display_name TEXT NOT NULL,
        venue TEXT, base_asset TEXT NOT NULL, quote_asset TEXT NOT NULL, contract_multiplier TEXT NOT NULL,
        underlying_id TEXT, precision_json TEXT NOT NULL, tags_json TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)), metadata_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE source_bindings (
        source_id TEXT NOT NULL, instrument_id TEXT NOT NULL REFERENCES instruments(id), provider_symbol TEXT NOT NULL,
        priority INTEGER NOT NULL, capabilities_json TEXT NOT NULL, quote_asset TEXT NOT NULL,
        conversion_json TEXT NOT NULL, params_json TEXT NOT NULL, egress_profile TEXT NOT NULL,
        cadence_seconds INTEGER NOT NULL, stale_after_seconds INTEGER NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), PRIMARY KEY (source_id, instrument_id)
      ) WITHOUT ROWID, STRICT;
      INSERT INTO instruments VALUES ('legacy-usd', 'other', 'LEGACY/USD', 'Legacy', NULL, 'LEGACY', 'USD', '1', NULL, '{"priceScale":2,"quantityScale":6}', '[]', 1, '{}', 1);
      INSERT INTO source_bindings VALUES ('legacy-source', 'legacy-usd', 'LEGACY', 1, '["quote"]', 'USD', 'null', '{}', 'vpn', 60, 120, 1);
    `);
    legacy.close();
    const driver = createStorageDriver("node-sqlite", path);
    try {
      await driver.open();
      await driver.migrate();
      const verifier = new DatabaseSync(path);
      try {
        expect(verifier.prepare("SELECT id, origin FROM instruments WHERE id = 'legacy-usd'").get()).toMatchObject({ id: "legacy-usd", origin: "config" });
        expect(verifier.prepare("SELECT provider_symbol, origin FROM source_bindings WHERE instrument_id = 'legacy-usd'").get()).toMatchObject({ provider_symbol: "LEGACY", origin: "config" });
        expect(verifier.prepare("SELECT name FROM schema_migrations WHERE version = 3").get()).toMatchObject({ name: "instrument-origin" });
      } finally {
        verifier.close();
      }
    } finally {
      await driver.close();
    }
  });

  it("keeps user instruments across YAML sync, maps XAG into 黄金, reports shadowing, and rejects hard delete with a position", async () => {
    const directory = await temporaryDirectory("invest-f1-storage-");
    const path = join(directory, "f1.sqlite");
    const driver = createStorageDriver("node-sqlite", path);
    try {
      await driver.open();
      await driver.migrate();
      const loaded = await loadConfigFile("config/portfolio.yaml");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const configRows = loaded.config.instruments.map((instrument) => ({
        ...instrument,
        origin: "config" as const,
        shadowed: false,
      }));
      await driver.syncConfigInstruments(configRows, 1);
      const xag = userXag();
      await driver.createUserInstrument(xag, 2);

      // This is the same path used by a YAML reload. Config rows are refreshed,
      // while origin=user rows are outside both the upsert and delete sets.
      await driver.syncConfigInstruments(configRows, 3);
      const userRows = await driver.getUserInstruments();
      expect(userRows.map((instrument) => instrument.id)).toEqual(["xag-usd"]);
      const registry = new ConfigRegistry(loaded.config, userRows);
      expect(registry.instrument("xag-usd")).toMatchObject({ panelId: "metals", assetClass: "preciousMetal" });

      const shadowCandidate = { ...xag, id: "xau-usd", sourceBindings: [{ ...xag.sourceBindings[0]!, instrumentId: "xau-usd" }] };
      const shadowRegistry = new ConfigRegistry(loaded.config, [shadowCandidate]);
      expect(shadowRegistry.instrument("xau-usd")?.displayName).toBe("黄金现货（USD/金衡盎司）");
      expect(shadowRegistry.shadowedUserInstrumentIds).toEqual(["xau-usd"]);
      expect(shadowRegistry.issues[0]?.message).toContain("shadowed by YAML");
      expect(shadowCandidate.shadowed).toBe(true);

      const database = new DatabaseSync(path);
      try {
        database.exec("PRAGMA foreign_keys = ON");
        database.prepare(`
          INSERT OR IGNORE INTO accounts (id, display_name, adapter_id, institution, mode, reporting_currency, enabled, last_sync_at_ms, metadata_json)
          VALUES ('manual', 'Manual', 'manual', 'Manual', 'manual', 'USD', 1, NULL, '{}')
        `).run();
        database.prepare(`
          INSERT INTO positions (
            account_id, instrument_id, quantity, average_cost, cost_basis, mark_price,
            market_value, realized_pnl, unrealized_pnl, quote_asset, as_of_ms, freshness_status
          ) VALUES ('manual', 'xag-usd', '1.25', '69.29', '86.6125', NULL, NULL, '0', NULL, 'USD', 1, 'live')
        `).run();
        expect(database.prepare("SELECT name FROM schema_migrations WHERE version = 3").get()).toMatchObject({ name: "instrument-origin" });
        expect(database.prepare("SELECT origin FROM instruments WHERE id = 'xag-usd'").get()).toMatchObject({ origin: "user" });
      } finally {
        database.close();
      }

      const deletion = await driver.deleteUserInstrument("xag-usd", true);
      expect(deletion).toEqual({ status: "referenced", references: { transactions: 0, nonZeroPositions: 1 } });
      expect(await driver.getInstrumentOrigin("xag-usd")).toBe("user");
    } finally {
      await driver.close();
    }
  });

  it("rejects persistence at the HTTP boundary when every server-side re-probe fails", async () => {
    const directory = await temporaryDirectory("invest-f1-api-");
    const configPath = join(directory, "portfolio.yaml");
    const sqlitePath = join(directory, "f1.sqlite");
    await writeFile(configPath, disabledSearchConfig(), "utf8");
    const storage = createStorageDriver("node-sqlite", sqlitePath);
    try {
      await storage.open();
      await storage.migrate();
      const configManager = new ConfigManager(configPath);
      await configManager.loadInitial();
      const request = Readable.from([JSON.stringify({ candidates: [dogeCandidate()] })]) as unknown as {
        method: string;
        url: string;
        headers: Record<string, string>;
      };
      request.method = "POST";
      request.url = "/api/instruments";
      request.headers = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
      let statusCode = 0;
      let responseBody = "";
      const response = {
        set statusCode(value: number) { statusCode = value; },
        get statusCode() { return statusCode; },
        setHeader: () => undefined,
        end: (body: string) => { responseBody = body; },
      };
      await handleRequest(request as never, response as never, {
        configManager,
        storage,
        adapters: createAdapterRegistry(),
        httpClient: {},
        authMode: "off",
        authToken: null,
      } as never);
      expect(statusCode).toBe(422);
      expect(JSON.parse(responseBody)).toMatchObject({ error: "probe_required" });
      expect(await storage.getUserInstruments()).toHaveLength(0);
    } finally {
      await storage.close();
    }
  });

  it("shows XAG probe evidence, re-probes on create, and places it in the 黄金 descriptor section", async () => {
    const directory = await temporaryDirectory("invest-f1-xag-api-");
    const configPath = join(directory, "portfolio.yaml");
    const sqlitePath = join(directory, "f1.sqlite");
    await writeFile(configPath, goldSearchConfig(), "utf8");
    const storage = createStorageDriver("node-sqlite", sqlitePath);
    try {
      await storage.open();
      await storage.migrate();
      const configManager = new ConfigManager(configPath, 1, async (config) => {
        await storage.syncConfigInstruments(config.instruments.map((instrument) => ({
          ...instrument,
          origin: "config" as const,
          shadowed: false,
        })), Date.now());
        const registry = new ConfigRegistry(config, await storage.getUserInstruments());
        return { config: registry.appConfig(), issues: registry.issues };
      });
      await configManager.loadInitial();
      let requests = 0;
      const httpClient = {
        profile: () => ({ maxRedirects: 3, connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 }),
        request: async (options: { url: string }) => {
          requests += 1;
          return {
            ok: true as const,
            value: {
              status: 200,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(JSON.stringify({
                price: "69.29",
                currency: "USD",
                updatedAt: "2026-08-26T00:00:00.000Z",
              })),
              url: options.url,
              receivedAt: "2026-08-26T00:00:01.000Z",
              serverDate: null,
              clockSkewMs: null,
              egressProfileUsed: "vpn" as const,
            },
          };
        },
      };
      const deps = {
        configManager,
        storage,
        adapters: createAdapterRegistry(),
        httpClient,
        authMode: "off",
        authToken: null,
        scheduler: {
          sourceCapabilityAvailable: () => true,
          sourceFreshnessClass: () => "realtime",
          sourceAuthConfigured: () => true,
        },
      };
      const candidate = xagCandidate();
      const probe = await invokeApi("POST", "/api/instruments/probe", { candidates: [candidate] }, deps);
      expect(probe.status).toBe(200);
      expect(probe.body).toMatchObject({
        probes: [{ ok: true, price: "69.29", quoteAsset: "USD", capturedAt: "2026-08-26T00:00:00.000Z", egressUsed: "vpn" }],
      });

      const create = await invokeApi("POST", "/api/instruments", { candidates: [candidate], probes: [{ ok: true, price: "forged" }] }, deps);
      expect(create.status).toBe(201);
      expect(create.body).toMatchObject({ generation: 2, instrument: { id: "xag-usd", panelId: "metals" } });
      expect(requests).toBe(2);

      const view = await invokeApi("GET", "/api/view", undefined, deps);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({
        sections: expect.arrayContaining([
          expect.objectContaining({ title: "黄金", panels: [expect.objectContaining({ instrumentId: "xag-usd" })] }),
        ]),
      });
    } finally {
      await storage.close();
    }
  });
});

function searchContext(
  sourceId: "coingecko" | "binance-vision" | "gold-api" | "massive-stocks",
  payload: unknown,
  authToken: string | null = "fixture-key",
): { readonly context: AdapterContext; readonly requests: () => number } {
  let requestCount = 0;
  const params = sourceId === "coingecko"
    ? { vsCurrency: "usd", days: 1 }
    : sourceId === "binance-vision"
      ? { interval: "1m", limit: 50 }
      : sourceId === "gold-api"
        ? { metal: "XAU", quoteAsset: "USD", unit: "troy_ounce" }
        : { adjusted: true, timeframe: "1d", historyYears: 5, limit: 50_000 };
  const source = SourceConfigSchema.parse({
    id: sourceId,
    adapter: sourceId,
    baseUrl: `https://${sourceId}-fixture.example.invalid`,
    authRef: sourceId === "massive-stocks" ? "env:MASSIVE_API_KEY" : null,
    egressProfile: "vpn",
    egressFallback: ["corp"],
    userAgent: "f1-test",
    followRedirects: true,
    capabilities: ["instrumentSearch", "quote", ...(sourceId === "coingecko" || sourceId === "binance-vision" ? ["candle" as const] : [])],
    defaultBinding: { cadenceSeconds: 30, staleAfterSeconds: 120, egressProfile: "vpn" },
    params,
    rateLimit: { requestsPerSecond: 1, burst: 1, quotaPerDay: null, retryAfterHeader: true },
    enabled: true,
  });
  const binding = SourceBindingSchema.parse({
    sourceId,
    instrumentId: "instrument-search",
    capabilities: ["instrumentSearch"],
    providerSymbol: "SEARCH",
    quoteAsset: "USD",
    conversion: null,
    params: {},
    cadenceSeconds: 30,
    staleAfterSeconds: 120,
    egressProfile: "vpn",
    egressFallback: ["corp"],
  });
  const instrument = InstrumentSchema.parse({
    id: "instrument-search",
    assetClass: "other",
    symbol: "SEARCH",
    displayName: "Search",
    venue: null,
    baseAsset: "SEARCH",
    quoteAsset: "USD",
    contractMultiplier: "1",
    underlyingId: null,
    precision: { priceScale: 2, quantityScale: 6 },
    tags: [],
    active: false,
    metadata: {},
  });
  const httpClient = {
    profile: () => ({ maxRedirects: 3, connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 }),
    request: async (options: { url: string }) => {
      requestCount += 1;
      return {
        ok: true as const,
        value: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify(payload)),
          url: options.url,
          receivedAt: "2026-08-26T00:00:00.000Z",
          serverDate: null,
          clockSkewMs: null,
          egressProfileUsed: "vpn" as const,
        },
      };
    },
  } as unknown as AdapterContext["httpClient"];
  return {
    context: {
      source,
      binding,
      instrument,
      httpClient,
      authToken,
      now: "2026-08-26T00:00:00.000Z",
      clockSkewToleranceMs: 2_000,
      requestId: `search-${sourceId}`,
      capability: "instrumentSearch",
    },
    requests: () => requestCount,
  };
}

function userXag(): StoredInstrumentConfig {
  const binding = SourceBindingSchema.parse({
    sourceId: "gold-api",
    instrumentId: "xag-usd",
    enabled: true,
    priority: 2,
    capabilities: ["quote"],
    providerSymbol: "XAG",
    quoteAsset: "USD",
    conversion: null,
    params: { metal: "XAG", quoteAsset: "USD", unit: "troy_ounce" },
    cadenceSeconds: 60,
    staleAfterSeconds: 300,
    egressProfile: "vpn",
    egressFallback: ["corp"],
  });
  return {
    ...InstrumentSchema.parse({
      id: "xag-usd",
      assetClass: "preciousMetal",
      symbol: "XAG/USD",
      displayName: "Silver",
      venue: "spot",
      baseAsset: "XAG",
      quoteAsset: "USD",
      contractMultiplier: "1",
      underlyingId: null,
      precision: { priceScale: 2, quantityScale: 6 },
      tags: [],
      active: true,
      metadata: {},
    }),
    sourceBindings: [binding],
    panelId: "other",
    watch: true,
    origin: "user",
    shadowed: false,
  };
}

function dogeCandidate(): InstrumentCandidate {
  return {
    sourceId: "coingecko",
    providerSymbol: "dogecoin",
    symbol: "DOGE/USD",
    displayName: "Dogecoin",
    assetClass: "crypto",
    baseAsset: "DOGE",
    quoteAsset: "USD",
    capabilities: ["quote"],
    rank: 9,
    venue: null,
  };
}

function xagCandidate(): InstrumentCandidate {
  return {
    sourceId: "gold-api",
    providerSymbol: "XAG",
    symbol: "XAG/USD",
    displayName: "Silver",
    assetClass: "preciousMetal",
    baseAsset: "XAG",
    quoteAsset: "USD",
    capabilities: ["quote"],
    rank: 1,
    venue: "spot",
  };
}

function binanceDogeCandidate(
  providerSymbol: string,
  quoteAsset: "USDT" | "USDC" | "FDUSD",
): InstrumentCandidate {
  return {
    sourceId: "binance-vision",
    providerSymbol,
    symbol: `DOGE/${quoteAsset}`,
    displayName: `DOGE / ${quoteAsset}`,
    assetClass: "crypto",
    baseAsset: "DOGE",
    quoteAsset,
    capabilities: ["quote"],
    rank: null,
    venue: "Binance",
  };
}

function coinGeckoXagSubstringCandidate(
  providerSymbol: string,
  baseAsset: string,
  rank: number,
): InstrumentCandidate {
  return {
    sourceId: "coingecko",
    providerSymbol,
    symbol: `${baseAsset}/USD`,
    displayName: providerSymbol,
    assetClass: "crypto",
    baseAsset,
    quoteAsset: "USD",
    capabilities: ["quote"],
    rank,
    venue: null,
  };
}

function disabledSearchConfig(): string {
  return `version: 1
egressProfiles:
  direct: { name: direct, proxyUrl: null, userAgent: test, followRedirects: false, maxRedirects: 0, connectTimeoutMs: 100, requestTimeoutMs: 100 }
  corp: { name: corp, proxyUrl: null, userAgent: test, followRedirects: false, maxRedirects: 0, connectTimeoutMs: 100, requestTimeoutMs: 100 }
  vpn: { name: vpn, proxyUrl: null, userAgent: test, followRedirects: false, maxRedirects: 0, connectTimeoutMs: 100, requestTimeoutMs: 100 }
sources:
  - id: coingecko
    adapter: coingecko
    baseUrl: https://api.coingecko.com/api/v3
    authRef: null
    egressProfile: vpn
    egressFallback: [corp]
    userAgent: test
    followRedirects: false
    capabilities: [instrumentSearch, quote]
    defaultBinding: { cadenceSeconds: 30, staleAfterSeconds: 120, egressProfile: vpn }
    params: { vsCurrency: usd, days: 1 }
    rateLimit: { requestsPerSecond: 1, burst: 1, quotaPerDay: null, retryAfterHeader: true }
    enabled: false
sections:
  - id: crypto
    title: 加密货币
    order: 10
    match: { assetClasses: [crypto], capabilities: [] }
    widgetKinds: [quote-card]
  - id: other
    title: 其他
    order: 1000
    match: { assetClasses: [], capabilities: [] }
    widgetKinds: [quote-card]
instruments: []
symbolMaps: []
intel:
  enabled: false
  sources: []
  pollingSeconds: 300
  dedup: { canonicalizeTrackingParams: true, simHashDistance: 3, minHashJaccard: 0.85 }
  llmRouteId: unused
llm: { providers: [], routes: {} }
accounts: []
`;
}

function goldSearchConfig(): string {
  return disabledSearchConfig()
    .replaceAll("coingecko", "gold-api")
    .replace("enabled: false", "enabled: true")
    .replace("capabilities: [instrumentSearch, quote]", "capabilities: [instrumentSearch, quote]")
    .replace("params: { vsCurrency: usd, days: 1 }", "params: { metal: XAU, quoteAsset: USD, unit: troy_ounce }")
    .replace("id: crypto\n    title: 加密货币", "id: metals\n    title: 黄金")
    .replace("assetClasses: [crypto]", "assetClasses: [preciousMetal]");
}

function dogeSearchConfig(): string {
  return `version: 1
egressProfiles:
  direct: { name: direct, proxyUrl: null, userAgent: test, followRedirects: false, maxRedirects: 0, connectTimeoutMs: 100, requestTimeoutMs: 100 }
  corp: { name: corp, proxyUrl: null, userAgent: test, followRedirects: false, maxRedirects: 0, connectTimeoutMs: 100, requestTimeoutMs: 100 }
  vpn: { name: vpn, proxyUrl: null, userAgent: test, followRedirects: false, maxRedirects: 0, connectTimeoutMs: 100, requestTimeoutMs: 100 }
sources:
  - id: coingecko
    adapter: coingecko
    baseUrl: https://api.coingecko.com/api/v3
    authRef: null
    egressProfile: vpn
    egressFallback: [corp]
    userAgent: test
    followRedirects: false
    capabilities: [instrumentSearch, quote]
    defaultBinding: { cadenceSeconds: 30, staleAfterSeconds: 120, egressProfile: vpn }
    params: { vsCurrency: usd, days: 1 }
    rateLimit: { requestsPerSecond: 1, burst: 1, quotaPerDay: null, retryAfterHeader: true }
    enabled: true
  - id: binance-vision
    adapter: binance-vision
    baseUrl: https://data-api.binance.vision
    authRef: null
    egressProfile: vpn
    egressFallback: [corp]
    userAgent: test
    followRedirects: false
    capabilities: [instrumentSearch, quote]
    defaultBinding: { cadenceSeconds: 30, staleAfterSeconds: 120, egressProfile: vpn }
    params: { interval: 1m, limit: 50 }
    rateLimit: { requestsPerSecond: 1, burst: 1, quotaPerDay: null, retryAfterHeader: true }
    enabled: true
  - id: massive-stocks
    adapter: massive-stocks
    baseUrl: https://api.massive.com
    authRef: env:MASSIVE_API_KEY
    egressProfile: vpn
    egressFallback: [corp]
    userAgent: test
    followRedirects: false
    capabilities: [instrumentSearch, quote]
    defaultBinding: { cadenceSeconds: 30, staleAfterSeconds: 1200, egressProfile: vpn }
    params: { adjusted: true, timeframe: 1d, historyYears: 5, limit: 50000 }
    rateLimit: { requestsPerSecond: 1, burst: 1, quotaPerDay: null, retryAfterHeader: true }
    enabled: false
sections:
  - id: crypto
    title: 加密货币
    order: 10
    match: { assetClasses: [crypto], capabilities: [] }
    widgetKinds: [quote-card]
  - id: equity
    title: 股票
    order: 20
    match: { assetClasses: [equity], capabilities: [] }
    widgetKinds: [quote-card]
  - id: other
    title: 其他
    order: 1000
    match: { assetClasses: [], capabilities: [] }
    widgetKinds: [quote-card]
instruments: []
symbolMaps: []
intel:
  enabled: false
  sources: []
  pollingSeconds: 300
  dedup: { canonicalizeTrackingParams: true, simHashDistance: 3, minHashJaccard: 0.85 }
  llmRouteId: unused
llm: { providers: [], routes: {} }
accounts: []
`;
}

async function invokeApi(
  method: "GET" | "POST",
  url: string,
  body: unknown,
  deps: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  const request = Readable.from(chunks) as unknown as { method: string; url: string; headers: Record<string, string> };
  request.method = method;
  request.url = url;
  request.headers = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" };
  let status = 0;
  let responseBody = "";
  const response = {
    set statusCode(value: number) { status = value; },
    get statusCode() { return status; },
    setHeader: () => undefined,
    end: (value: string) => { responseBody = value; },
  };
  await handleRequest(request as never, response as never, deps as never);
  return { status, body: JSON.parse(responseBody) as Record<string, unknown> };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

async function jsonFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(process.cwd(), "tests", "fixtures", name), "utf8")) as unknown;
}
