import type { Candle, Freshness } from "./schemas.js";
import type { MovingAverages } from "./candle-chart.js";

export interface MarketGreeks {
  delta: string | null; gamma: string | null; theta: string | null;
  vega: string | null; rho: string | null; midIv: string | null;
  // Keep the provider's timestamp verbatim: Tradier does not include an offset.
  updatedAt: string | null;
}
export interface MarketQuote {
  symbol: string;
  description: string;
  type: "stock" | "etf" | "option";
  last: string | null; bid: string | null; ask: string | null;
  tradeAt: string | null; bidAt: string | null; askAt: string | null;
  change: string | null; changePercent: string | null;
  volume: string | null; openInterest: string | null;
  underlying: string | null; expiration: string | null; strike: string | null;
  right: "call" | "put" | null; contractSize: string | null;
  greeks: MarketGreeks | null;
  freshness: Freshness | null;
}
export interface MarketMeta {
  source: "Tradier";
  environment: "live" | "sandbox";
  currency: "USD";
  receivedAt: string;
}
export interface MarketQuotesResponse extends MarketMeta { quotes: MarketQuote[]; missing: string[] }
export interface OptionExpirationsResponse extends MarketMeta { symbol: string; expirations: string[] }
export interface OptionChainResponse extends MarketMeta { symbol: string; expiration: string; contracts: MarketQuote[] }
export interface MarketHistoryResponse extends MarketMeta { symbol: string; candles: readonly (Candle & { ma?: MovingAverages })[]; notice: string; warnings?: readonly string[] }
export interface MarketIntradayResponse extends MarketMeta { symbol: string; date: string; session?: "pre" | "regular" | "post" | "overnight"; interval: "5min"; points: { time: number; price: string }[]; notice: string }

// Broker symbols may pad the OCC root with spaces. Never infer a contract's
// multiplier from the root or assume that every option delivers 100 shares.
export function tradierSymbol(symbol: string): string {
  const compact = symbol.trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/.test(compact) ? compact : symbol.trim().toUpperCase().replace(/\./g, "/");
}
