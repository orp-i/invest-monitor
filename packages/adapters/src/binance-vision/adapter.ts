import {
  CandleSchema,
  decimalAdd,
  decimalDivide,
  err,
  InstrumentCandidateSchema,
  QuoteSchema,
  type InstrumentCandidate,
  type Result,
  type SourceError,
} from "@invest/domain";
import { SourceParams } from "@invest/config";
import type { RawHttpResponse } from "@invest/egress";
import {
  candidateCapabilities,
  debugRejectedInstrumentCandidate,
  fetchJson,
  freshnessFor,
  normalizeOptionalDecimal,
  normalizeRequiredDecimal,
  parseJson,
  queryUrl,
  requireArray,
  requireRecord,
  sourceError,
  timestampFromEpoch,
  validateCapability,
} from "../common.js";
import type { AdapterContext, NormalizedAdapterData, SourceAdapter } from "../types.js";

interface BinanceTickerRaw {
  readonly kind: "ticker";
  readonly payload: Record<string, unknown>;
}

interface BinanceKlinesRaw {
  readonly kind: "klines";
  readonly payload: readonly unknown[];
}

type BinanceRaw = BinanceTickerRaw | BinanceKlinesRaw;

interface BinanceExchangeSymbol {
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: "USDT" | "USDC" | "FDUSD";
}

const EXCHANGE_INFO_CACHE_MS = 24 * 60 * 60 * 1000;
const SEARCH_QUOTE_ASSETS = new Set(["USDT", "USDC", "FDUSD"]);
let exchangeInfoCache: {
  readonly baseUrl: string;
  readonly expiresAtMs: number;
  readonly symbols: readonly BinanceExchangeSymbol[];
} | null = null;

export const binanceVisionAdapter: SourceAdapter = {
  id: "binance-vision",
  paramsSchema: SourceParams["binance-vision"],
  capabilities: ["instrumentSearch", "quote", "candle"],
  freshnessClass: "realtime",

  async searchInstruments(query: string, context: AdapterContext): Promise<Result<InstrumentCandidate[], SourceError>> {
    const loaded = await loadExchangeInfo(context);
    if (!loaded.ok) return loaded;
    const needle = query.trim().toUpperCase();
    const capabilities = candidateCapabilities(context, this.capabilities);
    const candidates: InstrumentCandidate[] = [];
    for (const entry of loaded.value) {
      if (!entry.symbol.includes(needle) && !entry.baseAsset.includes(needle)) continue;
      const candidate = InstrumentCandidateSchema.safeParse({
        sourceId: context.source.id,
        providerSymbol: entry.symbol,
        symbol: `${entry.baseAsset}/${entry.quoteAsset}`,
        displayName: `${entry.baseAsset} / ${entry.quoteAsset}`,
        assetClass: "crypto",
        baseAsset: entry.baseAsset,
        // Quote assets are deliberately source-native. USDT/USDC/FDUSD
        // must never be relabelled as USD.
        quoteAsset: entry.quoteAsset,
        capabilities,
        rank: null,
        venue: "Binance",
      });
      if (!candidate.success) {
        debugRejectedInstrumentCandidate(context.source.id, entry.symbol);
        continue;
      }
      candidates.push(candidate.data);
    }
    return { ok: true, value: candidates };
  },

  async fetch(context: AdapterContext, params: unknown, signal: AbortSignal): Promise<Result<RawHttpResponse, SourceError>> {
    const capabilityError = validateCapability(context, this.capabilities);
    if (capabilityError) return err(capabilityError);
    const parsed = this.paramsSchema.safeParse(params);
    if (!parsed.success) return err(sourceError(context, "schema", parsed.error.message, { causeCode: "INVALID_PARAMS" }));
    const typed = parsed.data as { interval: string; limit: number };
    const url = context.capability === "quote"
      ? queryUrl(context.source.baseUrl, "api/v3/ticker/24hr", { symbol: context.binding.providerSymbol })
      : queryUrl(context.source.baseUrl, "api/v3/klines", {
        symbol: context.binding.providerSymbol,
        interval: typed.interval,
        limit: typed.limit,
      });
    return fetchJson(context, url, signal);
  },

  parse(response: RawHttpResponse, context: AdapterContext): Result<unknown, SourceError> {
    const parsed = parseJson(response, context);
    if (!parsed.ok) return parsed;
    if (context.capability === "quote") {
      const record = requireRecord(parsed.value, context, "Binance ticker response");
      if (!record.ok) return record;
      return { ok: true, value: { kind: "ticker", payload: record.value } satisfies BinanceTickerRaw };
    }
    const array = requireArray(parsed.value, context, "Binance klines response");
    if (!array.ok) return array;
    return { ok: true, value: { kind: "klines", payload: array.value } satisfies BinanceKlinesRaw };
  },

  normalize(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
    if (context.capability === "quote") return normalizeTicker(raw, context);
    return normalizeKlines(raw, context);
  },
};

async function loadExchangeInfo(
  context: AdapterContext,
): Promise<Result<readonly BinanceExchangeSymbol[], SourceError>> {
  if (exchangeInfoCache
    && exchangeInfoCache.baseUrl === context.source.baseUrl
    && exchangeInfoCache.expiresAtMs > Date.now()) {
    return { ok: true, value: exchangeInfoCache.symbols };
  }
  const response = await fetchJson(
    context,
    queryUrl(context.source.baseUrl, "api/v3/exchangeInfo", {}),
    new AbortController().signal,
  );
  if (!response.ok) return response;
  const parsed = parseJson(response.value, context);
  if (!parsed.ok) return parsed;
  const root = requireRecord(parsed.value, context, "Binance exchangeInfo response");
  if (!root.ok) return root;
  const rawSymbols = requireArray(root.value.symbols, context, "Binance exchangeInfo symbols");
  if (!rawSymbols.ok) return rawSymbols;
  const symbols: BinanceExchangeSymbol[] = [];
  for (const value of rawSymbols.value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.status !== "TRADING"
      || typeof entry.symbol !== "string"
      || typeof entry.baseAsset !== "string"
      || typeof entry.quoteAsset !== "string"
      || !SEARCH_QUOTE_ASSETS.has(entry.quoteAsset)) continue;
    symbols.push({
      symbol: entry.symbol,
      baseAsset: entry.baseAsset,
      quoteAsset: entry.quoteAsset as BinanceExchangeSymbol["quoteAsset"],
    });
  }
  exchangeInfoCache = { baseUrl: context.source.baseUrl, expiresAtMs: Date.now() + EXCHANGE_INFO_CACHE_MS, symbols };
  return { ok: true, value: symbols };
}

function normalizeTicker(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
  if (!isTicker(raw)) return err(sourceError(context, "schema", "unexpected Binance ticker payload", { causeCode: "RAW_KIND" }));
  const price = normalizeRequiredDecimal(raw.payload.lastPrice, context, "lastPrice");
  if (!price.ok) return price;
  const bid = normalizeOptionalDecimal(raw.payload.bidPrice);
  const ask = normalizeOptionalDecimal(raw.payload.askPrice);
  const mid = bid !== null && ask !== null ? decimalDivide(decimalAdd(bid, ask), "2") : null;
  const capturedAt = timestampFromEpoch(raw.payload.closeTime, context, "closeTime");
  if (!capturedAt.ok) return capturedAt;
  const receivedAt = context.now;
  const quote = QuoteSchema.safeParse({
    instrumentId: context.instrument.id,
    sourceId: context.source.id,
    providerSymbol: context.binding.providerSymbol,
    price: price.value,
    bid,
    ask,
    mid,
    dayOpen: normalizeOptionalDecimal(raw.payload.openPrice),
    dayHigh: normalizeOptionalDecimal(raw.payload.highPrice),
    dayLow: normalizeOptionalDecimal(raw.payload.lowPrice),
    previousClose: normalizeOptionalDecimal(raw.payload.prevClosePrice),
    volume: normalizeOptionalDecimal(raw.payload.volume),
    quoteAsset: context.binding.quoteAsset,
    convertedTo: null,
    capturedAt: capturedAt.value,
    receivedAt,
    freshness: freshnessFor(capturedAt.value, receivedAt, context, "realtime"),
    quality: "authoritative",
    rawRef: null,
  });
  if (!quote.success) return err(sourceError(context, "schema", quote.error.message, { causeCode: "QUOTE_SCHEMA" }));
  return { ok: true, value: { kind: "quote", value: quote.data } };
}

function normalizeKlines(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
  if (!isKlines(raw)) return err(sourceError(context, "schema", "unexpected Binance klines payload", { causeCode: "RAW_KIND" }));
  const rows = [];
  for (const item of raw.payload) {
    if (!Array.isArray(item) || item.length < 11) {
      return err(sourceError(context, "schema", "Binance kline has fewer than 11 fields", { causeCode: "KLINE_SHAPE" }));
    }
    const openTime = timestampFromEpoch(item[0], context, "openTime");
    const closeTime = timestampFromEpoch(item[6], context, "closeTime");
    if (!openTime.ok) return openTime;
    if (!closeTime.ok) return closeTime;
    if ((context.binding.params.interval ?? context.source.params.interval) === "1d" && Date.parse(closeTime.value) >= Date.parse(context.now)) continue;
    const open = normalizeRequiredDecimal(item[1], context, "open");
    const high = normalizeRequiredDecimal(item[2], context, "high");
    const low = normalizeRequiredDecimal(item[3], context, "low");
    const close = normalizeRequiredDecimal(item[4], context, "close");
    if (!open.ok) return open;
    if (!high.ok) return high;
    if (!low.ok) return low;
    if (!close.ok) return close;
    const tradeCount = Number(item[8]);
    const candle = CandleSchema.safeParse({
      instrumentId: context.instrument.id,
      sourceId: context.source.id,
      timeframe: String(context.binding.params.interval ?? context.source.params.interval ?? "1m"),
      openTime: openTime.value,
      closeTime: closeTime.value,
      open: open.value,
      high: high.value,
      low: low.value,
      close: close.value,
      volume: normalizeOptionalDecimal(item[5]),
      tradeCount: Number.isSafeInteger(tradeCount) && tradeCount >= 0 ? tradeCount : null,
      session: "24x7",
      quoteAsset: context.binding.quoteAsset,
      convertedTo: null,
      freshness: freshnessFor(closeTime.value, context.now, context, "realtime"),
    });
    if (!candle.success) return err(sourceError(context, "schema", candle.error.message, { causeCode: "CANDLE_SCHEMA" }));
    rows.push(candle.data);
  }
  return { ok: true, value: { kind: "candles", value: rows } };
}

function isTicker(value: unknown): value is BinanceTickerRaw {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "ticker";
}

function isKlines(value: unknown): value is BinanceKlinesRaw {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "klines";
}
