import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseConfigText, type ConfigSnapshot } from "@invest/config";
import type { EgressHttpClient, RawHttpResponse } from "@invest/egress";
import { IntelScheduler } from "@invest/intel";
import { createStorageDriver } from "@invest/storage";

describe("IntelScheduler", () => {
  it("collects, associates, persists, emits, and deduplicates an RSS batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invest-intel-"));
    const sqlitePath = join(directory, "intel.sqlite");
    const storage = createStorageDriver("node-sqlite", sqlitePath);
    try {
      await storage.open();
      await storage.migrate();
      const configText = await readFile(new URL("../../config/portfolio.yaml", import.meta.url), "utf8");
      const parsed = parseConfigText(configText);
      if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
      const snapshot: ConfigSnapshot = {
        config: { ...parsed.config, intel: { ...parsed.config.intel, sources: ["google-news-rss"] } },
        generation: 1,
        sha256: parsed.sha256,
        loadedAt: parsed.loadedAt,
      };
      for (const instrument of snapshot.config.instruments) {
        await storage.upsertInstrument(instrument, Date.parse(snapshot.loadedAt));
      }
      const body = new TextEncoder().encode(await readFile(new URL("../fixtures/news-rss.xml", import.meta.url), "utf8"));
      const httpClient = {
        profile: () => ({ maxRedirects: 3, connectTimeoutMs: 5_000, requestTimeoutMs: 15_000 }),
        request: async (): Promise<{ ok: true; value: RawHttpResponse }> => ({
          ok: true,
          value: {
            status: 200,
            headers: { "content-type": "application/xml" },
            body,
            url: "https://news.google.com/rss/search?q=fixture",
            receivedAt: "2026-08-23T12:06:00.000Z",
            serverDate: "Sun, 23 Aug 2026 12:06:00 GMT",
            clockSkewMs: 0,
            // The configured primary is vpn; this fixture represents a request
            // that actually completed through the corp fallback.
            egressProfileUsed: "corp",
          },
        }),
      } as unknown as EgressHttpClient;
      const emitted: string[] = [];
      const scheduler = new IntelScheduler(storage, httpClient, async () => null, (item) => emitted.push(item.id));
      await scheduler.applySnapshot(snapshot);

      const first = await scheduler.collectNow();
      expect(first[0]).toMatchObject({ ok: true, fetched: 2, inserted: 2, duplicates: 0 });
      expect(emitted).toHaveLength(2);
      const verifier = new DatabaseSync(sqlitePath);
      try {
        expect(verifier.prepare("SELECT egress_profile_used FROM raw_events ORDER BY id DESC LIMIT 1").get())
          .toMatchObject({ egress_profile_used: "corp" });
      } finally {
        verifier.close();
      }
      expect(await storage.getNews("aapl-usd")).toHaveLength(1);
      expect(await storage.getNews("btc-usd")).toHaveLength(1);

      const second = await scheduler.collectNow();
      expect(second[0]).toMatchObject({ ok: true, fetched: 2, inserted: 0, duplicates: 2 });
      expect(emitted).toHaveLength(2);
      const health = await storage.getLatestSourceHealth("google-news-rss", "news");
      expect(health[0]?.status).toBe("healthy");
      expect(health[0]?.egressProfileUsed).toBe("corp");
      await scheduler.stop();
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
