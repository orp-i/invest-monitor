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
  fetchJson,
  freshnessFor,
  normalizeOptionalDecimal,
  normalizeRequiredDecimal,
  parseJson,
  queryUrl,
  requireArray,
  requireRecord,
  sourceError,
  validateCapability,
} from "../common.js";
import type { AdapterContext, NormalizedAdapterData, SourceAdapter } from "../types.js";

interface MassiveSnapshotRaw {
  readonly kind: "snapshot";
  readonly payload: Record<string, unknown>;
}

interface MassiveAggregatesRaw {
  readonly kind: "aggregates";
  readonly payload: readonly unknown[];
}

type MassiveRaw = MassiveSnapshotRaw | MassiveAggregatesRaw;
type MassiveTimeframe = "1m" | "5m" | "15m" | "1h" | "1d" | "1w";

interface MassiveParams {
  readonly adjusted: boolean;
  readonly timeframe: MassiveTimeframe;
  readonly historyYears: number;
  readonly limit: number;
}

const TIMEFRAME_PATH: Record<MassiveTimeframe, { multiplier: number; timespan: string; durationMs: number }> = {
  "1m": { multiplier: 1, timespan: "minute", durationMs: 60_000 },
  "5m": { multiplier: 5, timespan: "minute", durationMs: 5 * 60_000 },
  "15m": { multiplier: 15, timespan: "minute", durationMs: 15 * 60_000 },
  "1h": { multiplier: 1, timespan: "hour", durationMs: 60 * 60_000 },
  "1d": { multiplier: 1, timespan: "day", durationMs: 24 * 60 * 60_000 },
  "1w": { multiplier: 1, timespan: "week", durationMs: 7 * 24 * 60 * 60_000 },
};

export const massiveStocksAdapter: SourceAdapter = {
  id: "massive-stocks",
  paramsSchema: SourceParams["massive-stocks"],
  capabilities: ["instrumentSearch", "quote", "candle"],
  freshnessClass: "delayed",

  async searchInstruments(query: string, context: AdapterContext): Promise<Result<InstrumentCandidate[], SourceError>> {
    if (!context.authToken) {
      return err(sourceError(context, "auth", "Massive API credential is not configured", {
        code: "auth-missing",
        causeCode: "MISSING_AUTH",
      }));
    }
    const response = await fetchJson(
      context,
      queryUrl(context.source.baseUrl, "v3/reference/tickers", {
        market: "stocks",
        active: "true",
        search: query,
        limit: 50,
      }),
      new AbortController().signal,
      { authorization: `Bearer ${context.authToken}` },
    );
    if (!response.ok) return response;
    const parsed = parseJson(response.value, context);
    if (!parsed.ok) return parsed;
    const root = requireRecord(parsed.value, context, "Massive ticker search response");
    if (!root.ok) return root;
    const results = requireArray(root.value.results, context, "Massive ticker search results");
    if (!results.ok) return results;
    const capabilities = candidateCapabilities(context, this.capabilities);
    const candidates: InstrumentCandidate[] = [];
    for (const value of results.value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const ticker = value as Record<string, unknown>;
      if (typeof ticker.ticker !== "string") continue;
      const candidate = InstrumentCandidateSchema.safeParse({
        sourceId: context.source.id,
        providerSymbol: ticker.ticker,
        symbol: ticker.ticker,
        displayName: typeof ticker.name === "string" ? ticker.name : ticker.ticker,
        assetClass: "equity",
        baseAsset: ticker.ticker,
        quoteAsset: "USD",
        capabilities,
        rank: null,
        venue: typeof ticker.primary_exchange === "string" ? ticker.primary_exchange : null,
      });
      if (candidate.success) candidates.push(candidate.data);
    }
    return { ok: true, value: candidates };
  },

  async fetch(context: AdapterContext, params: unknown, signal: AbortSignal): Promise<Result<RawHttpResponse, SourceError>> {
    const capabilityError = validateCapability(context, this.capabilities);
    if (capabilityError) return err(capabilityError);
    if (!context.authToken) {
      return err(sourceError(context, "auth", "Massive API credential is not configured", {
        code: "auth-missing",
        causeCode: "MISSING_AUTH",
      }));
    }
    const parsed = this.paramsSchema.safeParse(params);
    if (!parsed.success) return err(sourceError(context, "schema", parsed.error.message, { causeCode: "INVALID_PARAMS" }));
    const typed = parsed.data as MassiveParams;
    const url = context.capability === "quote"
      ? queryUrl(context.source.baseUrl, `v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(context.binding.providerSymbol)}`, {})
      : aggregatesUrl(context, typed);
    return fetchJson(context, url, signal, { authorization: `Bearer ${context.authToken}` });
  },

  parse(response: RawHttpResponse, context: AdapterContext): Result<unknown, SourceError> {
    const parsed = parseJson(response, context);
    if (!parsed.ok) return parsed;
    const root = requireRecord(parsed.value, context, "Massive response");
    if (!root.ok) return root;
    if (typeof root.value.status === "string" && root.value.status.toUpperCase() !== "OK") {
      return err(sourceError(context, "semantic", `Massive returned status ${root.value.status}`, {
        causeCode: "PROVIDER_STATUS",
      }));
    }
    if (context.capability === "quote") {
      const ticker = requireRecord(root.value.ticker, context, "Massive ticker snapshot");
      if (!ticker.ok) return ticker;
      return { ok: true, value: { kind: "snapshot", payload: ticker.value } satisfies MassiveSnapshotRaw };
    }
    if (typeof root.value.next_url === "string" && root.value.next_url.length > 0) {
      return err(sourceError(context, "semantic", "Massive aggregates response requires pagination; increase limit or narrow the range", {
        causeCode: "PAGINATION_REQUIRED",
      }));
    }
    const results = requireArray(root.value.results, context, "Massive aggregate results");
    if (!results.ok) return results;
    if (results.value.length === 0) {
      return err(sourceError(context, "semantic", "Massive aggregate results are empty", { causeCode: "EMPTY_RESULTS" }));
    }
    return { ok: true, value: { kind: "aggregates", payload: results.value } satisfies MassiveAggregatesRaw };
  },

  normalize(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
    if (context.capability === "quote") return normalizeSnapshot(raw, context);
    return normalizeAggregates(raw, context);
  },
};

function aggregatesUrl(context: AdapterContext, params: MassiveParams): string {
  const range = TIMEFRAME_PATH[params.timeframe];
  const to = new Date(context.now);
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - params.historyYears);
  const path = `v2/aggs/ticker/${encodeURIComponent(context.binding.providerSymbol)}/range/${range.multiplier}/${range.timespan}/${dateOnly(from)}/${dateOnly(to)}`;
  return queryUrl(context.source.baseUrl, path, {
    adjusted: String(params.adjusted),
    sort: "asc",
    limit: params.limit,
  });
}

function normalizeSnapshot(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
  if (!isSnapshot(raw)) return err(sourceError(context, "schema", "unexpected Massive snapshot payload", { causeCode: "RAW_KIND" }));
  const lastTrade = optionalRecord(raw.payload.lastTrade);
  const lastQuote = optionalRecord(raw.payload.lastQuote);
  const minute = optionalRecord(raw.payload.min);
  const day = optionalRecord(raw.payload.day);
  const previousDay = optionalRecord(raw.payload.prevDay);
  const price = firstDecimal(lastTrade?.p, minute?.c, day?.c);
  const bid = normalizeOptionalDecimal(lastQuote?.p);
  const ask = normalizeOptionalDecimal(lastQuote?.P);
  const mid = bid !== null && ask !== null ? decimalDivide(decimalAdd(bid, ask), "2") : null;
  const capturedAtMs = latestProviderTimestamp([
    lastTrade?.t,
    lastQuote?.t,
    raw.payload.updated,
    minute?.t,
  ]);
  if (capturedAtMs === null) {
    return err(sourceError(context, "semantic", "Massive snapshot has no valid provider timestamp", {
      causeCode: "MISSING_CAPTURED_AT",
    }));
  }
  const capturedAt = new Date(capturedAtMs).toISOString();
  const receivedAt = context.now;
  const quote = QuoteSchema.safeParse({
    instrumentId: context.instrument.id,
    sourceId: context.source.id,
    providerSymbol: context.binding.providerSymbol,
    price,
    bid,
    ask,
    mid,
    dayOpen: normalizeOptionalDecimal(day?.o),
    dayHigh: normalizeOptionalDecimal(day?.h),
    dayLow: normalizeOptionalDecimal(day?.l),
    previousClose: normalizeOptionalDecimal(previousDay?.c),
    volume: normalizeOptionalDecimal(day?.dv ?? day?.v),
    quoteAsset: context.binding.quoteAsset,
    convertedTo: null,
    capturedAt,
    receivedAt,
    freshness: freshnessFor(capturedAt, receivedAt, context, "delayed"),
    quality: "authoritative",
    rawRef: null,
  });
  if (!quote.success) return err(sourceError(context, "schema", quote.error.message, { causeCode: "QUOTE_SCHEMA" }));
  return { ok: true, value: { kind: "quote", value: quote.data } };
}

function normalizeAggregates(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
  if (!isAggregates(raw)) return err(sourceError(context, "schema", "unexpected Massive aggregates payload", { causeCode: "RAW_KIND" }));
  const params = massiveStocksAdapter.paramsSchema.safeParse({ ...context.source.params, ...context.binding.params });
  if (!params.success) return err(sourceError(context, "schema", params.error.message, { causeCode: "INVALID_PARAMS" }));
  const typed = params.data as MassiveParams;
  const durationMs = TIMEFRAME_PATH[typed.timeframe].durationMs;
  const rows = [];
  for (const value of raw.payload) {
    const record = requireRecord(value, context, "Massive aggregate bar");
    if (!record.ok) return record;
    const openTimeMs = providerEpochMilliseconds(record.value.t);
    if (openTimeMs === null) {
      return err(sourceError(context, "semantic", "Massive aggregate timestamp is invalid", { causeCode: "INVALID_TIMESTAMP" }));
    }
    const open = normalizeRequiredDecimal(record.value.o, context, "open");
    const high = normalizeRequiredDecimal(record.value.h, context, "high");
    const low = normalizeRequiredDecimal(record.value.l, context, "low");
    const close = normalizeRequiredDecimal(record.value.c, context, "close");
    if (!open.ok) return open;
    if (!high.ok) return high;
    if (!low.ok) return low;
    if (!close.ok) return close;
    const closeTimeMs = openTimeMs + durationMs - 1;
    const capturedAt = new Date(closeTimeMs).toISOString();
    const tradeCount = Number(record.value.n);
    const candle = CandleSchema.safeParse({
      instrumentId: context.instrument.id,
      sourceId: context.source.id,
      timeframe: typed.timeframe,
      openTime: new Date(openTimeMs).toISOString(),
      closeTime: capturedAt,
      open: open.value,
      high: high.value,
      low: low.value,
      close: close.value,
      volume: normalizeOptionalDecimal(record.value.dv ?? record.value.v),
      tradeCount: Number.isSafeInteger(tradeCount) && tradeCount >= 0 ? tradeCount : null,
      session: "unknown",
      quoteAsset: context.binding.quoteAsset,
      convertedTo: null,
      freshness: freshnessFor(capturedAt, context.now, context, "delayed"),
    });
    if (!candle.success) return err(sourceError(context, "schema", candle.error.message, { causeCode: "CANDLE_SCHEMA" }));
    rows.push(candle.data);
  }
  return { ok: true, value: { kind: "candles", value: rows } };
}

function firstDecimal(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeOptionalDecimal(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function latestProviderTimestamp(values: readonly unknown[]): number | null {
  const timestamps = values.map(providerEpochMilliseconds).filter((value): value is number => value !== null);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function providerEpochMilliseconds(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      const integer = BigInt(value);
      const divisor = value.length >= 18 ? 1_000_000n : value.length >= 15 ? 1_000n : value.length <= 10 ? 1n : null;
      const milliseconds = divisor === null ? integer : value.length <= 10 ? integer * 1_000n : integer / divisor;
      const numeric = Number(milliseconds);
      return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
    } catch {
      return null;
    }
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value >= 1e17 ? Math.trunc(value / 1e6)
    : value >= 1e14 ? Math.trunc(value / 1e3)
      : value <= 1e10 ? Math.trunc(value * 1e3)
        : Math.trunc(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSnapshot(value: unknown): value is MassiveSnapshotRaw {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "snapshot";
}

function isAggregates(value: unknown): value is MassiveAggregatesRaw {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "aggregates";
}
