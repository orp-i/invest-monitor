import {
  computeFreshness,
  err,
  normalizeDecimal,
  normalizeNullableDecimal,
  SourceErrorSchema,
  type Capability,
  type FreshnessClass,
  type Result,
  type SourceError,
} from "@invest/domain";
import type { AdapterContext } from "./types.js";
import type { RawHttpResponse, TransportError } from "@invest/egress";

export function sourceError(
  context: Pick<AdapterContext, "source" | "capability" | "requestId">,
  kind: SourceError["kind"],
  message: string,
  options: Partial<Pick<SourceError, "httpStatus" | "retryable" | "retryAfterSeconds" | "clockSkewMs" | "egressProfileUsed" | "code" | "causeCode">> = {},
): SourceError {
  return SourceErrorSchema.parse({
    kind,
    sourceId: context.source.id,
    capability: context.capability,
    message,
    httpStatus: options.httpStatus ?? null,
    retryable: options.retryable ?? false,
    retryAfterSeconds: options.retryAfterSeconds ?? null,
    clockSkewMs: options.clockSkewMs ?? null,
    egressProfileUsed: options.egressProfileUsed ?? null,
    requestId: context.requestId,
    observedAt: new Date().toISOString(),
    code: options.code ?? null,
    causeCode: options.causeCode ?? null,
  });
}

export function transportError(
  context: Pick<AdapterContext, "source" | "capability" | "requestId">,
  error: TransportError,
): SourceError {
  return sourceError(
    context,
    error.kind,
    error.message,
    { retryable: true, causeCode: error.code, egressProfileUsed: error.egressProfileUsed },
  );
}

export function requestError(
  response: RawHttpResponse,
  context: Pick<AdapterContext, "source" | "capability" | "requestId">,
): SourceError {
  const retryAfterValue = response.headers["retry-after"];
  const retryAfterSeconds = retryAfterValue && /^\d+(\.\d+)?$/.test(retryAfterValue)
    ? Number(retryAfterValue)
    : null;
  const kind: SourceError["kind"] = response.status === 401 || response.status === 403
    ? "auth"
    : response.status === 429
      ? "rate_limited"
      : "http";
  const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  return sourceError(context, kind, `HTTP ${response.status} from ${context.source.id}`, {
    httpStatus: response.status,
    retryable,
    retryAfterSeconds,
    clockSkewMs: response.clockSkewMs,
    egressProfileUsed: response.egressProfileUsed,
    causeCode: `HTTP_${response.status}`,
  });
}

export function parseJson(
  response: RawHttpResponse,
  context: Pick<AdapterContext, "source" | "capability" | "requestId">,
): Result<unknown, SourceError> {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(response.body)) as unknown };
  } catch (error) {
    return err(sourceError(context, "parse", error instanceof Error ? error.message : "invalid JSON", {
      retryable: false,
      causeCode: "INVALID_JSON",
    }));
  }
}

export function requireRecord(
  value: unknown,
  context: Pick<AdapterContext, "source" | "capability" | "requestId">,
  label: string,
): Result<Record<string, unknown>, SourceError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(sourceError(context, "schema", `${label} must be an object`, { causeCode: "EXPECTED_OBJECT" }));
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export function requireArray(
  value: unknown,
  context: Pick<AdapterContext, "source" | "capability" | "requestId">,
  label: string,
): Result<readonly unknown[], SourceError> {
  if (!Array.isArray(value)) {
    return err(sourceError(context, "schema", `${label} must be an array`, { causeCode: "EXPECTED_ARRAY" }));
  }
  return { ok: true, value };
}

export async function fetchJson(
  context: AdapterContext,
  url: string,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<Result<RawHttpResponse, SourceError>> {
  const response = await context.httpClient.request({
    url,
    egressProfile: context.binding.egressProfile,
    egressFallback: context.binding.egressFallback,
    userAgent: context.source.userAgent,
    followRedirects: context.source.followRedirects,
    maxRedirects: context.httpClient.profile(context.binding.egressProfile).maxRedirects,
    connectTimeoutMs: context.httpClient.profile(context.binding.egressProfile).connectTimeoutMs,
    requestTimeoutMs: context.httpClient.profile(context.binding.egressProfile).requestTimeoutMs,
    headers,
    signal,
  });
  if (!response.ok) return err(transportError(context, response.error));
  if (response.value.status < 200 || response.value.status >= 300) return err(requestError(response.value, context));
  return response;
}

export function normalizeRequiredDecimal(
  value: unknown,
  context: Pick<AdapterContext, "source" | "capability" | "requestId">,
  field: string,
): Result<string, SourceError> {
  const result = normalizeDecimal(value);
  if (!result.ok) return err(sourceError(context, "semantic", `${field}: ${result.error.message}`, { causeCode: "INVALID_DECIMAL" }));
  return result;
}

export function normalizeOptionalDecimal(value: unknown): string | null {
  return normalizeNullableDecimal(value);
}

export function timestampFromEpoch(
  value: unknown,
  context: Pick<AdapterContext, "source" | "capability" | "requestId">,
  field: string,
): Result<string, SourceError> {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return err(sourceError(context, "semantic", `${field} is not a valid epoch timestamp`, { causeCode: "INVALID_TIMESTAMP" }));
  }
  const timestamp = new Date(numeric).toISOString();
  return { ok: true, value: timestamp };
}

export function freshnessFor(
  capturedAt: string,
  receivedAt: string,
  context: AdapterContext,
  freshnessClass: FreshnessClass,
) {
  return computeFreshness(
    capturedAt,
    receivedAt,
    context.binding.staleAfterSeconds,
    new Date(receivedAt),
    freshnessClass,
    context.clockSkewToleranceMs,
  );
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function queryUrl(baseUrl: string, path: string, params: Record<string, string | number>): string {
  const url = new URL(joinUrl(baseUrl, path));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

export function validateCapability(context: AdapterContext, supported: readonly Capability[]): SourceError | null {
  return supported.includes(context.capability)
    ? null
    : sourceError(context, "unsupported", `${context.source.adapter} does not implement ${context.capability}`, { causeCode: "UNSUPPORTED_CAPABILITY" });
}

export function candidateCapabilities(
  context: AdapterContext,
  supported: readonly Capability[],
): Capability[] {
  return context.source.capabilities.filter((capability) =>
    capability !== "instrumentSearch" && supported.includes(capability));
}

export function debugRejectedInstrumentCandidate(sourceId: string, providerSymbol: string): void {
  console.debug("[instrument-search] rejected invalid candidate", { sourceId, providerSymbol });
}
