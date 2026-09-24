import { connect } from "node:net";
import type { EgressName, EgressProfile } from "@invest/config";
import type { Result } from "@invest/domain";
import { request } from "undici";
import { EgressDispatcherPool } from "./dispatcher-pool.js";

export interface RawHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
  readonly url: string;
  readonly receivedAt: string;
  readonly serverDate: string | null;
  /** Signed provider Date minus local receive time, in milliseconds. */
  readonly clockSkewMs: number | null;
  /** The dispatcher that produced this response, including any per-request fallback. */
  readonly egressProfileUsed: EgressName;
}

export interface TransportError {
  readonly kind: "network" | "timeout";
  readonly message: string;
  readonly code: string | null;
  readonly egressProfileUsed: EgressName | null;
  readonly fallbackEligible: boolean;
}

export interface HttpRequestOptions {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly egressProfile: EgressName;
  readonly egressFallback?: readonly EgressName[];
  readonly userAgent: string;
  readonly followRedirects: boolean;
  readonly maxRedirects: number;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
  readonly signal?: AbortSignal;
}

export interface EgressFallbackEvent {
  readonly url: string;
  readonly primary: EgressName;
  readonly failedProfile: EgressName;
  readonly fallbackProfile: EgressName;
  readonly error: TransportError;
}

export type EgressFallbackListener = (event: EgressFallbackEvent) => void;

const VPN_LISTENER_CHECK_TTL_MS = 5_000;

export class EgressHttpClient {
  private vpnListenerCheck: { proxyUrl: string; checkedAtMs: number; result: ProxyListenerCheck } | null = null;
  private vpnListenerCheckPromise: { proxyUrl: string; promise: Promise<ProxyListenerCheck> } | null = null;

  public constructor(
    private pool: EgressDispatcherPool,
    private readonly onFallback: EgressFallbackListener = () => undefined,
  ) {}

  public profile(name: EgressName) {
    return this.pool.profile(name);
  }

  public async request(options: HttpRequestOptions): Promise<Result<RawHttpResponse, TransportError>> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), options.requestTimeoutMs);
    const abortFromCaller = options.signal
      ? () => timeoutController.abort(options.signal?.reason)
      : null;
    options.signal?.addEventListener("abort", abortFromCaller as EventListener, { once: true });

    try {
      const routes = this.pool.route(options.egressProfile, options.egressFallback ?? []);
      let lastError: TransportError | null = null;
      for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        if (!route) continue;
        const listenerError = await this.vpnListenerError(route.name, route.profile.proxyUrl);
        const result = listenerError
          ? { ok: false as const, error: listenerError }
          : await this.requestThrough(route.name, route.dispatcher, route.profile.maxRedirects, options, timeoutController.signal);
        if (result.ok) return result;
        lastError = result.error;

        const fallback = routes[index + 1];
        if (!fallback || !result.error.fallbackEligible) return result;
        try {
          this.onFallback({
            url: options.url,
            primary: options.egressProfile,
            failedProfile: route.name,
            fallbackProfile: fallback.name,
            error: result.error,
          });
        } catch {
          // Observability must never interfere with request routing.
        }
      }
      return {
        ok: false,
        error: lastError ?? transportFailure("no egress route is configured", "NO_EGRESS_ROUTE", null, false),
      };
    } finally {
      clearTimeout(timeout);
      if (abortFromCaller && options.signal) options.signal.removeEventListener("abort", abortFromCaller as EventListener);
    }
  }

  public async close(): Promise<void> {
    await this.pool.close();
  }

  public async updateProfiles(profiles: Record<EgressName, EgressProfile>): Promise<void> {
    const previous = this.pool;
    this.pool = new EgressDispatcherPool(profiles);
    this.vpnListenerCheck = null;
    this.vpnListenerCheckPromise = null;
    await previous.close();
  }

  private async requestThrough(
    egressProfileUsed: EgressName,
    dispatcher: ReturnType<EgressDispatcherPool["get"]>,
    maxRedirects: number,
    options: HttpRequestOptions,
    signal: AbortSignal,
  ): Promise<Result<RawHttpResponse, TransportError>> {
    let receivedHttpResponse = false;
    try {
      let currentUrl = options.url;
      for (let redirect = 0; ; redirect += 1) {
        receivedHttpResponse = false;
        const response = await request(currentUrl, {
          dispatcher,
          method: options.method ?? "GET",
          headers: {
            ...(options.headers ?? {}),
            "user-agent": options.userAgent,
            accept: "application/json, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.1",
          },
          headersTimeout: options.requestTimeoutMs,
          bodyTimeout: options.requestTimeoutMs,
          body: options.body,
          signal,
        });
        receivedHttpResponse = true;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        const location = headers.location;
        if (options.followRedirects && location && response.statusCode >= 300 && response.statusCode < 400 && redirect < maxRedirects) {
          await response.body.arrayBuffer();
          const nextUrl = new URL(location, currentUrl);
          if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
            return { ok: false, error: transportFailure("redirect uses an unsupported protocol", "UNSAFE_REDIRECT", egressProfileUsed, false) };
          }
          if (nextUrl.hostname !== new URL(options.url).hostname) {
            return { ok: false, error: transportFailure("redirect leaves the configured source host", "UNSAFE_REDIRECT", egressProfileUsed, false) };
          }
          currentUrl = nextUrl.toString();
          receivedHttpResponse = false;
          continue;
        }
        const body = new Uint8Array(await response.body.arrayBuffer());
        const receivedAtMs = Date.now();
        const serverDateMs = headers.date ? Date.parse(headers.date) : NaN;
        return {
          ok: true,
          value: {
            status: response.statusCode,
            headers,
            body,
            url: currentUrl,
            receivedAt: new Date(receivedAtMs).toISOString(),
            serverDate: headers.date ?? null,
            clockSkewMs: Number.isFinite(serverDateMs) ? serverDateMs - receivedAtMs : null,
            egressProfileUsed,
          },
        };
      }
    } catch (error) {
      const code = errorCode(error);
      const isTimeout = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
      return {
        ok: false,
        error: transportFailure(
          error instanceof Error ? error.message : String(error),
          code,
          egressProfileUsed,
          !receivedHttpResponse && isConnectionLayerFailure(error),
          isTimeout ? "timeout" : "network",
        ),
      };
    }
  }

  private async vpnListenerError(name: EgressName, proxyUrl: string | null): Promise<TransportError | null> {
    if (name !== "vpn" || !proxyUrl) return null;
    const now = Date.now();
    if (this.vpnListenerCheck?.proxyUrl === proxyUrl
      && now - this.vpnListenerCheck.checkedAtMs < VPN_LISTENER_CHECK_TTL_MS) {
      return this.vpnListenerCheck.result.reachable
        ? null
        : transportFailure(this.vpnListenerCheck.result.error ?? "VPN proxy listener is unreachable", "PROXY_LISTENER_UNREACHABLE", name, true);
    }

    if (this.vpnListenerCheckPromise?.proxyUrl !== proxyUrl) {
      this.vpnListenerCheckPromise = { proxyUrl, promise: checkProxyListener(proxyUrl) };
    }
    const result = await this.vpnListenerCheckPromise.promise;
    this.vpnListenerCheck = { proxyUrl, checkedAtMs: Date.now(), result };
    this.vpnListenerCheckPromise = null;
    return result.reachable
      ? null
      : transportFailure(result.error ?? "VPN proxy listener is unreachable", "PROXY_LISTENER_UNREACHABLE", name, true);
  }
}

function transportFailure(
  message: string,
  code: string | null,
  egressProfileUsed: EgressName | null,
  fallbackEligible: boolean,
  kind: TransportError["kind"] = "network",
): TransportError {
  return { kind, message, code, egressProfileUsed, fallbackEligible };
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isConnectionLayerFailure(error: unknown): boolean {
  for (const current of errorChain(error)) {
    const code = errorCode(current);
    if (code && (CONNECTION_ERROR_CODES.has(code)
      || code.startsWith("ERR_TLS_")
      || code.startsWith("ERR_SSL_")
      || code.startsWith("CERT_")
      || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
      || code === "SELF_SIGNED_CERT_IN_CHAIN"
      || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")) return true;
    if (current instanceof Error && /\b(?:TLS|SSL|certificate)\b/i.test(current.message)) return true;
  }
  return false;
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    values.push(current);
    seen.add(current);
    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return values;
}

function errorCode(error: unknown): string | null {
  for (const current of errorChain(error)) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const value = (current as { code?: unknown }).code;
      if (typeof value === "string" && value) return value;
    }
  }
  return null;
}

export interface ProxyListenerCheck {
  readonly configured: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly reachable: boolean;
  readonly error: string | null;
}

export async function checkProxyListener(proxyUrl: string | null): Promise<ProxyListenerCheck> {
  if (!proxyUrl) return { configured: false, host: null, port: null, reachable: true, error: null };
  try {
    const parsed = new URL(proxyUrl);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: parsed.hostname, port, timeout: 2_000 });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("timeout", () => {
        socket.destroy(new Error("proxy listener timeout"));
      });
      socket.once("error", reject);
    });
    return { configured: true, host: parsed.hostname, port, reachable: true, error: null };
  } catch (error) {
    return {
      configured: true,
      host: null,
      port: null,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
