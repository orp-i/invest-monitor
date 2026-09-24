import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  FreshnessSchema,
  InstrumentSchema,
  NewsItemSchema,
  QuoteSchema,
  SourceBindingSchema,
} from "@invest/domain";
import { createStorageDriver, type StorageDriver } from "@invest/storage";

const instrument = InstrumentSchema.parse({
  id: "btc-usd",
  assetClass: "crypto",
  symbol: "BTC/USD",
  displayName: "Bitcoin",
  venue: "aggregate",
  baseAsset: "BTC",
  quoteAsset: "USD",
  contractMultiplier: "1",
  underlyingId: null,
  precision: { priceScale: 2, quantityScale: 8 },
  tags: ["crypto"],
  active: true,
  metadata: {},
});

const binding = SourceBindingSchema.parse({
  sourceId: "coingecko",
  instrumentId: "btc-usd",
  enabled: true,
  priority: 10,
  capabilities: ["quote"],
  providerSymbol: "bitcoin",
  quoteAsset: "USD",
  conversion: null,
  params: {},
  cadenceSeconds: 30,
  staleAfterSeconds: 120,
  egressProfile: "corp",
});

function quote() {
  const freshness = FreshnessSchema.parse({
    capturedAt: "2026-08-22T14:25:00.000Z",
    receivedAt: "2026-08-22T14:25:01.000Z",
    clockSkewMs: -1000,
    clockSkewToleranceMs: 2000,
    skewSuspected: false,
    freshnessBasis: "capturedAt",
    staleAfterSeconds: 120,
    isStale: false,
    status: "live",
  });
  return QuoteSchema.parse({
    instrumentId: "btc-usd",
    sourceId: "coingecko",
    providerSymbol: "bitcoin",
    price: "77009",
    bid: null,
    ask: null,
    mid: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    previousClose: null,
    volume: null,
    quoteAsset: "USD",
    convertedTo: null,
    capturedAt: freshness.capturedAt,
    receivedAt: freshness.receivedAt,
    freshness,
    quality: "indicative",
    rawRef: null,
  });
}

describe("StorageDriver switching", () => {
  it.each(["node-sqlite", "better-sqlite3"] as const)("persists quotes with %s", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "invest-storage-"));
    const path = join(directory, "quotes.sqlite");
    const driver: StorageDriver = createStorageDriver(kind, path);
    try {
      await driver.open();
      await driver.migrate();
      await driver.upsertInstrument(instrument, Date.parse("2026-08-22T14:25:01.000Z"));
      await driver.upsertSourceBinding(binding);
      await driver.appendQuotes([quote()]);
      const rows = await driver.getLatestQuotes("btc-usd");
      expect(rows).toHaveLength(1);
    expect(rows[0]?.price).toBe("77009");
    expect(rows[0]?.quoteAsset).toBe("USD");
    expect(rows[0]?.clockSkewMs).toBe(-1000);
    expect(rows[0]?.skewSuspected).toBe(false);
    expect(rows[0]?.freshnessBasis).toBe("capturedAt");
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists the actual egress on raw events and source health", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invest-egress-storage-"));
    const path = join(directory, "egress.sqlite");
    const driver = createStorageDriver("node-sqlite", path);
    try {
      await driver.open();
      await driver.migrate();
      const rawEventId = await driver.appendRawEvent({
        sourceId: "coingecko",
        instrumentId: "btc-usd",
        capability: "quote",
        requestId: "egress-storage-test",
        capturedAt: null,
        receivedAt: "2026-08-26T04:00:00.000Z",
        httpStatus: 200,
        contentType: "application/json",
        body: new TextEncoder().encode("{}"),
        rawJson: "{}",
        parseStatus: "fetched",
        egressProfileUsed: "corp",
      });
      await driver.recordSourceHealth({
        sourceId: "coingecko",
        capability: "quote",
        observedAt: "2026-08-26T04:00:01.000Z",
        status: "healthy",
        successRate: "1",
        p50LatencyMs: 12,
        p95LatencyMs: 12,
        quotaUsed: null,
        circuitState: "closed",
        lastSuccessAt: "2026-08-26T04:00:01.000Z",
        lastError: null,
        clockSkewMedianMs: null,
        clockSkewStatus: "unknown",
        clockSkewToleranceMs: 2_000,
        egressProfileUsed: "corp",
      });

      const verifier = new DatabaseSync(path);
      try {
        const raw = verifier.prepare("SELECT egress_profile_used FROM raw_events WHERE id = ?").get(rawEventId) as { egress_profile_used: string };
        expect(raw.egress_profile_used).toBe("corp");
      } finally {
        verifier.close();
      }
      expect((await driver.getLatestSourceHealth("coingecko", "quote"))[0]?.egressProfileUsed).toBe("corp");
      expect(await driver.getSourceEgressUsageSince(0)).toEqual([{
        sourceId: "coingecko",
        egressProfileUsed: "corp",
        requestCountSince: 1,
        latestObservedAtMs: Date.parse("2026-08-26T04:00:01.000Z"),
      }]);
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adds nullable egress columns without losing legacy observations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invest-egress-migration-"));
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (1, 'clock-skew-observability', 1);
      CREATE TABLE raw_events (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        instrument_id TEXT,
        capability TEXT,
        request_id TEXT NOT NULL,
        captured_at_ms INTEGER,
        received_at_ms INTEGER NOT NULL,
        http_status INTEGER,
        content_type TEXT,
        body_sha256 TEXT NOT NULL,
        raw_json TEXT,
        blob_ref TEXT,
        parse_status TEXT NOT NULL
      ) STRICT;
      INSERT INTO raw_events VALUES (1, 'legacy-source', NULL, 'news', 'legacy-request', NULL, 1, 200, NULL, 'hash', NULL, NULL, 'fetched');
      CREATE TABLE source_health (
        source_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        success_rate TEXT NOT NULL,
        p50_latency_ms INTEGER,
        p95_latency_ms INTEGER,
        quota_used TEXT,
        circuit_state TEXT NOT NULL,
        last_success_at_ms INTEGER,
        last_error_json TEXT,
        clock_skew_median_ms INTEGER,
        clock_skew_status TEXT NOT NULL,
        clock_skew_tolerance_ms INTEGER NOT NULL,
        PRIMARY KEY (source_id, capability, observed_at_ms)
      ) WITHOUT ROWID, STRICT;
      INSERT INTO source_health VALUES ('legacy-source', 'news', 1, 'healthy', '1', 1, 1, NULL, 'closed', 1, NULL, NULL, 'unknown', 2000);
    `);
    legacy.close();

    const driver = createStorageDriver("node-sqlite", path);
    try {
      await driver.open();
      await driver.migrate();
      const verifier = new DatabaseSync(path);
      try {
        expect(verifier.prepare("SELECT COUNT(*) AS count FROM raw_events").get()).toMatchObject({ count: 1 });
        expect(verifier.prepare("SELECT egress_profile_used FROM raw_events WHERE id = 1").get()).toMatchObject({ egress_profile_used: null });
        expect(verifier.prepare("SELECT egress_profile_used FROM source_health WHERE source_id = 'legacy-source'").get()).toMatchObject({ egress_profile_used: null });
        expect(verifier.prepare("SELECT name FROM schema_migrations WHERE version = 2").get()).toMatchObject({ name: "egress-observability" });
      } finally {
        verifier.close();
      }
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["node-sqlite", "better-sqlite3"] as const)("preserves deduplicated news provenance with %s", async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "invest-news-storage-"));
    const path = join(directory, "news.sqlite");
    const driver: StorageDriver = createStorageDriver(kind, path);
    try {
      await driver.open();
      await driver.migrate();
      await driver.upsertInstrument(instrument, Date.parse("2026-08-23T12:01:00.000Z"));
      const item = NewsItemSchema.parse({
        id: "news-fixture",
        sourceId: "google-news-rss",
        url: "https://example.com/story?utm_source=rss",
        canonicalUrl: "https://example.com/story",
        title: "Bitcoin market fixture",
        contentText: "Bitcoin liquidity increased.",
        summary: "Bitcoin liquidity increased.",
        language: "en-US",
        publishedAt: "2026-08-23T12:00:00.000Z",
        fetchedAt: "2026-08-23T12:01:00.000Z",
        instrumentIds: ["btc-usd"],
        tags: ["instrument:btc-usd"],
        sentiment: "unknown",
        importance: "medium",
        contentHash: "a".repeat(64),
        duplicateOf: null,
        enrichment: { providerId: null, model: null, promptVersion: "rule-excerpt-v1", completedAt: "2026-08-23T12:01:00.000Z" },
      });
      const first = await driver.writeNews({
        item,
        associations: [{ instrumentId: "btc-usd", method: "rule", confidence: "1" }],
        provenance: {
          sourceId: "google-news-rss",
          url: item.url,
          title: item.title,
          contentHash: item.contentHash,
          fetchedAt: item.fetchedAt,
          rawEventId: null,
        },
      });
      const second = await driver.writeNews({
        item: { ...item, id: "news-fixture-copy", sourceId: "coindesk-rss", url: "https://example.com/story?ref=coindesk" },
        associations: [{ instrumentId: "btc-usd", method: "rule", confidence: "1" }],
        provenance: {
          sourceId: "coindesk-rss",
          url: "https://example.com/story?ref=coindesk",
          title: item.title,
          contentHash: item.contentHash,
          fetchedAt: "2026-08-23T12:02:00.000Z",
          rawEventId: null,
        },
      });
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(await driver.getNews("btc-usd")).toHaveLength(1);
      expect(await driver.getNewsProvenance(item.id)).toHaveLength(2);

      const reclassified = await driver.writeNews({
        item: {
          ...item,
          instrumentIds: [],
          tags: [],
          importance: "low",
          summary: "No configured instrument matched.",
        },
        associations: [],
        provenance: {
          sourceId: item.sourceId,
          url: item.url,
          title: item.title,
          contentHash: item.contentHash,
          fetchedAt: item.fetchedAt,
          rawEventId: null,
        },
      });
      expect(reclassified.inserted).toBe(false);
      expect(reclassified.item.instrumentIds).toEqual([]);
      expect(reclassified.item.tags).toEqual([]);
      expect(await driver.getNews("btc-usd")).toHaveLength(0);
      expect(await driver.getNews()).toHaveLength(1);

      await driver.recordLlmUsage({
        providerId: "openrouter",
        model: "fixture/model",
        routeId: "news-summary",
        contentHash: item.contentHash,
        promptVersion: "v1",
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: "0.01",
        latencyMs: 20,
        status: "success",
        createdAt: "2026-08-23T12:03:00.000Z",
      });
      expect(await driver.getLlmUsageSince("news-summary", Date.parse("2026-08-23T00:00:00.000Z"))).toHaveLength(1);
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
