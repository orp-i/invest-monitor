import { describe, expect, it } from "vitest";
import {
  contractOf, reviewExecutionDetails, sopInferEffects, validateMergeAdvice, MergeAdviceValidationError, SOP_INFERRED_SUFFIX, SAME_DAY_SUFFIX, MERGE_SOP_RULES,
  type MergeAdviceInput, type MergeAdviceOutput, type ReviewFill, type TradingCase,
} from "@invest/domain";

const cash = (side: "buy" | "sell", price: string) => side === "buy" ? (-(Number(price) * 100) - 0.11).toFixed(2) : (Number(price) * 100 - 0.13).toFixed(2);
const fill = (id: string, symbol: string, side: "buy" | "sell", price: string, day = "2026-09-25", extra: Partial<ReviewFill> = {}): ReviewFill => ({
  id, transactionId: id, source: "tradier", symbol, instrumentKey: `acct:${symbol}`, accountKey: "acct", side, quantity: "1", price, feeCost: "0", multiplier: null,
  currency: "USD", occurredAt: day, timePrecision: "day", netCash: cash(side, price), sourceLabel: "TRADIER", ...extra,
});
const entry = (id: string, fills: ReviewFill[]): TradingCase => ({ id, title: id, strategy: "自动开平仓配对（意图待复盘）", horizon: "unspecified", instrumentType: "option", fillIds: fills.map(f => f.id), historyComplete: true, fills,
  createdAt: "2026-09-25T20:00:00.000Z", updatedAt: "2026-09-25T20:00:00.000Z", plans: [], evidence: [], events: [], assessments: [], linkHistory: [] });
// Two same-day round trips of a 770/771 call debit spread as Tradier reports them: dates only, no flags, no multiplier.
const spread = [fill("a", "SPY260925C00770000", "buy", "0.42"), fill("b", "SPY260925C00770000", "sell", "0.89"), fill("c", "SPY260925C00770000", "buy", "0.45"), fill("d", "SPY260925C00770000", "sell", "0.65"),
  fill("e", "SPY260925C00771000", "buy", "0.53"), fill("f", "SPY260925C00771000", "buy", "0.35"), fill("g", "SPY260925C00771000", "sell", "0.23"), fill("h", "SPY260925C00771000", "sell", "0.24")];

describe("review SOP", () => {
  it("applies the SOP-4 debit-spread default only to user-confirmed groupings without broker flags", () => {
    const d = reviewExecutionDetails(entry("user-merged", spread));
    expect(d.direction).toBe(`看多认购价差（买低卖高行权价）${SOP_INFERRED_SUFFIX}`); expect(d.sop).toMatchObject({ rule: "SOP-4" }); expect(d.sop!.note).toContain("770 为多头腿"); expect(d.sop!.note).toContain("2 轮");
    expect(d.actions.a).toBe("买入开仓（多头）（SOP 推断）"); expect(d.actions.b).toBe("卖出平仓（多头）（SOP 推断）"); expect(d.actions.g).toBe("卖出开仓（空头）（SOP 推断）"); expect(d.actions.e).toBe("买入平仓（空头回补）（SOP 推断）");
    expect(d.legs.find(l => l.symbol.endsWith("770000"))).toMatchObject({ direction: "long", openingQuantity: "2", openingPrice: "0.435", closingPrice: "0.77", pnl: "66.52" });
    expect(d.legs.find(l => l.symbol.endsWith("771000"))).toMatchObject({ direction: "short", openingQuantity: "2", openingPrice: "0.235", closingPrice: "0.44", pnl: "-41.48" });
    // Automatic cases never use the default; a broker flag anywhere switches it off (flags win over the SOP).
    expect(reviewExecutionDetails(entry("auto-case-x", spread)).direction).toBe("结构方向待核实");
    expect(sopInferEffects(spread.map((f, i) => i === 0 ? { ...f, positionEffect: "open" as const } : f))).toBeNull();
    // Puts: the higher strike carries the premium and is the long leg.
    const puts = spread.map(f => ({ ...f, symbol: f.symbol.replace("C0077", "P0077"), instrumentKey: f.instrumentKey.replace("C0077", "P0077") }));
    expect(reviewExecutionDetails(entry("user-puts", puts)).direction).toBe(`看空认沽价差（买高卖低行权价）${SOP_INFERRED_SUFFIX}`);
    // Mixed option types, unbalanced legs, instants or a third contract are left to broker evidence.
    expect(sopInferEffects(spread.map(f => f.id === "e" ? { ...f, symbol: "SPY260925P00771000" } : f))).toBeNull();
    expect(sopInferEffects(spread.slice(0, 6))).toBeNull();
    expect(sopInferEffects(spread.map(f => ({ ...f, occurredAt: "2026-09-25T14:00:00.000Z", timePrecision: "instant" as const })))).toBeNull();
    expect(sopInferEffects([...spread, fill("i", "SPY260925C00775000", "buy", "0.05"), fill("j", "SPY260925C00775000", "sell", "0.19")])).toBeNull();
    expect(MERGE_SOP_RULES.some(r => r.startsWith("SOP-4"))).toBe(true);
  });
  it("treats date-ordered openings inside a user grouping as confirmed so multi-day spreads are recognized", () => {
    const legs = [fill("o1", "SPY260925C00772000", "buy", "0.55", "2026-09-24"), fill("c1", "SPY260925C00772000", "sell", "0.21"), fill("o2", "SPY260925C00775000", "sell", "0.19", "2026-09-24"), fill("c2", "SPY260925C00775000", "buy", "0.05")];
    const d = reviewExecutionDetails(entry("user-two-days", legs));
    expect(d.direction).toBe(`看多认购价差（买低卖高行权价）${SAME_DAY_SUFFIX}`); expect(d.sop).toBeNull();
    expect(d.actions.o1).toBe("买入开仓（多头）"); expect(d.actions.c2).toBe("买入平仓（空头回补）");
    expect(reviewExecutionDetails(entry("auto-case-two-days", legs)).direction).toBe("多腿组合 · 方向分别见各腿");
  });
  it("recomputes money, balance, structure and merge feasibility from the fills and rejects unknown ids", () => {
    const input: MergeAdviceInput = { schemaVersion: 1, sopVersion: "test", assembledAt: "2026-09-26T00:00:00.000Z", sop: [], clusters: [], warnings: [],
      cases: [{ ref: "C1", id: "A", title: "A", strategy: "auto", createdAt: "2026-09-25T00:00:00Z", userConfirmed: false, reviewed: false, structure: "", fillIds: ["a", "b", "c", "d"] }, { ref: "C2", id: "B", title: "B", strategy: "auto", createdAt: "2026-09-25T00:00:01Z", userConfirmed: false, reviewed: false, structure: "", fillIds: ["e", "f", "g", "h"] }],
      fills: spread.map((f, i) => ({ ref: `F${i + 1}`, id: f.id, symbol: f.symbol, contract: contractOf(f.symbol), side: f.side, quantity: f.quantity, price: f.price, netCash: f.netCash!, feeCost: f.feeCost, multiplier: null, day: "2026-09-25", timePrecision: "day" as const, occurredAt: "2026-09-25", positionEffect: null, lotId: null, orderGroupId: null, broker: "TRADIER", caseId: f.symbol.endsWith("770000") ? "A" : "B", caseTitle: null })) };
    const output: MergeAdviceOutput = { summary: "两腿同日两轮认购价差", limitations: [], proposals: [{ id: "p1", kind: "merge", caseIds: ["A", "B"], fillIds: spread.map(f => f.id), structure: "看多认购价差", direction: "bullish",
      legs: [{ symbol: "SPY260925C00770000", role: "long", openFillIds: ["a", "c"], closeFillIds: ["b", "d"] }, { symbol: "SPY260925C00771000", role: "short", openFillIds: ["g", "h"], closeFillIds: ["e", "f"] }], rounds: 2, confidence: "medium", rationale: "按 SOP-4 借方价差", sopRules: ["SOP-4", "SOP-5"], warnings: [] }] };
    const [view] = validateMergeAdvice(output, input);
    expect(view).toMatchObject({ netCash: "25.04", actionable: { targetCaseId: "A", sourceCaseIds: ["B"] } });
    expect(view!.verifiedStructure).toContain("看多认购价差"); expect(view!.checks[0]).toContain("已平衡");
    // Short refs are mapped back to ids, so the model never has to repeat 64-character hashes.
    const byRef = validateMergeAdvice({ ...output, proposals: [{ ...output.proposals[0]!, caseIds: ["C1", "C2"], fillIds: spread.map((_, i) => `F${i + 1}`), legs: [{ symbol: "SPY260925C00770000", role: "long", openFillIds: ["F1", "F3"], closeFillIds: ["F2", "F4"] }, { symbol: "SPY260925C00771000", role: "short", openFillIds: ["F7", "F8"], closeFillIds: ["F5", "F6"] }] }] }, input)[0]!;
    expect(byRef.fillIds).toEqual(spread.map(f => f.id)); expect(byRef.caseIds).toEqual(["A", "B"]); expect(byRef.actionable).toEqual({ targetCaseId: "A", sourceCaseIds: ["B"] }); expect(byRef.verifiedStructure).toContain("看多认购价差");
    expect(() => validateMergeAdvice({ ...output, proposals: [{ ...output.proposals[0]!, fillIds: [...output.proposals[0]!.fillIds, "zzz"] }] }, input)).toThrow(MergeAdviceValidationError);
    expect(() => validateMergeAdvice({ ...output, proposals: [{ ...output.proposals[0]!, legs: [{ symbol: "x", role: "long", openFillIds: ["nope"], closeFillIds: [] }] }] }, input)).toThrow(MergeAdviceValidationError);
    // The reviewed case becomes the target; two reviewed cases cannot be merged automatically; partial coverage is not actionable.
    expect(validateMergeAdvice(output, { ...input, cases: input.cases.map(c => c.id === "B" ? { ...c, reviewed: true } : c) })[0]!.actionable).toEqual({ targetCaseId: "B", sourceCaseIds: ["A"] });
    expect(validateMergeAdvice(output, { ...input, cases: input.cases.map(c => ({ ...c, reviewed: true })) })[0]!.actionable).toBeNull();
    const partial = validateMergeAdvice({ ...output, proposals: [{ ...output.proposals[0]!, fillIds: spread.slice(0, 6).map(f => f.id), legs: [] }] }, input)[0]!;
    expect(partial.actionable).toBeNull(); expect(partial.checks.join(" ")).toContain("未平仓");
  });
});
