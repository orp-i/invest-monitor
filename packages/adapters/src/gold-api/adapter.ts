import {
  err,
  InstrumentCandidateSchema,
  QuoteSchema,
  Timestamp,
  type Result,
  type SourceError,
  type InstrumentCandidate,
} from "@invest/domain";
import { SourceParams } from "@invest/config";
import type { RawHttpResponse } from "@invest/egress";
import {
  candidateCapabilities,
  debugRejectedInstrumentCandidate,
  fetchJson,
  freshnessFor,
  normalizeRequiredDecimal,
  parseJson,
  queryUrl,
  requireArray,
  requireRecord,
  sourceError,
  validateCapability,
} from "../common.js";
import type { AdapterContext, NormalizedAdapterData, SourceAdapter } from "../types.js";

interface GoldApiRaw {
  readonly kind: "gold";
  readonly payload: Record<string, unknown>;
}

const DISCOVERABLE_METALS = new Map([
  ["XAU", "Gold"],
  ["XAG", "Silver"],
  ["XPT", "Platinum"],
  ["XPD", "Palladium"],
  ["HG", "Copper"],
]);

export const goldApiAdapter: SourceAdapter = {
  id: "gold-api",
  paramsSchema: SourceParams["gold-api"],
  capabilities: ["instrumentSearch", "quote"],
  freshnessClass: "realtime",

  async searchInstruments(query: string, context: AdapterContext): Promise<Result<InstrumentCandidate[], SourceError>> {
    const response = await fetchJson(
      context,
      queryUrl(context.source.baseUrl, "symbols", {}),
      new AbortController().signal,
    );
    if (!response.ok) return response;
    const parsed = parseJson(response.value, context);
    if (!parsed.ok) return parsed;
    const payload = Array.isArray(parsed.value)
      ? parsed.value
      : typeof parsed.value === "object" && parsed.value !== null
        ? (parsed.value as Record<string, unknown>).symbols
        : null;
    const symbols = requireArray(payload, context, "Gold API symbols");
    if (!symbols.ok) return symbols;
    const needle = query.trim().toUpperCase();
    const available = new Set(symbols.value.flatMap((value) => {
      if (typeof value === "string") return [value.toUpperCase()];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const symbol = (value as Record<string, unknown>).symbol;
        return typeof symbol === "string" ? [symbol.toUpperCase()] : [];
      }
      return [];
    }));
    // Gold API also lists BTC and ETH. They are intentionally not exposed:
    // CoinGecko and Binance are the repository's more appropriate crypto sources.
    const capabilities = candidateCapabilities(context, this.capabilities);
    const matches = [...DISCOVERABLE_METALS.entries()]
      .filter(([symbol, name]) => available.has(symbol) && (`${symbol} ${name}`.toUpperCase().includes(needle)));
    const candidates: InstrumentCandidate[] = [];
    for (const [rank, [symbol, name]] of matches.entries()) {
      const candidate = InstrumentCandidateSchema.safeParse({
        sourceId: context.source.id,
        providerSymbol: symbol,
        symbol: `${symbol}/USD`,
        displayName: name,
        assetClass: "preciousMetal",
        baseAsset: symbol,
        quoteAsset: "USD",
        capabilities,
        rank,
        venue: "spot",
      });
      if (!candidate.success) {
        debugRejectedInstrumentCandidate(context.source.id, symbol);
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
    const typed = parsed.data as { metal: string };
    const url = queryUrl(context.source.baseUrl, `price/${encodeURIComponent(typed.metal)}`, {});
    return fetchJson(context, url, signal);
  },

  parse(response: RawHttpResponse, context: AdapterContext): Result<unknown, SourceError> {
    const parsed = parseJson(response, context);
    if (!parsed.ok) return parsed;
    const record = requireRecord(parsed.value, context, "Gold API response");
    if (!record.ok) return record;
    return { ok: true, value: { kind: "gold", payload: record.value } satisfies GoldApiRaw };
  },

  normalize(raw: unknown, context: AdapterContext): Result<NormalizedAdapterData, SourceError> {
    if (!isGold(raw)) return err(sourceError(context, "schema", "unexpected Gold API payload", { causeCode: "RAW_KIND" }));
    const payload = raw.payload;
    const currency = typeof payload.currency === "string" ? payload.currency.toUpperCase() : null;
    if (currency && currency !== context.binding.quoteAsset) {
      return err(sourceError(context, "semantic", `Gold API returned ${currency}, expected ${context.binding.quoteAsset}`, { causeCode: "QUOTE_ASSET_MISMATCH" }));
    }
    const price = normalizeRequiredDecimal(payload.price, context, "price");
    if (!price.ok) return price;
    const capturedAt = typeof payload.updatedAt === "string" && payload.updatedAt.length > 0
      ? payload.updatedAt
      : context.now;
    if (!Timestamp.safeParse(capturedAt).success) {
      return err(sourceError(context, "semantic", "Gold API updatedAt is not an ISO timestamp", { causeCode: "INVALID_UPDATED_AT" }));
    }
    const receivedAt = context.now;
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
      capturedAt,
      receivedAt,
      freshness: freshnessFor(capturedAt, receivedAt, context, "realtime"),
      quality: "authoritative",
      rawRef: null,
    });
    if (!quote.success) return err(sourceError(context, "schema", quote.error.message, { causeCode: "QUOTE_SCHEMA" }));
    return { ok: true, value: { kind: "quote", value: quote.data } };
  },
};

function isGold(value: unknown): value is GoldApiRaw {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "gold";
}
