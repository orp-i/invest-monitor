import {
  CandleSchema,
  err,
  InstrumentCandidateSchema,
  QuoteSchema,
  type Result,
  type SourceError,
  type InstrumentCandidate,
  type Capability,
  decimalMax,
  decimalMin,
} from "@invest/domain";
import { SourceParams } from "@invest/config";
import type { RawHttpResponse } from "@invest/egress";
import {
  fetchJson,
  candidateCapabilities,
  freshnessFor,
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

interface CoinGeckoQuoteRaw {
  readonly kind: "quote";
  readonly payload: Record<string, unknown>;
}

interface CoinGeckoChartRaw {
  readonly kind: "chart";
  readonly payload: Record<string, unknown>;
}

type CoinGeckoRaw = CoinGeckoQuoteRaw | CoinGeckoChartRaw;

export const coinGeckoAdapter: SourceAdapter = {
  id: "coingecko",
  paramsSchema: SourceParams.coingecko,
  capabilities: ["instrumentSearch", "quote", "candle"],
  freshnessClass: "realtime",

  async searchInstruments(query: string, context: AdapterContext): Promise<Result<InstrumentCandidate[], SourceError>> {
    const response = await fetchJson(
      context,
      queryUrl(context.source.baseUrl, "search", { query }),
      new AbortController().signal,
    );
    if (!response.ok) return response;
    const parsed = parseJson(response.value, context);
    if (!parsed.ok) return parsed;
    const root = requireRecord(parsed.value, context, "CoinGecko search response");
    if (!root.ok) return root;
    const coins = requireArray(root.value.coins, context, "CoinGecko search coins");
    if (!coins.ok) return coins;
    const candidates: InstrumentCandidate[] = [];
    for (const value of coins.value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const coin = value as Record<string, unknown>;
      if (typeof coin.id !== "string" || typeof coin.symbol !== "string" || typeof coin.name !== "string") continue;
      const baseAsset = coin.symbol.toUpperCase();
      const candidate = InstrumentCandidateSchema.safeParse({
        sourceId: context.source.id,
        providerSymbol: coin.id,
        symbol: `${baseAsset}/USD`,
        displayName: coin.name,
        assetClass: "crypto",
        baseAsset,
        quoteAsset: "USD",
        capabilities: candidateCapabilities(context, this.capabilities),
        rank: typeof coin.market_cap_rank === "number" && Number.isInteger(coin.market_cap_rank)
          ? coin.market_cap_rank
          : null,
        venue: null,
      });
      if (candidate.success) candidates.push(candidate.data);
    }
    return { ok: true, value: candidates };
  },

  async fetch(context: AdapterContext, params: unknown, signal: AbortSignal): Promise<Result<RawHttpResponse, SourceError>> {
    const capabilityError = validateCapability(context, this.capabilities);
    if (capabilityError) return err(capabilityError);
    const parsed = this.paramsSchema.safeParse(params);
    if (!parsed.success) return err(sourceError(context, "schema", parsed.error.message, { causeCode: "INVALID_PARAMS" }));
    const typed = parsed.data as { vsCurrency: string; days: number };
    const url = context.capability === "quote"
      ? queryUrl(context.source.baseUrl, "simple/price", {
        ids: context.binding.providerSymbol,
        vs_currencies: typed.vsCurrency,
        include_24hr_change: "true",
      })
      : queryUrl(context.source.baseUrl, `coins/${encodeURIComponent(context.binding.providerSymbol)}/market_chart`, {
        vs_currency: typed.vsCurrency,
        days: typed.days,
      });
    return fetchJson(context, url, signal);
  },

  parse(response: RawHttpResponse, context: AdapterContext): Result<unknown, SourceError> {
    const parsed = parseJson(response, context);
    if (!parsed.ok) return parsed;
    const record = requireRecord(parsed.value, context, "CoinGecko response");
    if (!record.ok) return record;
    if (context.capability === "quote") {
      const entry = record.value[context.binding.providerSymbol];
      const entryRecord = requireRecord(entry, context, "CoinGecko quote entry");
      if (!entryRecord.ok) return entryRecord;
      return { ok: true, value: { kind: "quote", payload: record.value } satisfies CoinGeckoQuoteRaw };
    }
    const prices = requireArray(record.value.prices, context, "CoinGecko prices");
    if (!prices.ok) return prices;
    if (prices.value.length === 0) return err(sourceError(context, "schema", "CoinGecko prices is empty", { causeCode: "EMPTY_PRICES" }));
    return { ok: true, value: { kind: "chart", payload: record.value } satisfies CoinGeckoChartRaw };
  },

  normalize(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
    if (context.capability === "quote") return normalizeQuote(raw, context);
    return normalizeChart(raw, context);
  },
};

function normalizeQuote(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
  if (!isCoinGeckoQuoteRaw(raw)) return err(sourceError(context, "schema", "unexpected CoinGecko quote payload", { causeCode: "RAW_KIND" }));
  const entryResult = requireRecord(raw.payload[context.binding.providerSymbol], context, "CoinGecko quote entry");
  if (!entryResult.ok) return entryResult;
  const priceField = entryResult.value[context.binding.quoteAsset.toLowerCase()] ?? entryResult.value.usd;
  const price = normalizeRequiredDecimal(priceField, context, "price");
  if (!price.ok) return price;
  const receivedAt = context.now;
  // simple/price has no provider market timestamp. The boundary records the
  // observation instant as capturedAt and labels this aggregate quote
  // indicative; this limitation is reported in the implementation handoff.
  const quote = QuoteSchema.safeParse({
    instrumentId: context.instrument.id,
    sourceId: context.source.id,
    providerSymbol: context.binding.providerSymbol,
    price: price.value,
    bid: null,
    ask: null,
    mid: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    previousClose: null,
    volume: null,
    quoteAsset: context.binding.quoteAsset,
    convertedTo: null,
    capturedAt: receivedAt,
    receivedAt,
    freshness: freshnessFor(receivedAt, receivedAt, context, "realtime"),
    quality: "indicative",
    rawRef: null,
  });
  if (!quote.success) return err(sourceError(context, "schema", quote.error.message, { causeCode: "QUOTE_SCHEMA" }));
  return { ok: true, value: { kind: "quote", value: quote.data } };
}

function normalizeChart(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
  if (!isCoinGeckoChartRaw(raw)) return err(sourceError(context, "schema", "unexpected CoinGecko chart payload", { causeCode: "RAW_KIND" }));
  const pricesResult = requireArray(raw.payload.prices, context, "CoinGecko prices");
  if (!pricesResult.ok) return pricesResult;
  const groups = new Map<number, { timestamps: number[]; values: string[] }>();
  for (const point of pricesResult.value) {
    if (!Array.isArray(point) || point.length < 2) {
      return err(sourceError(context, "schema", "CoinGecko price point has invalid shape", { causeCode: "PRICE_POINT_SHAPE" }));
    }
    const timestamp = Number(point[0]);
    if (!Number.isFinite(timestamp)) return err(sourceError(context, "semantic", "CoinGecko price timestamp is invalid", { causeCode: "INVALID_TIMESTAMP" }));
    const value = normalizeRequiredDecimal(point[1], context, "price");
    if (!value.ok) return value;
    const bucket = Math.floor(timestamp / 300_000) * 300_000;
    const group = groups.get(bucket) ?? { timestamps: [], values: [] };
    group.timestamps.push(timestamp);
    group.values.push(value.value);
    groups.set(bucket, group);
  }
  const rows = [];
  for (const [bucket, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    const openTime = new Date(bucket).toISOString();
    const closeTime = new Date(bucket + 300_000 - 1).toISOString();
    const capturedAt = new Date(Math.max(...group.timestamps)).toISOString();
    const candle = CandleSchema.safeParse({
      instrumentId: context.instrument.id,
      sourceId: context.source.id,
      timeframe: "5m",
      openTime,
      closeTime,
      open: group.values[0],
      high: decimalMax(group.values),
      low: decimalMin(group.values),
      close: group.values[group.values.length - 1],
      volume: null,
      tradeCount: null,
      session: "24x7",
      quoteAsset: context.binding.quoteAsset,
      convertedTo: null,
      freshness: freshnessFor(capturedAt, context.now, context, "realtime"),
    });
    if (!candle.success) return err(sourceError(context, "schema", candle.error.message, { causeCode: "CANDLE_SCHEMA" }));
    rows.push(candle.data);
  }
  return { ok: true, value: { kind: "candles", value: rows } };
}

function isCoinGeckoQuoteRaw(value: unknown): value is CoinGeckoQuoteRaw {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "quote";
}

function isCoinGeckoChartRaw(value: unknown): value is CoinGeckoChartRaw {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "chart";
}
