import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerSnapshot } from "@invest/domain";
import type { AppConfig } from "@invest/config";
import { createStorageDriver, type StorageDriver } from "@invest/storage";
import { brokerConnections } from "../../apps/server/src/brokers.js";
import { brokerSyncs, runBrokerSync } from "../../apps/server/src/broker-status.js";
import { createPerformanceRecorder, recordPerformance, refreshPerformanceBrokers } from "../../apps/server/src/performance.js";

const connections = brokerConnections({ TRADIER_ACCESS_TOKEN: "fixture", IBKR_FLEX_TOKEN: "fixture", IBKR_FLEX_QUERY_ID: "fixture" });
const now = Date.parse("2026-09-12T04:00:00Z");
const snapshot = (broker: "tradier" | "ibkr", unrealizedPnl: string): BrokerSnapshot => ({ broker, environment: broker === "ibkr" ? "statement" : "live", accountId: broker, syncedAt: new Date(now).toISOString(), asOf: "2026-09-11", currency: "USD", equity: "1000", unrealizedPnl, sessionRealizedPnl: null, positions: [{ id: "p", symbol: broker === "ibkr" ? "BBB" : "AAA", quantity: "2", currency: "USD", costBasis: "100", marketValue: null, unrealizedPnl }], trades: [], notes: [] });
const deferred = () => { let resolve!: () => void, reject!: (reason: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("daily recording waits for both broker refreshes", () => {
  it.each(["node-sqlite", "better-sqlite3"] as const)("persists the newly fetched holdings and P&L before the sample with %s", async kind => {
    const dir = await mkdtemp(join(tmpdir(), "daily-brokers-")), storage = createStorageDriver(kind, join(dir, "test.sqlite"));
    await storage.open(); await storage.migrate();
    const calls: string[] = [], second = deferred();
    try {
      await storage.saveBrokerSnapshots([snapshot("tradier", "0"), snapshot("ibkr", "0")]);
      const refresh = async (broker: "tradier" | "ibkr") => runBrokerSync(storage, broker, async () => {
        calls.push(broker); if (broker === "ibkr") await second.promise;
        await storage.saveBrokerSnapshots([snapshot(broker, broker === "tradier" ? "11" : "22")]);
      });
      const recorder = createPerformanceRecorder({ storage, now: () => now, refreshBrokers: () => refreshPerformanceBrokers(connections, refresh), record: async slot => { calls.push("record"); await recordPerformance(storage, { sources: [], instruments: [] } as unknown as AppConfig, slot); }, onRecorded: () => { calls.push("notify"); } });
      const running = recorder.runDue();
      await vi.waitFor(() => expect(calls).toEqual(["tradier", "ibkr"]));
      expect(await storage.getPerformanceHistory()).toEqual([]);
      second.resolve(); await running;
      expect(calls).toEqual(["tradier", "ibkr", "record", "notify"]);
      expect(await storage.getPerformanceHistory()).toMatchObject([{ totalNet: "33", unrealizedNet: "33", scheduledFor: "2026-09-12T04:00:00.000Z" }]);
      expect((await storage.getBrokerSnapshots()).every(a => a.positions[0]!.quantity === "2")).toBe(true);
      await recorder.runDue(); await createPerformanceRecorder({ storage, now: () => now, refreshBrokers: () => refreshPerformanceBrokers(connections, refresh), record: vi.fn(), onRecorded: vi.fn() }).runDue();
      expect(calls).toHaveLength(4); // Same slot and restart do not re-fetch/re-record.
    } finally { second.resolve(); await storage.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it.each(["tradier", "ibkr"] as const)("still requests both brokers after %s fails, and only records after successful retry", async failed => {
    let fail = true;
    const refresh = vi.fn(async (broker: string) => { if (fail && broker === failed) throw new Error("offline"); });
    const record = vi.fn(), notify = vi.fn();
    const recorder = createPerformanceRecorder({ storage: { getPerformanceHistory: async () => [] }, now: () => now, refreshBrokers: () => refreshPerformanceBrokers(connections, refresh), record, onRecorded: notify });
    await expect(recorder.runDue()).rejects.toThrow("日 K 等待券商同步成功");
    expect(refresh.mock.calls.map(c => c[0])).toEqual(["tradier", "ibkr"]); expect(record).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    fail = false; await recorder.runDue(); expect(record).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledTimes(1);
  });
  it("waits for the full existing sync including post-processing and avoids duplicate provider requests", async () => {
    const storage = {} as StorageDriver, network = deferred(), post = deferred(), alternate = vi.fn();
    const work = vi.fn(async () => { await network.promise; await post.promise; });
    const existing = runBrokerSync(storage, "tradier", work);
    const refresh = vi.fn((broker: "tradier" | "ibkr") => broker === "tradier" ? runBrokerSync(storage, broker, alternate) : Promise.resolve());
    const record = vi.fn(), recorder = createPerformanceRecorder({ storage: { getPerformanceHistory: async () => [] }, now: () => now, refreshBrokers: () => refreshPerformanceBrokers(connections, refresh), record, onRecorded: vi.fn() });
    const daily = recorder.runDue(); await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    network.resolve(); await Promise.resolve(); expect(record).not.toHaveBeenCalled(); expect(brokerSyncs.get(storage)?.has("tradier")).toBe(true);
    post.resolve(); await Promise.all([existing, daily]);
    expect(work).toHaveBeenCalledTimes(1); expect(alternate).not.toHaveBeenCalled(); expect(record).toHaveBeenCalledTimes(1); expect(brokerSyncs.get(storage)?.size).toBe(0);
  });
  it("propagates a shared sync failure to all waiters and releases the lock for retry", async () => {
    const storage = {} as StorageDriver, network = deferred();
    const first = runBrokerSync(storage, "ibkr", () => network.promise), second = runBrokerSync(storage, "ibkr", vi.fn());
    expect(second).toBe(first);
    const settled = Promise.allSettled([first, second]); network.reject(new Error("offline"));
    expect((await settled).map(r => r.status)).toEqual(["rejected", "rejected"]); expect(brokerSyncs.get(storage)?.size).toBe(0);
    const retry = vi.fn(async () => {}); await runBrokerSync(storage, "ibkr", retry); expect(retry).toHaveBeenCalledTimes(1);
  });
  it("keeps the configured broker working when another has no credentials", async () => {
    const refresh = vi.fn(async () => {});
    await refreshPerformanceBrokers(brokerConnections({ TRADIER_ACCESS_TOKEN: "fixture" }), refresh);
    expect(refresh.mock.calls).toEqual([["tradier"]]);
  });
});
