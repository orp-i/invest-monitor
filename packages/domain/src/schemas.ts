import { z } from "zod";

export const DecimalString = z
  .string()
  .regex(/^-?(0|[1-9]\d*)(\.\d+)?$/, "must be a decimal string");
export type DecimalString = z.infer<typeof DecimalString>;

export const Timestamp = z.string().datetime({ offset: true });
export const ClockSkewToleranceMsSchema = z.number().int().nonnegative();
export type ClockSkewToleranceMs = z.infer<typeof ClockSkewToleranceMsSchema>;
export const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 2_000;
export const FiatCurrency = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be an ISO-4217 fiat currency code");
export const QuoteAsset = z.string().regex(/^[A-Z0-9]{2,10}$/);
export const AssetCode = z.string().regex(/^[A-Z][A-Z0-9._-]{0,11}$/);
export const AssetClass = z.enum([
  "crypto",
  "preciousMetal",
  "equity",
  "option",
  "cash",
  "other",
]);
export const SourceId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

export const QuoteConversionSchema = z.object({
  currency: FiatCurrency,
  rate: DecimalString,
  fxSourceId: SourceId,
  fxCapturedAt: Timestamp,
});
export type QuoteConversion = z.infer<typeof QuoteConversionSchema>;

export const ConversionPolicySchema = z.object({
  targetCurrency: FiatCurrency,
  fxSourceId: SourceId,
}).nullable();

export const CapabilitySchema = z.enum([
  "instrumentSearch",
  "quote",
  "candle",
  "optionChain",
  "greeks",
  "depth",
  "funding",
  "news",
  "filings",
  "account",
  "positions",
  "transactions",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

const FreshnessBaseSchema = z.object({
  capturedAt: Timestamp,
  receivedAt: Timestamp,
  clockSkewMs: z.number().int().nullable(),
  clockSkewToleranceMs: ClockSkewToleranceMsSchema,
  skewSuspected: z.boolean(),
  freshnessBasis: z.enum(["capturedAt", "receivedAt"]),
  staleAfterSeconds: z.number().int().nonnegative(),
  isStale: z.boolean(),
  status: z.enum(["live", "delayed", "stale", "unavailable"]),
  tradeReferenceAt: Timestamp.optional(),
  dataLagMs: z.number().nonnegative().optional(),
  tradeSession: z.enum(["pre", "regular", "post", "overnight", "unknown"]).optional(),
  tradeSessionDate: z.string().optional(),
  sessionBasis: z.enum(["calendar", "time-window", "unknown"]).optional(),
  marketState: z.enum(["open", "closed", "premarket", "postmarket", "unknown"]).optional(),
});
export const FreshnessSchema = FreshnessBaseSchema.superRefine((freshness, ctx) => {
  const capturedMs = Date.parse(freshness.capturedAt);
  const receivedMs = Date.parse(freshness.receivedAt);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(receivedMs)) return;

  const observedSkewMs = capturedMs - receivedMs;
  const skewSuspected = observedSkewMs > freshness.clockSkewToleranceMs;
  if (freshness.clockSkewMs !== observedSkewMs) {
    ctx.addIssue({
      code: "custom",
      path: ["clockSkewMs"],
      message: "clockSkewMs must equal capturedAt minus receivedAt",
    });
  }
  if (freshness.skewSuspected !== skewSuspected) {
    ctx.addIssue({
      code: "custom",
      path: ["skewSuspected"],
      message: "skewSuspected must be derived from clockSkewMs and clockSkewToleranceMs",
    });
  }
  const expectedBasis = skewSuspected ? "receivedAt" : "capturedAt";
  if (freshness.freshnessBasis !== expectedBasis) {
    ctx.addIssue({
      code: "custom",
      path: ["freshnessBasis"],
      message: "freshnessBasis must use receivedAt for suspected future provider timestamps",
    });
  }
});
export type Freshness = z.infer<typeof FreshnessSchema>;

export const GreeksSchema = z.object({
  delta: DecimalString.nullable(),
  gamma: DecimalString.nullable(),
  theta: DecimalString.nullable(),
  vega: DecimalString.nullable(),
  rho: DecimalString.nullable(),
  impliedVolatility: DecimalString.nullable(),
  model: z.string().nullable(),
  calculatedAt: Timestamp.nullable(),
});
export type Greeks = z.infer<typeof GreeksSchema>;

export const InstrumentSchema = z.object({
  id: z.string().min(1),
  assetClass: AssetClass,
  symbol: z.string().min(1),
  displayName: z.string().min(1),
  venue: z.string().nullable(),
  baseAsset: AssetCode,
  quoteAsset: QuoteAsset,
  contractMultiplier: DecimalString.default("1"),
  underlyingId: z.string().nullable(),
  precision: z.object({
    priceScale: z.number().int().nonnegative(),
    quantityScale: z.number().int().nonnegative(),
  }),
  tags: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  // Zod 4.4.3 accepts this one-argument form at runtime; its declaration
  // still exposes the older two-argument signature.
  // @ts-expect-error DESIGN.md requires the one-argument z.record form.
  metadata: z.record(z.unknown()).default({}),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

export const SourceBindingSchema = z.object({
  sourceId: SourceId,
  instrumentId: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().nonnegative().default(100),
  capabilities: z.array(CapabilitySchema).min(1),
  providerSymbol: z.string().min(1),
  quoteAsset: QuoteAsset,
  conversion: ConversionPolicySchema,
  // @ts-expect-error DESIGN.md requires the one-argument z.record form.
  params: z.record(z.unknown()).default({}),
  cadenceSeconds: z.number().positive(),
  staleAfterSeconds: z.number().positive(),
  egressProfile: z.enum(["direct", "corp", "vpn"]),
  egressFallback: z.array(z.enum(["direct", "corp", "vpn"])).default([]),
});
export type SourceBinding = z.infer<typeof SourceBindingSchema>;

export const InstrumentCandidateSchema = z.object({
  sourceId: SourceId,
  providerSymbol: z.string().min(1),
  symbol: z.string().min(1),
  displayName: z.string().min(1),
  assetClass: AssetClass,
  baseAsset: AssetCode,
  quoteAsset: QuoteAsset,
  capabilities: z.array(CapabilitySchema),
  rank: z.number().int().nullable(),
  venue: z.string().nullable(),
});
export type InstrumentCandidate = z.infer<typeof InstrumentCandidateSchema>;

const QuoteBaseSchema = z.object({
  instrumentId: z.string().min(1),
  sourceId: SourceId,
  providerSymbol: z.string(),
  price: DecimalString.nullable(),
  bid: DecimalString.nullable(),
  ask: DecimalString.nullable(),
  mid: DecimalString.nullable(),
  dayOpen: DecimalString.nullable(),
  dayHigh: DecimalString.nullable(),
  dayLow: DecimalString.nullable(),
  previousClose: DecimalString.nullable(),
  volume: DecimalString.nullable(),
  quoteAsset: QuoteAsset,
  convertedTo: QuoteConversionSchema.nullable(),
  capturedAt: Timestamp,
  receivedAt: Timestamp,
  freshness: FreshnessSchema,
  quality: z.enum(["authoritative", "indicative", "derived", "unknown"]),
  rawRef: z.string().nullable(),
});
export const QuoteSchema = QuoteBaseSchema
  .superRefine((quote, ctx) => {
    if (Date.parse(quote.capturedAt) !== Date.parse(quote.freshness.capturedAt)) {
      ctx.addIssue({ code: "custom", path: ["freshness", "capturedAt"], message: "freshness.capturedAt must match capturedAt" });
    }
    if (Date.parse(quote.receivedAt) !== Date.parse(quote.freshness.receivedAt)) {
      ctx.addIssue({ code: "custom", path: ["freshness", "receivedAt"], message: "freshness.receivedAt must match receivedAt" });
    }
  })
  .transform((quote) => ({
    ...quote,
    quality: quote.freshness.skewSuspected && quote.quality === "authoritative"
      ? "indicative" as const
      : quote.quality,
  }));
export type Quote = z.infer<typeof QuoteSchema>;

export const CandleSchema = z.object({
  instrumentId: z.string(),
  sourceId: SourceId,
  timeframe: z.enum(["1s", "1m", "5m", "15m", "1h", "1d", "1w"]),
  openTime: Timestamp,
  closeTime: Timestamp,
  open: DecimalString,
  high: DecimalString,
  low: DecimalString,
  close: DecimalString,
  volume: DecimalString.nullable(),
  tradeCount: z.number().int().nonnegative().nullable(),
  session: z.enum(["pre", "regular", "post", "24x7", "unknown"]),
  quoteAsset: QuoteAsset,
  convertedTo: QuoteConversionSchema.nullable(),
  freshness: FreshnessSchema,
});
export type Candle = z.infer<typeof CandleSchema>;

export const OptionContractSchema = z.object({
  instrumentId: z.string(),
  underlyingInstrumentId: z.string(),
  sourceId: SourceId,
  providerSymbol: z.string(),
  occSymbol: z.string().nullable(),
  right: z.enum(["call", "put"]),
  exerciseStyle: z.enum(["american", "european", "unknown"]),
  settlement: z.enum(["physical", "cash", "unknown"]),
  expiration: Timestamp,
  strike: DecimalString,
  contractMultiplier: DecimalString,
  bid: DecimalString.nullable(),
  ask: DecimalString.nullable(),
  last: DecimalString.nullable(),
  volume: DecimalString.nullable(),
  openInterest: DecimalString.nullable(),
  quoteAsset: QuoteAsset,
  convertedTo: QuoteConversionSchema.nullable(),
  greeks: GreeksSchema.nullable(),
  freshness: FreshnessSchema,
});
export type OptionContract = z.infer<typeof OptionContractSchema>;

export const OptionChainSchema = z.object({
  underlyingInstrumentId: z.string(),
  sourceId: SourceId,
  capturedAt: Timestamp,
  expirations: z.array(Timestamp),
  contracts: z.array(OptionContractSchema),
  slice: z.object({
    expirations: z.array(Timestamp).nullable(),
    minStrike: DecimalString.nullable(),
    maxStrike: DecimalString.nullable(),
    aroundAtm: z.number().int().nonnegative().nullable(),
    complete: z.boolean(),
  }),
  freshness: FreshnessSchema,
});
export type OptionChain = z.infer<typeof OptionChainSchema>;

export const NewsItemSchema = z.object({
  id: z.string(),
  sourceId: SourceId,
  url: z.string().url(),
  canonicalUrl: z.string().url(),
  title: z.string().min(1),
  contentText: z.string().nullable(),
  summary: z.string().nullable(),
  language: z.string().default("und"),
  publishedAt: Timestamp.nullable(),
  fetchedAt: Timestamp,
  instrumentIds: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  sentiment: z.enum(["positive", "negative", "neutral", "mixed", "unknown"]).default("unknown"),
  importance: z.enum(["low", "medium", "high", "critical"]).default("low"),
  contentHash: z.string(),
  duplicateOf: z.string().nullable(),
  enrichment: z.object({
    providerId: z.string().nullable(),
    model: z.string().nullable(),
    promptVersion: z.string().nullable(),
    completedAt: Timestamp.nullable(),
  }),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

export const LLMRequestSchema = z.object({
  routeId: z.string().min(1),
  model: z.string().min(1),
  system: z.string().min(1),
  user: z.string().min(1),
  responseSchemaName: z.string().min(1),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(1).default(0),
  cacheKey: z.string().min(1),
  deadlineMs: z.number().int().positive(),
});
export type LLMRequest = z.infer<typeof LLMRequestSchema>;

export const NewsEnrichmentSchema = z.object({
  summary: z.string().min(1).max(1_200),
  instrumentIds: z.array(z.string()).max(20),
  tags: z.array(z.string()).max(30),
  sentiment: z.enum(["positive", "negative", "neutral", "mixed", "unknown"]),
  importance: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({
    quote: z.string().max(300),
    reason: z.string().max(300),
  })).max(5),
  uncertainties: z.array(z.string()).max(10),
});
export type NewsEnrichment = z.infer<typeof NewsEnrichmentSchema>;

export const LLMResponseSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  requestId: z.string().min(1),
  outputText: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: DecimalString.nullable(),
  latencyMs: z.number().int().nonnegative(),
  completedAt: Timestamp,
});
export type LLMResponse = z.infer<typeof LLMResponseSchema>;

export const LLMErrorSchema = z.object({
  kind: z.enum(["network", "auth", "quota", "timeout", "invalid_output", "provider"]),
  providerId: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  requestId: z.string().nullable(),
});
export type LLMError = z.infer<typeof LLMErrorSchema>;

export const AccountSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  adapterId: z.string(),
  mode: z.enum(["readonly", "manual"]),
  reportingCurrency: FiatCurrency,
  institution: z.string(),
  enabled: z.boolean(),
  lastSyncAt: Timestamp.nullable(),
  freshness: FreshnessSchema.nullable(),
  // @ts-expect-error DESIGN.md requires the one-argument z.record form.
  metadata: z.record(z.unknown()).default({}),
});
export type Account = z.infer<typeof AccountSchema>;

export const PositionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  instrumentId: z.string(),
  quantity: DecimalString,
  averageCost: DecimalString,
  costBasis: DecimalString,
  markPrice: DecimalString.nullable(),
  marketValue: DecimalString.nullable(),
  realizedPnl: DecimalString,
  unrealizedPnl: DecimalString.nullable(),
  quoteAsset: QuoteAsset,
  asOf: Timestamp,
  freshness: FreshnessSchema,
});
export type Position = z.infer<typeof PositionSchema>;

export const PnLSnapshotSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  asOf: Timestamp,
  reportingCurrency: FiatCurrency,
  cashValue: DecimalString,
  marketValue: DecimalString,
  costBasis: DecimalString,
  realizedPnl: DecimalString,
  unrealizedPnl: DecimalString,
  totalPnl: DecimalString,
  fxSourceId: SourceId.nullable(),
  freshness: FreshnessSchema,
});
export type PnLSnapshot = z.infer<typeof PnLSnapshotSchema>;

export const AlertSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  instrumentId: z.string().nullable(),
  accountId: z.string().nullable(),
  severity: z.enum(["info", "warning", "critical"]),
  status: z.enum(["firing", "acknowledged", "resolved"]),
  message: z.string(),
  observedValue: DecimalString.nullable(),
  threshold: DecimalString.nullable(),
  sourceId: SourceId.nullable(),
  firedAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  dedupKey: z.string(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const SourceErrorSchema = z.object({
  kind: z.enum([
    "network",
    "timeout",
    "http",
    "auth",
    "rate_limited",
    "parse",
    "schema",
    "semantic",
    "unsupported",
    "market_closed",
  ]),
  sourceId: SourceId,
  capability: CapabilitySchema.nullable(),
  message: z.string(),
  httpStatus: z.number().int().nullable(),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().nonnegative().nullable(),
  clockSkewMs: z.number().int().nullable().default(null),
  egressProfileUsed: z.enum(["direct", "corp", "vpn"]).nullable().default(null),
  requestId: z.string(),
  observedAt: Timestamp,
  code: z.string().nullable().default(null),
  causeCode: z.string().nullable(),
});
export type SourceError = z.infer<typeof SourceErrorSchema>;

export type FreshnessClass = "realtime" | "delayed" | "eod" | "unknown";

export function computeFreshness(
  capturedAt: string,
  receivedAt: string,
  staleAfterSeconds: number,
  now = new Date(),
  freshnessClass: FreshnessClass = "realtime",
  clockSkewToleranceMs: ClockSkewToleranceMs = DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
): Freshness {
  const capturedMs = Date.parse(capturedAt);
  const receivedMs = Date.parse(receivedAt);
  const observedSkewMs = Number.isFinite(capturedMs) && Number.isFinite(receivedMs)
    ? capturedMs - receivedMs
    : null;
  const skewSuspected = observedSkewMs !== null && observedSkewMs > clockSkewToleranceMs;
  const freshnessBasis = skewSuspected ? "receivedAt" : "capturedAt";
  const freshnessBaseMs = skewSuspected ? receivedMs : capturedMs;
  const ageMs = Number.isFinite(freshnessBaseMs)
    ? Math.max(0, now.getTime() - freshnessBaseMs)
    : Infinity;
  const isStale = !Number.isFinite(capturedMs) || !Number.isFinite(receivedMs) || ageMs > staleAfterSeconds * 1000;
  const status = isStale
    ? "stale"
    : freshnessClass === "delayed" || freshnessClass === "eod"
      ? "delayed"
      : "live";
  return FreshnessSchema.parse({
    capturedAt,
    receivedAt,
    clockSkewMs: observedSkewMs,
    clockSkewToleranceMs,
    skewSuspected,
    freshnessBasis,
    staleAfterSeconds,
    isStale,
    status,
  });
}

// A live provider's last trade is an event clock, not a periodic heartbeat.
// No trades during a closed/illiquid session does not mean the data is delayed.
// The independent receipt clock still detects a stopped collector/connection.
export function computeTradeFreshness(capturedAt: string, receivedAt: string, tradeReferenceAt: string, staleAfterSeconds: number,
  now = new Date(), freshnessClass: FreshnessClass = "realtime", clockSkewToleranceMs = DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  marketState: "open" | "closed" | "premarket" | "postmarket" | "unknown" = "unknown"): Freshness {
  const freshness = computeFreshness(capturedAt, receivedAt, staleAfterSeconds, now, freshnessClass, clockSkewToleranceMs);
  const dataLagMs = Math.max(0, Date.parse(tradeReferenceAt) - Date.parse(capturedAt));
  const confirmed = Number.isFinite(dataLagMs) && dataLagMs === 0 && !freshness.skewSuspected;
  const receivedRecently = now.getTime() - Date.parse(receivedAt) <= staleAfterSeconds * 1000;
  if (freshnessClass === "realtime" && confirmed && receivedRecently) {
    freshness.isStale = false; freshness.status = "live";
  } else if (dataLagMs > 0 && receivedRecently && !freshness.skewSuspected) {
    freshness.isStale = false; freshness.status = "delayed";
  }
  return FreshnessSchema.parse({ ...freshness, tradeReferenceAt, dataLagMs, marketState });
}

export const TransactionTypeSchema = z.enum([
  "buy",
  "sell",
  "deposit",
  "withdraw",
  "fee",
  "dividend",
  "withholding_tax",
  "interest",
  "option_expiry",
  "option_exercise",
  "option_assignment",
  "transfer",
  "adjustment",
]);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const TransactionSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  instrumentId: z.string().min(1),
  type: TransactionTypeSchema,
  quantity: DecimalString,
  price: DecimalString.nullable(),
  fees: DecimalString,
  // Stablecoin-denominated ledgers are valid cost ledgers. They must remain
  // visibly distinct from fiat rather than being forced through FiatCurrency.
  currency: QuoteAsset,
  tradeAt: Timestamp,
  settlementAt: Timestamp.nullable(),
  externalId: z.string().nullable(),
  rawRef: z.string().nullable(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

const TransactionWriteBaseSchema = z.object({
  accountId: z.string().min(1).default("manual"),
  instrumentId: z.string().min(1),
  type: TransactionTypeSchema,
  quantity: DecimalString,
  price: DecimalString.nullable(),
  fees: DecimalString,
  currency: QuoteAsset,
  tradeAtMs: z.number().int().nonnegative(),
});

export const TransactionWriteSchema = TransactionWriteBaseSchema.superRefine((transaction, ctx) => {
  const quantityIsZero = /^-?0(?:\.0+)?$/.test(transaction.quantity);
  const quantityIsNegative = transaction.quantity.startsWith("-") && !quantityIsZero;
  const feeIsNegative = transaction.fees.startsWith("-") && !/^-?0(?:\.0+)?$/.test(transaction.fees);
  if (feeIsNegative) {
    ctx.addIssue({ code: "custom", path: ["fees"], message: "fees must be non-negative" });
  }
  if (transaction.type === "buy" || transaction.type === "sell") {
    if (quantityIsZero || quantityIsNegative) {
      ctx.addIssue({ code: "custom", path: ["quantity"], message: "trade quantity must be positive" });
    }
    if (transaction.price === null || transaction.price.startsWith("-") || /^0(?:\.0+)?$/.test(transaction.price)) {
      ctx.addIssue({ code: "custom", path: ["price"], message: "trade price must be positive" });
    }
  } else if (transaction.type === "dividend") {
    if (quantityIsZero || quantityIsNegative) {
      ctx.addIssue({ code: "custom", path: ["quantity"], message: "gross dividend must be positive" });
    }
    if (transaction.price !== null) {
      ctx.addIssue({ code: "custom", path: ["price"], message: "dividend price must be null" });
    }
    if (!/^0(?:\.0+)?$/.test(transaction.fees)) {
      ctx.addIssue({ code: "custom", path: ["fees"], message: "dividend fees must be zero; record fees separately" });
    }
  } else if (transaction.type === "withholding_tax") {
    if (!quantityIsNegative) {
      ctx.addIssue({ code: "custom", path: ["quantity"], message: "withholding tax must be a negative cash flow" });
    }
    if (transaction.price !== null) {
      ctx.addIssue({ code: "custom", path: ["price"], message: "withholding tax price must be null" });
    }
    if (!/^0(?:\.0+)?$/.test(transaction.fees)) {
      ctx.addIssue({ code: "custom", path: ["fees"], message: "withholding tax fees must be zero" });
    }
  }
});
export type TransactionWrite = z.infer<typeof TransactionWriteSchema>;

export const TransactionPatchSchema = TransactionWriteBaseSchema.partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "transaction patch must not be empty");
export type TransactionPatch = z.infer<typeof TransactionPatchSchema>;
