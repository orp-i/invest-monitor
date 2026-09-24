import { Decimal } from "decimal.js";
import { tradierSymbol } from "./market-data.js";

export type PositionDirection = "long" | "short" | "mixed" | "unknown";
export type MarketDirection = "bullish" | "bearish" | "neutral" | "volatility" | "mixed" | "unknown";
export function optionIdentity(symbol: string) {
  const m = /^(.+)(\d{6})([CP])(\d{8})$/.exec(tradierSymbol(symbol));
  return m ? { underlying: m[1]!, expiry: m[2]!, type: m[3] as "C" | "P", strike: new Decimal(m[4]!).div(1000).toFixed() } : null;
}
export function quantityDirection(quantity: string): PositionDirection {
  const n = new Decimal(quantity); return n.isZero() ? "unknown" : n.gt(0) ? "long" : "short";
}
export function marketDirection(symbol: string, direction: PositionDirection): MarketDirection {
  if (direction === "unknown" || direction === "mixed") return direction;
  const put = optionIdentity(symbol)?.type === "P";
  return (direction === "long") !== put ? "bullish" : "bearish";
}
export function directionLabel(symbol: string, direction: PositionDirection): string {
  if (direction === "unknown") return "多空待核实";
  if (direction === "mixed") return "含多头与空头";
  const option = optionIdentity(symbol);
  const side = direction === "long" ? "多头" : "空头";
  return option ? `${marketDirection(symbol, direction) === "bearish" ? "看空" : "看多"}标的 · ${direction === "long" ? "买入" : "卖出"} ${option.type === "P" ? "Put" : "Call"}（合约${side}）` : `${side} · ${direction === "short" ? "卖出持有" : "买入持有"}`;
}
export function executionAction(side: "buy" | "sell", effect: "open" | "close" | null | undefined): string {
  if (!effect) return "开平待核实";
  return effect === "open" ? side === "sell" ? "卖出开仓（空头）" : "买入开仓（多头）" : side === "buy" ? "买入平仓（空头回补）" : "卖出平仓（多头）";
}
export interface StrategyLeg {
  symbol: string; direction: PositionDirection; openingQuantity: string;
  multiplier?: string | null; openingAt?: string | null; currency?: string; broker?: string;
  /** Broker report day shared by every opening fill, and whether each opening fill carries an explicit open flag. */
  openingDay?: string | null; openingConfirmed?: boolean;
}
/** timing: "exact" = legs opened at the same verified instant; "same-day" = user-confirmed grouping with same-day explicit openings. */
export interface IdentifiedStrategy { label: string; marketDirection: MarketDirection; referenceUrl: string | null; timing: "exact" | "same-day" | null }
export interface IdentifyOptions { /** Allow recognition of legs that opened on the same report day with explicit open flags when instants are unavailable; only for groupings the user confirmed. */ sameDayConfirmed?: boolean }
export const SAME_DAY_SUFFIX = " · 按同日开仓识别（用户已确认）";
const identified = (label: string, direction: MarketDirection, slug?: string): IdentifiedStrategy => ({ label, marketDirection: direction, referenceUrl: slug ? `https://optionstrat.com/build/${slug}` : null, timing: slug ? "exact" : null });

// Structural classifications follow https://optionstrat.com/strategies.
// They describe the opening structure, not live delta or the trader's intent.
// Multi-leg recognition requires matching, simultaneous, verified openings.
export function identifyStrategy(legs: StrategyLeg[], settings: IdentifyOptions = {}): IdentifiedStrategy {
  if (!legs.length || legs.some(l => l.direction === "unknown")) return identified("结构方向待核实", "unknown");
  if (legs.some(l => l.direction === "mixed")) return identified("包含多空转换", "mixed");
  if (legs.length === 1) {
    const leg = legs[0]!, option = optionIdentity(leg.symbol), direction = marketDirection(leg.symbol, leg.direction);
    if (!option) return identified(direction === "bearish" ? "看空结构" : "看多结构", direction);
    const type = option.type === "P" ? "Put" : "Call", side = leg.direction === "long" ? "Long" : "Short";
    return identified(`${direction === "bearish" ? "看空" : "看多"} · ${side === "Long" ? "买入" : "卖出"}${type === "Put" ? "认沽" : "认购"}（${side} ${type}）`, direction, `${side.toLowerCase()}-${type.toLowerCase()}`);
  }
  const fallback = identified("多腿组合 · 方向分别见各腿", "unknown");
  const parsed = legs.map(l => ({ ...l, option: optionIdentity(l.symbol), quantity: new Decimal(l.openingQuantity) }));
  const first = parsed[0]!;
  const exact = !!first.openingAt && parsed.every(l => l.openingAt === first.openingAt);
  const sameDay = !exact && settings.sameDayConfirmed === true && !!first.openingDay && parsed.every(l => l.openingDay === first.openingDay && l.openingConfirmed === true);
  if (!first.option || (!exact && !sameDay) || first.multiplier == null || new Decimal(first.multiplier).lte(0) || parsed.some(l =>
    !l.option || l.option.underlying !== first.option!.underlying || l.option.expiry !== first.option!.expiry ||
    l.multiplier == null || !new Decimal(l.multiplier).eq(first.multiplier!) ||
    l.currency !== first.currency || l.broker !== first.broker || l.quantity.lte(0))) return fallback;
  const done = (result: IdentifiedStrategy): IdentifiedStrategy => exact ? result : { ...result, label: `${result.label}${SAME_DAY_SUFFIX}`, timing: "same-day" };
  const options = parsed.map(l => ({ ...l, option: l.option!, strike: new Decimal(l.option!.strike) })).sort((a, b) => a.strike.comparedTo(b.strike));
  const equalSize = options.every(l => l.quantity.eq(first.quantity));
  if (options.length === 2 && equalSize) {
    const [low, high] = options as [typeof options[number], typeof options[number]];
    if (low.option.type === high.option.type && low.direction !== high.direction && low.strike.lt(high.strike)) {
      const bearish = high.direction === "long", put = low.option.type === "P";
      return done(identified(`${bearish ? "看空" : "看多"}${put ? "认沽" : "认购"}价差（${put ? bearish ? "买高卖低" : "卖高买低" : bearish ? "卖低买高" : "买低卖高"}行权价）`, bearish ? "bearish" : "bullish", `${bearish ? "bear" : "bull"}-${put ? "put" : "call"}-spread`));
    }
    const put = options.find(l => l.option.type === "P"), call = options.find(l => l.option.type === "C");
    if (put && call && put.direction === call.direction && put.strike.lte(call.strike)) {
      const long = put.direction === "long", straddle = put.strike.eq(call.strike);
      return done(identified(`${long ? "双向波动" : "中性区间"} · ${long ? "买入" : "卖出"}${straddle ? "跨式" : "宽跨式"}`, long ? "volatility" : "neutral", `${long ? "" : "short-"}${straddle ? "straddle" : "strangle"}`));
    }
  }
  if (options.length === 3 && options.every(l => l.option.type === first.option!.type)) {
    const [low, mid, high] = options as [typeof options[number], typeof options[number], typeof options[number]];
    if (low.direction === high.direction && low.direction !== mid.direction && low.quantity.eq(high.quantity) && mid.quantity.eq(low.quantity.mul(2)) && mid.strike.gt(low.strike) && mid.strike.minus(low.strike).eq(high.strike.minus(mid.strike))) {
      const long = low.direction === "long", put = low.option.type === "P";
      return done(identified(`${long ? "中性区间" : "双向波动"} · ${long ? "买入" : "卖出"}${put ? "认沽" : "认购"}蝶式`, long ? "neutral" : "volatility", `${long ? "long" : "short"}-${put ? "put" : "call"}-butterfly`));
    }
  }
  if (options.length === 4 && equalSize) {
    const puts = options.filter(l => l.option.type === "P"), calls = options.filter(l => l.option.type === "C");
    if (puts.length === 2 && calls.length === 2) {
      const [lowPut, highPut] = puts as [typeof options[number], typeof options[number]], [lowCall, highCall] = calls as [typeof options[number], typeof options[number]];
      if (lowPut.strike.lt(highPut.strike) && highPut.strike.lte(lowCall.strike) && lowCall.strike.lt(highCall.strike) && lowPut.direction === highCall.direction && highPut.direction === lowCall.direction && lowPut.direction !== highPut.direction) {
        const neutral = lowPut.direction === "long", butterfly = highPut.strike.eq(lowCall.strike);
        return done(identified(`${neutral ? "中性区间" : "双向波动"} · ${neutral ? "" : "反向"}${butterfly ? "铁蝶" : "铁鹰"}`, neutral ? "neutral" : "volatility", `${neutral ? "" : "inverse-"}iron-${butterfly ? "butterfly" : "condor"}`));
      }
    }
  }
  return fallback;
}
export const strategyDirection = (legs: StrategyLeg[]): string => identifyStrategy(legs).label;
