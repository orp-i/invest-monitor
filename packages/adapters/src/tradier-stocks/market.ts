import { Decimal } from "decimal.js";
import { type MarketQuote, type Result, type SourceError, err } from "@invest/domain";
import { freshnessFor, normalizeOptionalDecimal, sourceError } from "../common.js";
import type { AdapterContext } from "../types.js";
import { tradierTradeFreshness } from "./clock.js";

export const stockSymbolPattern = /^[A-Z][A-Z0-9/.-]{0,19}$/;
export const optionSymbolPattern = /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/;
export const marketSymbolPattern = /^[A-Z][A-Z0-9/.-]{0,34}$/;
export const marketRecord = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
export const marketList = (v: unknown): unknown[] => v === undefined || v === null || v === "null" ? [] : Array.isArray(v) ? v : [v];
export const validMarketDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const decimal = (v: unknown, nonnegative = false): string | null => {
  try { const n = normalizeOptionalDecimal(v); return n !== null && (!nonnegative || new Decimal(n).gte(0)) ? n : null; } catch { return null; }
};
const timestamp = (v: unknown): string | null => /^\d{12,14}$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number.isFinite(new Date(Number(v)).getTime()) ? new Date(Number(v)).toISOString() : null;

export function normalizeMarketQuotes(raw: unknown, context: AdapterContext): Result<MarketQuote[], SourceError> {
  const quotes: MarketQuote[] = [];
  const seen = new Set<string>();
  for (const item of marketList(raw)) {
    const row = marketRecord(item);
    if (!row || typeof row.symbol !== "string" || !marketSymbolPattern.test(row.symbol) || !["stock", "etf", "option"].includes(String(row.type)) || seen.has(row.symbol)) return err(sourceError(context, "schema", "Tradier 报价包含无效或重复的合约"));
    seen.add(row.symbol);
    const type = row.type as MarketQuote["type"];
    const strike = decimal(row.strike, true);
    if (type === "option" && (!optionSymbolPattern.test(row.symbol) || !validMarketDay(row.expiration_date) || !["call", "put"].includes(String(row.option_type)) || strike === null || typeof row.underlying !== "string")) return err(sourceError(context, "schema", "Tradier 期权缺少合约身份字段"));
    const tradeAt = timestamp(row.trade_date);
    const g = marketRecord(row.greeks);
    const contractSize = decimal(row.contract_size, true);
    quotes.push({
      symbol: row.symbol, description: typeof row.description === "string" ? row.description : row.symbol, type,
      last: tradeAt ? decimal(row.last, true) : null, bid: decimal(row.bid, true), ask: decimal(row.ask, true),
      tradeAt, bidAt: timestamp(row.bid_date), askAt: timestamp(row.ask_date),
      change: decimal(row.change), changePercent: decimal(row.change_percentage),
      volume: decimal(row.volume, true), openInterest: type === "option" ? decimal(row.open_interest, true) : null,
      underlying: type === "option" ? String(row.underlying) : null,
      expiration: type === "option" ? String(row.expiration_date) : null,
      strike: type === "option" ? strike : null, right: type === "option" ? row.option_type as "call" | "put" : null,
      contractSize: type === "option" && contractSize !== null && new Decimal(contractSize).gt(0) ? contractSize : null,
      greeks: type === "option" && g ? { delta: decimal(g.delta), gamma: decimal(g.gamma), theta: decimal(g.theta), vega: decimal(g.vega), rho: decimal(g.rho), midIv: decimal(g.mid_iv, true), updatedAt: typeof g.updated_at === "string" ? g.updated_at.slice(0, 60) : null } : null,
      freshness: tradeAt ? tradierTradeFreshness(tradeAt, context, type === "option" ? "option" : "equity") : null,
    });
  }
  return { ok: true, value: quotes };
}
