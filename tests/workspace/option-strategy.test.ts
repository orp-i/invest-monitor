import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { baseStrategyLabel, identifyStrategy, optionIdentity, SAME_DAY_EVIDENCE_SUFFIX, SAME_DAY_SUFFIX, type StrategyLeg } from "@invest/domain";

const leg = (type: "P" | "C", strike: number, direction: "long" | "short", quantity = "1"): StrategyLeg => ({
  symbol: `XYZ260918${type}${String(strike * 1000).padStart(8, "0")}`, direction,
  openingQuantity: quantity, multiplier: "100", openingAt: "2026-09-01T15:00:00Z", broker: "test", currency: "USD",
});
const invert = (legs: StrategyLeg[]): StrategyLeg[] => legs.map(l => ({ ...l, direction: l.direction === "long" ? "short" : "long" }));
// Expiration intrinsic cash values provide an independent check of the shape;
// entry premiums/fees add a constant and do not change directional classification.
const payoff = (legs: StrategyLeg[], stock: number) => legs.reduce((sum, l) => {
  const o = optionIdentity(l.symbol)!;
  const intrinsic = Decimal.max(0, o.type === "P" ? new Decimal(o.strike).minus(stock) : new Decimal(stock).minus(o.strike));
  return sum.plus(intrinsic.mul(l.openingQuantity).mul(l.multiplier!).mul(l.direction === "long" ? 1 : -1));
}, new Decimal(0));

describe("OptionStrat structural classification", () => {
  it.each([
    ["P", "long", "bearish", "long-put"], ["P", "short", "bullish", "short-put"],
    ["C", "long", "bullish", "long-call"], ["C", "short", "bearish", "short-call"],
  ] as const)("classifies %s %s by underlying exposure", (type, side, direction, slug) => {
    const legs = [leg(type, 100, side)];
    expect(identifyStrategy(legs)).toMatchObject({ marketDirection: direction, referenceUrl: `https://optionstrat.com/build/${slug}` });
    expect(payoff(legs, 110).comparedTo(payoff(legs, 90))).toBe(direction === "bullish" ? 1 : -1);
  });
  it.each(["P", "C"] as const)("classifies both %s vertical directions with monotone expiration values", type => {
    const bearish = [leg(type, 90, "short"), leg(type, 110, "long")];
    for (const legs of [bearish, invert(bearish)]) {
      const direction = identifyStrategy(legs).marketDirection;
      expect(direction).toBe(legs[0]!.direction === "short" ? "bearish" : "bullish");
      expect(payoff(legs, 120).comparedTo(payoff(legs, 80))).toBe(direction === "bullish" ? 1 : -1);
    }
  });
  it.each([100, 110])("distinguishes two-sided movement from range structures at call strike %s", callStrike => {
    const long = [leg("P", 100, "long"), leg("C", callStrike, "long")];
    expect(identifyStrategy(long)).toMatchObject({ marketDirection: "volatility", label: callStrike === 100 ? "双向波动 · 买入跨式" : "双向波动 · 买入宽跨式" });
    expect(identifyStrategy(invert(long)).marketDirection).toBe("neutral");
    for (const edge of [80, 130]) expect(payoff(long, edge).gt(payoff(long, 105))).toBe(true);
  });
  it.each(["P", "C"] as const)("recognizes 1:2:1 %s butterflies and their inverses", type => {
    const butterfly = [leg(type, 90, "long"), leg(type, 100, "short", "2"), leg(type, 110, "long")];
    expect(identifyStrategy(butterfly).marketDirection).toBe("neutral");
    expect(identifyStrategy(invert(butterfly)).marketDirection).toBe("volatility");
    for (const edge of [80, 120]) expect(payoff(butterfly, 100).gt(payoff(butterfly, edge))).toBe(true);
    butterfly[1]!.openingQuantity = "1"; expect(identifyStrategy(butterfly).referenceUrl).toBeNull();
    butterfly[1] = leg(type, 95, "short", "2"); expect(identifyStrategy(butterfly).referenceUrl).toBeNull();
  });
  it.each([100, 110])("recognizes iron butterfly/condor and inverse with inner call strike %s", callStrike => {
    const iron = [leg("P", 90, "long"), leg("P", 100, "short"), leg("C", callStrike, "short"), leg("C", 120, "long")];
    expect(identifyStrategy(iron)).toMatchObject({ marketDirection: "neutral", label: callStrike === 100 ? "中性区间 · 铁蝶" : "中性区间 · 铁鹰" });
    expect(identifyStrategy(invert(iron)).marketDirection).toBe("volatility");
    for (const edge of [80, 130]) expect(payoff(iron, 100).gt(payoff(iron, edge))).toBe(true);
    expect(identifyStrategy([...iron].reverse())).toEqual(identifyStrategy(iron));
  });
  it("recognizes broker-flagged same-day openings and uniform unknown sizes on a standard root, never a mixed or adjusted size", () => {
    const a = { ...leg("C", 770, "long"), symbol: "SPY260925C00770000", openingAt: null, openingDay: "2026-09-25", openingConfirmed: true, multiplier: null };
    const b = { ...leg("C", 771, "short"), symbol: "SPY260925C00771000", openingAt: null, openingDay: "2026-09-25", openingConfirmed: true, multiplier: null };
    expect(identifyStrategy([a, b]).referenceUrl).toBeNull();
    const evidence = identifyStrategy([a, b], { sameDayEvidence: true });
    expect(evidence).toMatchObject({ timing: "same-day", marketDirection: "bullish", referenceUrl: "https://optionstrat.com/build/bull-call-spread" });
    expect(evidence.label.endsWith(SAME_DAY_EVIDENCE_SUFFIX)).toBe(true);
    expect(baseStrategyLabel(evidence.label)).toBe("看多认购价差（买低卖高行权价）");
    expect(identifyStrategy([a, b], { sameDayEvidence: true, sameDayConfirmed: true }).label.endsWith(SAME_DAY_SUFFIX)).toBe(true);
    expect(identifyStrategy([a, b].map(l => ({ ...l, symbol: l.symbol.replace("SPY", "SPY1") })), { sameDayEvidence: true }).referenceUrl).toBeNull();
    expect(identifyStrategy([{ ...a, multiplier: "100" }, b], { sameDayEvidence: true }).referenceUrl).toBeNull();
    expect(identifyStrategy([a, { ...b, openingConfirmed: false }], { sameDayEvidence: true }).referenceUrl).toBeNull();
    expect(identifyStrategy([a, { ...b, openingDay: "2026-09-24" }], { sameDayEvidence: true }).referenceUrl).toBeNull();
  });
  it("does not guess calendar, ratio, cross-currency, unknown-size or independently opened structures", () => {
    const a = leg("P", 90, "short"), b = leg("P", 110, "long");
    for (const change of [{ symbol: b.symbol.replace("260918", "261016") }, { openingQuantity: "2" }, { currency: "HKD" }, { broker: "other" }, { multiplier: null }, { multiplier: "10" }, { openingAt: null }, { openingAt: "2026-09-02T15:00:00Z" }, { direction: "unknown" as const }]) {
      expect(identifyStrategy([a, { ...b, ...change }]).referenceUrl).toBeNull();
    }
    expect(identifyStrategy([leg("P", 110, "long"), leg("C", 90, "long")]).referenceUrl).toBeNull(); // Guts, not a strangle.
  });
});

describe("same-day recognition for user-confirmed groupings", () => {
  const dayLeg = (type: "P" | "C", strike: number, direction: "long" | "short", extra: Partial<StrategyLeg> = {}): StrategyLeg => ({ ...leg(type, strike, direction), openingAt: null, openingDay: "2026-09-16", openingConfirmed: true, ...extra });
  it("keeps the strict rule by default and recognizes same-day explicit openings only when confirmed", () => {
    const spread = [dayLeg("C", 55, "long"), dayLeg("C", 65, "short")];
    expect(identifyStrategy(spread)).toMatchObject({ label: "多腿组合 · 方向分别见各腿", referenceUrl: null, timing: null });
    const relaxed = identifyStrategy(spread, { sameDayConfirmed: true });
    expect(relaxed).toMatchObject({ marketDirection: "bullish", referenceUrl: "https://optionstrat.com/build/bull-call-spread", timing: "same-day" });
    expect(relaxed.label).toBe("看多认购价差（买低卖高行权价） · 按同日开仓识别（用户已确认）");
    expect(identifyStrategy([leg("C", 55, "long"), leg("C", 65, "short")], { sameDayConfirmed: true })).toMatchObject({ timing: "exact", label: "看多认购价差（买低卖高行权价）" });
  });
  it("still refuses different days, unconfirmed openings, different expiries and single legs", () => {
    expect(identifyStrategy([dayLeg("C", 55, "long"), dayLeg("C", 65, "short", { openingDay: "2026-09-17" })], { sameDayConfirmed: true }).timing).toBeNull();
    expect(identifyStrategy([dayLeg("C", 55, "long"), dayLeg("C", 65, "short", { openingConfirmed: false })], { sameDayConfirmed: true }).timing).toBeNull();
    expect(identifyStrategy([dayLeg("C", 55, "long"), { ...dayLeg("C", 65, "short"), symbol: "XYZ261218C00065000" }], { sameDayConfirmed: true }).timing).toBeNull();
    expect(identifyStrategy([dayLeg("P", 100, "long")], { sameDayConfirmed: true })).toMatchObject({ timing: "exact", referenceUrl: "https://optionstrat.com/build/long-put" });
  });
  it("applies the same-day tier to user groupings and to broker-flagged automatic cases, each with its own suffix", async () => {
    const { reviewExecutionDetails, userConfirmedGrouping } = await import("@invest/domain");
    const fill = (id: string, symbol: string, side: "buy" | "sell") => ({ id, transactionId: id, source: "tradier" as const, symbol, instrumentKey: symbol, side, quantity: "1", price: "1", feeCost: "0", multiplier: "100", currency: "USD", occurredAt: "2026-09-16", timePrecision: "day" as const, positionEffect: "open" as const });
    const fills = [fill("a", "UCO261016C00055000", "buy"), fill("c", "UCO261016C00065000", "sell")];
    const base = { title: "t", strategy: "s", horizon: "swing" as const, instrumentType: "option" as const, fillIds: ["a", "c"], historyComplete: true, fills, createdAt: "", updatedAt: "", plans: [], evidence: [], events: [], assessments: [] };
    const manual = { ...base, id: "user-case", linkHistory: [] };
    const merged = { ...base, id: "auto-case-x", linkHistory: [{ recordedAt: "", fillIds: ["c"], historyComplete: true, mergedFrom: [{ id: "auto-case-y", title: "y", fillIds: ["c"] }] }] };
    const automatic = { ...merged, pairingBasis: "自动合并：同一多腿订单" };
    const untouched = { ...base, id: "auto-case-z", linkHistory: [] };
    expect([manual, merged, automatic, untouched].map(userConfirmedGrouping)).toEqual([true, true, false, false]);
    expect(reviewExecutionDetails(manual).strategy.timing).toBe("same-day");
    expect(reviewExecutionDetails(manual).strategy.label.endsWith(SAME_DAY_SUFFIX)).toBe(true);
    expect(reviewExecutionDetails(merged).strategy.label).toBe(`看多认购价差（买低卖高行权价）${SAME_DAY_SUFFIX}`);
    // Automatic cases whose every fill carries a broker open/close flag are recognized too, labelled as broker evidence.
    expect(reviewExecutionDetails(automatic).strategy.label).toBe(`看多认购价差（买低卖高行权价）${SAME_DAY_EVIDENCE_SUFFIX}`);
    expect(reviewExecutionDetails(untouched).strategy).toMatchObject({ timing: "same-day", label: expect.stringContaining(SAME_DAY_EVIDENCE_SUFFIX) });
    const unflagged = { ...untouched, fills: fills.map((f, i) => i === 1 ? { ...f, positionEffect: null } : f) };
    expect(reviewExecutionDetails(unflagged).strategy.timing).toBeNull();
  });
});
