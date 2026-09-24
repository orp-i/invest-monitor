import {
  err,
  SourceErrorSchema,
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  type Capability,
  type FreshnessClass,
  type Instrument,
  type Quote,
  type Result,
  type SourceBinding,
  type SourceError,
} from "@invest/domain";
import type { ConfigSnapshot, InstrumentConfig, SourceConfig } from "@invest/config";
import { ConfigRegistry } from "@invest/config";
import { createAdapterRegistry, tradierClockState, tradierTradeSession, type AdapterContext, type AdapterRegistry, type SourceAdapter } from "@invest/adapters";
import type { EgressHttpClient } from "@invest/egress";
import type { StorageDriver } from "@invest/storage";
import type { SourceHealthInput } from "@invest/storage";
import { TokenBucket } from "./token-bucket.js";
import { retryResult } from "./retry.js";
import { HealthTracker } from "./health.js";

interface ScheduledJob {
  readonly key: string;
  readonly instrument: InstrumentConfig;
  readonly source: SourceConfig;
  readonly binding: SourceBinding;
  readonly capability: Capability;
  readonly adapter: SourceAdapter;
  readonly generation: number;
  nextRunAt: number;
  running: boolean;
}

export type SourceAuthResolver = (authRef: string | null) => Promise<string | null>;

export interface SchedulerStatus {
  readonly state: "stopped" | "running";
  readonly lastHeartbeat: string | null;
  readonly generation: number | null;
  readonly jobs: number;
  readonly activeJobs: number;
  readonly pausedJobs: number;
}

export type SchedulerEvent =
  | {
      readonly type: "quote.updated";
      readonly generation: number;
      readonly instrumentId: string;
      readonly sourceId: string;
      readonly quote: Quote;
      readonly health: SourceHealthInput;
    }
  | {
      readonly type: "health.updated";
      readonly generation: number;
      readonly instrumentId?: string;
      readonly sourceId: string;
      readonly capability: Capability;
      readonly health: SourceHealthInput;
    };

export class CollectorScheduler {
  private readonly adapters: AdapterRegistry;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly health = new HealthTracker();
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly authTokensBySource = new Map<string, string | null>();
  private readonly listeners = new Set<(event: SchedulerEvent) => void>();
  private running = false;
  private lastHeartbeatAt: string | null = null;
  private snapshotValue: ConfigSnapshot | null = null;
  private dispatchTimer: NodeJS.Timeout | null = null;
  private readonly interests = new Map<string, { instrumentId: string; expiresAt: number }>();
  private backgroundQuotes = new Set<string>();
  private readonly inFlightKeys = new Set<string>();

  public constructor(
    private readonly storage: StorageDriver,
    private readonly httpClient: EgressHttpClient,
    adapters?: AdapterRegistry,
    private readonly resolveAuth: SourceAuthResolver = async () => null,
    private readonly options: { onDemand?: boolean; automaticStocks?: boolean } = {},
  ) {
    this.adapters = adapters ?? createAdapterRegistry();
  }

  public async start(snapshot: ConfigSnapshot): Promise<void> {
    this.running = true;
    await this.applySnapshot(snapshot);
    if (!this.dispatchTimer) this.dispatchTimer = setInterval(() => this.dispatch(), 1000);
    this.dispatchTimer.unref();
    this.touchHeartbeat();
  }

  public async applySnapshot(snapshot: ConfigSnapshot): Promise<void> {
    this.snapshotValue = snapshot;
    this.health.setClockSkewToleranceMs(snapshot.config.clockSkewToleranceMs);
    this.authTokensBySource.clear();
    for (const source of snapshot.config.sources) {
      const token = await this.resolveAuth(source.authRef).catch(() => null);
      this.authTokensBySource.set(source.id, token);
    }
    this.buckets.clear();
    for (const source of snapshot.config.sources) {
      this.buckets.set(source.id, new TokenBucket(source.rateLimit.requestsPerSecond, source.rateLimit.burst));
    }
    const previousJobs = new Map(this.jobs);
    this.jobs.clear();
    if (!this.running) return;
    for (const instrument of snapshot.config.instruments) {
      if (!instrument.active || !instrument.watch) continue;
      for (const binding of instrument.sourceBindings) {
        const source = snapshot.config.sources.find((candidate) => candidate.id === binding.sourceId);
        if (!source || !source.enabled || !binding.enabled) continue;
        if (source.authRef !== null && !this.sourceAuthConfigured(source.id)) {
          for (const capability of binding.capabilities) {
            await this.recordFailure(source, binding, capability, this.missingAuthError(source.id, capability));
          }
          continue;
        }
        const adapter = this.adapters.get(source.adapter);
        if (!adapter) {
          await this.recordFailure(source, binding, "quote", this.unsupportedError(source.id, binding, "adapter not registered"));
          continue;
        }
        for (const capability of binding.capabilities) {
          if (!adapter.capabilities.includes(capability)) continue;
          const key = `${source.id}:${instrument.id}:${capability}`;
          this.jobs.set(key, {
            key,
            instrument,
            source,
            binding,
            capability,
            adapter,
            generation: snapshot.generation,
            nextRunAt: previousJobs.get(key)?.nextRunAt ?? 0,
            running: false,
          });
        }
      }
    }
    this.dispatch();
  }

  public setBackgroundQuoteInstruments(ids: readonly string[]): void {
    this.backgroundQuotes = new Set(ids);
  }

  // One lease per visible browser tab. Replacing it immediately quiets the old
  // selection; expiry also handles closed tabs and lost network connections.
  public setInterest(clientId: string, instrumentId: string | null): void {
    this.pruneInterests();
    if (instrumentId === null) this.interests.delete(clientId);
    else if (this.interests.has(clientId) || this.interests.size < 1024) this.interests.set(clientId, { instrumentId, expiresAt: Date.now() + 90000 });
    this.dispatch();
  }

  private pruneInterests(): void {
    for (const [id, interest] of this.interests) if (interest.expiresAt <= Date.now()) this.interests.delete(id);
  }

  private demanded(job: ScheduledJob): boolean {
    return !this.options.onDemand || this.automaticStock(job) || (job.capability === "quote" && this.backgroundQuotes.has(job.instrument.id))
      || [...this.interests.values()].some(interest => interest.instrumentId === job.instrument.id && interest.expiresAt > Date.now());
  }

  private automaticStock(job: ScheduledJob | undefined): boolean {
    return Boolean(this.options.automaticStocks && job?.instrument.assetClass === "equity" && (job.capability === "quote" || job.capability === "candle"));
  }

  public async collectNow(instrumentId?: string, sourceId?: string): Promise<readonly { key: string; ok: boolean; error?: SourceError }[]> {
    const selected = [...this.jobs.values()].filter((job) =>
      (!instrumentId || job.instrument.id === instrumentId) && (!sourceId || job.source.id === sourceId));
    const results = await Promise.all(selected.map(async (job) => {
      const result = await this.runJob(job);
      return result.ok
        ? { key: job.key, ok: true }
        : { key: job.key, ok: false, error: result.error };
    }));
    return results;
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    this.dispatchTimer = null;
    this.interests.clear();
    this.jobs.clear();
  }

  public status(): SchedulerStatus {
    return {
      state: this.running ? "running" : "stopped",
      lastHeartbeat: this.lastHeartbeatAt,
      generation: this.snapshotValue?.generation ?? null,
      jobs: this.jobs.size,
      activeJobs: this.inFlightKeys.size,
      pausedJobs: [...this.jobs.values()].filter(job => !this.demanded(job)).length,
    };
  }

  public healthTracker(): HealthTracker {
    return this.health;
  }

  public sourceFreshnessClass(sourceId: string): FreshnessClass {
    const source = this.snapshotValue?.config.sources.find((candidate) => candidate.id === sourceId);
    const adapter = source ? this.adapters.get(source.adapter) : undefined;
    return source ? adapter?.freshnessClassFor?.(source) ?? adapter?.freshnessClass ?? "unknown" : "unknown";
  }

  public sourceTradeSession(sourceId: string, at: string, assetClass: string) {
    const source = this.snapshotValue?.config.sources.find(source => source.id === sourceId);
    return source?.adapter === "tradier-stocks" ? tradierTradeSession(this.httpClient, source.baseUrl, this.authTokensBySource.get(sourceId) ?? null, at, assetClass) : {};
  }

  public sourceMarketState(sourceId: string) {
    const source = this.snapshotValue?.config.sources.find(s => s.id === sourceId);
    return source?.adapter === "tradier-stocks" ? tradierClockState(this.httpClient, source.baseUrl, this.authTokensBySource.get(sourceId) ?? null) : "unknown";
  }

  public sourceCapabilityAvailable(sourceId: string, capability: Capability): boolean {
    const source = this.snapshotValue?.config.sources.find((candidate) => candidate.id === sourceId);
    if (!source?.enabled || !source.capabilities.includes(capability)) return false;
    if (source.authRef !== null && !this.sourceAuthConfigured(sourceId)) return false;
    return this.adapters.get(source.adapter)?.capabilities.includes(capability) === true;
  }

  public sourceAuthConfigured(sourceId: string): boolean {
    const source = this.snapshotValue?.config.sources.find((candidate) => candidate.id === sourceId);
    if (!source) return false;
    return source.authRef === null || Boolean(this.authTokensBySource.get(sourceId));
  }

  public subscribe(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dispatch(): void {
    if (!this.running) return;
    this.touchHeartbeat();
    this.pruneInterests();
    let available = 4 - [...this.inFlightKeys].filter(key => !this.automaticStock(this.jobs.get(key))).length;
    for (const job of [...this.jobs.values()].sort((a, b) => a.nextRunAt - b.nextRunAt)) {
      if (this.inFlightKeys.has(job.key) || job.nextRunAt > Date.now() || !this.demanded(job)) continue;
      if (!this.automaticStock(job)) { if (available <= 0) continue; available--; }
      void this.runJob(job);
    }
  }

  private async runJob(job: ScheduledJob): Promise<Result<true, SourceError>> {
    if (this.inFlightKeys.has(job.key)) return { ok: true, value: true };
    this.inFlightKeys.add(job.key);
    job.running = true;
    const startedAt = Date.now();
    const requestId = `${job.generation}-${job.source.id}-${job.instrument.id}-${job.capability}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const context: AdapterContext = {
      source: job.source,
      binding: job.binding,
      instrument: job.instrument,
      httpClient: this.httpClient,
      authToken: this.authTokensBySource.get(job.source.id) ?? null,
      now: new Date().toISOString(),
      clockSkewToleranceMs: this.snapshotValue?.config.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
      requestId,
      capability: job.capability,
    };
    const bucket = this.buckets.get(job.source.id);
    let observedClockSkewMs: number | null = null;
    let egressProfileUsed: SourceHealthInput["egressProfileUsed"] = null;
    try {
      if (!bucket) return this.fail(job, this.unsupportedError(job.source.id, job.binding, "rate limiter is missing"), startedAt);
      const circuit = this.health.circuitState(job.source.id, job.capability);
      if (circuit === "open") {
        return this.fail(job, this.unsupportedError(job.source.id, job.binding, "source circuit is open", "CIRCUIT_OPEN"), startedAt);
      }
      await bucket.acquire();
      const params = { ...job.source.params, ...job.binding.params };
      const fetched = await retryResult(() => job.adapter.fetch(context, params, new AbortController().signal));
      if (!fetched.ok) return this.fail(job, fetched.error, startedAt, null, fetched.error.egressProfileUsed);
      observedClockSkewMs = fetched.value.clockSkewMs;
      egressProfileUsed = fetched.value.egressProfileUsed;
      const rawEventId = await this.storage.appendRawEvent({
        sourceId: job.source.id,
        instrumentId: job.instrument.id,
        capability: job.capability,
        requestId,
        capturedAt: null,
        receivedAt: fetched.value.receivedAt,
        httpStatus: fetched.value.status,
        contentType: fetched.value.headers["content-type"] ?? null,
        body: fetched.value.body,
        rawJson: new TextDecoder().decode(fetched.value.body),
        parseStatus: "fetched",
        egressProfileUsed: fetched.value.egressProfileUsed,
      });
      const responseContext: AdapterContext = { ...context, now: fetched.value.receivedAt };
      const parsed = job.adapter.parse(fetched.value, responseContext);
      if (!parsed.ok) return this.fail(job, parsed.error, startedAt, observedClockSkewMs, egressProfileUsed);
      const normalized = job.adapter.normalize(parsed.value, responseContext);
      if (!normalized.ok) return this.fail(job, normalized.error, startedAt, observedClockSkewMs, egressProfileUsed);
      let updatedQuote: Quote | null = null;
      if (normalized.value.kind === "quote") {
        updatedQuote = { ...normalized.value.value, rawRef: String(rawEventId) };
        await this.storage.appendQuotes([updatedQuote]);
      } else if (normalized.value.value.length > 0) {
        await this.storage.appendCandles(normalized.value.value);
      }
      if (normalized.value.kind === "candles" && normalized.value.warnings) await this.storage.setCandleWarnings(job.instrument.id, job.source.id, normalized.value.warnings, Date.now());
      const health = this.health.recordSuccess(job.source.id, job.capability, Date.now() - startedAt, observedClockSkewMs, egressProfileUsed);
      await this.storage.recordSourceHealth(health);
      this.emit({
        type: "health.updated",
        generation: job.generation,
        instrumentId: job.instrument.id,
        sourceId: job.source.id,
        capability: job.capability,
        health,
      });
      if (updatedQuote) {
        this.emit({
          type: "quote.updated",
          generation: job.generation,
          instrumentId: job.instrument.id,
          sourceId: job.source.id,
          quote: updatedQuote,
          health,
        });
      }
      this.touchHeartbeat();
      return { ok: true, value: true };
    } catch (error) {
      const sourceError = this.unexpectedError(job, error);
      return this.fail(job, sourceError, startedAt, observedClockSkewMs, egressProfileUsed);
    } finally {
      job.running = false;
      this.inFlightKeys.delete(job.key);
      job.nextRunAt = Date.now() + Math.max(1000, Math.round(job.binding.cadenceSeconds * 1000 * (0.9 + Math.random() * 0.2)));
    }
  }

  private async fail(
    job: ScheduledJob,
    error: SourceError,
    startedAt: number,
    clockSkewMs?: number | null,
    egressProfileUsed: SourceHealthInput["egressProfileUsed"] = error.egressProfileUsed,
  ): Promise<Result<never, SourceError>> {
    const health = this.health.recordFailure(job.source.id, job.capability, error, clockSkewMs, egressProfileUsed);
    await this.storage.recordSourceHealth(health);
    this.emit({
      type: "health.updated",
      generation: job.generation,
      instrumentId: job.instrument.id,
      sourceId: job.source.id,
      capability: job.capability,
      health,
    });
    this.touchHeartbeat();
    return err(error);
  }

  private async recordFailure(source: SourceConfig, binding: SourceBinding, capability: Capability, error: SourceError): Promise<void> {
    const health = this.health.recordFailure(source.id, capability, error);
    await this.storage.recordSourceHealth(health);
  }

  private unsupportedError(sourceId: string, binding: SourceBinding, message: string, causeCode = "UNSUPPORTED"): SourceError {
    return SourceErrorSchema.parse({
      kind: "unsupported",
      sourceId,
      capability: binding.capabilities[0] ?? null,
      message,
      httpStatus: null,
      retryable: false,
      retryAfterSeconds: null,
      requestId: `scheduler-${Date.now()}`,
      observedAt: new Date().toISOString(),
      causeCode,
    });
  }

  private missingAuthError(sourceId: string, capability: Capability): SourceError {
    return SourceErrorSchema.parse({
      kind: "auth",
      sourceId,
      capability,
      message: "source credential reference is not configured",
      httpStatus: null,
      retryable: false,
      retryAfterSeconds: null,
      requestId: `scheduler-${sourceId}-${capability}-${Date.now()}`,
      observedAt: new Date().toISOString(),
      causeCode: "MISSING_AUTH",
    });
  }

  private unexpectedError(job: ScheduledJob, error: unknown): SourceError {
    return SourceErrorSchema.parse({
      kind: "network",
      sourceId: job.source.id,
      capability: job.capability,
      message: error instanceof Error ? error.message : String(error),
      httpStatus: null,
      retryable: false,
      retryAfterSeconds: null,
      requestId: `scheduler-${Date.now()}`,
      observedAt: new Date().toISOString(),
      causeCode: "UNEXPECTED_COLLECTOR_ERROR",
    });
  }

  private touchHeartbeat(): void {
    this.lastHeartbeatAt = new Date().toISOString();
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
