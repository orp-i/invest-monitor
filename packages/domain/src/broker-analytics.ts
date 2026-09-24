import { Decimal } from "decimal.js";
import type { BrokerSnapshot, BrokerTrade } from "./workspace.js";
import type { StatementImport } from "./trading-review.js";
import { tradierSymbol } from "./market-data.js";
const Money = Decimal.clone({ precision: 40 });
export const brokerLabel = (broker: string): string => broker === "elephant" ? "大象" : broker === "schwab" ? "嘉信 Schwab" : broker === "alpaca" ? "Alpaca" : broker.toUpperCase();
export function assetKind(value: string | undefined): "股票 / ETF" | "期权" | "其他" {
  if (/^(stk|stock|stocks|equity|equities|etf)$/i.test(value ?? "")) return "股票 / ETF";
  if (/^(opt|option|options|fop)$/i.test(value ?? "")) return "期权";
  return "其他";
}
export function exactTotal(values: (string | null | undefined)[]): string | null {
  return values.some(v => v == null) ? null : values.reduce<InstanceType<typeof Money>>((n, v) => n.plus(v!), new Money(0)).toFixed();
}
export function brokerFeeTotals(account: BrokerSnapshot) {
  const groups = new Map<string, { values: (string | null)[]; trades: number }>();
  for (const trade of account.trades) {
    const currency = account.broker === "ibkr" ? trade.feeCurrency ?? "币种待核实" : trade.currency;
    const group = groups.get(currency) ?? { values: [], trades: 0 }; groups.set(currency, group);
    group.trades++;
    group.values.push(trade.statementFees ?? trade.totalFees ?? (trade.fees === null ? null : new Money(trade.fees).mul(account.broker === "ibkr" ? -1 : 1).toFixed()));
  }
  return [...groups].map(([currency, group]) => ({ currency, total: exactTotal(group.values), known: exactTotal(group.values.filter(v => v !== null))!, missing: group.values.filter(v => v === null).length, trades: group.trades }));
}
// Read-only enrichment: keep the API commission and immutable execution ID,
// while showing confirmed total expenses when this exact execution is matched.
export function withConfirmedBrokerFees(accounts: BrokerSnapshot[], statements: StatementImport[]): BrokerSnapshot[] {
  const real = accounts.filter(a => a.broker === "tradier" && a.environment !== "sandbox");
  if (real.length !== 1) return accounts;
  const key = (f: { symbol: string; currency: string; side: string; quantity: string; price: string | null }, date: string) => JSON.stringify([tradierSymbol(f.symbol), f.currency, f.side, new Money(f.quantity).toFixed(), f.price === null ? null : new Money(f.price).toFixed(), date.slice(0, 10)]);
  const unique = new Map(statements.filter(s => s.broker.toLowerCase() === "tradier").flatMap(s => s.fills.map(f => [f.id, f] as const)));
  const matches = new Map<string, StatementImport["fills"]>();
  for (const fill of unique.values()) { const id = key(fill, fill.occurredAt); matches.set(id, [...(matches.get(id) ?? []), fill]); }
  return accounts.map(a => a !== real[0] ? a : { ...a, trades: a.trades.map(t => {
    const match = matches.get(key(t, t.tradedAt))?.shift();
    return match ? { ...t, statementFillId: match.id, positionEffect: t.positionEffect ?? match.positionEffect ?? match.provenance?.action, multiplier: t.multiplier ?? match.multiplier, statementFees: match.feeCost, statementFeeSource: match.provenance?.fileName ?? "正式成交确认单" } : t;
  }) });
}
export function brokerPositionTotals(accounts: BrokerSnapshot[]) {
  const groups = new Map<string, BrokerSnapshot["positions"]>();
  for (const account of accounts) for (const position of account.positions) groups.set(position.currency, [...(groups.get(position.currency) ?? []), position]);
  return [...groups].map(([currency, rows]) => ({ currency, count: rows.length, cost: exactTotal(rows.map(p => p.costBasis)), marketValue: exactTotal(rows.map(p => p.marketValue)), unrealizedPnl: exactTotal(rows.map(p => p.unrealizedPnl)) }));
}

// Exact option identities may share verified contract metadata across brokers.
// Net settlement cash includes expenses; commission remains a separate source field.
export function withBrokerExecutionDetails(accounts: BrokerSnapshot[], statements: StatementImport[]): BrokerSnapshot[] {
  const sizes = new Map<string, Set<string>>();
  const add = (symbol: string, size: string | null | undefined) => {
    if (size != null && new Money(size).gt(0)) {
      const key = tradierSymbol(symbol); sizes.set(key, new Set([...(sizes.get(key) ?? []), new Money(size).toFixed()]));
    }
  };
  for (const a of accounts) for (const row of [...a.positions, ...a.trades]) add(row.symbol, row.multiplier);
  for (const s of statements) for (const f of s.fills) add(f.symbol, f.multiplier);
  return withConfirmedBrokerFees(accounts, statements).map(a => ({ ...a, trades: a.trades.map(t => {
    const options = sizes.get(tradierSymbol(t.symbol));
    const multiplier = options?.size === 1 ? [...options][0]! : options && options.size > 1 ? null : t.multiplier ?? (assetKind(t.assetType) === "股票 / ETF" ? "1" : null);
    let totalFees = a.broker === "tradier" && t.netCash != null ? null : t.totalFees ?? null;
    if (a.broker === "tradier" && t.netCash != null && t.price !== null && multiplier !== null) {
      const gross = new Money(t.quantity).mul(t.price).mul(multiplier).mul(t.side === "sell" ? 1 : -1);
      const expense = gross.minus(t.netCash);
      // Invalid/reversed cash must never become an invented rebate or multiplier.
      if (expense.gte(0) && (t.fees === null || expense.gte(t.fees))) totalFees = expense.toFixed();
    }
    return { ...t, ...(options && options.size > 1 || multiplier !== null ? { multiplier } : {}), ...(totalFees !== null || t.totalFees != null ? { totalFees } : {}) };
  }) }));
}

// An unmatched one-sided execution stream can establish an opening only when
// its signed balance agrees with this account's current broker inventory.
export function brokerPositionEffect(account: BrokerSnapshot, trade: BrokerTrade): "open" | "close" | null {
  if (trade.positionEffect) return trade.positionEffect;
  const symbol = tradierSymbol(trade.symbol);
  const rows = account.trades.filter(t => tradierSymbol(t.symbol) === symbol && t.currency === trade.currency);
  const position = account.positions.find(p => tradierSymbol(p.symbol) === symbol && p.currency === trade.currency);
  return position && rows.length && rows.every(t => t.side === trade.side && t.positionEffect !== "close") && rows.reduce((n, t) => n.plus(new Money(t.quantity).mul(t.side === "buy" ? 1 : -1)), new Money(0)).eq(position.quantity) ? "open" : null;
}
