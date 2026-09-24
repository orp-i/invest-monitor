import { Decimal } from "decimal.js";
import { directionLabel, executionAction, identifyStrategy, type PositionDirection } from "./trade-direction.js";
import { exactTotal } from "./broker-analytics.js";
import { localReviewDay, tradingCaseMetrics, type ReviewFill, type TradingCase, type WeeklyReviewInput } from "./trading-review.js";
const Money = Decimal.clone({ precision: 40 });
export const reviewBroker = (fill: ReviewFill) => fill.provenance?.broker ?? fill.sourceLabel ?? (fill.source === "manual" ? "手工记录" : fill.source.toUpperCase());
export function brokerReportDay(value: string): string | null {
  const day = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value);
  if (!day) return null;
  const normalized = `${day[1]}-${day[2]}-${day[3]}`;
  return Number.isFinite(Date.parse(normalized)) && new Date(normalized).toISOString().slice(0, 10) === normalized ? normalized : null;
}
export interface ExecutionLeg {
  key: string; symbol: string; broker: string; currency: string;
  direction: PositionDirection; directionLabel: string; multiplier: string | null; openingAt: string | null;
  openingDay: string | null; openingConfirmed: boolean;
  openingPrice: string | null; closingPrice: string | null; openingQuantity: string; closingQuantity: string;
  fees: string | null; netQuantity: string; pnl: string | null; classificationKnown: boolean;
}
/** A grouping the user made or confirmed: a manually created case, or an automatic case merged by hand (not by order/instant evidence). */
export function userConfirmedGrouping(entry: Pick<TradingCase, "id" | "linkHistory" | "pairingBasis">): boolean {
  if (typeof entry.id !== "string") return false;
  if (!entry.id.startsWith("auto-case-")) return true;
  return (entry.linkHistory ?? []).some(l => l.mergedFrom?.length) && !(entry.pairingBasis ?? "").startsWith("自动合并");
}
export function reviewExecutionDetails(entry: TradingCase) {
  const groups = new Map<string, ReviewFill[]>();
  for (const fill of entry.fills) groups.set(fill.instrumentKey, [...(groups.get(fill.instrumentKey) ?? []), fill]);
  const legs: ExecutionLeg[] = [];
  const actions: Record<string, string> = {};
  for (const [key, original] of groups) {
    const fills = [...original].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const ambiguous = fills.some((f, i) => fills.some((g, j) => j !== i && (g.occurredAt === f.occurredAt || (f.timePrecision === "day" || g.timePrecision === "day") && brokerReportDay(g.occurredAt) === brokerReportDay(f.occurredAt)) && f.side !== g.side && !(f.positionEffect ?? f.provenance?.action)));
    let balance = new Money(0), openQuantity = new Money(0), closeQuantity = new Money(0), openValue = new Money(0), closeValue = new Money(0);
    let openValid = true, closeValid = true, classified = true;
    const directions = new Set<"long" | "short">();
    for (const fill of fills) {
      const quantity = new Money(fill.quantity), signed = quantity.mul(fill.side === "buy" ? 1 : -1);
      const explicit = fill.positionEffect ?? fill.provenance?.action;
      let opened = new Money(0), closed = new Money(0);
      if (explicit === "open") opened = quantity;
      else if (explicit === "close") closed = quantity;
      else if (!entry.historyComplete || ambiguous) { classified = false; actions[fill.id] = "开平待核实"; }
      else { closed = balance.isZero() || balance.isPositive() === signed.isPositive() ? new Money(0) : Money.min(balance.abs(), quantity); opened = quantity.minus(closed); }
      if (opened.gt(0)) directions.add(fill.side === "buy" ? "long" : "short");
      if (closed.gt(0)) directions.add(fill.side === "buy" ? "short" : "long");
      if (opened.gt(0) || closed.gt(0)) actions[fill.id] = opened.gt(0) && closed.gt(0) ? `${executionAction(fill.side, "close")}；${executionAction(fill.side, "open")}` : executionAction(fill.side, opened.gt(0) ? "open" : "close");
      openQuantity = openQuantity.plus(opened); closeQuantity = closeQuantity.plus(closed);
      if (fill.price === null) { if (opened.gt(0)) openValid = false; if (closed.gt(0)) closeValid = false; }
      else { openValue = openValue.plus(opened.mul(fill.price)); closeValue = closeValue.plus(closed.mul(fill.price)); }
      balance = balance.plus(signed);
    }
    const currency = fills[0]!.currency;
    const sameCurrency = fills.every(f => f.currency === currency && (!f.feeCurrency || f.feeCurrency === currency));
    const cash = exactTotal(fills.map(f => f.netCash ?? (f.price === null || f.multiplier === null || f.feeCost === null ? null : new Money(f.provenance?.grossAmount ?? new Money(f.quantity).mul(f.price).mul(f.multiplier)).mul(f.side === "sell" ? 1 : -1).minus(f.feeCost).toFixed())));
    const direction: PositionDirection = !classified ? "unknown" : directions.size === 1 ? [...directions][0]! : directions.size > 1 ? "mixed" : "unknown";
    const sizes = new Set(fills.map(f => f.multiplier));
    const openings = fills.filter(f => (f.positionEffect ?? f.provenance?.action) === "open"), firstOpening = openings[0];
    const openingAt = firstOpening && openings.every(f => f.timePrecision === "instant" && f.occurredAt === firstOpening.occurredAt) ? firstOpening.occurredAt : null;
    const openingDay = firstOpening && openings.every(f => brokerReportDay(f.occurredAt) !== null && brokerReportDay(f.occurredAt) === brokerReportDay(firstOpening.occurredAt)) ? brokerReportDay(firstOpening.occurredAt) : null;
    legs.push({ openingAt, openingDay, openingConfirmed: openings.length > 0, direction, directionLabel: directionLabel(fills[0]!.symbol, direction), multiplier: sizes.size === 1 ? fills[0]!.multiplier : null, key, symbol: fills[0]!.symbol, broker: reviewBroker(fills[0]!), currency,
      openingPrice: sameCurrency && classified && openValid && openQuantity.gt(0) ? openValue.div(openQuantity).toFixed() : null,
      closingPrice: sameCurrency && classified && closeValid && closeQuantity.gt(0) ? closeValue.div(closeQuantity).toFixed() : null,
      openingQuantity: openQuantity.toFixed(), closingQuantity: closeQuantity.toFixed(), netQuantity: balance.toFixed(),
      fees: sameCurrency ? exactTotal(fills.map(f => f.feeCost)) : null, pnl: entry.historyComplete && balance.isZero() && sameCurrency ? cash : null, classificationKnown: classified });
  }
  const currencies = [...new Set(entry.fills.map(f => f.currency))];
  const strategy = identifyStrategy(legs, { sameDayConfirmed: userConfirmedGrouping(entry) });
  return { legs, actions, strategy, direction: strategy.label, fees: currencies.map(currency => ({ currency, total: exactTotal(entry.fills.filter(f => f.currency === currency).map(f => f.feeCost)) })) };
}
export interface ReviewTimelinePoint { day: string; broker: string; currency: string; pnl: string; cumulativePnl: string; completed: number; fills: number; titles: string[] }
export function weeklyTradeTimeline(cases: TradingCase[], range: Pick<WeeklyReviewInput, "weekStart" | "weekEnd" | "timezone">) {
  const buckets = new Map<string, { day: string; broker: string; currency: string; pnl: InstanceType<typeof Money>; completed: number; fills: number; titles: string[] }>();
  const omitted = new Set<string>();
  const take = (day: string, broker: string, currency: string) => { const key = JSON.stringify([day, broker, currency]); let b = buckets.get(key); if (!b) { b = { day, broker, currency, pnl: new Money(0), completed: 0, fills: 0, titles: [] }; buckets.set(key, b); } return b; };
  for (const entry of cases) {
    for (const fill of entry.fills) {
      const day = localReviewDay(fill.occurredAt, fill.timePrecision, range.timezone);
      if (day === null) { omitted.add("券商本地时间缺少时区，未分配到图表日期"); continue; }
      if (day >= range.weekStart && day <= range.weekEnd) take(day, reviewBroker(fill), fill.currency).fills++;
    }
    const metrics = tradingCaseMetrics(entry);
    if (metrics.state !== "closed" || metrics.netPnl === null || !metrics.currency) continue;
    const last = [...entry.fills].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1)!;
    const day = localReviewDay(last.occurredAt, last.timePrecision, range.timezone);
    if (!day || day < range.weekStart || day > range.weekEnd) continue;
    const brokers = [...new Set(entry.fills.map(reviewBroker))];
    const bucket = take(day, brokers.length === 1 ? brokers[0]! : "跨券商组合", metrics.currency);
    bucket.pnl = bucket.pnl.plus(metrics.netPnl); bucket.completed++; bucket.titles.push(entry.title);
  }
  const cumulative = new Map<string, InstanceType<typeof Money>>();
  const points: ReviewTimelinePoint[] = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day) || a.broker.localeCompare(b.broker)).map(b => { const key = JSON.stringify([b.broker, b.currency]); const sum = (cumulative.get(key) ?? new Money(0)).plus(b.pnl); cumulative.set(key, sum); return { ...b, pnl: b.pnl.toFixed(), cumulativePnl: sum.toFixed() }; });
  return { points, omitted: [...omitted] };
}
