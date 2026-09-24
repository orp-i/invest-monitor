import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  FreshnessSchema,
  InstrumentSchema,
  QuoteSchema,
  replayMovingAverage,
  summarizePortfolio,
  type PositionLedgerTransaction,
} from "@invest/domain";
import { loadConfigFile } from "@invest/config";
import { createStorageDriver, type StorageDriver } from "@invest/storage";
import { handleRequest } from "../../apps/server/src/app.js";
import { formatDecimal } from "../../apps/web/src/format.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("F2 moving weighted average", () => {
  it("keeps sell fees out of average cost and matches the exact acceptance fixture", () => {
    const transactions = [
      trade("buy-1", "buy", "1", "100", "1", 1),
      trade("buy-2", "buy", "1", "120", "1", 2),
      trade("sell-1", "sell", "1", "150", "1", 3),
    ];

    expect(replayMovingAverage(transactions.slice(0, 1))).toMatchObject({
      quantity: "1", costBasis: "101", averageCost: "101", realizedPnl: "0",
    });
    expect(replayMovingAverage(transactions.slice(0, 2))).toMatchObject({
      quantity: "2", costBasis: "222", averageCost: "111", realizedPnl: "0",
    });
    expect(replayMovingAverage(transactions)).toMatchObject({
      quantity: "1", costBasis: "111", averageCost: "111", realizedPnl: "38",
    });
  });

  it("forces Q/C/A to exact zero after selling the final unit", () => {
    const projection = replayMovingAverage([
      trade("buy", "buy", "1", "100", "1", 1),
      trade("sell", "sell", "1", "150", "1", 2),
    ]);
    expect(projection).toMatchObject({ quantity: "0", costBasis: "0", averageCost: "0", realizedPnl: "48" });
    expect(projection && summarizePortfolio([{ ...projection, markPrice: "150", markQuoteAsset: "USD" }], []).positionsCount).toBe(0);
  });

  it("mirrors the formula for a short fixture while keeping Q negative", () => {
    const opened = replayMovingAverage([trade("short", "sell", "2", "100", "1", 1)]);
    expect(opened).toMatchObject({ quantity: "-2", costBasis: "-200", averageCost: "100", realizedPnl: "-1" });

    const partiallyCovered = replayMovingAverage([
      trade("short", "sell", "2", "100", "1", 1),
      trade("cover", "buy", "1", "80", "1", 2),
    ]);
    expect(partiallyCovered).toMatchObject({ quantity: "-1", costBasis: "-100", averageCost: "100", realizedPnl: "18" });
  });

  it("keeps gross dividends and negative withholding tax as separate rows and totals net income", () => {
    const position = replayMovingAverage([trade("buy", "buy", "1", "100", "0", 1)]);
    expect(position).not.toBeNull();
    if (!position) return;
    const transactions = [
      cash("gross", "dividend", "10", 2),
      cash("tax", "withholding_tax", "-3", 3),
    ];
    const summary = summarizePortfolio([{ ...position, markPrice: null, markQuoteAsset: "USD" }], transactions);
    expect(transactions.map((transaction) => transaction.type)).toEqual(["dividend", "withholding_tax"]);
    expect(summary.costSubtotals[0]).toMatchObject({ grossDividend: "10", withholdingTax: "-3", netIncome: "7" });
    expect(summary.costSubtotals[0]?.netIncome).not.toBe(summary.costSubtotals[0]?.grossDividend);
  });
});

describe("F2 SQLite projection", () => {
  it.each(["node-sqlite", "better-sqlite3"] as const)("auto-creates manual and fully replays after historical deletion with %s", async (kind) => {
    const { storage, path } = await storageFixture(kind);
    try {
      const verifier = new DatabaseSync(path);
      try {
        expect(verifier.prepare(`
          SELECT id, adapter_id, mode, reporting_currency, enabled FROM accounts WHERE id = 'manual'
        `).get()).toMatchObject({ id: "manual", adapter_id: "manual", mode: "manual", reporting_currency: "USD", enabled: 1 });
      } finally {
        verifier.close();
      }
      await storage.createTransaction("buy-1", write("buy", "1", "100", "1", 1));
      await storage.createTransaction("buy-2", write("buy", "1", "120", "1", 2));
      await storage.createTransaction("sell-1", write("sell", "1", "150", "1", 3));
      expect((await storage.getPositionProjections())[0]).toMatchObject({
        quantity: "1", costBasis: "111", averageCost: "111", realizedPnl: "38", quoteAsset: "USD",
      });

      expect(await storage.deleteTransaction("buy-1")).toBe(true);
      const remaining = await storage.getTransactions();
      const expected = replayMovingAverage(remaining);
      expect((await storage.getPositionProjections())[0]).toMatchObject(expected ?? {});

      await expect(storage.createTransaction("mixed-currency", {
        ...write("buy", "1", "90", "0", 4),
        currency: "USDT",
      })).rejects.toThrow("mixed transaction currencies");
      expect((await storage.getPositionProjections())[0]).toMatchObject(expected ?? {});
    } finally {
      await storage.close();
    }
  });
});

describe("F2 HTTP and UI contracts", () => {
  it("keeps a candle collection failure separate from quote freshness", async () => {
    const fixture = await configuredStorage();
    try {
      await fixture.storage.appendQuotes([binanceQuote()]);
      const observedAt = new Date().toISOString();
      for (const capability of ["quote", "candle"]) await fixture.storage.recordSourceHealth({
        sourceId: "binance-vision", capability, observedAt, status: capability === "quote" ? "healthy" : "down",
        successRate: "1", p50LatencyMs: 10, p95LatencyMs: 20, quotaUsed: null, circuitState: "closed",
        lastSuccessAt: observedAt, lastError: null, clockSkewMedianMs: 0, clockSkewStatus: "normal", clockSkewToleranceMs: 2000, egressProfileUsed: "corp",
      });
      const response = await invokeApi("GET", "/api/quotes?instrumentId=btc-usd", undefined, fixture.deps);
      const quote = (response.body.quotes as Array<Record<string, unknown>>).find(row => row.sourceId === "binance-vision");
      expect(quote).toMatchObject({ sourceHealth: { capability: "quote", status: "healthy" }, freshness: { status: "live" } });
    } finally { await fixture.storage.close(); }
  });
  it("returns null unrealized PnL for unavailable quotes, then keeps USD cost and USDT marks separate", async () => {
    const fixture = await configuredStorage();
    try {
      await fixture.storage.createTransaction("buy", write("buy", "1", "100", "1", 1));
      const unavailable = await invokeApi("GET", "/api/positions", undefined, fixture.deps);
      expect(unavailable.status).toBe(200);
      expect((unavailable.body.positions as Array<Record<string, unknown>>)[0]).toMatchObject({
        quoteAsset: "USD", markPrice: null, unrealizedPnl: null,
        freshness: expect.objectContaining({ status: "unavailable" }),
      });
      expect(formatDecimal(null, 2)).toBe("—");

      const staleCapturedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      await fixture.storage.appendQuotes([binanceQuote(staleCapturedAt)]);
      const stale = await invokeApi("GET", "/api/positions", undefined, fixture.deps);
      expect((stale.body.positions as Array<Record<string, unknown>>)[0]).toMatchObject({
        markPrice: "110",
        unrealizedPnl: "9",
        freshness: expect.objectContaining({ status: "stale", capturedAt: staleCapturedAt }),
      });

      await fixture.storage.appendQuotes([binanceQuote()]);
      const marked = await invokeApi("GET", "/api/positions", undefined, fixture.deps);
      expect((marked.body.positions as Array<Record<string, unknown>>)[0]).toMatchObject({
        quoteAsset: "USD", markQuoteAsset: "USDT", markPrice: "110", marketValue: "110", unrealizedPnl: "9",
      });
      const summary = await invokeApi("GET", "/api/pnl/summary", undefined, fixture.deps);
      expect(summary.body).toMatchObject({
        canCombine: false,
        combinedTotals: null,
        costSubtotals: [{ currency: "USD", costBasis: "101" }],
        valuationSubtotals: [{ currency: "USDT", marketValue: "110", unrealizedPnl: "9" }],
      });
      expect(summary.body.explanation).toContain("未使用 FX");
      expect(summary.body.explanation).toContain("1:1");
    } finally {
      await fixture.storage.close();
    }
  });

  it("exposes account, research, and manual ledger sections with generic widgets", async () => {
    const fixture = await configuredStorage();
    try {
      const view = await invokeApi("GET", "/api/view", undefined, fixture.deps);
      const sections = view.body.sections as Array<{ title: string; panels: Array<{ widgets: Array<{ kind: string }> }> }>;
      expect(sections.map((section) => section.title)).toEqual(["总览", "持仓", "券商", "宏观研究与判断", "交易复盘", "加密货币", "股票", "期权", "黄金", "情报", "设置", "系统"]);
      expect(sections[1]?.panels[0]?.widgets.map((widget) => widget.kind)).toEqual([
        "pnl-summary", "transaction-form", "position-table", "transaction-history",
      ]);
    } finally {
      await fixture.storage.close();
    }
  });

  it("supports transaction CRUD and applies CSRF to every write", async () => {
    const fixture = await configuredStorage();
    try {
      const rejected = await invokeApi("POST", "/api/transactions", write("buy", "1", "100", "1", 1), fixture.deps, false);
      expect(rejected.status).toBe(403);

      const created = await invokeApi("POST", "/api/transactions", write("buy", "1", "100", "1", 1), fixture.deps);
      expect(created.status).toBe(201);
      const transaction = created.body.transaction as { id: string };
      const listed = await invokeApi("GET", "/api/transactions?instrumentId=btc-usd&from=0&to=10", undefined, fixture.deps);
      expect(listed.body.transactions).toHaveLength(1);

      const patched = await invokeApi("PATCH", `/api/transactions/${transaction.id}`, { price: "120" }, fixture.deps);
      expect(patched.status).toBe(200);
      expect(patched.body.transaction).toMatchObject({ price: "120" });

      expect((await invokeApi("POST", "/api/transactions", {
        instrumentId: "btc-usd", type: "dividend", quantity: "10", price: null,
        fees: "0", currency: "USD", tradeAtMs: 2,
      }, fixture.deps)).status).toBe(201);
      expect((await invokeApi("POST", "/api/transactions", {
        instrumentId: "btc-usd", type: "withholding_tax", quantity: "-3", price: null,
        fees: "0", currency: "USD", tradeAtMs: 3,
      }, fixture.deps)).status).toBe(201);
      expect((await fixture.storage.getTransactions()).map((row) => row.type)).toEqual([
        "buy", "dividend", "withholding_tax",
      ]);
      expect((await invokeApi("GET", "/api/pnl/summary", undefined, fixture.deps)).body.costSubtotals).toEqual([
        expect.objectContaining({ grossDividend: "10", withholdingTax: "-3", netIncome: "7" }),
      ]);

      const deleted = await invokeApi("DELETE", `/api/transactions/${transaction.id}`, undefined, fixture.deps);
      expect(deleted.status).toBe(200);
      expect((await fixture.storage.getPositionProjections())).toHaveLength(0);
    } finally {
      await fixture.storage.close();
    }
  });
});

function trade(
  id: string,
  type: "buy" | "sell",
  quantity: string,
  price: string,
  fees: string,
  tradeAtMs: number,
): PositionLedgerTransaction {
  return { id, accountId: "manual", instrumentId: "btc-usd", type, quantity, price, fees, currency: "USD", tradeAtMs };
}

function cash(
  id: string,
  type: "dividend" | "withholding_tax",
  quantity: string,
  tradeAtMs: number,
): PositionLedgerTransaction {
  return { id, accountId: "manual", instrumentId: "btc-usd", type, quantity, price: null, fees: "0", currency: "USD", tradeAtMs };
}

function write(type: "buy" | "sell", quantity: string, price: string, fees: string, tradeAtMs: number) {
  return { accountId: "manual", instrumentId: "btc-usd", type, quantity, price, fees, currency: "USD", tradeAtMs } as const;
}

async function storageFixture(kind: "node-sqlite" | "better-sqlite3"): Promise<{ storage: StorageDriver; path: string }> {
  const directory = await temporaryDirectory("invest-f2-storage-");
  const path = join(directory, "f2.sqlite");
  const storage = createStorageDriver(kind, path);
  await storage.open();
  await storage.migrate();
  await storage.upsertInstrument(InstrumentSchema.parse({
    id: "btc-usd",
    assetClass: "crypto",
    symbol: "BTC/USD",
    displayName: "Bitcoin",
    venue: null,
    baseAsset: "BTC",
    quoteAsset: "USD",
    contractMultiplier: "1",
    underlyingId: null,
    precision: { priceScale: 2, quantityScale: 8 },
    tags: [],
    active: true,
    metadata: {},
  }), 1);
  return { storage, path };
}

async function configuredStorage() {
  const directory = await temporaryDirectory("invest-f2-api-");
  const storage = createStorageDriver("node-sqlite", join(directory, "f2.sqlite"));
  await storage.open();
  await storage.migrate();
  const loaded = await loadConfigFile("config/portfolio.yaml");
  if (!loaded.ok) throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
  await storage.syncConfigInstruments(loaded.config.instruments.map((instrument) => ({
    ...instrument,
    origin: "config" as const,
    shadowed: false,
  })), 1);
  const snapshot = {
    config: loaded.config,
    generation: 1,
    sha256: "fixture",
    loadedAt: new Date().toISOString(),
  };
  const deps = {
    configManager: { snapshot },
    storage,
    scheduler: {
      sourceCapabilityAvailable: () => true,
      sourceFreshnessClass: () => "realtime",
      sourceAuthConfigured: () => true,
    },
    authMode: "off",
    authToken: null,
  };
  return { storage, deps };
}

function binanceQuote(capturedAt = new Date().toISOString()) {
  const stale = Date.now() - Date.parse(capturedAt) > 120_000;
  const freshness = FreshnessSchema.parse({
    capturedAt,
    receivedAt: capturedAt,
    clockSkewMs: 0,
    clockSkewToleranceMs: 2_000,
    skewSuspected: false,
    freshnessBasis: "capturedAt",
    staleAfterSeconds: 120,
    isStale: stale,
    status: stale ? "stale" : "live",
  });
  return QuoteSchema.parse({
    instrumentId: "btc-usd",
    sourceId: "binance-vision",
    providerSymbol: "BTCUSDT",
    price: "110",
    bid: null,
    ask: null,
    mid: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    previousClose: null,
    volume: null,
    quoteAsset: "USDT",
    convertedTo: null,
    capturedAt,
    receivedAt: capturedAt,
    freshness,
    quality: "authoritative",
    rawRef: null,
  });
}

async function invokeApi(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body: unknown,
  deps: unknown,
  csrf = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  request.method = method;
  request.url = url;
  request.headers = {
    "content-type": "application/json",
    ...(csrf ? { "x-requested-with": "XMLHttpRequest" } : {}),
  };
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
