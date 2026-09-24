import type {
  Capability,
  Candle,
  Instrument,
  InstrumentCandidate,
  Quote,
  Result,
  SourceBinding,
  SourceError,
} from "@invest/domain";
import type { SourceConfig } from "@invest/config";
import type { EgressHttpClient, RawHttpResponse } from "@invest/egress";
import type { z } from "zod";

export interface AdapterContext {
  readonly source: SourceConfig;
  readonly binding: SourceBinding;
  readonly instrument: Instrument;
  readonly httpClient: EgressHttpClient;
  readonly authToken: string | null;
  readonly now: string;
  readonly clockSkewToleranceMs: number;
  readonly requestId: string;
  readonly capability: Capability;
}

export type NormalizedAdapterData =
  | { readonly kind: "quote"; readonly value: Quote }
  | { readonly kind: "candles"; readonly value: readonly Candle[]; readonly warnings?: readonly string[] };

export interface SourceAdapter {
  readonly id: string;
  readonly paramsSchema: z.ZodTypeAny;
  readonly capabilities: readonly Capability[];
  readonly freshnessClass: "realtime" | "delayed" | "eod" | "unknown";
  freshnessClassFor?(source: SourceConfig): SourceAdapter["freshnessClass"];
  searchInstruments?(
    query: string,
    context: AdapterContext,
  ): Promise<Result<InstrumentCandidate[], SourceError>>;
  fetch(
    context: AdapterContext,
    params: unknown,
    signal: AbortSignal,
  ): Promise<Result<RawHttpResponse, SourceError>>;
  parse(
    response: RawHttpResponse,
    context: AdapterContext,
  ): Result<unknown, SourceError>;
  normalize(
    raw: unknown,
    context: AdapterContext,
  ): Result<NormalizedAdapterData, SourceError>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  public register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public get(adapterId: string): SourceAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  public values(): readonly SourceAdapter[] {
    return [...this.adapters.values()];
  }
}
