import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchWriteSchema, type BrokerSnapshot, type ResearchEntry } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { handleRequest } from "../../apps/server/src/app.js";
import { effectiveStatus, formatMoney } from "../../apps/web/src/format.js";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
const input = { title: "利率判断", topic: "rates", facts: "待核查的测试事实", thesis: "测试判断", invalidation: "测试证伪条件", observedOn: "2026-09-04", reviewOn: "2026-09-10", sourceUrl: "https://www.federalreserve.gov/", newsIds: [], transactionIds: [] };
const account: BrokerSnapshot = { broker: "tradier", environment: "live", accountId: "A", syncedAt: "2026-09-05", asOf: "2026-09-05", currency: "USD", equity: null, unrealizedPnl: null, sessionRealizedPnl: null, positions: [], trades: [{ id: "t1", externalId: null, symbol: "GLD", side: "buy", quantity: "1", price: "100", fees: "0", currency: "USD", tradedAt: "2026-09-04", timePrecision: "day", assetType: "Equity" }], notes: [] };

describe("research persistence and broker sync", () => {
  it.each(["node-sqlite", "better-sqlite3"] as const)("preserves original thesis, concurrent review history and idempotent broker records with %s", async kind => {
    const path = await mkdtemp(join(tmpdir(), "invest-workspace-")); paths.push(path);
    const storage = createStorageDriver(kind, join(path, "test.sqlite"));
    await storage.open(); await storage.migrate();
    try {
      const entry: ResearchEntry = { ...ResearchWriteSchema.parse(input), id: "r1", createdAt: "2026-09-05", evidence: [], linkedTrades: [], reviews: [] };
      await storage.createResearchEntry(entry);
      await Promise.all([storage.appendResearchReview("r1", { outcome: "mixed", notes: "第一项新证据" }, "2026-09-06"), storage.appendResearchReview("r1", { outcome: "invalidated", notes: "第二项新证据" }, "2026-09-07")]);
      expect((await storage.getResearchEntries())[0]).toMatchObject({ thesis: input.thesis, facts: input.facts, reviews: [{ outcome: "mixed" }, { outcome: "invalidated" }] });
      expect(await storage.appendResearchReview("absent", { outcome: "pending", notes: "test" }, "2026-09-05")).toBeNull();
      await storage.saveBrokerSnapshots([account]); await storage.saveBrokerSnapshots([account]);
      expect((await storage.getBrokerSnapshots())[0]?.trades).toHaveLength(1);
      await storage.saveBrokerSnapshots([{ ...account, trades: [{ ...account.trades[0]!, id: "t2" }] }]);
      expect((await storage.getBrokerSnapshots())[0]?.trades).toHaveLength(2);
      await storage.saveBrokerSnapshots([{ ...account, environment: "sandbox", trades: [] }]);
      expect(await storage.getBrokerSnapshots()).toHaveLength(2);
      await storage.migrate();
      expect((await storage.getResearchEntries())[0]?.reviews).toHaveLength(2);
    } finally { await storage.close(); }
  });

  it("validates dates, source URLs and frozen-thesis review API with CSRF", async () => {
    const path = await mkdtemp(join(tmpdir(), "invest-research-api-")); paths.push(path);
    const storage = createStorageDriver("node-sqlite", join(path, "test.sqlite")); await storage.open(); await storage.migrate();
    const deps = { storage, authMode: "off", authToken: null };
    try {
      const locked = { ...deps, authMode: "token", authToken: "test-secret", sessions: { isValid: () => false } };
      expect((await api("GET", "/api/research", undefined, locked)).status).toBe(401);
      expect((await api("GET", "/api/brokers", undefined, locked)).status).toBe(401);
      expect((await api("POST", "/api/research", input, deps, false)).status).toBe(403);
      expect((await api("POST", "/api/research", { ...input, sourceUrl: "javascript:alert(1)" }, deps)).status).toBe(400);
      expect((await api("POST", "/api/research", { ...input, observedOn: "2026-02-30" }, deps)).status).toBe(400);
      expect((await api("POST", "/api/research", { ...input, transactionIds: ["not-found"] }, deps)).status).toBe(400);
      const created = await api("POST", "/api/research", input, deps);
      expect(created.status).toBe(201);
      const id = created.body.entry.id;
      expect((await api("POST", `/api/research/${id}/reviews`, { outcome: "confirmed", notes: "evidence", thesis: "rewrite original" }, deps)).status).toBe(400);
      expect((await api("POST", `/api/research/${id}/reviews`, { outcome: "confirmed", notes: "evidence" }, deps)).status).toBe(200);
      expect((await api("GET", "/api/research", undefined, deps)).body.entries[0].thesis).toBe(input.thesis);
      expect((await api("POST", "/api/brokers/tradier/sync", undefined, deps, false)).status).toBe(403);
    } finally { await storage.close(); }
  });
});

it("formats money without binary rounding and expires live labels on the browser clock", () => {
  expect(formatMoney("9007199254740993.125", 2)).toBe("9,007,199,254,740,993.13");
  expect(formatMoney(null)).toBe("—");
  const now = Date.now();
  const freshness = { capturedAt: new Date(now - 61_000).toISOString(), receivedAt: new Date(now).toISOString(), staleAfterSeconds: 60, isStale: false, status: "live" as const, freshnessBasis: "capturedAt" as const, clockSkewMs: 0, skewSuspected: false, clockSkewToleranceMs: 2000 };
  expect(effectiveStatus(freshness, "connected", "healthy", now)).toBe("stale");
  expect(effectiveStatus({ ...freshness, freshnessBasis: "receivedAt" }, "connected", "healthy", now)).toBe("live");
  expect(effectiveStatus({ ...freshness, status: "delayed", capturedAt: freshness.receivedAt }, "connected", "healthy", now)).toBe("delayed");
  expect(effectiveStatus({ ...freshness, status: "unavailable" }, "disconnected", "down", now)).toBe("unavailable");
});

async function api(method: string, url: string, body: unknown, deps: unknown, csrf = true) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  request.method = method; request.url = url; request.headers = csrf ? { "x-requested-with": "XMLHttpRequest" } : {};
  let status = 0, text = "";
  const response = { set statusCode(value: number) { status = value; }, setHeader() {}, end(value: string) { text = value; } };
  await handleRequest(request, response as never, deps as never);
  return { status, body: JSON.parse(text) };
}
