import { Decimal } from "decimal.js";
import { BrokerTradeSchema, type BrokerSnapshot, type BrokerTrade } from "./workspace.js";
import type { ReviewFill } from "./trading-review.js";
import { exactTotal, brokerLabel } from "./broker-analytics.js";
import { replayBrokerTrades } from "./account-performance.js";

const reportDay = (s: string) => /^\d{8}/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);

export function worthlessExpirationTrade(snapshot: BrokerSnapshot, opening: ReviewFill, id: string, recordedAt: string, note: string): BrokerTrade {
  if (snapshot.broker !== "elephant") throw Error("当前确认流程仅用于大象结单");
  const match = /(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(opening.symbol);
  if (!match) throw Error("仅支持明确的 OCC 到期期权");
  const expiration = `20${match[1]}-${match[2]}-${match[3]}`;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(recordedAt));
  if (expiration >= today) throw Error("到期日尚未结束，不能记录作废");
  const position = snapshot.positions.find(p => p.symbol === opening.symbol);
  if (!position || !position.multiplier || opening.multiplier !== position.multiplier || opening.currency !== position.currency || opening.occurredAt.slice(0, 10) > expiration || !new Decimal(position.quantity).abs().eq(opening.quantity) || opening.provenance?.action !== "open") throw Error("持仓与原开仓依据不匹配");
  const rows = snapshot.trades.filter(t => t.symbol === opening.symbol).sort((a, b) => a.tradedAt.localeCompare(b.tradedAt));
  if (!rows.length || rows.some(t => t.price === null || t.multiplier === null || t.multiplier === undefined || t.fees === null)) throw Error("成交成本不完整");
  const replay = replayBrokerTrades(rows.map(t => ({ side: t.side, quantity: t.quantity, grossAmount: t.grossAmount ?? new Decimal(t.quantity).mul(t.price!).mul(t.multiplier!).toFixed(), fees: t.fees! })));
  if (!new Decimal(replay.quantity).eq(position.quantity)) throw Error("成交余额与待结算持仓不符");
  return BrokerTradeSchema.parse({ id, externalId: null, symbol: position.symbol,
    side: new Decimal(position.quantity).gt(0) ? "sell" : "buy", quantity: new Decimal(position.quantity).abs().toFixed(),
    price: "0", grossAmount: "0", fees: "0", feeCurrency: position.currency, currency: position.currency,
    multiplier: position.multiplier, positionEffect: "close", tradedAt: expiration, timePrecision: "day", assetType: "OPT",
    expirationConfirmation: { kind: "worthless", recordedAt, openingFillId: opening.id, note },
  });
}

// The bank report remains intact in storage. Confirmed later events adjust the
// displayed inventory; report NAV, cash and its original date remain unchanged.
export function applyBrokerExpirations(snapshot: BrokerSnapshot): BrokerSnapshot {
  let positions = snapshot.positions;
  const notes = [...snapshot.notes];
  for (const t of snapshot.trades.filter(t => t.expirationConfirmation?.kind === "worthless")) {
    const p = positions.find(p => p.symbol === t.symbol);
    if (!p) continue;
    if (reportDay(snapshot.asOf) > t.tradedAt || !new Decimal(p.quantity).plus(new Decimal(t.quantity).mul(t.side === "sell" ? -1 : 1)).isZero()) {
      notes.push(`${t.symbol}：结单持仓与用户确认的到期结果存在差异，请核对新结单。`); continue;
    }
    positions = positions.filter(row => row !== p);
    notes.push(`${t.symbol}：${t.tradedAt} 到期作废，结算价值 0；用户确认于 ${t.expirationConfirmation!.recordedAt}。未记录额外到期费用。账户净值、现金及其余价格仍为 ${snapshot.asOf} 结单口径。`);
  }
  return notes.length === snapshot.notes.length ? snapshot : { ...snapshot, positions, unrealizedPnl: positions === snapshot.positions ? snapshot.unrealizedPnl : exactTotal(positions.map(p => p.unrealizedPnl)), notes };
}

export function expirationReviewFill(trade: BrokerTrade, opening: ReviewFill, broker: string): ReviewFill {
  if (!trade.expirationConfirmation || trade.expirationConfirmation.openingFillId !== opening.id) throw Error("缺少对应的用户确认及开仓记录");
  return { id: trade.id, transactionId: trade.id, source: "adjustment", sourceLabel: brokerLabel(broker),
    instrumentKey: opening.instrumentKey, symbol: trade.symbol, side: trade.side, quantity: trade.quantity,
    price: "0", feeCost: "0", multiplier: trade.multiplier ?? null, currency: trade.currency,
    occurredAt: trade.tradedAt, timePrecision: "day", positionEffect: "close", environment: "statement",
    expirationConfirmation: trade.expirationConfirmation,
  };
}
