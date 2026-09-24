import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketDailyWriteSchema, marketReportToday, type MarketDailyReport, type MarketDailyContext, marketDailyExcerpt } from "@invest/domain";
import { createStorageDriver, type StorageDriver } from "@invest/storage";
import { marketDailyRequest } from "../../apps/server/src/market-daily.js";
import { handleRequest } from "../../apps/server/src/app.js";

const paths: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
const API = "/api/research/daily-reports";
const input = { date: "2026-09-10", title: "隔离测试日报", body: "隔离数据库中的原始观察", summary: "风险偏好回升，尚待验证", stance: "risk-on", drivers: "隔离事件", watch: "验证条件", sourceUrl: "https://example.org/report", assetIds: ["sp500"], status: "ready" };
const time = (value: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(value)); };
async function database(driver: "node-sqlite" | "better-sqlite3") {
  const path = await mkdtemp(join(tmpdir(), "invest-market-daily-")); paths.push(path);
  const storage = createStorageDriver(driver, join(path, "test.sqlite")); await storage.open(); await storage.migrate(); return storage;
}
const request = (storage: StorageDriver, method: string, path = "", body?: unknown) => marketDailyRequest(method, new URL(`${API}${path}`, "http://localhost"), body, storage);
const reportOf = (reply: Awaited<ReturnType<typeof request>>) => reply.body.report as MarketDailyReport;
async function context(storage: StorageDriver, query = "") { return (await request(storage, "GET", `/context?from=2026-09-01&to=2026-09-30${query}`)).body.context as MarketDailyContext; }

describe.each(["node-sqlite", "better-sqlite3"] as const)("manual market daily reports with %s", driver => {
  it("accepts historical backfill across years and keeps report date separate from actual entry time", async () => {
    time("2026-09-12T04:00:00Z"); const storage = await database(driver);
    try {
      const created = await request(storage, "POST", "", { ...input, date: "2016-03-15" }); expect(created.status).toBe(201);
      const report = reportOf(created); expect(report.date).toBe("2016-03-15"); expect(report.createdAt).toBe("2026-09-12T04:00:00.000Z");
      expect((await request(storage, "GET", "?from=2016-03-01&to=2016-03-31")).body.reports).toHaveLength(1);
      const past = (await request(storage, "GET", "/context?from=2016-03-01&to=2016-03-31&asOf=2016-03-31T12:00:00Z")).body.context as MarketDailyContext;
      expect(past.reports).toEqual([]);
      const current = (await request(storage, "GET", "/context?from=2016-03-01&to=2016-03-31")).body.context as MarketDailyContext;
      expect(current.reports[0]?.id).toBe(report.id);
    } finally { await storage.close(); }
  });

  it("starts empty, keeps versions through restart/migrate, separates draft from ready and supports archival recovery", async () => {
    time("2026-09-12T04:00:00Z"); const storage = await database(driver);
    try {
      expect((await request(storage, "GET")).body.reports).toEqual([]);
      const created = await request(storage, "POST", "", { ...input, status: "draft", body: "" }); expect(created.status).toBe(201);
      let report = reportOf(created); expect(report.revision).toBe(1); expect((await context(storage)).reports).toEqual([]);
      time("2026-09-12T04:01:00Z");
      report = reportOf(await request(storage, "PATCH", `/${report.id}`, { expectedRevision: 1, report: input }));
      expect(report.revision).toBe(2); expect(report.createdAt).toBe("2026-09-12T04:00:00.000Z");
      expect((await context(storage)).reports[0]?.citation).toBe(`market-daily:${report.id}:v2`);
      expect((await request(storage, "GET")).body.reports).toEqual([expect.not.objectContaining({ body: input.body })]);
      await storage.close(); await storage.open(); await storage.migrate(); await storage.migrate();
      expect(reportOf(await request(storage, "GET", `/${report.id}`))).toEqual(report);
      expect(reportOf(await request(storage, "GET", `/${report.id}?revision=1`)).body).toBe("");
      expect((await request(storage, "GET", `/${report.id}/revisions`)).body.revisions).toHaveLength(2);
      time("2026-09-12T04:02:00Z");
      const archived = await request(storage, "PATCH", `/${report.id}`, { expectedRevision: 2, report: { ...input, status: "archived" } }); expect(archived.status).toBe(200);
      expect((await request(storage, "GET")).body.reports).toEqual([]);
      expect((await request(storage, "GET", "?status=archived")).body.reports).toHaveLength(1);
      expect((await context(storage)).reports).toEqual([]);
      expect((await request(storage, "POST", "", input)).status).toBe(409);
      expect((await request(storage, "PATCH", `/${report.id}`, { expectedRevision: 3, report: input })).status).toBe(200);
      expect((await context(storage)).reports[0]?.revision).toBe(4);
      expect(await storage.getStudyRecords()).toEqual([]); expect(await storage.getResearchEntries()).toEqual([]);
    } finally { await storage.close(); }
  });

  it("atomically rejects duplicate dates and stale edits without losing either stored version", async () => {
    time("2026-09-12T04:00:00Z"); const storage = await database(driver);
    try {
      const createReplies = await Promise.all([request(storage, "POST", "", input), request(storage, "POST", "", { ...input, body: "并发新建" })]);
      expect(createReplies.map(reply => reply.status)).toEqual([201, 409]);
      const report = reportOf(createReplies[0]!);
      const updates = await Promise.all(["先到的修改", "后到的修改"].map(body => request(storage, "PATCH", `/${report.id}`, { expectedRevision: 1, report: { ...input, body } })));
      expect(updates.map(reply => reply.status)).toEqual([200, 409]);
      expect(reportOf(await request(storage, "GET", `/${report.id}`)).body).toBe("先到的修改");
      expect(reportOf(await request(storage, "GET", `/${report.id}?revision=1`)).body).toBe(input.body);
      expect((await request(storage, "GET", `/${report.id}/revisions`)).body.revisions).toHaveLength(2);
      expect((await request(storage, "PATCH", `/${report.id}`, { expectedRevision: 2, report: { ...input, date: "2026-09-09" } })).status).toBe(400);
    } finally { await storage.close(); }
  });

  it("constructs point-in-time context from the version actually known then, excluding late backfills and withdrawals", async () => {
    time("2026-09-10T12:00:00Z"); const storage = await database(driver);
    try {
      const original = reportOf(await request(storage, "POST", "", input));
      time("2026-09-11T12:00:00Z");
      await request(storage, "PATCH", `/${original.id}`, { expectedRevision: 1, report: { ...input, body: "后来的新判断", stance: "risk-off" } });
      await request(storage, "POST", "", { ...input, date: "2026-09-09", body: "事后补录的历史日报" });
      time("2026-09-12T12:00:00Z");
      await request(storage, "PATCH", `/${original.id}`, { expectedRevision: 2, report: { ...input, status: "draft" } });
      expect((await context(storage, "&asOf=2026-09-10T13:00:00Z")).reports).toEqual([expect.objectContaining({ revision: 1, body: input.body })]);
      const yesterday = await context(storage, "&asOf=2026-09-11T13:00:00Z");
      expect(yesterday.reports.map(report => report.date)).toEqual(["2026-09-09", "2026-09-10"]); expect(yesterday.reports[1]?.body).toBe("后来的新判断");
      expect((await context(storage)).reports.map(report => report.date)).toEqual(["2026-09-09"]);
      expect((await context(storage, "&asOf=2026-09-10T11:59:59Z")).reports).toEqual([]);
      expect((await context(storage, "&asOf=2026-09-10T20:00:00%2B08:00")).reports[0]?.revision).toBe(1);
      expect((await context(storage, "&asOf=2026-09-11T13:00:00Z&limit=1")).hasMore).toBe(true);
      expect(((await request(storage, "GET", "/context?asOf=2026-09-10T13:00:00Z")).body.context as MarketDailyContext).reports[0]?.revision).toBe(1);
      expect((await request(storage, "GET", "/context?asOf=2027-01-01T00:00:00Z")).status).toBe(400);
    } finally { await storage.close(); }
  });
});

it("validates manual inputs, real calendar dates, query limits and revision references", async () => {
  time("2026-09-12T15:59:00Z"); const storage = await database("node-sqlite");
  try {
    expect(marketReportToday(new Date("2026-09-12T16:00:00Z"))).toBe("2026-09-13");
    for (const invalid of [{ date: "2026-02-30" }, { date: "2026-09-13" }, { sourceUrl: "javascript:alert(1)" }, { assetIds: ["unknown"] }, { body: " " }, { body: "a".repeat(50001) }, { title: " " }, { status: "archived" }, { injected: "field" }]) {
      expect((await request(storage, "POST", "", { ...input, ...invalid })).status, JSON.stringify(Object.keys(invalid))).toBe(400);
    }
    expect(MarketDailyWriteSchema.safeParse({ ...input, status: "draft", body: "" }).success).toBe(true);
    const report = reportOf(await request(storage, "POST", "", input));
    for (const path of ["?from=2026-09-12&to=2026-09-01", "?limit=-1", "?limit=367", "?unknown=1", "/context?limit=32", "/context?asOf=yesterday", `/${report.id}?revision=1.5`]) expect((await request(storage, "GET", path)).status).toBe(400);
    expect((await request(storage, "GET", `/${report.id}?revision=999`)).status).toBe(404);
    expect((await request(storage, "PATCH", "/missing", { expectedRevision: 1, report: input })).status).toBe(404);
    expect((await request(storage, "PATCH", `/${report.id}`, { report: input })).status).toBe(400);
    expect((await request(storage, "DELETE", `/${report.id}`)).status).toBe(405);
    expect((await request(storage, "GET", "/missing/revisions")).status).toBe(404);
  } finally { await storage.close(); }
});

it("protects daily reports, history and inference context with existing authentication and CSRF", async () => {
  time("2026-09-12T04:00:00Z"); const storage = await database("node-sqlite");
  const deps = { storage, authMode: "off", authToken: null };
  const locked = { ...deps, authMode: "token", authToken: "isolated-test-only", sessions: { isValid: () => false } };
  try {
    for (const path of [API, `${API}/context`, `${API}/missing/revisions`, `${API}/missing?revision=1`]) expect((await api("GET", path, undefined, locked)).status).toBe(401);
    for (const method of ["POST", "PATCH"]) expect((await api(method, API, input, deps, false)).status).toBe(403);
    const created = await api("POST", API, input, deps); expect(created.status).toBe(201);
    expect((await api("GET", `${API}/context`, undefined, deps)).body.context.reports[0].id).toBe(created.body.report.id);
    const listed = (await api("GET", API, undefined, deps)).body.reports;
    expect(listed).toHaveLength(1); expect(listed[0]).not.toHaveProperty("body"); expect(listed[0].excerpt).toBe(marketDailyExcerpt(input.body));
  } finally { await storage.close(); }
});

async function api(method: string, url: string, body: unknown, deps: unknown, csrf = true) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  request.method = method; request.url = url; request.headers = csrf ? { "x-requested-with": "XMLHttpRequest" } : {};
  let status = 0, text = "";
  const response = { set statusCode(value: number) { status = value; }, setHeader() {}, end(value: string) { text = value; } };
  await handleRequest(request, response as never, deps as never); return { status, body: JSON.parse(text) };
}

it("derives a display excerpt from the user's own body text without inventing a summary", () => {
  expect(marketDailyExcerpt("  第一句。\n\n第二句   较长。 ")).toBe("第一句。 第二句 较长。");
  const long = marketDailyExcerpt(`${"甲".repeat(150)}。${"乙".repeat(100)}`, 200);
  expect(long).toBe(`${"甲".repeat(150)}。…`);
  expect(marketDailyExcerpt("丙".repeat(300), 200)).toBe(`${"丙".repeat(200)}…`);
  expect(marketDailyExcerpt("")).toBe("");
});
