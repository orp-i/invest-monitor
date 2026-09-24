import { z } from "zod";
import {
  AssetClass,
  CapabilitySchema,
  ClockSkewToleranceMsSchema,
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  DecimalString,
  FiatCurrency,
  InstrumentSchema,
  SourceBindingSchema,
  SourceId,
  WidgetKindSchema,
} from "@invest/domain";

export const EgressProfileSchema = z.object({
  name: z.enum(["direct", "corp", "vpn"]),
  proxyUrl: z.string().url().nullable(),
  userAgent: z.string().min(1),
  followRedirects: z.boolean().default(false),
  maxRedirects: z.number().int().min(0).max(10).default(0),
  connectTimeoutMs: z.number().int().positive().default(5_000),
  requestTimeoutMs: z.number().int().positive().default(15_000),
});
export type EgressProfile = z.infer<typeof EgressProfileSchema>;
export type EgressName = EgressProfile["name"];

export const RateLimitSchema = z.object({
  requestsPerSecond: z.number().positive(),
  burst: z.number().int().positive(),
  quotaPerDay: z.number().int().positive().nullable(),
  retryAfterHeader: z.boolean().default(true),
});
export type RateLimit = z.infer<typeof RateLimitSchema>;

export const DefaultBindingSchema = z.object({
  cadenceSeconds: z.number().positive(),
  staleAfterSeconds: z.number().positive(),
  egressProfile: z.enum(["direct", "corp", "vpn"]),
});
export type DefaultBinding = z.infer<typeof DefaultBindingSchema>;

export const SourceConfigSchema = z.object({
  id: SourceId,
  adapter: z.string().min(1),
  baseUrl: z.string().url(),
  authRef: z.string().regex(/^(env|secret):[A-Z][A-Z0-9_]*$/).nullable(),
  egressProfile: z.enum(["direct", "corp", "vpn"]),
  egressFallback: z.array(z.enum(["direct", "corp", "vpn"])).default([]),
  userAgent: z.string().min(1),
  followRedirects: z.boolean(),
  capabilities: z.array(CapabilitySchema).min(1),
  defaultBinding: DefaultBindingSchema.nullable().default(null),
  // @ts-expect-error DESIGN.md requires the one-argument z.record form.
  params: z.record(z.unknown()).default({}),
  rateLimit: RateLimitSchema,
  enabled: z.boolean().default(true),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const InstrumentConfigSchema = InstrumentSchema.extend({
  sourceBindings: z.array(SourceBindingSchema).min(1),
  panelId: z.string().default("generic-asset"),
  watch: z.boolean().default(true),
});
export type InstrumentConfig = z.infer<typeof InstrumentConfigSchema>;

export const SectionConfigSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  order: z.number().int(),
  match: z.object({
    assetClasses: z.array(AssetClass).default([]),
    capabilities: z.array(CapabilitySchema).default([]),
  }),
  widgetKinds: z.array(WidgetKindSchema),
});
export type SectionConfig = z.infer<typeof SectionConfigSchema>;

export const SymbolMapConfigSchema = z.object({
  sourceId: SourceId,
  // @ts-expect-error DESIGN.md uses the one-argument z.record form.
  entries: z.record(z.string()) as unknown as z.ZodType<Record<string, string>>,
});

export const AppConfigSchema = z.object({
  version: z.literal(1),
  clockSkewToleranceMs: ClockSkewToleranceMsSchema.default(DEFAULT_CLOCK_SKEW_TOLERANCE_MS),
  // @ts-expect-error DESIGN.md uses the one-argument z.record form.
  egressProfiles: z.record(EgressProfileSchema) as unknown as z.ZodType<Record<string, z.infer<typeof EgressProfileSchema>>>,
  instruments: z.array(InstrumentConfigSchema),
  sources: z.array(SourceConfigSchema),
  sections: z.array(SectionConfigSchema).default([]),
  symbolMaps: z.array(SymbolMapConfigSchema),
  intel: z.object({
    enabled: z.boolean(),
    sources: z.array(SourceId),
    pollingSeconds: z.number().positive(),
    dedup: z.object({
      canonicalizeTrackingParams: z.boolean(),
      simHashDistance: z.number().int().nonnegative(),
      minHashJaccard: z.number().min(0).max(1),
    }),
    llmRouteId: z.string(),
  }),
  llm: z.object({
    providers: z.array(z.object({
      id: z.string(),
      baseUrl: z.string().url(),
      apiKeyRef: z.string().regex(/^(env|secret):[A-Z][A-Z0-9_]*$/).nullable(),
      egressProfile: z.enum(["direct", "corp", "vpn"]).default("corp"),
      egressFallback: z.array(z.enum(["direct", "corp", "vpn"])).default([]),
      models: z.array(z.string()).min(1),
      enabled: z.boolean(),
    })),
    // @ts-expect-error DESIGN.md uses the one-argument z.record form.
    routes: z.record(z.object({
      orderedProviders: z.array(z.string()).min(1),
      maxInputTokens: z.number().int().positive(),
      maxOutputTokens: z.number().int().positive(),
      dailyUsdBudget: DecimalString,
    })) as unknown as z.ZodType<Record<string, {
      orderedProviders: string[];
      maxInputTokens: number;
      maxOutputTokens: number;
      dailyUsdBudget: string;
    }>>,
  }),
  accounts: z.array(z.object({
    id: z.string(),
    adapter: z.string(),
    institution: z.string(),
    mode: z.enum(["readonly", "manual"]),
    enabled: z.boolean(),
    credentialsRef: z.string().nullable(),
    reportingCurrency: FiatCurrency,
  })),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const SourceParams = {
  "tradier-stocks": z.object({
    timeframe: z.literal("1d").default("1d"),
    historyDays: z.number().int().min(1).max(1825).default(730),
  }).strict(),
  coingecko: z.object({
    vsCurrency: z.string().regex(/^[a-z]{3,10}$/),
    days: z.number().int().positive().max(365),
  }).strict(),
  "binance-vision": z.object({
    interval: z.enum(["1s", "1m", "5m", "15m", "1h", "1d"]),
    limit: z.number().int().positive().max(1000),
  }).strict(),
  "gold-api": z.object({
    metal: z.enum(["XAU", "XAG", "XPT", "XPD", "HG"]),
    quoteAsset: z.string().regex(/^[A-Z0-9]{2,10}$/),
    unit: z.enum(["troy_ounce", "gram"]),
  }).strict(),
  "massive-stocks": z.object({
    adjusted: z.boolean(),
    timeframe: z.enum(["1m", "5m", "15m", "1h", "1d", "1w"]),
    historyYears: z.number().int().min(1).max(5),
    limit: z.number().int().positive().max(50_000),
  }).strict(),
  rss: z.object({
    query: z.string().min(1).nullable(),
    language: z.string().min(2).max(20),
    region: z.string().regex(/^[A-Z]{2}$/).nullable(),
    maxItems: z.number().int().positive().max(200),
  }).strict(),
} as const;

export type KnownSourceAdapter = keyof typeof SourceParams;

export const CapabilityDescriptorSchema = z.object({
  capability: CapabilitySchema,
  supportedAssetClasses: z.array(AssetClass),
  supportsStreaming: z.boolean(),
  supportsHistorical: z.boolean(),
  maxGranularity: z.enum(["tick", "1s", "1m", "5m", "15m", "1h", "1d", "unknown"]),
  freshnessClass: z.enum(["realtime", "delayed", "eod", "unknown"]),
  requiresEntitlement: z.boolean(),
  parameterSchemaId: z.string().nullable(),
});

export const SourceCapabilitiesSchema = z.object({
  sourceId: SourceId,
  capabilities: z.array(CapabilityDescriptorSchema),
  observedAt: z.string().datetime({ offset: true }),
  health: z.enum(["healthy", "degraded", "down", "unknown"]),
});

export type ConfigSnapshot = {
  readonly config: AppConfig;
  readonly generation: number;
  readonly sha256: string;
  readonly loadedAt: string;
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
};
