import { Decimal } from "decimal.js";
import type { BrokerSnapshot } from "./workspace.js";
import type { MarketQuote } from "./market-data.js";
import { tradierSymbol } from "./market-data.js";
import { optionIdentity } from "./trade-direction.js";
import { assetKind, brokerLabel } from "./broker-analytics.js";
import { MARKET_STANCES } from "./market-daily.js";
import { EXPOSURE_METHOD, EXPOSURE_THEMES, EXPOSURE_THRESHOLDS, HEDGE_BENCHMARKS, INSTRUMENT_PROFILES, UNLISTED_PROFILE, instrumentProfile, themeById, type ExposureTheme, type ExposureThresholds, type HedgeBenchmark, type HedgeTool, type InstrumentProfile, type ThemeMembership } from "./exposure-catalog.js";

// Structured risk-exposure analysis (docs/RISK-EXPOSURE.md): delta-adjusted notional per leg → structure
// and max loss per underlying → theme exposure via catalog coefficients → long/short status per theme →
// balancing rules R1–R5 with reference sizing. Nothing here places orders or invents missing data.
const Money = Decimal.clone({ precision: 40 });
type M = InstanceType<typeof Money>;
const money = (v: string | number | M) => new Money(v);
const fixed = (v: M | null, dp = 2) => v === null ? null : v.isZero() ? money(0).toFixed(dp) : v.toFixed(dp);
const shares = (v: M | null) => v === null ? null : v.toDecimalPlaces(4).toFixed();
const sum = (values: (string | null)[]) => values.some(v => v === null) ? null : values.reduce<M>((n, v) => n.plus(v!), money(0));
const pct = (part: M | null, whole: M | null) => part === null || whole === null || whole.isZero() ? null : fixed(part.div(whole).mul(100), 1);

export interface BetaEstimate { benchmark: string; beta: string; correlation: string; samples: number; from: string; to: string }
/** OLS beta of daily log returns on common dates (newest `maxSamples` observations). Returns null below `minSamples`. */
export function estimateBeta(asset: readonly { date: string; close: string }[], benchmark: readonly { date: string; close: string }[], benchmarkSymbol: string, maxSamples = 250, minSamples = 60): BetaEstimate | null {
  const closes = (rows: readonly { date: string; close: string }[]) => {
    const byDate = new Map<string, number>();
    for (const row of rows) { const v = Number(row.close); if (Number.isFinite(v) && v > 0) byDate.set(row.date.slice(0, 10), v); }
    return byDate;
  };
  const a = closes(asset), b = closes(benchmark);
  const dates = [...a.keys()].filter(d => b.has(d)).sort();
  const ra: number[] = [], rb: number[] = [], used: string[] = [];
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1]!, day = dates[i]!;
    ra.push(Math.log(a.get(day)! / a.get(prev)!)); rb.push(Math.log(b.get(day)! / b.get(prev)!)); used.push(day);
  }
  const start = Math.max(0, ra.length - maxSamples), x = rb.slice(start), y = ra.slice(start), days = used.slice(start);
  if (x.length < minSamples) return null;
  const mean = (v: number[]) => v.reduce((n, c) => n + c, 0) / v.length, mx = mean(x), my = mean(y);
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i]! - mx, dy = y[i]! - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return { benchmark: benchmarkSymbol, beta: (sxy / sxx).toFixed(3), correlation: (sxy / Math.sqrt(sxx * syy)).toFixed(3), samples: x.length, from: days[0]!, to: days.at(-1)! };
}

export interface ExposureLeg {
  broker: string; accountId: string; symbol: string; kind: "stock" | "option"; right: "call" | "put" | null; strike: string | null; expiry: string | null;
  quantity: string; direction: "long" | "short"; marketDirection: "bullish" | "bearish"; multiplier: string | null;
  markPrice: string | null; markSource: "tradier" | "broker" | null; markAt: string | null;
  delta: string | null; deltaSource: "stock" | "tradier-greeks" | null; deltaShares: string | null; deltaNotional: string | null;
  marketValue: string | null; costBasis: string | null; notes: string[];
}
export interface ExposureGroup {
  underlying: string; description: string | null; profileLabel: string; listed: boolean; memberships: ThemeMembership[]; benchmark: HedgeBenchmark | null;
  underlyingPrice: string | null; underlyingPriceAt: string | null; legs: ExposureLeg[]; structure: string; direction: "bullish" | "bearish" | "neutral" | "unknown";
  shares: string; deltaShares: string | null; deltaNotional: string | null; marketValue: string | null;
  betas: Partial<Record<HedgeBenchmark, BetaEstimate | null>>; betaAdjusted: Partial<Record<HedgeBenchmark, string | null>>;
  maxLoss: { value: string; basis: string } | null; unlimitedRisk: boolean; nearestExpiry: string | null; daysToExpiry: number | null; complete: boolean;
}
export type ThemeStatus = "unhedged-long" | "unhedged-short" | "partially-hedged" | "over-hedged" | "neutral" | "incomplete" | "empty";
export interface ThemeContribution { underlying: string; coefficient: number; basis: string; deltaNotional: string; notional: string }
export interface ThemeExposure {
  id: string; label: string; kind: ExposureTheme["kind"]; long: string; short: string; net: string; gross: string; coverage: string | null; netToEquity: string | null; significant: boolean;
  status: ThemeStatus; statusLabel: string; contributions: ThemeContribution[]; incompleteGroups: string[];
  netBetaAdjusted: Partial<Record<HedgeBenchmark, string | null>>; betaAssumedGroups: string[];
}
export interface ExposureFinding { severity: "high" | "medium" | "info"; title: string; detail: string }
export interface HedgeQuote { symbol: string; description: string | null; last: string | null; tradeAt: string | null }
export interface SideEffect { theme: string; label: string; notional: string }
export interface BalancingAction {
  rule: "R1" | "R2" | "R3" | "R4" | "R5"; theme: string; themeLabel: string; priority: "now" | "standby" | "info"; title: string;
  tool: { symbol: string; label: string; kind: HedgeTool["kind"] }; quantity: string | null; unit: string; notional: string | null; price: string | null; priceAt: string | null;
  sideEffects: SideEffect[]; note: string;
}
export interface MarketContext { latestDaily: { id: string; date: string; title: string; stance: keyof typeof MARKET_STANCES; stanceLabel: string } | null; bearish: boolean }
export interface RiskExposureAnalysis {
  currency: "USD"; capturedAt: string; equity: string | null; methodVersion: string; thresholds: ExposureThresholds; options: { ratio: number; putDelta: number }; marketContext: MarketContext;
  totals: { long: string; short: string; net: string; gross: string; netToEquity: string | null; grossToEquity: string | null; definedMaxLoss: string | null; definedMaxLossToEquity: string | null; definedRiskGroups: number; unlimitedRiskGroups: number; legs: number; valuedLegs: number };
  overall: { direction: "net-long" | "net-short" | "neutral" | "unknown"; label: string; summary: string; usEquityBetaNet: string | null };
  themes: ThemeExposure[]; groups: ExposureGroup[]; findings: ExposureFinding[]; actions: BalancingAction[]; hedgeQuotes: HedgeQuote[]; assumptions: string[]; missing: string[];
}
export interface RiskExposureInput { accounts: BrokerSnapshot[]; quotes: ReadonlyMap<string, MarketQuote>; betas?: ReadonlyMap<string, Partial<Record<HedgeBenchmark, BetaEstimate | null>>>; equity: string | null; capturedAt: string; marketContext?: MarketContext; options?: Partial<{ ratio: number; putDelta: number }>; thresholds?: Partial<ExposureThresholds> }

const isoExpiry = (yymmdd: string) => `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
const nyDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const daysBetween = (from: string, to: string) => Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86400000);
const midPrice = (q: MarketQuote | undefined) => q?.bid != null && q.ask != null && money(q.bid).gt(0) && money(q.ask).gt(0) ? fixed(money(q.bid).plus(q.ask).div(2), 4) : null;
const usdOptionOrStock = (symbol: string) => /^[A-Z][A-Z0-9/.-]{0,19}$/.test(symbol) || /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/.test(symbol);
const positionSymbols = (accounts: readonly BrokerSnapshot[]) => {
  const out = new Set<string>();
  for (const account of accounts) if (account.environment !== "sandbox") for (const p of account.positions) {
    if (p.currency !== "USD" || money(p.quantity).isZero() || assetKind(p.assetType) === "其他") continue;
    const symbol = tradierSymbol(p.symbol);
    if (usdOptionOrStock(symbol)) out.add(symbol);
  }
  return out;
};
const underlyingOf = (symbol: string) => optionIdentity(symbol)?.underlying ?? symbol;
/** Themes the book touches, in catalog order. */
export function exposureThemesFor(accounts: readonly BrokerSnapshot[]): ExposureTheme[] {
  const ids = new Set<string>();
  for (const s of positionSymbols(accounts)) for (const m of instrumentProfile(underlyingOf(s)).memberships) ids.add(m.theme);
  return EXPOSURE_THEMES.filter(t => ids.has(t.id));
}
/** Tradier symbols a risk analysis needs: USD stock/option positions, their underlyings, benchmarks and every catalog tool of the touched themes. */
export function exposureQuoteSymbols(accounts: readonly BrokerSnapshot[]): string[] {
  const symbols = new Set<string>(HEDGE_BENCHMARKS);
  for (const s of positionSymbols(accounts)) { symbols.add(s); symbols.add(underlyingOf(s)); }
  for (const theme of exposureThemesFor(accounts)) for (const tool of [...theme.longTools, ...theme.shortTools]) if (tool.symbol !== "*") symbols.add(tool.symbol);
  return [...symbols].sort();
}
/** Underlyings whose beta against the hedge benchmarks matters (US equity members, including benchmark ETFs held as options' underlyings). */
export function exposureBetaSymbols(accounts: readonly BrokerSnapshot[]): string[] {
  const out = new Set<string>();
  for (const s of positionSymbols(accounts)) { const u = underlyingOf(s); if (instrumentProfile(u).memberships.some(m => m.theme === "us-equity")) out.add(u); }
  return [...out].sort();
}

function describeStructure(legs: ExposureLeg[]): { structure: string; maxLoss: ExposureGroup["maxLoss"]; unlimitedRisk: boolean } {
  const stocks = legs.filter(l => l.kind === "stock"), options = legs.filter(l => l.kind === "option");
  const cost = sum(legs.map(l => l.costBasis));
  const shares = sum(stocks.map(l => l.quantity));
  const qtyContracts = (l: ExposureLeg) => money(l.quantity).abs().mul(l.multiplier ?? "0");
  if (!options.length) {
    if (shares === null) return { structure: "股票（数量待核实）", maxLoss: null, unlimitedRisk: false };
    if (shares.gt(0)) { const mv = sum(stocks.map(l => l.marketValue)); return { structure: `股票多头 · ${shares.toFixed()} 股`, maxLoss: mv === null ? null : { value: fixed(mv)!, basis: "股票跌至零的理论最大亏损 = 当前市值" }, unlimitedRisk: false }; }
    return { structure: `股票空头 · ${shares.abs().toFixed()} 股`, maxLoss: null, unlimitedRisk: true };
  }
  const sameExpiry = options.every(l => l.expiry === options[0]!.expiry), sameRight = options.every(l => l.right === options[0]!.right);
  if (!stocks.length && options.length === 1) {
    const leg = options[0]!, type = leg.right === "put" ? "认沽" : "认购";
    if (leg.direction === "long") return { structure: `买入${type}（${leg.marketDirection === "bearish" ? "看空" : "看多"}）`, maxLoss: leg.costBasis === null ? null : { value: fixed(money(leg.costBasis).abs())!, basis: "买入期权最大亏损 = 已付权利金（成本）" }, unlimitedRisk: false };
    if (leg.right === "put") { const cash = leg.strike === null || leg.multiplier === null ? null : money(leg.strike).mul(qtyContracts(leg)); return { structure: "卖出认沽（看多）· 未配对", maxLoss: cash === null || leg.costBasis === null ? null : { value: fixed(cash.plus(leg.costBasis))!, basis: "现金担保口径：行权价 × 合约规模 × 张数 − 已收权利金" }, unlimitedRisk: false }; }
    return { structure: "卖出认购（看空）· 未备兑", maxLoss: null, unlimitedRisk: true };
  }
  if (!stocks.length && options.length === 2 && sameExpiry && options.every(l => l.strike !== null && l.multiplier !== null)) {
    const [a, b] = options as [ExposureLeg, ExposureLeg];
    const equalSize = money(a.quantity).abs().eq(money(b.quantity).abs()) && a.multiplier === b.multiplier;
    if (sameRight && a.direction !== b.direction && equalSize) {
      const [low, high] = money(a.strike!).lt(b.strike!) ? [a, b] : [b, a];
      // Long the higher strike = bearish for both rights (bear put spread buys the high put; bear call spread buys the high call).
      const put = a.right === "put", bearish = high.direction === "long";
      const longLeg = a.direction === "long" ? a : b, shortLeg = longLeg === a ? b : a;
      const width = money(high.strike!).minus(low.strike!).mul(qtyContracts(a));
      const debit = cost !== null && cost.gt(0);
      const maxLoss = cost === null ? null : debit ? { value: fixed(cost)!, basis: "借方价差最大亏损 = 净支出（两腿成本之和）" } : { value: fixed(width.plus(cost))!, basis: "贷方价差最大亏损 = 行权价差 × 合约规模 × 张数 − 已收净权利金" };
      return { structure: `${bearish ? "看空" : "看多"}${put ? "认沽" : "认购"}价差（买 ${longLeg.strike} / 卖 ${shortLeg.strike}）`, maxLoss, unlimitedRisk: false };
    }
    if (!sameRight && a.direction === b.direction && equalSize) {
      const long = a.direction === "long", straddle = money(a.strike!).eq(b.strike!);
      return { structure: `${long ? "买入" : "卖出"}${straddle ? "跨式" : "宽跨式"}（${long ? "双向波动" : "中性区间"}）`, maxLoss: long && cost !== null ? { value: fixed(cost)!, basis: "买入跨式/宽跨式最大亏损 = 已付权利金" } : null, unlimitedRisk: !long };
    }
  }
  if (stocks.length && shares !== null && shares.gt(0) && options.length === 1) {
    const leg = options[0]!, covered = leg.multiplier !== null && qtyContracts(leg).lte(shares);
    if (leg.right === "call" && leg.direction === "short" && covered) { const mv = sum(stocks.map(l => l.marketValue)); return { structure: "备兑认购（股票多头 + 卖出认购）", maxLoss: mv === null || leg.costBasis === null ? null : { value: fixed(mv.plus(leg.costBasis))!, basis: "股票跌至零 − 已收权利金" }, unlimitedRisk: false }; }
    if (leg.right === "put" && leg.direction === "long" && covered && leg.strike !== null) { const price = stocks[0]!.markPrice; const floor = price === null ? null : Money.max(money(price).minus(leg.strike), 0).mul(qtyContracts(leg)); return { structure: "保护性认沽（股票多头 + 买入认沽）", maxLoss: floor === null || leg.costBasis === null ? null : { value: fixed(floor.plus(money(leg.costBasis).abs()))!, basis: "受保护数量按 (现价 − 行权价) + 权利金，其余股数按市值" }, unlimitedRisk: false }; }
  }
  const allLong = legs.every(l => l.direction === "long");
  const nakedCall = options.some(l => l.right === "call" && l.direction === "short") && !(shares !== null && shares.gt(0));
  return { structure: `多腿组合（${legs.length} 腿，逐腿列示）`, maxLoss: allLong && cost !== null ? { value: fixed(cost)!, basis: "全部为买入腿：最大亏损 = 成本之和" } : null, unlimitedRisk: nakedCall || (shares !== null && shares.lt(0)) };
}

const statusLabels: Record<ThemeStatus, string> = { "unhedged-long": "多头未对冲", "unhedged-short": "空头未对冲（独立方向性头寸）", "partially-hedged": "部分对冲", "over-hedged": "反向仓位超过多头（净空）", neutral: "接近中性", incomplete: "待核算", empty: "无敞口" };
const defaultContext: MarketContext = { latestDaily: null, bearish: false };

export function analyzeRiskExposure(input: RiskExposureInput): RiskExposureAnalysis {
  const thresholds: ExposureThresholds = { ...EXPOSURE_THRESHOLDS, ...input.thresholds };
  const options = { ratio: Math.min(Math.max(input.options?.ratio ?? 0.5, 0), 2), putDelta: Math.min(Math.max(input.options?.putDelta ?? 0.3, 0.05), 0.95) };
  const marketContext = input.marketContext ?? defaultContext;
  const missing = new Set<string>(), assumptions = new Set<string>();
  const quotes = input.quotes, betas = input.betas ?? new Map();
  const today = nyDate(input.capturedAt);
  const legsByUnderlying = new Map<string, ExposureLeg[]>();
  let legsTotal = 0;
  for (const account of input.accounts) {
    if (account.environment === "sandbox") continue;
    const label = `${brokerLabel(account.broker)} ${account.accountId}`;
    for (const p of account.positions) {
      const quantity = money(p.quantity);
      if (quantity.isZero()) continue;
      if (p.currency !== "USD") { missing.add(`${label} ${p.symbol}：${p.currency} 持仓缺少 USD 换算，未纳入敞口`); continue; }
      const kind = assetKind(p.assetType);
      if (kind === "其他") { missing.add(`${label} ${p.symbol}：资产类型 ${p.assetType ?? "未知"} 不是股票/期权，未纳入敞口`); continue; }
      const symbol = tradierSymbol(p.symbol);
      if (!usdOptionOrStock(symbol)) { missing.add(`${label} ${p.symbol}：代码格式无法查询行情，未纳入敞口`); continue; }
      legsTotal++;
      const option = optionIdentity(symbol), quote = quotes.get(symbol), notes: string[] = [];
      const multiplier = p.multiplier ?? quote?.contractSize ?? (option ? null : "1");
      let markPrice: string | null = null, markSource: ExposureLeg["markSource"] = null, markAt: string | null = null;
      if (quote && quote.last !== null && money(quote.last).gt(0)) { markPrice = quote.last; markSource = "tradier"; markAt = quote.tradeAt; }
      else if (midPrice(quote)) { markPrice = midPrice(quote); markSource = "tradier"; markAt = quote?.bidAt ?? null; notes.push("无最近成交价，采用买卖中间价"); }
      else if (p.markPrice != null) { markPrice = p.markPrice; markSource = "broker"; markAt = account.asOf; notes.push("采用券商报告价格"); }
      const direction: ExposureLeg["direction"] = quantity.gt(0) ? "long" : "short";
      const marketDirection: ExposureLeg["marketDirection"] = (direction === "long") !== (option?.type === "P") ? "bullish" : "bearish";
      let delta: string | null = null, deltaSource: ExposureLeg["deltaSource"] = null;
      if (!option) { delta = "1"; deltaSource = "stock"; }
      else if (quote?.greeks?.delta != null && money(quote.greeks.delta).abs().lte(1)) { delta = quote.greeks.delta; deltaSource = "tradier-greeks"; }
      else notes.push("缺少 Tradier Delta，未计入 Delta 敞口");
      const underlying = option ? option.underlying : symbol;
      const underlyingQuote = option ? quotes.get(underlying) : quote;
      const underlyingPrice = option ? (underlyingQuote?.last ?? null) : markPrice;
      if (option && underlyingPrice === null) notes.push("缺少标的报价，未计入 Delta 敞口");
      if (multiplier === null) notes.push("合约规模未知，未计入");
      if (!option && markPrice === null) notes.push("缺少报价，未计入");
      const deltaShares = delta !== null && multiplier !== null ? quantity.mul(multiplier).mul(delta) : null;
      const deltaNotional = deltaShares !== null && underlyingPrice !== null ? deltaShares.mul(underlyingPrice) : null;
      const marketValue = markPrice !== null && multiplier !== null ? quantity.mul(multiplier).mul(markPrice) : p.marketValue ?? null;
      const leg: ExposureLeg = { broker: account.broker, accountId: account.accountId, symbol, kind: option ? "option" : "stock", right: option ? option.type === "P" ? "put" : "call" : null, strike: option?.strike ?? null, expiry: option ? isoExpiry(option.expiry) : null,
        quantity: quantity.toFixed(), direction, marketDirection, multiplier, markPrice, markSource, markAt, delta, deltaSource, deltaShares: shares(deltaShares), deltaNotional: fixed(deltaNotional), marketValue: marketValue === null ? null : fixed(money(marketValue)), costBasis: p.costBasis, notes };
      legsByUnderlying.set(underlying, [...(legsByUnderlying.get(underlying) ?? []), leg]);
      if (deltaNotional === null) missing.add(`${label} ${symbol}：${notes.join("；") || "缺少估值依据"}`);
    }
  }
  const equity = input.equity === null ? null : money(input.equity);
  const groups: ExposureGroup[] = [];
  for (const [underlying, legs] of [...legsByUnderlying].sort(([a], [b]) => a.localeCompare(b))) {
    const listed = underlying in INSTRUMENT_PROFILES, profile = listed ? INSTRUMENT_PROFILES[underlying]! : UNLISTED_PROFILE, quote = quotes.get(underlying);
    const complete = legs.every(l => l.deltaNotional !== null);
    const deltaShares = sum(legs.map(l => l.deltaShares)), deltaNotional = sum(legs.map(l => l.deltaNotional)), marketValue = sum(legs.map(l => l.marketValue));
    const gross = legs.reduce<M>((n, l) => n.plus(l.deltaNotional === null ? 0 : money(l.deltaNotional).abs()), money(0));
    const direction: ExposureGroup["direction"] = deltaNotional === null ? "unknown" : gross.isZero() || deltaNotional.abs().div(gross).lt(thresholds.neutralBand) ? "neutral" : deltaNotional.gt(0) ? "bullish" : "bearish";
    const { structure, maxLoss, unlimitedRisk } = describeStructure(legs);
    const expiries = legs.map(l => l.expiry).filter((e): e is string => e !== null).sort();
    const groupBetas: ExposureGroup["betas"] = {}, betaAdjusted: ExposureGroup["betaAdjusted"] = {};
    const usCoefficient = profile.memberships.find(m => m.theme === "us-equity")?.coefficient ?? null;
    if (usCoefficient !== null) for (const benchmark of HEDGE_BENCHMARKS) {
      const estimate = underlying === benchmark ? { benchmark, beta: "1.000", correlation: "1.000", samples: 0, from: today, to: today } : betas.get(underlying)?.[benchmark] ?? null;
      groupBetas[benchmark] = estimate;
      betaAdjusted[benchmark] = deltaNotional === null ? null : fixed(deltaNotional.mul(usCoefficient).mul(estimate?.beta ?? "1"));
    }
    for (const m of profile.memberships) if (Math.abs(m.coefficient) !== 1 && /每日|杠杆|×/.test(m.basis)) assumptions.add(`${underlying}：${m.basis}，主题敞口按系数 ${m.coefficient} 折算；多日持有存在路径依赖`);
    if (!listed) assumptions.add(`${underlying} 不在主题目录内，按美股个股只计入市场 β；如属于某主题请补充目录（或让模型按自身知识补充并注明推断）`);
    groups.push({ underlying, description: quote?.description ?? null, profileLabel: profile.label, listed, memberships: profile.memberships, benchmark: profile.benchmark ?? null,
      underlyingPrice: legs[0]!.kind === "option" ? quote?.last ?? null : legs[0]!.markPrice, underlyingPriceAt: legs[0]!.kind === "option" ? quote?.tradeAt ?? null : legs[0]!.markAt, legs, structure, direction,
      shares: (sum(legs.filter(l => l.kind === "stock").map(l => l.quantity)) ?? money(0)).toFixed(), deltaShares: shares(deltaShares), deltaNotional: fixed(deltaNotional), marketValue: fixed(marketValue), betas: groupBetas, betaAdjusted, maxLoss, unlimitedRisk,
      nearestExpiry: expiries[0] ?? null, daysToExpiry: expiries[0] ? daysBetween(today, expiries[0]) : null, complete });
  }
  const significantAmount = equity === null ? null : equity.abs().mul(thresholds.significantToEquity);
  const themes: ThemeExposure[] = [];
  for (const theme of EXPOSURE_THEMES) {
    const members = groups.filter(g => g.memberships.some(m => m.theme === theme.id));
    if (!members.length) continue;
    const contributions: ThemeContribution[] = [];
    let long = money(0), short = money(0);
    for (const g of members) {
      if (g.deltaNotional === null) continue;
      const m = g.memberships.find(x => x.theme === theme.id)!;
      const notional = money(g.deltaNotional).mul(m.coefficient);
      contributions.push({ underlying: g.underlying, coefficient: m.coefficient, basis: m.basis, deltaNotional: g.deltaNotional, notional: fixed(notional)! });
      if (notional.gt(0)) long = long.plus(notional); else short = short.plus(notional);
    }
    const net = long.plus(short), gross = long.plus(short.abs());
    const incomplete = members.filter(g => !g.complete).map(g => g.underlying);
    const netBetaAdjusted: ThemeExposure["netBetaAdjusted"] = {}, betaAssumed: string[] = [];
    if (theme.id === "us-equity") for (const benchmark of HEDGE_BENCHMARKS) {
      netBetaAdjusted[benchmark] = fixed(members.reduce<M>((n, g) => n.plus(g.betaAdjusted[benchmark] ?? "0"), money(0)));
      for (const g of members) if (g.deltaNotional !== null && !g.betas[benchmark] && !betaAssumed.includes(g.underlying)) betaAssumed.push(g.underlying);
    }
    if (betaAssumed.length) assumptions.add(`${betaAssumed.join("、")} 缺少可估算的 β，按 β=1 计入 β 调整敞口`);
    let status: ThemeStatus;
    if (!contributions.length) status = "incomplete";
    else if (gross.isZero()) status = "empty";
    else if (short.isZero()) status = "unhedged-long";
    else if (long.isZero()) status = "unhedged-short";
    else if (net.abs().div(gross).lte(thresholds.neutralBand)) status = "neutral";
    else if (net.gt(0)) status = "partially-hedged";
    else status = "over-hedged";
    themes.push({ id: theme.id, label: theme.label, kind: theme.kind, long: fixed(long)!, short: fixed(short)!, net: fixed(net)!, gross: fixed(gross)!, coverage: long.isZero() || short.isZero() ? null : fixed(Money.min(long, short.abs()).div(Money.max(long, short.abs())).mul(100), 1),
      netToEquity: pct(net, equity), significant: significantAmount !== null && net.abs().gte(significantAmount), status, statusLabel: statusLabels[status] + (incomplete.length ? "（部分待核算）" : ""), contributions, incompleteGroups: incomplete, netBetaAdjusted, betaAssumedGroups: betaAssumed });
  }
  const valuedGroups = groups.filter(g => g.deltaNotional !== null);
  const long = valuedGroups.reduce<M>((n, g) => n.plus(Money.max(money(g.deltaNotional!), 0)), money(0)), short = valuedGroups.reduce<M>((n, g) => n.plus(Money.min(money(g.deltaNotional!), 0)), money(0));
  const net = long.plus(short), gross = long.plus(short.abs());
  // R5 counts option structures only; a stock's "max loss = market value" is listed per group but is not a defined-risk structure.
  const definedRisk = groups.filter(g => g.maxLoss !== null && g.legs.some(l => l.kind === "option")), defined = sum(definedRisk.map(g => g.maxLoss!.value));
  const usEquity = themes.find(t => t.id === "us-equity");
  const usNet = usEquity?.netBetaAdjusted.SPY ?? null;
  const direction: RiskExposureAnalysis["overall"]["direction"] = !valuedGroups.length ? "unknown" : usNet !== null && usEquity && !money(usEquity.gross).isZero()
    ? (money(usNet).abs().div(usEquity.gross).lte(thresholds.neutralBand) ? "neutral" : money(usNet).gt(0) ? "net-long" : "net-short")
    : gross.isZero() || net.abs().div(gross).lte(thresholds.neutralBand) ? "neutral" : net.gt(0) ? "net-long" : "net-short";
  const overallLabel = { "net-long": "净多头", "net-short": "净空头", neutral: "接近中性", unknown: "待核算" }[direction];
  const themeSummary = themes.filter(t => t.status !== "empty").map(t => `${t.label}：净 ${t.net} USD（${t.statusLabel}${t.significant ? "，占比大" : ""}）`).join("；");
  const overall = { direction, label: overallLabel, usEquityBetaNet: usNet, summary: !valuedGroups.length ? "没有可核算的 Delta 敞口。" : `${usNet !== null ? `以美股市场 β 为主视角：β 调整（对 SPY）净敞口 ${usNet} USD${equity && !equity.isZero() ? `，占净资产 ${pct(money(usNet), equity)}%` : ""}，判定为${overallLabel}。` : ""}按标的 Delta 名义合计：多头 ${fixed(long)} USD、空头 ${fixed(short)} USD，净 ${fixed(net)} USD，毛敞口 ${fixed(gross)} USD${equity && !equity.isZero() ? `（净资产的 ${fixed(gross.div(equity), 2)} 倍）` : ""}。各主题：${themeSummary}。` };

  const findings: ExposureFinding[] = [];
  for (const t of themes) {
    const equityNote = t.netToEquity === null ? "" : `，占净资产 ${t.netToEquity}%`, names = t.contributions.map(c => c.underlying).join("、");
    if (t.status === "unhedged-long") findings.push({ severity: t.significant ? "medium" : "info", title: `${t.label}：多头 ${t.long} USD 没有反向仓位${t.significant ? "（占比大）" : ""}`, detail: `该主题下跌 1% 时组合约变动 ${fixed(money(t.net).mul("-0.01"))} USD${equityNote}；涉及 ${names}。${t.significant ? "适用 R2/R4：下跌判断下备兑或买入认沽，或按比例配置反向工具/减仓。" : "占比未达阈值，可继续观察。"}` });
    else if (t.status === "unhedged-short") findings.push({ severity: t.significant ? "medium" : "info", title: `${t.label}：空头 ${t.short} USD 是独立的方向性头寸${t.significant ? "（占比大）" : ""}`, detail: `组合内没有同主题多头需要它来保护，它就是看空判断本身（${names}）；该主题上涨 1% 时约亏 ${fixed(money(t.short).abs().mul("0.01"))} USD${equityNote}。${t.significant ? "适用 R1：配置 25%–50% 的同主题多头以限制反弹风险，或减少张数。" : "占比未达阈值，可继续观察。"}限定风险结构的损失上限见明细。` });
    else if (t.status === "over-hedged") findings.push({ severity: t.significant ? "medium" : "info", title: `${t.label}：反向仓位 ${money(t.short).abs().toFixed()} USD 超过多头 ${t.long} USD，净空 ${t.net} USD`, detail: `若这些反向仓位的本意是保护多头，当前已超额对冲 ${fixed(money(t.net).abs())} USD${equityNote}，多头下跌反而净获利；若本意是做空，则同主题多头只覆盖空头的 ${fixed(money(t.long).div(money(t.short).abs()).mul(100), 1)}%。两种意图应分开记录，不宜同时当作“已对冲”。` });
    else if (t.status === "partially-hedged") findings.push({ severity: "info", title: `${t.label}：反向仓位覆盖多头的 ${t.coverage}%`, detail: `净多 ${t.net} USD${equityNote}，剩余部分仍随该主题波动；对冲工具与持仓不完全相同时存在基差风险（跟踪偏差）。` });
    else if (t.status === "neutral") findings.push({ severity: "info", title: `${t.label}：多空接近平衡（净 ${t.net} USD）`, detail: "Delta 接近中性不等于没有风险：个股相对指数的偏离、期权 Gamma/Vega/Theta 以及到期日仍会产生盈亏。" });
    else if (t.status === "incomplete") findings.push({ severity: "medium", title: `${t.label}：${t.incompleteGroups.join("、")} 缺少报价或 Delta，尚未纳入`, detail: "补齐 Tradier 报价/Greeks 或券商报告价格后再判断该主题方向。" });
  }
  for (const g of groups) {
    if (g.unlimitedRisk) findings.push({ severity: "high", title: `${g.underlying}：${g.structure} 亏损没有上限`, detail: "股票空头或未备兑的卖出认购在标的大幅上涨时亏损无上限，应优先设置反向仓位或止损。" });
    if (g.daysToExpiry !== null && g.daysToExpiry <= thresholds.expiryWarnDays) findings.push({ severity: g.daysToExpiry <= thresholds.expiryUrgentDays ? "high" : "medium", title: `${g.underlying}：${g.structure} 距到期 ${g.daysToExpiry} 天（${g.nearestExpiry}）`, detail: "临近到期 Delta/Gamma 变化很快，当前 Delta 敞口只是瞬时值；需提前决定平仓、展期或接受到期结果，不推定作废。" });
    if (equity && !equity.isZero() && g.deltaNotional !== null && money(g.deltaNotional).abs().div(equity).gte(thresholds.concentrationToEquity)) findings.push({ severity: "medium", title: `${g.underlying}：单一标的 Delta 名义 ${money(g.deltaNotional).abs().toFixed()} USD 占净资产 ${pct(money(g.deltaNotional).abs(), equity)}%`, detail: "集中度高时指数对冲只能覆盖市场因子，个股/单一 ETF 的特有风险仍需靠仓位上限或同标的反向仓位管理。" });
  }
  if (definedRisk.length) {
    const over = equity !== null && !equity.isZero() && defined !== null && defined.div(equity).gt(thresholds.definedLossToEquityLimit);
    findings.push({ severity: over ? "medium" : "info", title: `已识别限定风险的期权结构 ${definedRisk.length} 组，最大亏损合计 ${fixed(defined)} USD${equity && !equity.isZero() && defined ? `（占净资产 ${pct(defined, equity)}%${over ? `，超过 R5 参考上限 ${Math.round(thresholds.definedLossToEquityLimit * 100)}%` : ""}）` : ""}`, detail: "最大亏损按结构规则计算（买入期权 = 权利金，价差 = 净支出或价差宽度 − 净权利金，股票 = 当前市值）；不含手续费、提前指派与流动性风险。限定风险结构可以不对冲 Delta，而以最大亏损占比控制（R5）。" });
  }
  if (missing.size) findings.push({ severity: "medium", title: `${missing.size} 项持仓未完整纳入敞口`, detail: [...missing].join("；") });
  const severityRank = { high: 0, medium: 1, info: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  assumptions.add("Delta 名义 = 数量 × 合约规模 × Delta × 标的价格，是一阶瞬时敏感度；期权真实盈亏还受 Gamma、Vega、Theta 与流动性影响，不能由标的日 K 反推。");
  assumptions.add("毛敞口按标的分组的净 Delta 名义绝对值相加，同一标的多腿先轧差；净敞口 = 多头 − 空头，占比以券商报告净资产（含现金）为分母。主题敞口 = Delta 名义 × 目录系数，一个标的可同时计入多个主题，不同主题之间不互相抵消。");
  assumptions.add("目录中的关系系数（如航空股对油价 -0.3、EWY 对存储 0.5）是经验设定，用于定量参考；实际相关性随时间变化。");
  const themeSymbols = new Set<string>(HEDGE_BENCHMARKS);
  for (const t of themes) for (const tool of [...themeById(t.id)!.longTools, ...themeById(t.id)!.shortTools]) if (tool.symbol !== "*") themeSymbols.add(tool.symbol);
  const hedgeQuotes: HedgeQuote[] = [...themeSymbols].sort().map(s => { const q = quotes.get(s); return { symbol: s, description: q?.description ?? null, last: q?.last ?? null, tradeAt: q?.tradeAt ?? null }; });
  const analysis: RiskExposureAnalysis = { currency: "USD", capturedAt: input.capturedAt, equity: input.equity, methodVersion: EXPOSURE_METHOD.version, thresholds, options, marketContext,
    totals: { long: fixed(long)!, short: fixed(short)!, net: fixed(net)!, gross: fixed(gross)!, netToEquity: pct(net, equity), grossToEquity: equity && !equity.isZero() ? fixed(gross.div(equity), 2) : null,
      definedMaxLoss: fixed(defined), definedMaxLossToEquity: pct(defined, equity), definedRiskGroups: definedRisk.length, unlimitedRiskGroups: groups.filter(g => g.unlimitedRisk).length, legs: legsTotal, valuedLegs: groups.reduce((n, g) => n + g.legs.filter(l => l.deltaNotional !== null).length, 0) },
    overall, themes, groups, findings, actions: [], hedgeQuotes, assumptions: [...assumptions], missing: [...missing] };
  analysis.actions = balancingActions(analysis, options);
  return analysis;
}

/**
 * Balancing rules R1–R5 with reference sizing for one hedge ratio and one assumed put delta.
 * Index puts: contracts = target ÷ (price × 100 × |delta|); shares: target ÷ (price × |coefficient|).
 * Pure: the page recomputes it when the user changes ratio or delta.
 */
export function balancingActions(analysis: RiskExposureAnalysis, options: { ratio: number; putDelta: number }): BalancingAction[] {
  const thresholds = analysis.thresholds, ratio = Math.min(Math.max(options.ratio, 0), 2), putDelta = Math.min(Math.max(options.putDelta, 0.05), 0.95);
  const quote = (symbol: string) => analysis.hedgeQuotes.find(q => q.symbol === symbol) ?? { symbol, description: null, last: null, tradeAt: null };
  const equity = analysis.equity === null ? null : money(analysis.equity);
  const out: BalancingAction[] = [];
  const sideEffects = (symbol: string, notional: M, excludeTheme: string): SideEffect[] => instrumentProfile(symbol).memberships.filter(m => m.theme !== excludeTheme).map(m => ({ theme: m.theme, label: themeById(m.theme)?.label ?? m.theme, notional: fixed(notional.mul(m.coefficient))! }));
  const percentNote = (ratioUsed: number) => `按 ${Math.round(ratioUsed * 100)}% 比例`;
  for (const t of analysis.themes) {
    if (["neutral", "incomplete", "empty"].includes(t.status) || !t.significant) continue;
    const theme = themeById(t.id)!, netLong = money(t.net).gt(0);
    const ruleRatio = netLong ? ratio : Math.min(ratio, 0.5);
    const tools = netLong ? theme.shortTools : theme.longTools;
    for (const tool of tools) {
      const label = `${theme.label} · ${tool.label}`;
      if (tool.kind === "covered-call" || tool.kind === "protective-put") {
        const eligible = analysis.groups.filter(g => g.memberships.some(m => m.theme === t.id) && money(g.shares).gte(thresholds.optionLot));
        const largest = analysis.groups.filter(g => g.memberships.some(m => m.theme === t.id) && money(g.shares).gt(0)).sort((a, b) => money(b.shares).comparedTo(money(a.shares)))[0];
        if (!eligible.length) { out.push({ rule: "R2", theme: t.id, themeLabel: theme.label, priority: "info", title: `${tool.label}：当前不可行`, tool: { symbol: tool.symbol, label: tool.label, kind: tool.kind }, quantity: null, unit: "张", notional: null, price: null, priceAt: null, sideEffects: [], note: largest ? `每张对应 ${thresholds.optionLot} 股，持仓最多的 ${largest.underlying} 仅 ${largest.shares} 股，不足一张；改用指数认沽、反向 ETF 或减仓（R4）` : "没有 ≥100 股的股票持仓" }); continue; }
        for (const g of eligible) {
          const contracts = money(g.shares).div(thresholds.optionLot).floor();
          out.push({ rule: "R2", theme: t.id, themeLabel: theme.label, priority: analysis.marketContext.bearish ? "now" : "standby", title: `${g.underlying}：${tool.kind === "covered-call" ? "卖出认购（备兑）" : "买入认沽（保护）"} ${contracts.toFixed()} 张`, tool: { symbol: g.underlying, label: tool.label, kind: tool.kind }, quantity: contracts.toFixed(), unit: "张", notional: fixed(contracts.mul(thresholds.optionLot).mul(g.underlyingPrice ?? "0")), price: g.underlyingPrice, priceAt: g.underlyingPriceAt, sideEffects: [], note: `${analysis.marketContext.bearish ? `最新日报判断为${analysis.marketContext.latestDaily?.stanceLabel ?? "偏空"}，建议启用` : "备用方案：日报或自行判断市场下跌时启用"}；${tool.note}` });
        }
        continue;
      }
      const benchmark = t.id === "us-equity" ? (instrumentProfile(tool.symbol).benchmark ?? "SPY") : null;
      const exposure = benchmark ? t.netBetaAdjusted[benchmark] ?? t.net : t.net;
      const target = money(exposure).abs().mul(ruleRatio);
      const q = quote(tool.symbol), price = q.last === null ? null : money(q.last), coefficient = Math.abs(tool.coefficient);
      const rule: BalancingAction["rule"] = tool.kind === "related" ? "R3" : netLong ? (t.id === "us-equity" ? "R4" : "R3") : "R1";
      const priority: BalancingAction["priority"] = netLong && t.id === "us-equity" && !analysis.marketContext.bearish && tool.kind !== "related" ? "standby" : "now";
      if (tool.kind === "option") {
        const underlyingPrice = price, perContract = underlyingPrice === null ? null : underlyingPrice.mul(thresholds.optionLot).mul(putDelta).mul(coefficient);
        const contracts = perContract === null || perContract.isZero() ? null : target.div(perContract);
        out.push({ rule, theme: t.id, themeLabel: theme.label, priority, title: `${tool.label}：约 ${fixed(contracts) ?? "—"} 张（假设 |Delta| ${putDelta.toFixed(2)}）`, tool: { symbol: tool.symbol, label: tool.label, kind: tool.kind }, quantity: fixed(contracts), unit: "张", notional: fixed(target), price: q.last, priceAt: q.tradeAt, sideEffects: [],
          note: perContract === null ? "缺少标的报价" : contracts !== null && contracts.lt(1) ? `每张 Delta 名义约 ${fixed(perContract)} USD，是目标的 ${fixed(perContract.div(target.isZero() ? 1 : target), 1)} 倍；账户规模下一张就会超额，优先考虑反向 ETF 股数、减仓或更低 Delta/价差结构` : `${percentNote(ruleRatio)}目标 ${fixed(target)} USD；每张 Delta 名义约 ${fixed(perContract)} USD；${tool.note}` });
        continue;
      }
      const toolNotional = target.div(coefficient || 1);
      const shares = price === null || price.isZero() ? null : toolNotional.div(price);
      // The tool is always bought; its other catalog memberships come along as side exposures.
      const effects = sideEffects(tool.symbol, toolNotional, t.id);
      const heavy = equity !== null && !equity.isZero() ? effects.filter(e => money(e.notional).abs().div(equity).gte(thresholds.significantToEquity)) : [];
      out.push({ rule, theme: t.id, themeLabel: theme.label, priority: heavy.length ? "standby" : priority, title: `买入 ${tool.label}：约 ${fixed(shares) ?? "—"} 股`, tool: { symbol: tool.symbol, label: tool.label, kind: tool.kind }, quantity: fixed(shares), unit: "股", notional: fixed(toolNotional), price: q.last, priceAt: q.tradeAt, sideEffects: effects,
        note: `${percentNote(ruleRatio)}目标 ${fixed(target)} USD${coefficient !== 1 ? `，工具系数 ${tool.coefficient} → 工具名义 ${fixed(toolNotional)} USD` : ""}${effects.length ? `；附带敞口：${effects.map(e => `${e.label} ${e.notional} USD`).join("、")}` : ""}${heavy.length ? `；附带的 ${heavy.map(e => `${e.label}（占净资产 ${pct(money(e.notional).abs(), equity)}%）`).join("、")} 会显著改变其他主题方向，本账户规模下列为备用` : ""}${tool.note ? `；${tool.note}` : ""}` });
    }
    const reduceGroups = analysis.groups.filter(g => g.deltaNotional !== null && g.memberships.some(m => m.theme === t.id && (money(g.deltaNotional!).mul(m.coefficient).gt(0) === netLong)));
    if (reduceGroups.length) {
      const target = money(t.net).abs().mul(ruleRatio);
      out.push({ rule: netLong ? (t.id === "us-equity" ? "R4" : "R3") : "R1", theme: t.id, themeLabel: theme.label, priority: "now", title: `减少${netLong ? "多头" : "空头"}：按比例减仓 ${reduceGroups.map(g => g.underlying).join("、")}`, tool: { symbol: "*", label: "减仓", kind: "direct" }, quantity: null, unit: "—", notional: fixed(target), price: null, priceAt: null, sideEffects: [], note: `${percentNote(ruleRatio)}减少 ${fixed(target)} USD 主题敞口；减仓没有基差风险，但放弃相应方向的判断收益。各结构每张/每股 Delta 名义见明细` });
    }
  }
  const definedRisk = analysis.groups.filter(g => g.maxLoss !== null && g.legs.some(l => l.kind === "option"));
  const defined = sum(definedRisk.map(g => g.maxLoss!.value));
  if (defined !== null && equity !== null && !equity.isZero() && defined.div(equity).gt(thresholds.definedLossToEquityLimit)) {
    const limit = equity.mul(thresholds.definedLossToEquityLimit);
    out.push({ rule: "R5", theme: "all", themeLabel: "全部限定风险结构", priority: "info", title: `限定风险结构最大亏损 ${fixed(defined)} USD 超过净资产 ${Math.round(thresholds.definedLossToEquityLimit * 100)}%（${fixed(limit)} USD）`, tool: { symbol: "*", label: "减少张数 / 缩小价差", kind: "direct" }, quantity: null, unit: "—", notional: fixed(defined.minus(limit)), price: null, priceAt: null, sideEffects: [], note: `按 R5 需减少约 ${fixed(defined.minus(limit))} USD 的最大亏损；从占比最大的结构开始：${definedRisk.sort((a, b) => money(b.maxLoss!.value).comparedTo(money(a.maxLoss!.value))).slice(0, 3).map(g => `${g.underlying} ${g.maxLoss!.value} USD`).join("、")}` });
  }
  const priorityRank = { now: 0, standby: 1, info: 2 };
  return out.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
}

export interface RiskExposureReference {
  schemaVersion: 1; generatedAt: string; method: typeof EXPOSURE_METHOD; catalog: { themes: ExposureTheme[]; instruments: Record<string, InstrumentProfile> }; data: RiskExposureAnalysis; markdown: string;
}
/** Everything another LLM needs to repeat the analysis: method, the touched catalog slice, the data and a Markdown rendering. */
export function riskExposureReference(analysis: RiskExposureAnalysis): RiskExposureReference {
  const themes = EXPOSURE_THEMES.filter(t => analysis.themes.some(x => x.id === t.id));
  const instruments: Record<string, InstrumentProfile> = {};
  for (const g of analysis.groups) instruments[g.underlying] = instrumentProfile(g.underlying);
  for (const t of themes) for (const tool of [...t.longTools, ...t.shortTools]) if (tool.symbol !== "*" && INSTRUMENT_PROFILES[tool.symbol]) instruments[tool.symbol] = INSTRUMENT_PROFILES[tool.symbol]!;
  return { schemaVersion: 1, generatedAt: analysis.capturedAt, method: EXPOSURE_METHOD, catalog: { themes, instruments }, data: analysis, markdown: renderRiskExposureMarkdown(analysis) };
}
export function renderRiskExposureMarkdown(a: RiskExposureAnalysis): string {
  const row = (cells: (string | number | null | undefined)[]) => `| ${cells.map(c => c === null || c === undefined ? "—" : String(c).replace(/\|/g, "\\|")).join(" | ")} |`;
  const lines: string[] = [];
  lines.push(`# 持仓风险敞口分析（${a.capturedAt}）`, "", `- 方法版本：${a.methodVersion}；币种 USD；净资产（券商报告）：${a.equity ?? "未知"}`, `- 最新日报判断：${a.marketContext.latestDaily ? `${a.marketContext.latestDaily.date} ${a.marketContext.latestDaily.stanceLabel}（${a.marketContext.latestDaily.title}）` : "无"}`, `- 参数：对冲比例 ${Math.round(a.options.ratio * 100)}%，认沽 |Delta| 假设 ${a.options.putDelta.toFixed(2)}；“大量”阈值 = 净资产 × ${a.thresholds.significantToEquity}`, "", "## 1. 总体方向", "", `**${a.overall.label}**。${a.overall.summary}`, "", "## 2. 主题敞口", "", row(["主题", "多头", "空头", "净", "占净资产 %", "覆盖率 %", "状态", "构成（标的×系数）"]), row(["---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const t of a.themes) lines.push(row([t.label, t.long, t.short, t.net, t.netToEquity, t.coverage, t.statusLabel + (t.significant ? "，占比大" : ""), t.contributions.map(c => `${c.underlying}×${c.coefficient}=${c.notional}`).join("；")]));
  const us = a.themes.find(t => t.id === "us-equity");
  if (us) lines.push("", `美股权益 β 调整净敞口：${HEDGE_BENCHMARKS.map(b => `对 ${b} ${us.netBetaAdjusted[b] ?? "—"} USD`).join("；")}${us.betaAssumedGroups.length ? `（${us.betaAssumedGroups.join("、")} 按 β=1）` : ""}`);
  lines.push("", "## 3. 标的明细", "", row(["标的", "结构", "方向", "Delta 股数", "Delta 名义", "市值", "最大亏损", "最近到期", "主题归属", "β(SPY)"]), row(Array(10).fill("---")));
  for (const g of a.groups) lines.push(row([g.underlying, g.structure, { bullish: "看多", bearish: "看空", neutral: "中性", unknown: "待核算" }[g.direction], g.deltaShares, g.deltaNotional, g.marketValue, g.maxLoss ? `${g.maxLoss.value}（${g.maxLoss.basis}）` : g.unlimitedRisk ? "无上限" : null, g.nearestExpiry ? `${g.nearestExpiry}（${g.daysToExpiry} 天）` : null, g.memberships.map(m => `${themeById(m.theme)?.label ?? m.theme}×${m.coefficient}`).join("；"), g.betas.SPY ? `${g.betas.SPY.beta}（n=${g.betas.SPY.samples}）` : null]));
  lines.push("", "### 逐腿", "", row(["券商", "代码", "数量", "Delta", "合约规模", "标记价", "Delta 名义", "说明"]), row(Array(8).fill("---")));
  for (const g of a.groups) for (const l of g.legs) lines.push(row([brokerLabel(l.broker), l.symbol, l.quantity, l.delta, l.multiplier, l.markPrice, l.deltaNotional, l.notes.join("；")]));
  lines.push("", "## 4. 发现（按严重程度）", "");
  for (const f of a.findings) lines.push(`- [${{ high: "高", medium: "中", info: "参考" }[f.severity]}] **${f.title}** ${f.detail}`);
  lines.push("", "## 5. 平衡 / 对冲动作参考", "", row(["规则", "优先级", "主题", "动作", "数量", "价格", "目标/工具名义", "附带敞口", "说明"]), row(Array(9).fill("---")));
  for (const x of a.actions) lines.push(row([x.rule, { now: "建议执行", standby: "备用", info: "提示" }[x.priority], x.themeLabel, x.title, x.quantity === null ? null : `${x.quantity} ${x.unit}`, x.price, x.notional, x.sideEffects.map(e => `${e.label} ${e.notional}`).join("；"), x.note]));
  lines.push("", "## 6. 假设与缺失", "");
  for (const s of a.assumptions) lines.push(`- ${s}`);
  for (const s of a.missing) lines.push(`- 缺失：${s}`);
  lines.push("", "## 7. 判断方法", "", ...EXPOSURE_METHOD.steps.map(s => `- ${s}`), "", "### 规则", "", ...EXPOSURE_METHOD.rules.map(r => `- **${r.id} ${r.title}**：条件 — ${r.condition}；动作 — ${r.action}`), "", "### 提示模板", "", EXPOSURE_METHOD.promptTemplate, "");
  return lines.join("\n");
}
