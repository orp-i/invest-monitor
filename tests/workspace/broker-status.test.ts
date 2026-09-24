import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerConnectionStatus, BrokerSnapshot, BrokerSyncAttempt } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { describeBrokerSync } from "../../apps/server/src/broker-status.js";
import { handleRequest } from "../../apps/server/src/app.js";
import * as brokers from "../../apps/server/src/brokers.js";

const paths: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
const connection = brokers.brokerConnections({ TRADIER_ACCESS_TOKEN: "test" })[0]!;
const account: BrokerSnapshot = { broker: "tradier", environment: "live", accountId: "test", syncedAt: "2026-09-05T09:00:00Z", asOf: "2026-09-05T09:00:00Z", currency: "USD", equity: null, unrealizedPnl: null, sessionRealizedPnl: null, positions: [], trades: [], notes: [] };
const failure: BrokerSyncAttempt = { broker: "tradier", mode: "live", state: "error", startedAt: "2026-09-05T10:00:00Z", completedAt: "2026-09-05T10:01:00Z", message: "测试连接失败" };

describe("broker synchronization status", () => {
  it("distinguishes configuration, an empty successful snapshot, a later failure and a running retry", () => {
    expect(describeBrokerSync(connection, [], []).sync?.state).toBe("never");
    expect(describeBrokerSync(connection, [account], []).sync).toMatchObject({ state: "success", lastSuccessAt: account.syncedAt, accounts: 1, positions: 0, trades: 0 });
    expect(describeBrokerSync(connection, [account], [failure]).sync).toMatchObject({ state: "error", lastSuccessAt: account.syncedAt, message: failure.message, completedAt: failure.completedAt });
    expect(describeBrokerSync(connection, [account], [failure], "2026-09-05T11:00:00Z").sync?.state).toBe("running");
    expect(describeBrokerSync({ ...connection, mode: "sandbox" }, [account], [failure]).sync).toMatchObject({ state: "never", lastSuccessAt: null, accounts: 0 });
    expect(describeBrokerSync(connection, [], [{ ...failure, state: "success", message: null }]).sync).toMatchObject({ state: "success", lastSuccessAt: failure.completedAt, accounts: 0 });
  });

  it.each(["node-sqlite", "better-sqlite3"] as const)("persists the latest attempt and preserves account snapshots after reopening with %s", async kind => {
    const path = await mkdtemp(join(tmpdir(), "invest-broker-status-")); paths.push(path);
    const database = join(path, "test.sqlite");
    const storage = createStorageDriver(kind, database); await storage.open(); await storage.migrate();
    try {
      await storage.saveBrokerSnapshots([account]);
      await storage.saveBrokerSyncAttempt({ ...failure, state: "success", message: null });
      await storage.saveBrokerSyncAttempt(failure);
      await storage.saveBrokerSyncAttempt({ ...failure, mode: "sandbox" });
    } finally { await storage.close(); }
    const reopened = createStorageDriver(kind, database); await reopened.open(); await reopened.migrate();
    try {
      const attempts = await reopened.getBrokerSyncAttempts();
      expect(attempts).toHaveLength(2);
      expect(attempts.find(a => a.mode === "live")).toEqual(failure);
      expect(await reopened.getBrokerSnapshots()).toEqual([account]);
    } finally { await reopened.close(); }
  });

  it("returns real API success, running and failure states and keeps the last successful records", async () => {
    vi.stubEnv("TRADIER_ACCESS_TOKEN", "test"); vi.stubEnv("TRADIER_ENVIRONMENT", "live");
    const path = await mkdtemp(join(tmpdir(), "invest-broker-status-api-")); paths.push(path);
    const storage = createStorageDriver("node-sqlite", join(path, "test.sqlite")); await storage.open(); await storage.migrate();
    const deps = { storage, authMode: "off", authToken: null };
    const sync = vi.spyOn(brokers, "syncBroker").mockResolvedValueOnce([account]);
    const state = (body: any) => body.connections.find((c: BrokerConnectionStatus) => c.id === "tradier").sync;
    try {
      expect(state((await api("GET", "/api/brokers", deps)).body).state).toBe("never");
      const success = await api("POST", "/api/brokers/tradier/sync", deps);
      expect(success.status).toBe(200);
      expect(success.body.connection.sync).toMatchObject({ state: "success", accounts: 1, positions: 0, trades: 0 });
      let reject!: (error: Error) => void;
      sync.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
      const pending = api("POST", "/api/brokers/tradier/sync", deps);
      await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
      expect(state((await api("GET", "/api/brokers", deps)).body).state).toBe("running");
      expect((await api("POST", "/api/brokers/tradier/sync", deps)).status).toBe(409);
      reject(new Error("测试网络失败"));
      expect((await pending).status).toBe(502);
      const failed = await api("GET", "/api/brokers", deps);
      expect(state(failed.body)).toMatchObject({ state: "error", message: "测试网络失败", lastSuccessAt: account.syncedAt });
      expect(failed.body.accounts).toMatchObject([account]);
      expect(failed.body.accounts[0].computedRealizedNet).toBe("0");
      expect(await storage.getBrokerSnapshots()).toEqual([account]);
      expect(sync).toHaveBeenCalledTimes(2);
    } finally { await storage.close(); }
  });
});

async function api(method: string, url: string, deps: unknown) {
  const request = Readable.from([]) as any;
  request.method = method; request.url = url; request.headers = { "x-requested-with": "XMLHttpRequest" };
  let status = 0, text = "";
  const response = { set statusCode(value: number) { status = value; }, setHeader() {}, end(value: string) { text = value; } };
  await handleRequest(request, response as never, deps as never);
  return { status, body: JSON.parse(text) };
}
