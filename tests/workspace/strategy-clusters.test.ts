import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerSnapshotSchema, clusterReviewGroups, mergeSuggestions, type BrokerTrade, type ReviewFill, type TradingCase } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { pairedReviewFills, syncAutomaticTradingCases } from "../../apps/server/src/auto-trading-review.js";
import { currentTradingCases, tradingReviewRequest } from "../../apps/server/src/trading-review.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const fill = (id: string, symbol: string, side: "buy" | "sell", occurredAt: string, overrides: Partial<ReviewFill> = {}): ReviewFill => ({
  id, transactionId: id, source: "tradier", symbol, instrumentKey: `acct:${symbol}`, accountKey: "acct", side, quantity: "1", price: "1", feeCost: "0", multiplier: "100", currency: "USD",
  occurredAt, timePrecision: occurredAt.length > 10 ? "instant" : "day", sourceLabel: "TRADIER", ...overrides,
});
const T0 = "2026-09-16T14:31:02.000Z", T1 = "2026-09-17T15:00:00.000Z";
const vertical = (suffix = "", extra: Partial<ReviewFill> = {}) => [
  fill(`a${suffix}`, "UCO261016C00055000", "buy", T0, { positionEffect: "open", ...extra }), fill(`b${suffix}`, "UCO261016C00055000", "sell", T1, { positionEffect: "close" }),
  fill(`c${suffix}`, "UCO261016C00065000", "sell", T0, { positionEffect: "open", ...extra }), fill(`d${suffix}`, "UCO261016C00065000", "buy", T1, { positionEffect: "close" }),
];

describe("strategy clusters", () => {
  it("merges legs of one multi-leg order automatically, whatever the structure, and never across accounts", () => {
    const legs = [...vertical("", { orderGroupId: "900" }), fill("x", "UCO261218C00070000", "buy", "2026-09-16T14:31:02.000Z", { positionEffect: "open", orderGroupId: "900" })];
    const [cluster] = clusterReviewGroups(pairedReviewFills(legs));
    expect(cluster).toMatchObject({ evidence: "order", autoMerge: true, underlying: "UCO" }); expect(cluster!.groups).toHaveLength(3);
    expect(cluster!.basis).toContain("订单 900"); expect(cluster!.structure.recognized).toBe(false);
    const other = clusterReviewGroups(pairedReviewFills([...vertical("", { orderGroupId: "900" }).slice(0, 2), ...vertical("-2", { orderGroupId: "900" }).slice(2).map(f => ({ ...f, accountKey: "other", instrumentKey: "other:" + f.symbol }))]));
    expect(other).toHaveLength(2); expect(other.every(c => c.evidence === null)).toBe(true);
  });
  it("merges same-second openings only when the structure is recognized, otherwise suggests", () => {
    const [spread] = clusterReviewGroups(pairedReviewFills(vertical()));
    expect(spread).toMatchObject({ evidence: "instant", autoMerge: true });
    expect(spread!.structure).toMatchObject({ recognized: true, label: expect.stringContaining("认购价差") });
    const calendar = [...vertical().slice(0, 2), fill("e", "UCO261218C00065000", "sell", T0, { positionEffect: "open" }), fill("f", "UCO261218C00065000", "buy", T1, { positionEffect: "close" })];
    const [diagonal] = clusterReviewGroups(pairedReviewFills(calendar));
    expect(diagonal).toMatchObject({ evidence: "instant", autoMerge: false }); expect(diagonal!.structure.recognized).toBe(false); expect(diagonal!.basis).toContain("仅建议合并");
    const staggered = vertical().map(f => f.id === "d" ? { ...f, occurredAt: "2026-09-18T15:00:00.000Z" } : f);
    expect(clusterReviewGroups(pairedReviewFills(staggered)).map(c => c.evidence)).toEqual([null, null]);
  });
  it("treats unflagged day-precision fills as a suggestion only, with a shape hint for vertical-looking legs", () => {
    const day = [fill("a", "SPY260914P00761000", "buy", "2026-09-14"), fill("b", "SPY260914P00761000", "sell", "2026-09-14"), fill("c", "SPY260914P00757000", "sell", "2026-09-14"), fill("d", "SPY260914P00757000", "buy", "2026-09-14")];
    const [cluster] = clusterReviewGroups(pairedReviewFills(day));
    expect(cluster).toMatchObject({ evidence: "day", autoMerge: false }); expect(cluster!.basis).toContain("需人工确认"); expect(cluster!.basis).toContain("形态符合认沽价差"); expect(cluster!.structure.recognized).toBe(false);
    // Legs of different option types or unmatched quantities get no shape hint.
    const strangle = day.map(f => f.symbol.endsWith("757000") ? { ...f, symbol: "SPY260914C00757000", instrumentKey: "acct:SPY260914C00757000" } : f);
    expect(clusterReviewGroups(pairedReviewFills(strangle))[0]!.basis).not.toContain("形态符合");
    // Still-open legs flagged by the broker on the same day are recognized and merged; without flags they stay a suggestion.
    const open = [fill("a", "UCO261016C00055000", "buy", "2026-09-16", { positionEffect: "open" }), fill("c", "UCO261016C00065000", "sell", "2026-09-16", { positionEffect: "open" })];
    expect(clusterReviewGroups(pairedReviewFills(open))[0]).toMatchObject({ evidence: "structure", autoMerge: true, structure: { recognized: true, label: expect.stringContaining("看多认购价差") } });
    // Open legs without an explicit open flag are not even paired, so nothing is clustered.
    expect(clusterReviewGroups(pairedReviewFills(open.map(f => ({ ...f, positionEffect: null }))))).toEqual([]);
  });
  it("merges day-aligned legs once every fill carries a broker open/close flag and the structure is recognized", () => {
    const spyLeg = (symbol: string, rows: [id: string, side: "buy" | "sell", price: string, effect?: "open" | "close", lot?: string][]) =>
      rows.map(([id, side, price, effect, lot]) => fill(id, symbol, side, "2026-09-25", { price, multiplier: null, positionEffect: effect ?? null, lotId: lot ?? null }));
    // Two same-day round trips of a 770/771 call debit spread, as Tradier reports them: dates only, no multiplier.
    const unflagged = [...spyLeg("SPY260925C00770000", [["a", "buy", "0.42"], ["b", "sell", "0.89"], ["c", "buy", "0.45"], ["d", "sell", "0.65"]]), ...spyLeg("SPY260925C00771000", [["e", "buy", "0.53"], ["f", "buy", "0.35"], ["g", "sell", "0.23"], ["h", "sell", "0.24"]])];
    const [pending] = clusterReviewGroups(pairedReviewFills(unflagged));
    expect(pending).toMatchObject({ evidence: "day", autoMerge: false }); expect(pending!.basis).toContain("形态符合认购价差"); expect(pending!.basis).toContain("T+1");
    const flagged = [...spyLeg("SPY260925C00770000", [["a", "buy", "0.42", "open", "L1"], ["b", "sell", "0.89", "close", "L1"], ["c", "buy", "0.45", "open", "L2"], ["d", "sell", "0.65", "close", "L2"]]), ...spyLeg("SPY260925C00771000", [["e", "buy", "0.53", "close", "S1"], ["f", "buy", "0.35", "close", "S2"], ["g", "sell", "0.23", "open", "S2"], ["h", "sell", "0.24", "open", "S1"]])];
    const [merged] = clusterReviewGroups(pairedReviewFills(flagged));
    expect(merged).toMatchObject({ evidence: "structure", autoMerge: true, structure: { recognized: true } });
    expect(merged!.structure.label).toContain("看多认购价差"); expect(merged!.structure.label).toContain("券商开平标记");
    expect(merged!.basis).toContain("各腿 2 个批次"); expect(merged!.basis).toContain("未拆分为独立轮次"); expect(merged!.basis).not.toContain("按同日开仓识别");
    // A known size on one leg is never assumed equal to an unknown one; adjusted roots are not assumed standard.
    expect(clusterReviewGroups(pairedReviewFills(flagged.map(f => f.symbol.endsWith("770000") ? { ...f, multiplier: "100" } : f)))[0]).toMatchObject({ evidence: "day", autoMerge: false });
    expect(clusterReviewGroups(pairedReviewFills(flagged.map(f => ({ ...f, symbol: f.symbol.replace("SPY", "SPY1"), instrumentKey: f.instrumentKey.replace("SPY", "SPY1") }))))[0]).toMatchObject({ evidence: "day", autoMerge: false });
    // A shared middle strike with both long and short lots (two spreads sharing 768) is not a structure and stays a suggestion.
    const shared = [...spyLeg("SPY260924C00766000", [["m1", "buy", "0.57", "open", "A"], ["m2", "sell", "0.81", "close", "A"]]), ...spyLeg("SPY260924C00768000", [["m3", "buy", "0.33", "open", "B"], ["m4", "sell", "0.17", "close", "B"], ["m5", "sell", "0.32", "open", "C"], ["m6", "buy", "0.22", "close", "C"]]), ...spyLeg("SPY260924C00769000", [["m7", "sell", "0.18", "open", "D"], ["m8", "buy", "0.10", "close", "D"]])].map(f => ({ ...f, occurredAt: "2026-09-24" }));
    expect(clusterReviewGroups(pairedReviewFills(shared))[0]).toMatchObject({ evidence: "day", autoMerge: false, structure: { recognized: false, label: "包含多空转换" } });
    // A third unrelated same-day leg breaks the vertical shape: no merge.
    const third = [...flagged, ...spyLeg("SPY260925C00775000", [["t1", "buy", "0.05", "open", "T"], ["t2", "sell", "0.19", "close", "T"]])];
    expect(clusterReviewGroups(pairedReviewFills(third))[0]).toMatchObject({ evidence: "day", autoMerge: false });
  });
  it("suggests merging split unreviewed cases into the reviewed or earliest one", () => {
    const legs = vertical();
    const make = (id: string, fills: ReviewFill[], extra: Partial<TradingCase> = {}): TradingCase => ({ id, title: id, strategy: "自动开平仓配对（意图待复盘）", horizon: "unspecified", instrumentType: "option", fillIds: fills.map(f => f.id), historyComplete: true, fills, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z", plans: [], evidence: [], events: [], assessments: [], linkHistory: [], ...extra });
    const older = make("older", legs.slice(0, 2), { createdAt: "2026-09-16T00:00:00.000Z" }), newer = make("newer", legs.slice(2));
    expect(mergeSuggestions([older, newer], pairedReviewFills(legs))).toEqual([expect.objectContaining({ targetCaseId: "older", sourceCaseIds: ["newer"], evidence: "instant" })]);
    const reviewed = { ...newer, assessments: [{ id: "a", recordedAt: "2026-09-18T00:00:00.000Z", stage: "provisional" as const, basisFillIds: [], basisPlanId: null, curveIds: [], psychologyIds: [], planQuality: "unknown" as const, executionQuality: "unknown" as const, findings: "x", nextBehavior: "y", evidenceIds: [] }] };
    expect(mergeSuggestions([older, reviewed], pairedReviewFills(legs))).toEqual([expect.objectContaining({ targetCaseId: "newer", sourceCaseIds: ["older"] })]);
    expect(mergeSuggestions([{ ...older, assessments: reviewed.assessments }, reviewed], pairedReviewFills(legs))).toEqual([]);
    expect(mergeSuggestions([make("whole", legs)], pairedReviewFills(legs))).toEqual([]);
  });
});

describe("automatic multi-leg cases", () => {
  const at = "2026-09-17T16:00:00.000Z";
  const trade = (id: string, symbol: string, side: "buy" | "sell", tradedAt: string, netCash: string, extra: Partial<BrokerTrade> = {}): BrokerTrade => ({ id, externalId: null, symbol, side, quantity: "1", price: "1", fees: "0", currency: "USD", tradedAt, timePrecision: "day", assetType: "option", multiplier: "100", netCash, ...extra });
  const snapshot = (trades: BrokerTrade[]) => BrokerSnapshotSchema.parse({ broker: "tradier", accountId: "A", environment: "live", asOf: at, syncedAt: at, currency: "USD", equity: "1", unrealizedPnl: "0", sessionRealizedPnl: "0", positions: [], trades, notes: [] });
  // A 1:2 ratio is not a recognized structure, so day-aligned flagged legs stay separate until the order id arrives.
  const legsDay = [trade("o1", "UCO261016C00055000", "buy", "2026-09-16", "-355", { positionEffect: "open" }), trade("o2", "UCO261016C00065000", "sell", "2026-09-16", "268", { positionEffect: "open", quantity: "2" })];
  const withOrder = legsDay.map(t => ({ ...t, orderGroupId: "900", orderId: `${t.id}-leg`, executedAt: "2026-09-16T14:31:02.000Z", effectSource: "order" as const }));
  it.each(["node-sqlite", "better-sqlite3"] as const)("creates one case per order cluster, merges earlier unreviewed legs once evidence arrives, and leaves reviewed cases as suggestions with %s", async driver => {
    const dir = await mkdtemp(join(tmpdir(), "auto-strategy-")); dirs.push(dir);
    const storage = createStorageDriver(driver, join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      await storage.saveBrokerSnapshots([snapshot(legsDay)]);
      await syncAutomaticTradingCases(storage);
      expect((await storage.getTradingCases()).map(c => c.fills.length).sort()).toEqual([1, 1]);
      await storage.saveBrokerSnapshots([snapshot(withOrder)]);
      await syncAutomaticTradingCases(storage); await syncAutomaticTradingCases(storage);
      const [merged] = await storage.getTradingCases();
      expect(await storage.getTradingCases()).toHaveLength(1);
      expect(merged).toMatchObject({ strategy: "自动开平仓配对（意图待复盘）", instrumentType: "option" });
      expect(merged!.title).toContain("UCO"); expect(merged!.pairingBasis).toContain("自动合并"); expect(merged!.pairingBasis).toContain("订单 900");
      expect(merged!.fills.map(f => f.symbol).sort()).toEqual(["UCO261016C00055000", "UCO261016C00065000"]);
      // Stored fills keep their recorded day precision; the read view carries the order evidence.
      expect(merged!.fills.every(f => f.timePrecision === "day")).toBe(true);
      expect((await currentTradingCases(storage))[0]!.fills.every(f => f.timePrecision === "instant" && f.orderGroupId === "900" && f.occurredAt === "2026-09-16T14:31:02.000Z")).toBe(true);
      expect(merged!.linkHistory.at(-1)?.mergedFrom).toHaveLength(1);
      const review = await tradingReviewRequest("GET", "/api/trading-review", undefined, storage);
      expect((review.body as { suggestions: unknown[] }).suggestions).toEqual([]);
      // A reviewed leg is never merged automatically; the other leg is offered as a suggestion instead.
      // Different expiries: no recognized same-day structure, so the legs stay apart until an order id links them.
      const spy = [trade("s1", "SPY261016P00600000", "buy", "2026-09-17", "-100", { positionEffect: "open", orderGroupId: "901", executedAt: "2026-09-17T14:00:00.000Z" }), trade("s2", "SPY261120P00590000", "sell", "2026-09-17", "50", { positionEffect: "open" })];
      await storage.saveBrokerSnapshots([snapshot([...withOrder, ...spy])]);
      await syncAutomaticTradingCases(storage);
      const spyCases = (await storage.getTradingCases()).filter(c => c.fills.some(f => f.symbol.startsWith("SPY")));
      expect(spyCases).toHaveLength(2);
      const reviewedCase = spyCases.find(c => c.fills[0]!.symbol.endsWith("600000"))!;
      expect((await tradingReviewRequest("POST", `/api/trading-review/cases/${reviewedCase.id}/assessments`, { curveIds: [], psychologyIds: [], planQuality: "unknown", executionQuality: "unknown", findings: "结论", nextBehavior: "改进", evidenceIds: [] }, storage)).status).toBe(200);
      await storage.saveBrokerSnapshots([snapshot([...withOrder, ...spy.map(t => ({ ...t, orderGroupId: "901", executedAt: "2026-09-17T14:00:00.000Z" }))])]);
      await syncAutomaticTradingCases(storage);
      expect((await storage.getTradingCases()).filter(c => c.fills.some(f => f.symbol.startsWith("SPY")))).toHaveLength(2);
      const after = await tradingReviewRequest("GET", "/api/trading-review", undefined, storage);
      expect((after.body as { suggestions: { targetCaseId: string; sourceCaseIds: string[]; evidence: string }[] }).suggestions).toEqual([expect.objectContaining({ targetCaseId: reviewedCase.id, evidence: "order" })]);
    } finally { await storage.close(); }
  });
  it("merges split day-only legs once broker lot flags make the same-day structure recognizable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-structure-")); dirs.push(dir);
    const storage = createStorageDriver("node-sqlite", join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      const day = "2026-09-25";
      const legs = [trade("v1", "SPY260925C00770000", "buy", day, "-42.11", { price: "0.42" }), trade("v2", "SPY260925C00770000", "sell", day, "88.87", { price: "0.89" }), trade("v3", "SPY260925C00771000", "sell", day, "23.87", { price: "0.24" }), trade("v4", "SPY260925C00771000", "buy", day, "-53.11", { price: "0.53" })];
      await storage.saveBrokerSnapshots([snapshot(legs)]); await syncAutomaticTradingCases(storage);
      expect((await storage.getTradingCases()).map(c => c.fills.length).sort()).toEqual([2, 2]);
      const pending = await tradingReviewRequest("GET", "/api/trading-review", undefined, storage);
      const suggestions = (pending.body as { suggestions: { evidence: string; basis: string }[] }).suggestions;
      expect(suggestions).toEqual([expect.objectContaining({ evidence: "day" })]); expect(suggestions[0]!.basis).toContain("形态符合认购价差");
      // T+1: Tradier gainloss lots flag every fill; the split unreviewed cases become one recognized spread.
      const flagged = legs.map(t => ({ ...t, positionEffect: t.id === "v1" || t.id === "v3" ? "open" as const : "close" as const, lotId: t.symbol.endsWith("770000") ? "lot:a" : "lot:b", effectSource: "lot" as const }));
      await storage.saveBrokerSnapshots([snapshot(flagged)]); await syncAutomaticTradingCases(storage);
      const cases = await storage.getTradingCases();
      expect(cases).toHaveLength(1);
      expect(cases[0]!.pairingBasis).toContain("自动合并"); expect(cases[0]!.pairingBasis).toContain("看多认购价差"); expect(cases[0]!.pairingBasis).toContain("券商");
      expect(cases[0]!.title).toContain("看多认购价差"); expect(cases[0]!.title).not.toContain("按同日开仓识别");
      expect(cases[0]!.fills.map(f => f.symbol).sort()).toEqual(["SPY260925C00770000", "SPY260925C00770000", "SPY260925C00771000", "SPY260925C00771000"]);
      expect((await tradingReviewRequest("GET", "/api/trading-review", undefined, storage)).body).toMatchObject({ suggestions: [] });
    } finally { await storage.close(); }
  });
});
