import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createStorageDriver, type StorageDriver } from "@invest/storage";
import { handleRequest } from "../../apps/server/src/app.js";

const source = {
  title: "来源持久化测试资料", publisher: "测试发布者", url: "https://example.org/research",
  publishedAt: "", accessedAt: "2026-09-06", evidence: "只用于临时测试数据库。", confidence: "high",
};
const cases = [
  {
    collection: "companies", changedField: "narrative",
    legacy: { sector: "technology", cohort: "established", rank: 1, symbol: "TEST", name: "测试企业", narrative: "初始叙事", watch: "验证指标", sourceUrl: source.url, asOf: "2026-09-06" },
    metadata: { sources: [source], subsector: "存储·DRAM/HBM", tags: ["半导体", "存储"], stage: "商业化扩张" },
    cleared: { sources: [], subsector: "", tags: [], stage: "" },
  },
  {
    collection: "events", changedField: "facts",
    legacy: { title: "测试事件", date: "2026-09-05", category: "supply", region: "测试地区", facts: "测试事实", mechanism: "待验证传导", sourceUrl: source.url, assetIds: ["sp500", "wti-futures"], timing: "unknown" },
    metadata: { sources: [source] },
    cleared: { sources: [] },
  },
  {
    collection: "notes", changedField: "body",
    legacy: { sector: "technology", type: "report", title: "测试行业资料", date: "2026-09-06", body: "初始摘记", sourceUrl: source.url, symbol: "TEST" },
    metadata: { sources: [source], subsector: "存储·DRAM/HBM", tags: ["存储"] },
    cleared: { sources: [], subsector: "", tags: [] },
  },
] as const;

describe.each(["node-sqlite", "better-sqlite3"] as const)("research provenance with %s", driver => {
  it.each(cases)("round-trips $collection metadata, preserves it for old clients, and permits explicit clearing", async fixture => {
    await withStorage(driver, async storage => {
      const path = `/api/research/board/${fixture.collection}`;
      const created = await api("POST", path, { ...fixture.legacy, ...fixture.metadata }, storage);
      expect(created.status).toBe(201);
      const id = created.body.record.id as string;
      expect(created.body.record).toMatchObject(fixture.metadata);

      await storage.close(); await storage.open();
      expect(await getRecord(storage, fixture.collection, id)).toMatchObject(fixture.metadata);

      const legacyEdit = { ...fixture.legacy, [fixture.changedField]: "旧客户端修改的正文" };
      const patched = await api("PATCH", `${path}/${id}`, legacyEdit, storage);
      expect(patched.status).toBe(200);
      expect(await getRecord(storage, fixture.collection, id)).toMatchObject({
        ...fixture.metadata, [fixture.changedField]: "旧客户端修改的正文",
      });

      const cleared = await api("PATCH", `${path}/${id}`, { ...legacyEdit, ...fixture.cleared }, storage);
      expect(cleared.status).toBe(200);
      await storage.close(); await storage.open();
      expect(await getRecord(storage, fixture.collection, id)).toMatchObject(fixture.cleared);
    });
  });
});

describe("research source validation at the HTTP boundary", () => {
  it.each([
    { name: "executable URL", invalid: { ...source, url: "javascript:alert(1)" } },
    { name: "empty URL", invalid: { ...source, url: "" } },
    { name: "impossible publication date", invalid: { ...source, publishedAt: "2026-02-30" } },
    { name: "impossible access date", invalid: { ...source, accessedAt: "2026-09-31" } },
  ])("rejects $name on creation and editing without changing stored records", async ({ invalid }) => {
    await withStorage("node-sqlite", async storage => {
      for (const fixture of cases) {
        const path = `/api/research/board/${fixture.collection}`;
        expect((await api("POST", path, { ...fixture.legacy, sources: [invalid] }, storage)).status).toBe(400);
        const empty = await api("GET", "/api/research/board", undefined, storage);
        expect(empty.body[fixture.collection]).toEqual([]);

        const created = await api("POST", path, { ...fixture.legacy, ...fixture.metadata }, storage);
        expect(created.status).toBe(201);
        const id = created.body.record.id as string;
        expect((await api("PATCH", `${path}/${id}`, {
          ...fixture.legacy, [fixture.changedField]: "拒绝的编辑", sources: [invalid],
        }, storage)).status).toBe(400);
        expect(await getRecord(storage, fixture.collection, id)).toEqual(created.body.record);
      }
    });
  });
});

async function withStorage(driver: "node-sqlite" | "better-sqlite3", run: (storage: StorageDriver) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "invest-provenance-"));
  const storage = createStorageDriver(driver, join(directory, "test.sqlite"));
  try {
    await storage.open(); await storage.migrate();
    await run(storage);
  } finally {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function getRecord(storage: StorageDriver, collection: string, id: string) {
  const board = await api("GET", "/api/research/board", undefined, storage);
  expect(board.status).toBe(200);
  const records = board.body[collection] as Array<{ id: string }>;
  expect(records).toHaveLength(1);
  return records.find(record => record.id === id);
}

async function api(method: string, url: string, body: unknown, storage: StorageDriver) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  request.method = method; request.url = url;
  request.headers = { "x-requested-with": "XMLHttpRequest" };
  let status = 0, text = "";
  const response = { set statusCode(value: number) { status = value; }, setHeader() {}, end(value: string) { text = value; } };
  await handleRequest(request, response as never, { storage, authMode: "off", authToken: null } as never);
  return { status, body: JSON.parse(text) };
}
