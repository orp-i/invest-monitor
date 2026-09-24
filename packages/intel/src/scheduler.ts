import { createHash } from "node:crypto";
import {
  NewsItemSchema,
  SourceErrorSchema,
  type NewsItem,
  type SourceError,
} from "@invest/domain";
import type { ConfigSnapshot, SourceConfig } from "@invest/config";
import type { EgressHttpClient, RawHttpResponse } from "@invest/egress";
import type { SourceHealthInput, StorageDriver } from "@invest/storage";
import { canonicalizeNewsUrl } from "./canonical-url.js";
import { findDuplicateNews, newsContentHash } from "./dedup.js";
import { LlmRouter, type LlmRouteStatus } from "./llm.js";
import { parseSyndicationFeed, type FeedEntry } from "./rss.js";
import { tagNewsByRules } from "./tagger.js";

interface RssParams {
  readonly query: string | null;
  readonly language: string;
  readonly region: string | null;
  readonly maxItems: number;
}

interface ConditionalHeaders {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface IntelCollectionResult {
  readonly sourceId: string;
  readonly ok: boolean;
  readonly fetched: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly notModified: boolean;
  readonly error?: SourceError;
}

export interface IntelStatus {
  readonly state: "stopped" | "running";
  readonly generation: number | null;
  readonly lastPollAt: string | null;
  readonly polling: boolean;
  readonly configuredSources: number;
  readonly enabledSources: number;
  readonly llm: LlmRouteStatus;
}

type AuthResolver = (reference: string | null) => Promise<string | null>;
type NewsListener = (item: NewsItem, generation: number) => void;

export class IntelScheduler {
  private snapshot: ConfigSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;
  private lastPollAt: string | null = null;
  private readonly conditionalHeaders = new Map<string, ConditionalHeaders>();
  private readonly lastSuccessAt = new Map<string, string>();
  private readonly llm: LlmRouter;

  public constructor(
    private readonly storage: StorageDriver,
    private readonly httpClient: EgressHttpClient,
    resolveAuth: AuthResolver,
    private readonly onNews: NewsListener = () => undefined,
  ) {
    this.llm = new LlmRouter(storage, httpClient, resolveAuth);
  }

  public async start(snapshot: ConfigSnapshot): Promise<void> {
    this.running = true;
    await this.applySnapshot(snapshot);
  }

  public async applySnapshot(snapshot: ConfigSnapshot): Promise<void> {
    this.snapshot = snapshot;
    await this.llm.applySnapshot(snapshot);
    await this.reclassifyRuleItems(snapshot);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.running || !snapshot.config.intel.enabled) return;
    void this.collectNow();
    this.timer = setInterval(() => void this.collectNow(), snapshot.config.intel.pollingSeconds * 1_000);
  }

  public async collectNow(sourceId?: string): Promise<readonly IntelCollectionResult[]> {
    if (this.polling) return [];
    const snapshot = this.requireSnapshot();
    if (!snapshot.config.intel.enabled) return [];
    this.polling = true;
    try {
      const sources = snapshot.config.intel.sources
        .map((id) => snapshot.config.sources.find((source) => source.id === id))
        .filter((source): source is SourceConfig => source?.enabled === true)
        .filter((source) => !sourceId || source.id === sourceId);
      const results = await Promise.all(sources.map((source) => this.collectSource(source, snapshot)));
      this.lastPollAt = new Date().toISOString();
      return results;
    } finally {
      this.polling = false;
    }
  }

  public async status(): Promise<IntelStatus> {
    const snapshot = this.requireSnapshot();
    const configuredSources = snapshot.config.intel.sources.length;
    const enabledSources = snapshot.config.intel.sources.filter((id) =>
      snapshot.config.sources.find((source) => source.id === id)?.enabled === true).length;
    return {
      state: this.running ? "running" : "stopped",
      generation: snapshot.generation,
      lastPollAt: this.lastPollAt,
      polling: this.polling,
      configuredSources,
      enabledSources,
      llm: await this.llm.status(),
    };
  }

  public providerAuthConfigured(providerId: string): boolean {
    return this.llm.providerAuthConfigured(providerId);
  }

  public listModels(providerId: string, signal?: AbortSignal) {
    return this.llm.listModels(providerId, signal);
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async reclassifyRuleItems(snapshot: ConfigSnapshot): Promise<void> {
    const items = await this.storage.getNews(undefined, 1_000, true);
    for (const item of items) {
      if (item.enrichment.providerId !== null) continue;
      const rules = tagNewsByRules(item.title, item.contentText, snapshot.config.instruments, item.sourceId);
      const tags = [...new Set([
        ...rules.tags,
        ...item.tags.filter((tag) => tag.startsWith("publisher:")),
      ])];
      const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);
      if (item.summary === rules.summary && item.sentiment === rules.sentiment && item.importance === rules.importance
        && sameSet(item.tags, tags) && sameSet(item.instrumentIds, rules.instrumentIds)
        && item.enrichment.promptVersion === "rule-excerpt-v1") continue;
      await this.storage.writeNews({
        item: NewsItemSchema.parse({
          ...item,
          summary: rules.summary,
          instrumentIds: rules.instrumentIds,
          tags,
          sentiment: rules.sentiment,
          importance: rules.importance,
          enrichment: {
            providerId: null,
            model: null,
            promptVersion: "rule-excerpt-v1",
            completedAt: new Date().toISOString(),
          },
        }),
        associations: rules.instrumentIds.map((instrumentId) => ({ instrumentId, method: "rule", confidence: "1" })),
        provenance: {
          sourceId: item.sourceId,
          url: item.url,
          title: item.title,
          contentHash: item.contentHash,
          fetchedAt: item.fetchedAt,
          rawEventId: null,
        },
      });
    }
  }

  private async collectSource(source: SourceConfig, snapshot: ConfigSnapshot): Promise<IntelCollectionResult> {
    const startedAt = Date.now();
    const requestId = `${snapshot.generation}-${source.id}-news-${startedAt}`;
    let response: RawHttpResponse | null = null;
    try {
      if (source.adapter !== "rss") throw new Error(`unsupported intel adapter: ${source.adapter}`);
      const params = source.params as unknown as RssParams;
      const profile = this.httpClient.profile(source.egressProfile);
      const conditional = this.conditionalHeaders.get(source.id);
      const headers: Record<string, string> = {};
      if (conditional?.etag) headers["if-none-match"] = conditional.etag;
      if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;
      const fetched = await this.httpClient.request({
        url: feedUrl(source, params),
        egressProfile: source.egressProfile,
        egressFallback: source.egressFallback,
        userAgent: source.userAgent,
        followRedirects: source.followRedirects,
        maxRedirects: profile.maxRedirects,
        connectTimeoutMs: profile.connectTimeoutMs,
        requestTimeoutMs: profile.requestTimeoutMs,
        headers,
      });
      if (!fetched.ok) throw sourceFailure(source.id, requestId, fetched.error.kind, fetched.error.message, fetched.error.code);
      response = fetched.value;
      if (response.status === 304) {
        await this.recordHealth(source.id, startedAt, null, response.clockSkewMs, response.egressProfileUsed);
        return { sourceId: source.id, ok: true, fetched: 0, inserted: 0, duplicates: 0, notModified: true };
      }
      if (response.status < 200 || response.status >= 300) {
        const kind = response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "auth" : "http";
        throw sourceFailure(source.id, requestId, kind, `HTTP ${response.status}`, `HTTP_${response.status}`, response.status);
      }
      this.conditionalHeaders.set(source.id, {
        etag: response.headers.etag ?? null,
        lastModified: response.headers["last-modified"] ?? null,
      });
      const rawEventId = await this.storage.appendRawEvent({
        sourceId: source.id,
        instrumentId: null,
        capability: "news",
        requestId,
        capturedAt: null,
        receivedAt: response.receivedAt,
        httpStatus: response.status,
        contentType: response.headers["content-type"] ?? null,
        body: response.body,
        rawJson: null,
        parseStatus: "fetched",
        egressProfileUsed: response.egressProfileUsed,
      });
      const parsed = parseSyndicationFeed(new TextDecoder().decode(response.body), response.url);
      const entries = [...parsed.entries]
        .sort((left, right) => timestampValue(left.publishedAt) - timestampValue(right.publishedAt))
        .slice(-params.maxItems);
      const existing = await this.storage.getNews(undefined, 500, true);
      let inserted = 0;
      let duplicates = 0;
      for (const entry of entries) {
        const result = await this.processEntry(entry, source, params, response.receivedAt, rawEventId, snapshot, existing);
        if (result.inserted && result.item.duplicateOf === null) {
          inserted += 1;
          this.onNews(result.item, snapshot.generation);
        } else {
          duplicates += 1;
        }
        if (result.inserted) existing.unshift(result.item);
      }
      await this.recordHealth(source.id, startedAt, null, response.clockSkewMs, response.egressProfileUsed);
      return { sourceId: source.id, ok: true, fetched: entries.length, inserted, duplicates, notModified: false };
    } catch (error) {
      const sourceError = isSourceError(error)
        ? error
        : sourceFailure(source.id, requestId, "parse", error instanceof Error ? error.message : String(error), "INTEL_PIPELINE_ERROR");
      await this.recordHealth(source.id, startedAt, sourceError, response?.clockSkewMs ?? null, response?.egressProfileUsed ?? null);
      return { sourceId: source.id, ok: false, fetched: 0, inserted: 0, duplicates: 0, notModified: false, error: sourceError };
    }
  }

  private async processEntry(
    entry: FeedEntry,
    source: SourceConfig,
    params: RssParams,
    fetchedAt: string,
    rawEventId: number,
    snapshot: ConfigSnapshot,
    existing: readonly NewsItem[],
  ) {
    const canonicalUrl = canonicalizeNewsUrl(entry.url, snapshot.config.intel.dedup.canonicalizeTrackingParams);
    const contentText = entry.contentText?.slice(0, 20_000) ?? null;
    const contentHash = newsContentHash(entry.title, contentText);
    const rules = tagNewsByRules(entry.title, contentText, snapshot.config.instruments, source.id);
    const duplicate = findDuplicateNews(
      { canonicalUrl, contentHash, title: entry.title, contentText },
      existing,
      snapshot.config.intel.dedup,
    );
    let item = NewsItemSchema.parse({
      id: newsId(canonicalUrl, contentHash),
      sourceId: source.id,
      url: entry.url,
      canonicalUrl,
      title: entry.title,
      contentText,
      summary: rules.summary,
      language: params.language,
      publishedAt: entry.publishedAt,
      fetchedAt,
      instrumentIds: rules.instrumentIds,
      tags: entry.publisher ? [...rules.tags, `publisher:${entry.publisher}`] : rules.tags,
      sentiment: rules.sentiment,
      importance: rules.importance,
      contentHash,
      duplicateOf: duplicate?.id ?? null,
      enrichment: {
        providerId: null,
        model: null,
        promptVersion: "rule-excerpt-v1",
        completedAt: fetchedAt,
      },
    });
    let method: "rule" | "llm" = "rule";
    let confidence = "1";
    if (!duplicate && rules.instrumentIds.length === 0) {
      const enrichment = await this.llm.enrich(item, snapshot.config.instruments.map((instrument) => instrument.id));
      if (enrichment.kind === "enriched") {
        item = NewsItemSchema.parse({
          ...item,
          summary: enrichment.enrichment.summary,
          instrumentIds: enrichment.enrichment.instrumentIds,
          tags: [...new Set([...item.tags, ...enrichment.enrichment.tags])],
          sentiment: enrichment.enrichment.sentiment,
          importance: enrichment.enrichment.importance,
          enrichment: {
            providerId: enrichment.providerId,
            model: enrichment.model,
            promptVersion: "news-enrichment-v1",
            completedAt: enrichment.completedAt,
          },
        });
        method = "llm";
        confidence = String(enrichment.enrichment.confidence);
      }
    }
    return this.storage.writeNews({
      item,
      associations: item.instrumentIds.map((instrumentId) => ({ instrumentId, method, confidence })),
      provenance: {
        sourceId: source.id,
        url: entry.url,
        title: entry.title,
        contentHash,
        fetchedAt,
        rawEventId,
      },
    });
  }

  private async recordHealth(
    sourceId: string,
    startedAt: number,
    error: SourceError | null,
    clockSkewMs: number | null,
    egressProfileUsed: SourceHealthInput["egressProfileUsed"] = null,
  ): Promise<void> {
    const observedAt = new Date().toISOString();
    if (!error) this.lastSuccessAt.set(sourceId, observedAt);
    const input: SourceHealthInput = {
      sourceId,
      capability: "news",
      observedAt,
      status: error ? "down" : "healthy",
      successRate: error ? "0" : "1",
      p50LatencyMs: Date.now() - startedAt,
      p95LatencyMs: Date.now() - startedAt,
      quotaUsed: null,
      circuitState: "closed",
      lastSuccessAt: this.lastSuccessAt.get(sourceId) ?? null,
      lastError: error,
      clockSkewMedianMs: clockSkewMs,
      clockSkewStatus: clockSkewMs !== null && Math.abs(clockSkewMs) > (this.snapshot?.config.clockSkewToleranceMs ?? 2_000)
        ? "suspected"
        : clockSkewMs === null ? "unknown" : "normal",
      clockSkewToleranceMs: this.snapshot?.config.clockSkewToleranceMs ?? 2_000,
      egressProfileUsed,
    };
    await this.storage.recordSourceHealth(input);
  }

  private requireSnapshot(): ConfigSnapshot {
    if (!this.snapshot) throw new Error("intel scheduler has no configuration snapshot");
    return this.snapshot;
  }
}

function feedUrl(source: SourceConfig, params: RssParams): string {
  const url = new URL(source.baseUrl);
  if (params.query) url.searchParams.set("q", params.query);
  if (url.hostname === "news.google.com") {
    url.searchParams.set("hl", params.language);
    if (params.region) {
      url.searchParams.set("gl", params.region);
      url.searchParams.set("ceid", `${params.region}:${params.language.split("-")[0] ?? "en"}`);
    }
  }
  return url.toString();
}

function newsId(canonicalUrl: string, contentHash: string): string {
  return `news-${createHash("sha256").update(canonicalUrl).update("\n").update(contentHash).digest("hex").slice(0, 32)}`;
}

function timestampValue(value: string | null): number {
  if (!value) return 0;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function sourceFailure(
  sourceId: string,
  requestId: string,
  kind: SourceError["kind"],
  message: string,
  causeCode: string | null,
  httpStatus: number | null = null,
): SourceError {
  return SourceErrorSchema.parse({
    kind,
    sourceId,
    capability: "news",
    message,
    httpStatus,
    retryable: kind === "network" || kind === "timeout" || kind === "rate_limited" || (httpStatus !== null && httpStatus >= 500),
    retryAfterSeconds: null,
    requestId,
    observedAt: new Date().toISOString(),
    causeCode,
  });
}

function isSourceError(value: unknown): value is SourceError {
  return SourceErrorSchema.safeParse(value).success;
}
