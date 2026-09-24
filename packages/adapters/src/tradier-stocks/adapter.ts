import { setTimeout as delay } from "node:timers/promises";
import { Decimal } from "decimal.js";
import { CandleSchema, QuoteSchema, InstrumentCandidateSchema, err, type Candle, type InstrumentCandidate, type Result, type SourceError } from "@invest/domain";
import { SourceParams, type SourceConfig } from "@invest/config";
import type { RawHttpResponse, EgressHttpClient } from "@invest/egress";
import { candidateCapabilities, fetchJson, freshnessFor, normalizeOptionalDecimal, queryUrl, sourceError, validateCapability } from "../common.js";
import type { AdapterContext, SourceAdapter, NormalizedAdapterData } from "../types.js";
import { tradierTradeFreshness } from "./clock.js";

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const list = (value: unknown): unknown[] => value === null || value === "null" ? [] : Array.isArray(value) ? value : value === undefined ? [] : [value];
const symbolPattern = /^[A-Z][A-Z0-9/.-]{0,19}$/;
const occPattern = /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/;
const marketDay = (iso: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const positive = (value: unknown): string | null => { const normalized = normalizeOptionalDecimal(value); return normalized !== null && new Decimal(normalized).gt(0) ? normalized : null; };

// Quotes, history, search, probes and retries share the token's market-data
// quota. Reserve at most one request per 1.1 seconds (including sandbox).
const limits = new WeakMap<EgressHttpClient, Map<string, { nextAt: number; tail: Promise<void> }>>();
export async function requestTradier(context: AdapterContext, path: string, params: Record<string, string>, signal: AbortSignal): Promise<Result<RawHttpResponse, SourceError>> {
  if (!context.authToken?.trim()) return err(sourceError(context, "auth", "请在服务器 .env 填写 TRADIER_ACCESS_TOKEN 后重新创建服务容器", { code: "auth-missing", causeCode: "MISSING_AUTH" }));
  const base = new URL(context.source.baseUrl);
  if (base.protocol !== "https:" || !["api.tradier.com", "sandbox.tradier.com"].includes(base.hostname) || base.username || base.password || base.port || !/^\/v1\/?$/.test(base.pathname) || base.search || base.hash) {
    return err(sourceError(context, "auth", "Tradier 行情地址必须为官方 HTTPS /v1 接口", { causeCode: "INVALID_ORIGIN" }));
  }
  const byToken = limits.get(context.httpClient) ?? new Map<string, { nextAt: number; tail: Promise<void> }>();
  limits.set(context.httpClient, byToken);
  const key = `${base.origin}:${context.authToken}`;
  const state = byToken.get(key) ?? { nextAt: 0, tail: Promise.resolve() };
  byToken.set(key, state);
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    signal.throwIfAborted();
    while (state.nextAt > Date.now()) await delay(state.nextAt - Date.now(), undefined, { signal });
    state.nextAt = Date.now() + 1100;
    // Serialize starts to respect the shared token quota, not entire network
    // round trips. Independent symbols can stay in flight concurrently.
    release();
    const result = await fetchJson({ ...context, source: { ...context.source, followRedirects: false } }, queryUrl(base.href, path, params), signal, { authorization: `Bearer ${context.authToken.trim()}`, accept: "application/json" });
    if (!result.ok && result.error.kind === "rate_limited") {
      state.nextAt = Math.max(state.nextAt, Date.now() + (result.error.retryAfterSeconds ?? 60) * 1000);
      return err({ ...result.error, retryAfterSeconds: result.error.retryAfterSeconds ?? 60 });
    }
    return result;
  } finally { release(); }
}

export function parseTradier(response: RawHttpResponse, context: AdapterContext): Result<Row, SourceError> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(response.body), (_key, value: unknown, token?: { source?: string }) => {
      if (typeof value !== "number") return value;
      if (!token?.source) throw new Error("Node 24 required");
      return token.source;
    });
    const root = record(value);
    if (!root || root.errors || root.error) throw new Error("Invalid envelope");
    return { ok: true, value: root };
  } catch {
    return err(sourceError(context, "parse", "Tradier 行情响应格式无效，请检查 Token 和行情权限", { causeCode: "INVALID_RESPONSE" }));
  }
}

const request = requestTradier;
const parse = parseTradier;

export const tradierStocksAdapter: SourceAdapter = {
  id: "tradier-stocks",
  paramsSchema: SourceParams["tradier-stocks"],
  capabilities: ["instrumentSearch", "quote", "candle"],
  freshnessClass: "realtime",
  freshnessClassFor: tradierFreshness,

  async searchInstruments(query, context) {
    const response = await request(context, "markets/search", { q: query.trim(), indexes: "false" }, new AbortController().signal);
    if (!response.ok) return response;
    const parsed = parse(response.value, context);
    if (!parsed.ok) return parsed;
    if (!("securities" in parsed.value) || (parsed.value.securities !== null && parsed.value.securities !== "null" && !Object.hasOwn(record(parsed.value.securities) ?? {}, "security"))) return err(sourceError(context, "schema", "Tradier 搜索响应不完整"));
    const rows = list(record(parsed.value.securities)?.security);
    const candidates: InstrumentCandidate[] = [];
    for (const raw of rows) {
      const row = record(raw);
      if (!row || !["stock", "etf"].includes(String(row.type)) || typeof row.symbol !== "string" || !symbolPattern.test(row.symbol)) continue;
      const candidate = InstrumentCandidateSchema.safeParse({ sourceId: context.source.id, providerSymbol: row.symbol, symbol: row.symbol.replaceAll("/", "."), displayName: row.description ?? row.symbol, assetClass: "equity", baseAsset: row.symbol.replaceAll("/", "."), quoteAsset: "USD", capabilities: candidateCapabilities(context, this.capabilities), rank: null, venue: row.exchange ?? null });
      if (candidate.success && !candidates.some(item => item.providerSymbol === candidate.data.providerSymbol)) candidates.push(candidate.data);
    }
    return { ok: true, value: candidates };
  },

  async fetch(context, params, signal) {
    const unsupported = validateCapability(context, ["quote", "candle"]);
    if (unsupported) return err(unsupported);
    const parsed = SourceParams["tradier-stocks"].safeParse(params);
    if (!parsed.success) return err(sourceError(context, "schema", "Tradier 行情参数无效", { causeCode: "INVALID_PARAMS" }));
    if (!["equity", "option"].includes(context.instrument.assetClass) || context.binding.quoteAsset !== "USD" || !(context.instrument.assetClass === "option" ? occPattern : symbolPattern).test(context.binding.providerSymbol)) return err(sourceError(context, "semantic", "Tradier 行情仅支持 USD 股票、ETF 和 OCC 期权", { causeCode: "INVALID_INSTRUMENT" }));
    if (context.capability === "quote") return request(context, "markets/quotes", { symbols: context.binding.providerSymbol, greeks: "false" }, signal);
    const end = marketDay(context.now);
    const start = new Date(`${end}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - parsed.data.historyDays);
    return request(context, "markets/history", { symbol: context.binding.providerSymbol, interval: "daily", start: start.toISOString().slice(0, 10), end }, signal);
  },
  parse,
  normalize(raw, context) {
    const root = record(raw);
    if (!root) return err(sourceError(context, "schema", "Tradier 行情响应不是对象"));
    return context.capability === "quote" ? normalizeQuote(root, context) : normalizeHistory(root, context);
  },
};

export function tradierFreshness(source: SourceConfig): "realtime" | "delayed" | "eod" {
  if (!source.capabilities.includes("quote")) return "eod";
  return new URL(source.baseUrl).hostname === "sandbox.tradier.com" ? "delayed" : "realtime";
}

function normalizeQuote(root: Row, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
  const rows = list(record(root.quotes)?.quote).map(record).filter((row): row is Row => row !== null && row.symbol === context.binding.providerSymbol);
  if (rows.length !== 1 || !(context.instrument.assetClass === "option" ? ["option"] : ["stock", "etf"]).includes(String(rows[0]?.type))) return err(sourceError(context, "semantic", "Tradier 未返回该股票或期权的报价", { causeCode: "QUOTE_NOT_FOUND" }));
  const row = rows[0]!;
  const price = positive(row.last);
  const tradeAt = Number(row.trade_date);
  if (price === null || !/^\d{12,14}$/.test(String(row.trade_date)) || !Number.isSafeInteger(tradeAt) || !Number.isFinite(new Date(tradeAt).getTime())) return err(sourceError(context, "semantic", "Tradier 报价缺少有效成交价或成交时间", { causeCode: "INVALID_QUOTE" }));
  // Use the last trade's timestamp for the last trade's price. A new bid/ask
  // must not make an old execution appear live or change portfolio valuation.
  const capturedAt = new Date(tradeAt).toISOString();
  const quote = QuoteSchema.safeParse({ instrumentId: context.instrument.id, sourceId: context.source.id, providerSymbol: context.binding.providerSymbol, price, bid: positive(row.bid), ask: positive(row.ask), mid: null, dayOpen: positive(row.open), dayHigh: positive(row.high), dayLow: positive(row.low), previousClose: positive(row.prevclose), volume: normalizeOptionalDecimal(row.volume), quoteAsset: "USD", convertedTo: null, capturedAt, receivedAt: context.now, freshness: tradierTradeFreshness(capturedAt, context), quality: "authoritative", rawRef: null });
  if (!quote.success) return err(sourceError(context, "schema", "Tradier 报价字段校验失败", { causeCode: "QUOTE_SCHEMA" }));
  return { ok: true, value: { kind: "quote", value: quote.data } };
}

function normalizeHistory(root: Row, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
  if (!("history" in root) || (root.history !== null && root.history !== "null" && !Object.hasOwn(record(root.history) ?? {}, "day"))) return err(sourceError(context, "schema", "Tradier 历史行情响应不完整"));
  const today = marketDay(context.now);
  const candles = new Map<string, Candle>();
  const warnings: string[] = [];
  for (const raw of list(record(root.history)?.day)) {
    const row = record(raw);
    const date = row?.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return err(sourceError(context, "semantic", "Tradier 日 K 线日期无效"));
    // The API provides a trading date, not intraday timestamps. UTC midnight
    // represents that date bucket. Exclude today's incomplete daily candle.
    if (date >= today) continue;
    const open = positive(row!.open), high = positive(row!.high), low = positive(row!.low), close = positive(row!.close);
    if (!open || !high || !low || !close || new Decimal(high).lt(Decimal.max(open, low, close)) || new Decimal(low).gt(Decimal.min(open, high, close))) { warnings.push(`${date}：供应商 OHLC 价格缺失或范围不一致，本次跳过`); continue; }
    const openTime = `${date}T00:00:00.000Z`;
    const closeTime = `${date}T23:59:59.999Z`;
    const candle = CandleSchema.safeParse({ instrumentId: context.instrument.id, sourceId: context.source.id, timeframe: "1d", openTime, closeTime, open, high, low, close, volume: normalizeOptionalDecimal(row!.volume), tradeCount: null, session: "regular", quoteAsset: "USD", convertedTo: null, freshness: freshnessFor(closeTime, context.now, context, "eod") });
    if (!candle.success) return err(sourceError(context, "schema", "Tradier 日 K 线字段校验失败"));
    candles.set(date, candle.data);
  }
  return { ok: true, value: { kind: "candles", value: [...candles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value), warnings: warnings.length > 64 ? [...warnings.slice(0, 64), `另有 ${warnings.length - 64} 个异常日期`] : warnings } };
}
