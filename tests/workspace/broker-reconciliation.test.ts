import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { accountPerformance, BrokerSnapshotSchema, withBrokerExecutionDetails, tradingCaseMetrics, type BrokerTrade, type ReviewFill } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { pairedReviewFills, syncAutomaticTradingCases } from "../../apps/server/src/auto-trading-review.js";
import { availableReviewFills, currentTradingCases, tradingReviewRequest } from "../../apps/server/src/trading-review.js";
import { brokerWorkspaceData } from "../../apps/server/src/broker-status.js";

const at = "2026-09-11T07:00:00Z";
const trade = (id: string, side: "buy" | "sell", price: string, netCash: string, extra: Partial<BrokerTrade> = {}): BrokerTrade => ({ id, externalId: null, side, price, quantity: "1", fees: "0.35", currency: "USD", symbol: "SPY260910P00758000", tradedAt: "2026-09-10", timePrecision: "day", assetType: "option", netCash, ...extra });
const rows = [trade("buy", "buy", "1.73", "-173.46"), trade("sell", "sell", "0.77", "76.87", { fees: "0" })];
const account = (trades = rows) => BrokerSnapshotSchema.parse({ broker: "tradier", accountId: "test", environment: "live", asOf: at, syncedAt: at, currency: "USD", equity: "500", unrealizedPnl: "0", sessionRealizedPnl: "-96", positions: [], trades, notes: [] });
const fill = (id: string, side: "buy" | "sell", occurredAt: string, overrides: Partial<ReviewFill> = {}): ReviewFill => ({ id, transactionId: id, source: "tradier", symbol: "TEST", instrumentKey: "account-1:TEST", side, quantity: "1", price: "1", feeCost: "0", multiplier: "1", currency: "USD", occurredAt, timePrecision: "instant", ...overrides });

describe("broker settlement reconciliation", () => {
  it("counts expired-option round trips using settlement cash without inventing a multiplier or deducting commission twice", () => {
    const value = accountPerformance([account()], [], new Map(), at);
    expect(value).toMatchObject({ realizedNet: "-96.59", totalNet: "-96.59", fees: "0.35", unallocatedFees: "0", fills: 2 });
    expect(value.missing.join()).toContain("费用明细仅已知佣金");
  });
  it("uses verified adjusted contract sizes and extracts total expenses while preserving commission", () => {
    const a = account([trade("open", "buy", "2", "-20.48", { multiplier: "10" }), trade("close", "sell", "3", "29.51")]);
    const enriched = withBrokerExecutionDetails([a], [])[0]!;
    expect(enriched.trades.map(t => [t.multiplier, t.totalFees, t.fees])).toEqual([["10", "0.48", "0.35"], ["10", "0.49", "0.35"]]);
    expect(accountPerformance([a], [], new Map(), at)).toMatchObject({ realizedNet: "9.03", fees: "0.97", unallocatedFees: "0" });
  });
  it("values an unmarked opening from reconciled inventory and includes settlement expenses", () => {
    const a = account([trade("open", "buy", "1.09", "-109.11", { fees: "0", multiplier: "100" })]);
    a.positions = [{ id: "p", symbol: rows[0]!.symbol, quantity: "1", currency: "USD", multiplier: "100", costBasis: "109", marketValue: "102", unrealizedPnl: "-7" }];
    expect(accountPerformance([a], [], new Map([[rows[0]!.symbol, "1.02"]]), "2026-09-10T20:00:00Z")).toMatchObject({ realizedNet: "0", unrealizedNet: "-7.11", fees: "0.11", unallocatedFees: "0", valuedPositions: 1, complete: true });
  });
  it("supports partial exits on distinct dates without assigning an arbitrary same-day order", () => {
    const a = account([trade("open", "buy", "1", "-200.5", { multiplier: "100", quantity: "2", tradedAt: "2026-09-08" }), trade("close", "sell", "1.5", "149.5", { tradedAt: "2026-09-09" })]);
    a.positions = [{ id: "p", symbol: rows[0]!.symbol, quantity: "1", currency: "USD", multiplier: "100", costBasis: "100", marketValue: "120", unrealizedPnl: "20" }];
    expect(accountPerformance([a], [], new Map([[rows[0]!.symbol, "1.2"]]), "2026-09-10T20:00:00Z")).toMatchObject({ realizedNet: "49.25", unrealizedNet: "19.75", totalNet: "69", fees: "1", unallocatedFees: "0" });
    a.trades[1]!.tradedAt = "2026-09-08";
    expect(accountPerformance([a], [], new Map(), at).complete).toBe(false);
  });
  it("uses a missing-history holding's reported P&L with an explicit coverage note", () => {
    const a = account([]); a.positions = [{ id: "p", symbol: "SFD", quantity: "1", currency: "USD", costBasis: "20", marketValue: "23", unrealizedPnl: "3" }];
    expect(accountPerformance([a], [], new Map(), at)).toMatchObject({ unrealizedNet: "3", valuedPositions: 1, complete: false });
  });
  it("does not net trades across accounts or mix unsupported currencies", () => {
    const first = account([rows[0]!]), second = { ...account([rows[1]!]), accountId: "different" };
    expect(accountPerformance([first, second], [], new Map(), at).realizedNet).toBe("0");
    expect(accountPerformance([{ ...account(), trades: rows.map(t => ({ ...t, currency: "EUR" })) }], [], new Map(), at)).toMatchObject({ realizedNet: "0", complete: false });
  });
});
describe("automatic review pairs", () => {
  it("separates exact round trips, supports shorts and keeps ambiguous day-only executions together", () => {
    const f = [fill("a", "sell", "2026-09-01T10:00:00Z", { positionEffect: "open" }), fill("b", "buy", "2026-09-01T11:00:00Z", { positionEffect: "close" }), fill("c", "buy", "2026-09-02" , {timePrecision: "day"}), fill("d", "sell", "2026-09-02", {timePrecision: "day"})];
    expect(pairedReviewFills(f).map(g => g.map(f => f.id))).toEqual([["a", "b"], ["c", "d"]]);
    expect(pairedReviewFills([f[0]!, { ...f[1]!, instrumentKey: "another-account" }])).toHaveLength(1); // explicit open only
    expect(pairedReviewFills([fill("close-only", "sell", at, { positionEffect: "close" })])).toHaveLength(0);
  });
  it.each(["node-sqlite", "better-sqlite3"] as const)("creates pairs once, enriches saved reviews, and aligns cumulative account totals with %s", async driver => {
    const dir = await mkdtemp(join(tmpdir(), "broker-reconcile-"));
    const storage = createStorageDriver(driver, join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      await storage.saveBrokerSnapshots([account()]);
      await Promise.all([syncAutomaticTradingCases(storage), syncAutomaticTradingCases(storage)]);
      const cases = await currentTradingCases(storage); expect(cases).toHaveLength(1);
      expect(tradingCaseMetrics(cases[0]!)).toMatchObject({ state: "closed", netPnl: "-96.59" });
      const original = (await storage.getTradingCases())[0]!;
      await storage.updateTradingCase(original.id, c => ({ ...c, historyComplete: false }));
      expect(tradingCaseMetrics((await currentTradingCases(storage))[0]!)).toMatchObject({ state: "closed", netPnl: "-96.59" });
      expect((await storage.getTradingCases())[0]!.historyComplete).toBe(false);

      const workspace = await brokerWorkspaceData(storage);
      expect(workspace.accounts[0]).toMatchObject({ computedRealizedNet: "-96.59", sessionRealizedPnl: "-96", performance: { realizedNet: "-96.59" } });
      const response = await tradingReviewRequest("POST", `/api/trading-review/cases/${original.id}/assessments`, {curveIds:[],psychologyIds:[],planQuality:"unknown",executionQuality:"unknown",findings:"真实结算现金核对",nextBehavior:"核对费用",evidenceIds:[]}, storage);
      expect(response.status).toBe(200);
      await syncAutomaticTradingCases(storage);
      expect((await storage.getTradingCases())[0]!.assessments).toHaveLength(1);
      expect((await storage.getTradingCases())[0]!.assessments[0]!.stage).toBe("retrospective");
      expect(await availableReviewFills(storage)).toHaveLength(2);
    } finally { await storage.close(); await rm(dir, {recursive: true, force: true}); }
  });
});
