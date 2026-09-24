import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { accountPerformance, brokerFeeTotals, withConfirmedBrokerFees, BrokerSnapshotSchema, type StatementImport } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { loadConfigFile } from "@invest/config";
import { syncHeldInstruments } from "../../apps/server/src/held-instruments.js";

const at = "2026-09-05T12:00:00Z";
const position = (symbol = "AAPL", quantity = "2", multiplier = "1") => ({ id: symbol, symbol, quantity, multiplier, currency: "USD", costBasis: "201", marketValue: "220", unrealizedPnl: "19", assetType: "STK" });
const trade = (id: string, side: "buy" | "sell", price: string, quantity = "2", symbol = "AAPL") => ({ id, externalId: id, symbol, side, quantity, price, fees: "1", feeCurrency: "USD", multiplier: "1", currency: "USD", tradedAt: `2026-09-0${id === "sell" ? "2" : "1"}T14:00:00Z`, timePrecision: "instant" as const, assetType: "STK", positionEffect: side === "buy" ? "open" as const : "close" as const });
const account = (broker: "ibkr" | "tradier" | "elephant", positions: any[], trades: any[]) => BrokerSnapshotSchema.parse({ broker, accountId: broker + "-test", environment: broker === "tradier" ? "live" : "statement", asOf: "2026-09-04", syncedAt: at, currency: "USD", equity: "500", cash: "280", unrealizedPnl: null, sessionRealizedPnl: null, positions, trades, notes: [] });
function statement(broker: string, fills: any[]): StatementImport {
  return { id: "file", sha256: "a".repeat(64), fileName: "synthetic.pdf", importedAt: at, broker, grossTotal: "0", netCash: "0", feesTotal: "0", notes: [], fills: fills.map(f => ({ id: f.id, transactionId: f.id, source: "statement", instrumentKey: f.symbol, symbol: f.symbol, side: f.side, quantity: f.quantity, price: f.price, feeCost: f.fees, multiplier: f.multiplier, currency: "USD", occurredAt: f.tradedAt, timePrecision: f.timePrecision, provenance: { fileName: "synthetic.pdf", fileSha256: "a".repeat(64), page: 1, row: 1, broker, action: f.positionEffect, grossAmount: f.grossAmount ?? String(Number(f.price) * Number(f.quantity)), netCash: "0", feeBreakdown: { commission: f.fees }, originalTime: f.tradedAt, originalTimezone: "UTC", settlementDate: "2026-09-03" } })) };
}

describe("USD account performance and held instruments", () => {
  it("deducts IBKR's negative commission once, even when report cost already includes it", () => {
    const a = account("ibkr", [position()], [{ ...trade("buy", "buy", "100"), fees: "-1" }]);
    const value = accountPerformance([a], [], new Map([["AAPL", "110"]]), at);
    expect(value).toMatchObject({ totalNet: "19", unrealizedNet: "19", realizedNet: "0", fees: "1", unallocatedFees: "0", complete: true });
  });
  it("deduplicates API/confirmation executions before calculating realized profit and fees", () => {
    const buy = trade("buy", "buy", "100"), sell = trade("sell", "sell", "110");
    const a = account("tradier", [], [buy, sell]);
    const value = accountPerformance([a], [statement("Tradier", [buy, sell])], new Map(), at);
    expect(value).toMatchObject({ totalNet: "18", realizedNet: "18", fees: "2", fills: 2, duplicateFills: 2, complete: true });
  });
  it("uses the confirmed cent amount for fractional shares instead of inventing a multiplier", () => {
    const buy = { ...trade("fraction", "buy", "698", "0.3444", "QQQ"), fees: "0.99", grossAmount: "240.39" };
    const a = account("elephant", [position("QQQ", "0.3444")], [buy]);
    const value = accountPerformance([a], [statement("大象", [buy])], new Map([["QQQ", "710"]]), at);
    expect(value).toMatchObject({ totalNet: "3.144", unrealizedNet: "3.144", fees: "0.99", duplicateFills: 1, complete: true });
  });
  it("includes confirmation transaction and additional fees without double-counting API commission", () => {
    const rows = [trade("buy", "buy", "100"), trade("sell", "sell", "110")].map(t => ({ ...t, fees: "0.35" }));
    const a = account("tradier", [], rows);
    const confirmation = statement("Tradier", rows.map(t => ({ ...t, fees: "0.47" })));
    for (const f of confirmation.fills) f.provenance!.feeBreakdown = { commission: "0.35", transactionFee: "0.03", additionalFees: "0.09" };
    expect(accountPerformance([a], [confirmation], new Map(), at)).toMatchObject({ totalNet: "19.06", fees: "0.94", fills: 2, duplicateFills: 2, complete: true });
    const enriched = withConfirmedBrokerFees([a], [confirmation, confirmation])[0]!;
    expect(brokerFeeTotals(enriched)[0]).toMatchObject({ total: "0.94", trades: 2 });
    expect(enriched.trades[0]).toMatchObject({ id: "buy", fees: "0.35", statementFees: "0.47" });
    expect(a.trades[0]!.statementFees).toBeUndefined();
    const twoAccounts = [a, { ...a, accountId: "another-real-account" }];
    expect(withConfirmedBrokerFees(twoAccounts, [confirmation])).toBe(twoAccounts);
  });
  it("keeps short-position signs and expenses correct", () => {
    const open = { ...trade("short", "sell", "150", "1"), positionEffect: "open", fees: "2" };
    const a = account("elephant", [position("AAPL", "-1")], [open]);
    const value = accountPerformance([a], [], new Map([["AAPL", "140"]]), at);
    expect(value).toMatchObject({ totalNet: "8", unrealizedNet: "8", fees: "2", unallocatedFees: "0", complete: true });
  });
  it("does not turn missing cost or expired-option marks into zero profit, but still counts paid fees", () => {
    const a = account("elephant", [{ ...position(), costBasis: null }], [trade("buy", "buy", "100")]);
    const value = accountPerformance([a], [], new Map(), at);
    expect(value).toMatchObject({ totalNet: "-1", unrealizedNet: "0", fees: "1", unallocatedFees: "1", valuedPositions: 0, complete: false });
    expect(value.missing.join()).toContain("Tradier");
  });
  it("keeps sandbox balances and fees out of real account totals", () => {
    const sandbox = { ...account("tradier", [position()], [trade("buy", "buy", "100")]), environment: "sandbox" as const };
    expect(accountPerformance([sandbox], [], new Map([["AAPL", "110"]]), at)).toMatchObject({ fees: "0", positions: 0, equity: "0", fills: 0 });
  });
  it.each(["node-sqlite", "better-sqlite3"] as const)("adds every verified nonzero holding once and persists USD history with %s", async driver => {
    const dir = await mkdtemp(join(tmpdir(), "held-performance-"));
    const storage = createStorageDriver(driver, join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      const loaded = await loadConfigFile("config/portfolio.yaml"); if (!loaded.ok) throw Error("config invalid");
      await storage.syncConfigInstruments(loaded.config.instruments.map(i => ({ ...i, origin: "config" as const, shadowed: false })), Date.now());
      const option = { ...position("NVDA301220P00250000", "-2", "10"), assetType: "OPT" };
      await storage.saveBrokerSnapshots([account("elephant", [position("NOK", "13"), option, position("ZERO", "0")], []), account("ibkr", [position("NOK", "1")], [])]);
      await syncHeldInstruments(loaded.config, storage); await syncHeldInstruments(loaded.config, storage);
      const held = await storage.getUserInstruments(); expect(held).toHaveLength(2);
      expect(held.find(i => i.assetClass === "option")).toMatchObject({ contractMultiplier: "10", active: true, watch: true, symbol: option.symbol });
      expect(held.every(i => i.sourceBindings.every(b => b.sourceId.startsWith("tradier")))).toBe(true);
      const sample = { capturedAt: at, totalNet: "-10", realizedNet: "2", unrealizedNet: "-12", fees: "1", basis: "stable", complete: true };
      await storage.savePerformanceSample(sample); await storage.savePerformanceSample({ ...sample, capturedAt: "2026-09-05T12:01:00Z", totalNet: "-9" });
      await storage.close(); await storage.open();
      expect(await storage.getPerformanceHistory()).toEqual([{ ...sample, capturedAt: "2026-09-05T12:01:00Z", totalNet: "-9" }]);
    } finally { await storage.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
