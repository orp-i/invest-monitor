import { Decimal } from "decimal.js";
import { brokerLabel, withBrokerExecutionDetails } from "./broker-analytics.js";
import { tradierSymbol } from "./market-data.js";
import type { BrokerSnapshot } from "./workspace.js";
import type { StatementImport } from "./trading-review.js";

const Money = Decimal.clone({ precision: 50 });
type Fill = { id: string; broker: string; account: string; symbol: string; currency: string; side: "buy" | "sell"; qty: string; price: string | null; gross: string | null; fee: string | null; commission?: string | null; multiplier: string | null; at: string; day: string; precision: string; effect: string | null; netCash?: string | null };
const day = (v: string) => /^\d{8}/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v.slice(0, 10);
const normalized = (v: string | null) => v === null ? "?" : new Money(v).toFixed();
const signature = (f: Fill) => [f.broker, f.account, f.symbol, f.currency, f.side, normalized(f.qty), normalized(f.price), f.day].join(":");
export interface AccountPerformance {
  currency: "USD"; capturedAt: string; totalNet: string; realizedNet: string; unrealizedNet: string; fees: string; unallocatedFees: string;
  equity: string | null; complete: boolean; missing: string[]; fills: number; duplicateFills: number; from: string | null;
  basis: string; valuedPositions: number; positions: number; accounts: { broker: string; asOf: string }[];
}
export interface PerformanceSample { capturedAt: string; totalNet: string; unrealizedNet: string; realizedNet: string; fees: string; complete: boolean; basis: string; scheduledFor?: string }

// Both long and short entry fees belong to the open position until it closes.
// Exact reported cash amounts also preserve fractional-share cent rounding.
export function replayBrokerTrades(rows: { side: "buy" | "sell"; quantity: string; grossAmount: string; fees: string }[]) {
  let quantity = new Money(0), costBasis = new Money(0), realizedPnl = new Money(0);
  for (const row of rows) {
    const size = new Money(row.quantity), amount = new Money(row.grossAmount), fee = new Money(row.fees), sign = row.side === "buy" ? 1 : -1;
    if (!size.gt(0) || amount.lt(0)) throw new Error("Invalid execution size or amount");
    if (quantity.isZero() || quantity.isPositive() === (sign > 0)) {
      quantity = quantity.plus(size.mul(sign)); costBasis = costBasis.plus(amount.mul(sign)).plus(fee); continue;
    }
    const currentSign = quantity.isPositive() ? 1 : -1, closed = Money.min(size, quantity.abs());
    const price = amount.div(size), average = costBasis.div(quantity), closingFee = fee.mul(closed).div(size);
    realizedPnl = realizedPnl.plus(price.minus(average).mul(closed).mul(currentSign)).minus(closingFee);
    quantity = quantity.plus(closed.mul(sign)); costBasis = costBasis.minus(average.mul(closed).mul(currentSign));
    if (quantity.isZero()) costBasis = new Money(0);
    const opened = size.minus(closed);
    if (opened.gt(0)) { quantity = opened.mul(sign); costBasis = opened.mul(price).mul(sign).plus(fee.minus(closingFee)); }
  }
  return { quantity: quantity.toFixed(), costBasis: costBasis.toFixed(), realizedPnl: realizedPnl.toFixed() };
}

// All profit is scoped to imported executions and the latest broker inventory.
// Cash movements and NAV are never treated as profit. Fees enter exactly once.
export function accountPerformance(accountsInput: BrokerSnapshot[], statements: StatementImport[], marks: Map<string, string>, capturedAt: string): AccountPerformance {
  const accounts = withBrokerExecutionDetails(accountsInput.filter(a => a.environment !== "sandbox"), statements);
  const missing = new Set<string>(), fills: Fill[] = [];
  const accountFor = (broker: string) => accounts.filter(a => a.broker === broker).length === 1 ? accounts.find(a => a.broker === broker)!.accountId : `statement:${broker}`;
  const knownIds = new Set<string>();
  for (const statement of statements) for (const f of statement.fills) {
    if (knownIds.has(f.id)) continue; knownIds.add(f.id);
    const broker = statement.broker === "大象" ? "elephant" : "tradier";
    if (broker === "tradier" && accounts.filter(a => a.broker === "tradier").length > 1) { missing.add("Tradier 多账户结单归属待核实，暂以 API 成交计算，避免重复计入"); continue; }
    fills.push({ id: f.id, broker, account: accountFor(broker), symbol: tradierSymbol(f.symbol), currency: f.currency, side: f.side, qty: f.quantity, price: f.price, gross: f.provenance?.grossAmount ?? null, fee: f.feeCost, commission: f.provenance?.feeBreakdown.commission ?? null, multiplier: f.multiplier, at: f.occurredAt, day: day(f.occurredAt), precision: f.timePrecision, effect: f.provenance?.action ?? null });
  }
  const unmatched = new Map<string, Fill[]>();
  for (const f of fills) unmatched.set(signature(f), [...(unmatched.get(signature(f)) ?? []), f]);
  let duplicates = 0;
  for (const account of accounts) for (const t of account.trades) {
    if (account.broker === "elephant" && knownIds.has(t.id)) { duplicates++; continue; }
    const f: Fill = { id: `${account.broker}:${account.accountId}:${t.id}`, broker: account.broker, account: account.accountId, symbol: tradierSymbol(t.symbol), currency: t.currency,
      side: t.side, qty: t.quantity, price: t.price, gross: t.grossAmount ?? null, netCash: t.netCash, fee: t.statementFees ?? t.totalFees ?? (t.fees === null || (account.broker === "ibkr" && !t.feeCurrency) || (t.feeCurrency && t.feeCurrency !== "USD") ? null : new Money(t.fees).mul(account.broker === "ibkr" ? -1 : 1).toFixed()),
      multiplier: t.multiplier ?? (/^(stk|stock|etf|equity)$/i.test(t.assetType) ? "1" : null), at: t.tradedAt, day: day(t.tradedAt), precision: t.timePrecision, effect: t.positionEffect ?? null };
    // Tradier history supplies dates, while confirmations contain the same
    // executions. Match one-to-one by account/symbol/side/size/price/date.
    const match = account.broker === "tradier" && accounts.filter(a => a.broker === "tradier").length === 1 ? unmatched.get(signature(f))?.shift() : undefined;
    if (match) {
      duplicates++;
      // The history endpoint exposes commission alone. The reconciled
      // confirmation also includes transaction and additional fees.
      if (t.totalFees == null && f.fee !== null && match.fee !== null && !new Money(f.fee).eq(match.fee) && (match.commission == null || !new Money(f.fee).eq(match.commission))) missing.add(`${brokerLabel(f.broker)} ${f.symbol}：API 与结单佣金待核对，已采用正式结单完整费用`);
      if (match.fee === null) match.fee = f.fee;
      continue;
    }
    if (account.broker === "tradier" && t.netCash != null && t.totalFees == null && t.statementFees == null) missing.add(`${brokerLabel(f.broker)} ${f.symbol}：净盈亏采用结算现金，费用明细仅已知佣金，合约规模待补充`);
    fills.push(f);
  }
  // Contract size may be supplied by a confirmation or the broker position for
  // this exact OCC contract. It is never inferred from an arbitrary 100 rule.
  const multipliers = new Map<string, Set<string>>();
  for (const f of fills) if (f.multiplier) multipliers.set(`${f.broker}:${f.symbol}`, new Set([...(multipliers.get(`${f.broker}:${f.symbol}`) ?? []), f.multiplier]));
  for (const a of accounts) for (const p of a.positions) if (p.multiplier) multipliers.set(`${a.broker}:${tradierSymbol(p.symbol)}`, new Set([...(multipliers.get(`${a.broker}:${tradierSymbol(p.symbol)}`) ?? []), p.multiplier]));
  let fees = new Money(0), allocatedFees = new Money(0), realizedNet = new Money(0), unrealizedNet = new Money(0), valuedPositions = 0;
  const groups = new Map<string, Fill[]>();
  const groupKey = (a: string, b: string, s: string) => JSON.stringify([a, b, s]);
  for (const f of fills) {
    if (f.currency !== "USD") { missing.add(`${brokerLabel(f.broker)}：${f.currency} 成交缺少可核实的 USD 汇率`); continue; }
    if (f.fee === null) missing.add(`${brokerLabel(f.broker)} ${f.symbol}：手续费缺失`); else fees = fees.plus(f.fee);
    const options = multipliers.get(`${f.broker}:${f.symbol}`);
    if (options?.size === 1 && !f.multiplier) f.multiplier = [...options][0]!;
    if (options && options.size > 1) { f.multiplier = null; missing.add(`${f.symbol}：合约规模冲突`); }
    const key = groupKey(f.broker, f.account, f.symbol); groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const covered = new Set<string>();
  for (const [key, group] of groups) {
    group.sort((a, b) => a.day.localeCompare(b.day) || a.at.localeCompare(b.at));
    const first = group[0]!, name = `${brokerLabel(first.broker)} ${first.symbol}`;
    const cashComplete = group.every(f => f.netCash != null);
    if (group.some(f => (f.netCash == null && (f.price === null || f.multiplier === null)) || !new Money(f.qty).gt(0) || (f.multiplier !== null && !new Money(f.multiplier).gt(0))) || first.effect === "close") { missing.add(`${name}：开仓记录或合约规模不完整`); continue; }
    const quantity = group.reduce((n, f) => n.plus(new Money(f.qty).mul(f.side === "buy" ? 1 : -1)), new Money(0));
    const groupFees = group.reduce((n, f) => n.plus(f.fee ?? "0"), new Money(0));
    if (quantity.isZero()) {
      const gross = group.reduce((n, f) => n.plus(f.netCash != null ? new Money(f.netCash).plus(f.fee ?? "0") : new Money(f.gross ?? new Money(f.qty).mul(f.price!).mul(f.multiplier!)).mul(f.side === "sell" ? 1 : -1)), new Money(0));
      realizedNet = realizedNet.plus(cashComplete ? group.reduce((n, f) => n.plus(f.netCash!), new Money(0)) : gross.minus(groupFees)); allocatedFees = allocatedFees.plus(groupFees); continue;
    }
    const account = accounts.find(a => a.broker === first.broker && a.accountId === first.account);
    const position = account?.positions.find(p => tradierSymbol(p.symbol) === first.symbol && p.currency === "USD" && new Money(p.quantity).eq(quantity));
    if (!position || group.some(f => f.precision === "day" && group.some(other => other.day === f.day && other.side !== f.side)) || group.some(f => f.multiplier === null || f.price === null)) { missing.add(`${name}：成交余额与当前持仓或开仓依据尚未核对`); continue; }
    const replay = (includeFees: boolean) => replayBrokerTrades(group.map(f => ({ side: f.side, quantity: f.qty, grossAmount: f.netCash != null ? new Money(f.netCash).plus(f.fee ?? "0").mul(f.side === "sell" ? 1 : -1).toFixed() : f.gross ?? new Money(f.qty).mul(f.price!).mul(f.multiplier!).toFixed(), fees: includeFees ? f.fee ?? "0" : "0" })));
    const net = replay(true), gross = replay(false);
    const realizedFees = new Money(gross.realizedPnl).minus(net.realizedPnl);
    realizedNet = realizedNet.plus(net.realizedPnl); allocatedFees = allocatedFees.plus(realizedFees);
    const mark = marks.get(first.symbol);
    if (mark === undefined) { missing.add(`${name}：缺少 Tradier 最近成交价（到期合约需核对结算）`); continue; }
    const value = new Money(position.quantity).mul(first.multiplier!).mul(mark);
    unrealizedNet = unrealizedNet.plus(value.minus(net.costBasis));
    allocatedFees = allocatedFees.plus(new Money(net.costBasis).minus(gross.costBasis));
    covered.add(key); valuedPositions++;
  }
  const positions = accounts.flatMap(a => a.positions.filter(p => !new Money(p.quantity).isZero()).map(p => ({ account: a, position: p })));
  const valuationDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(capturedAt));
  for (const { account: a, position: p } of positions) {
    const key = groupKey(a.broker, a.accountId, tradierSymbol(p.symbol));
    if (!covered.has(key) && !groups.has(key) && p.currency === "USD" && p.unrealizedPnl !== null) {
      unrealizedNet = unrealizedNet.plus(p.unrealizedPnl); covered.add(key); valuedPositions++;
      missing.add(`${brokerLabel(a.broker)} ${p.symbol}：未实现采用券商报告，历史成交与费用待补充`);
    }
    if (!covered.has(key)) missing.add(`${brokerLabel(a.broker)} ${p.symbol}：成本、报价或持仓变动待补充`);
    const expiry = /(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(tradierSymbol(p.symbol));
    if (expiry && `20${expiry[1]}-${expiry[2]}-${expiry[3]}` < valuationDay) missing.add(`${p.symbol}：结单仍列示已到期期权，需核对到期或行权结果`);
  }
  for (const a of accounts) if (a.currency !== "USD") missing.add(`${brokerLabel(a.broker)}：账户 ${a.currency ?? "未知币种"} 净值缺少 USD 换算依据`);
  const unallocatedFees = fees.minus(allocatedFees);
  const basis = JSON.stringify([fills.map(f => [f.id, f.qty, f.price, f.gross, f.fee, f.multiplier, f.netCash]).sort(), accounts.map(a => [a.broker, a.accountId, a.positions.map(p => [p.symbol, p.quantity])]), [...covered].sort(), [...missing].sort()]);
  return { currency: "USD", capturedAt, totalNet: realizedNet.plus(unrealizedNet).minus(unallocatedFees).toDecimalPlaces(8).toFixed(), realizedNet: realizedNet.toDecimalPlaces(8).toFixed(), unrealizedNet: unrealizedNet.toDecimalPlaces(8).toFixed(), fees: fees.toFixed(), unallocatedFees: unallocatedFees.toFixed(),
    equity: accounts.some(a => a.currency !== "USD" || a.equity === null) ? null : accounts.reduce((n, a) => n.plus(a.equity!), new Money(0)).toFixed(),
    complete: missing.size === 0 && positions.length === valuedPositions, missing: [...missing], fills: fills.length, duplicateFills: duplicates, from: fills.map(f => f.day).sort()[0] ?? null,
    basis, valuedPositions, positions: positions.length, accounts: accounts.map(a => ({ broker: a.broker, asOf: a.asOf })),
  };
}
