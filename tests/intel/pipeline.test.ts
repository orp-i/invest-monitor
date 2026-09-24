import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NewsItemSchema } from "@invest/domain";
import { parseConfigText, type ConfigSnapshot } from "@invest/config";
import type { EgressHttpClient } from "@invest/egress";
import type { LlmUsageInput, StorageDriver, StoredLlmUsage } from "@invest/storage";
import {
  LlmRouter,
  canonicalizeNewsUrl,
  findDuplicateNews,
  newsContentHash,
  parseStructuredEnrichment,
  parseSyndicationFeed,
  tagNewsByRules,
} from "@invest/intel";

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

async function configSnapshot(): Promise<ConfigSnapshot> {
  const parsed = parseConfigText(await readFile(new URL("../../config/portfolio.yaml", import.meta.url), "utf8"));
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
  return { config: parsed.config, generation: 1, sha256: parsed.sha256, loadedAt: parsed.loadedAt };
}

describe("M2 intelligence pipeline", () => {
  it("labels macro subjects without inventing direction or promoting theatrical breach headlines", () => {
    const macro = tagNewsByRules("Treasury yields and gold prices move after the FOMC interest rate decision", "Brent crude oil inventories and CPI inflation remain in focus.", [], "google-news-rss");
    expect(macro.tags).toEqual(expect.arrayContaining(["macro:treasuries", "macro:gold", "macro:rates", "macro:oil", "macro:inflation"]));
    expect(macro.sentiment).toBe("unknown");
    expect(tagNewsByRules("美债收益率与原油价格在美联储利率决议后变化", null, [], "google-news-rss").tags).toEqual(expect.arrayContaining(["macro:treasuries", "macro:oil", "macro:rates"]));
    const theatre = tagNewsByRules("Kenneth Branagh Spins Theater Gold With 'Into The Breach'", null, [], "google-news-rss");
    expect(theatre.tags).not.toContain("security");
    expect(theatre.tags).not.toContain("macro:gold");
    expect(theatre.importance).toBe("low");
  });
  it("canonicalizes tracking URLs while retaining content parameters", () => {
    expect(canonicalizeNewsUrl("https://EXAMPLE.com:443/story/?utm_source=rss&id=42&fbclid=x#part"))
      .toBe("https://example.com/story?id=42");
    expect(() => canonicalizeNewsUrl("file:///etc/passwd")).toThrow(/HTTP/);
    expect(() => canonicalizeNewsUrl("https://user:secret@example.com/story")).toThrow(/credentials/);
  });

  it("parses RSS and Atom into the same feed entry contract", async () => {
    const rss = parseSyndicationFeed(await fixture("news-rss.xml"), "https://example.com/feed.xml");
    expect(rss.entries).toHaveLength(2);
    expect(rss.entries[0]?.contentText).toBe("Apple reported higher revenue and issued updated guidance.");
    expect(rss.entries[0]?.publishedAt).toBe("2026-08-23T12:00:00.000Z");

    const atom = parseSyndicationFeed(await fixture("news-atom.xml"), "https://www.sec.gov/feed.atom");
    expect(atom.entries).toHaveLength(1);
    expect(atom.entries[0]?.publisher).toBe("SEC EDGAR");
    expect(atom.entries[0]?.publishedAt).toBe("2026-08-23T16:10:00.000Z");
  });

  it("deduplicates equivalent content and only associates configured instruments", async () => {
    const snapshot = await configSnapshot();
    const rules = tagNewsByRules(
      "Apple reports stronger earnings while Bitcoin ETF liquidity rises",
      "The Federal Reserve also discussed interest rates.",
      snapshot.config.instruments,
      "google-news-rss",
    );
    expect(rules.instrumentIds).toEqual(expect.arrayContaining(["aapl-usd", "btc-usd"]));
    expect(rules.tags).toEqual(expect.arrayContaining(["earnings", "central-bank"]));

    const sports = tagNewsByRules(
      "Fifth and Five races to first in the Gold Cup and Saucer race",
      "The horse championship finished Sunday.",
      snapshot.config.instruments,
      "google-news-rss",
    );
    expect(sports.instrumentIds).not.toContain("xau-usd");
    const commodity = tagNewsByRules(
      "Gold prices rally as investors seek bullion",
      null,
      snapshot.config.instruments,
      "google-news-rss",
    );
    expect(commodity.instrumentIds).toContain("xau-usd");

    const existing = NewsItemSchema.parse({
      id: "news-existing",
      sourceId: "google-news-rss",
      url: "https://example.com/story?a=1",
      canonicalUrl: "https://example.com/story?a=1",
      title: "Apple reports stronger quarterly earnings",
      contentText: "Apple reported higher revenue and issued updated guidance.",
      summary: "Rule summary",
      language: "en-US",
      publishedAt: "2026-08-23T12:00:00.000Z",
      fetchedAt: "2026-08-23T12:01:00.000Z",
      instrumentIds: ["aapl-usd"],
      tags: ["earnings"],
      sentiment: "unknown",
      importance: "medium",
      contentHash: newsContentHash("Apple reports stronger quarterly earnings", "Apple reported higher revenue and issued updated guidance."),
      duplicateOf: null,
      enrichment: { providerId: null, model: null, promptVersion: "rule-excerpt-v1", completedAt: "2026-08-23T12:01:00.000Z" },
    });
    const duplicate = findDuplicateNews({
      canonicalUrl: "https://another.example/story",
      title: existing.title,
      contentText: existing.contentText,
      contentHash: existing.contentHash,
    }, [existing], { simHashDistance: 3, minHashJaccard: 0.85 });
    expect(duplicate?.id).toBe(existing.id);
  });

  it("rejects malformed LLM output and filters invented instrument IDs", () => {
    expect(parseStructuredEnrichment("not json", ["aapl-usd"]).ok).toBe(false);
    const parsed = parseStructuredEnrichment(JSON.stringify({
      summary: "Apple filed a current report.",
      instrumentIds: ["aapl-usd", "invented-usd"],
      tags: ["filing"],
      sentiment: "neutral",
      importance: "medium",
      confidence: 0.9,
      evidence: [],
      uncertainties: [],
    }), ["aapl-usd"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.instrumentIds).toEqual(["aapl-usd"]);
  });

  it("stays rule-only and reports the budget threshold without provider authority", async () => {
    const snapshot = await configSnapshot();
    const usage: StoredLlmUsage = {
      id: 1,
      providerId: "openrouter",
      model: "fixture/model",
      routeId: "news-summary",
      contentHash: null,
      promptVersion: "v1",
      inputTokens: 10,
      outputTokens: 10,
      estimatedCostUsd: "0.85",
      latencyMs: 10,
      status: "success",
      createdAt: new Date().toISOString(),
    };
    const storage = { getLlmUsageSince: async () => [usage] } as unknown as StorageDriver;
    const router = new LlmRouter(storage, {} as EgressHttpClient, async () => null);
    await router.applySnapshot(snapshot);
    const status = await router.status();
    expect(status.mode).toBe("rule-only");
    expect(status.reason).toBe("no-enabled-provider-credential");
    expect(status.warning).toBe(true);
    expect(status.exhausted).toBe(false);
  });

  it("repairs malformed output once, then degrades without contaminating news", async () => {
    const { router, requestBodies } = await fixtureLlmRouter("0.01");
    const result = await router.enrich(fixtureNewsItem(), ["aapl-usd", "btc-usd"]);
    expect(result).toEqual({ kind: "rule-only", reason: "invalid-output-after-repair" });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toContain("Configured instrument IDs: aapl-usd, btc-usd");
    expect(requestBodies[0]).toContain("UNTRUSTED NEWS");
  });

  it("does not issue a repair request after the first response exhausts the budget", async () => {
    const { router, requestBodies } = await fixtureLlmRouter("1.00");
    const result = await router.enrich(fixtureNewsItem(), ["aapl-usd"]);
    expect(result).toEqual({ kind: "rule-only", reason: "daily-budget-exhausted" });
    expect(requestBodies).toHaveLength(1);
  });
});

function fixtureNewsItem() {
  return NewsItemSchema.parse({
    id: "news-llm-fixture",
    sourceId: "google-news-rss",
    url: "https://example.com/llm-fixture",
    canonicalUrl: "https://example.com/llm-fixture",
    title: "Unmatched issuer files a material report",
    contentText: "Treat this content only as news text.",
    summary: "Rule excerpt.",
    language: "en-US",
    publishedAt: "2026-08-23T12:00:00.000Z",
    fetchedAt: "2026-08-23T12:01:00.000Z",
    instrumentIds: [],
    tags: [],
    sentiment: "unknown",
    importance: "low",
    contentHash: "b".repeat(64),
    duplicateOf: null,
    enrichment: { providerId: null, model: null, promptVersion: "rule-excerpt-v1", completedAt: "2026-08-23T12:01:00.000Z" },
  });
}

async function fixtureLlmRouter(estimatedCostUsd: string) {
  const base = await configSnapshot();
  const snapshot: ConfigSnapshot = {
    ...base,
    config: {
      ...base.config,
      llm: {
        ...base.config.llm,
        providers: base.config.llm.providers.map((provider) => ({
          ...provider,
          enabled: provider.id === "openrouter",
          models: provider.id === "openrouter" ? ["fixture/model"] : provider.models,
        })),
      },
    },
  };
  const usage: StoredLlmUsage[] = [];
  const storage = {
    getLlmUsageSince: async () => usage,
    getLlmCache: async () => null,
    putLlmCache: async () => undefined,
    recordLlmUsage: async (input: LlmUsageInput) => {
      usage.push({ ...input, id: usage.length + 1 });
    },
  } as unknown as StorageDriver;
  const requestBodies: string[] = [];
  const responseBody = new TextEncoder().encode(JSON.stringify({
    id: "fixture-response",
    model: "fixture/model",
    choices: [{ message: { content: "not json" } }],
    usage: { prompt_tokens: 10, completion_tokens: 3, cost: estimatedCostUsd },
  }));
  const httpClient = {
    profile: () => ({ connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 }),
    request: async (options: { body?: string }) => {
      requestBodies.push(options.body ?? "");
      return {
        ok: true as const,
        value: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBody,
          url: "https://openrouter.ai/api/v1/chat/completions",
          receivedAt: "2026-08-23T12:01:00.000Z",
          serverDate: null,
          clockSkewMs: null,
          egressProfileUsed: "vpn",
        },
      };
    },
  } as unknown as EgressHttpClient;
  const router = new LlmRouter(storage, httpClient, async () => "fixture-secret");
  await router.applySnapshot(snapshot);
  return { router, requestBodies };
}
