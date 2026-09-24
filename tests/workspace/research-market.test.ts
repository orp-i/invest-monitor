import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateStudyBars, monthObservation, pairedStudy, seasonality, studyEventWindow, STUDY_INSTRUMENTS, type StudyBar, type StudySeries } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { parseFredStudy, parseYahooStudy, researchBoardRequest, researchSeriesRequest, researchStart, validateStudyBars } from "../../apps/server/src/research-market.js";
import { handleRequest } from "../../apps/server/src/app.js";

const paths: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true }); });
const days = (from: string, n: number, fn: (i: number) => number): StudyBar[] => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10), close: fn(i) }));
const event = { title: "测试事件", date: "2026-09-05", category: "war", region: "测试地区", facts: "仅测试库使用", mechanism: "待验证", sourceUrl: "https://example.org/event", assetIds: ["sp500"], timing: "unknown" };
const company = { sector: "technology", cohort: "established", rank: 1, symbol: "TEST", name: "测试公司", narrative: "测试叙事", watch: "测试验证指标", sourceUrl: "https://example.org/report", asOf: "2026-09-05" };

describe("review market calculations", () => {
  it("uses previous month close, excludes partial months, and reserves exactly ten complete calendar years", () => {
    const bars = [{ date: "2015-12-31", close: 100 }, ...days("2016-01-01", 31, i => 101 + i)];
    expect(monthObservation(bars, 2016, 1, "2016-02-01").value).toBeCloseTo(31);
    expect(monthObservation(bars.slice(1), 2016, 1, "2016-02-01").value).toBeNull();
    expect(monthObservation(bars, 2016, 1, "2016-01-31").value).toBeNull();
    expect(monthObservation(bars.slice(0, 20), 2016, 1, "2016-02-01").value).toBeNull();
    const matrix = seasonality(bars, "2026-09-06");
    expect(matrix).toHaveLength(10); expect(matrix[0]![0]!.year).toBe(2016); expect(matrix[9]![11]!.year).toBe(2025);
    expect(researchStart("2026-09-06")).toBe("2015-12-01");
  });
  it("aggregates true OHLC and does not manufacture candles for rates", () => {
    expect(aggregateStudyBars([{ date: "2026-08-31", open: 5, high: 7, low: 4, close: 6 }, { date: "2026-09-01", open: 6, high: 9, low: 5, close: 8 }], "week")).toEqual([{ date: "2026-08-31", open: 5, high: 9, low: 4, close: 8 }]);
    expect(aggregateStudyBars(days("2026-09-01", 3, i => 3 + i), "month")).toEqual([{ date: "2026-09-01", close: 5 }]);
  });
  it("maps weekends and after-close events, uses pre-event baseline, and leaves incomplete windows empty", () => {
    const bars = [{ date: "2026-09-03", close: 90 }, { date: "2026-09-04", close: 100 }, { date: "2026-09-08", close: 110 }, { date: "2026-09-09", close: 121 }];
    const weekend = studyEventWindow(bars, { date: "2026-09-05", timing: "unknown" });
    expect(weekend.baseDate).toBe("2026-09-04"); expect(weekend.reactionDate).toBe("2026-09-08"); expect(weekend.after[0]!.value).toBeCloseTo(10); expect(weekend.after[1]!.value).toBeNull();
    expect(studyEventWindow(bars, { date: "2026-09-08", timing: "after-close" }).after[0]!.value).toBeCloseTo(10);
    expect(studyEventWindow(bars, { date: "2026-09-03", timing: "unknown" }).baseDate).toBeNull();
    expect(studyEventWindow(bars, { date: "2026-10-01", timing: "unknown" }).after.every(p => p.value === null)).toBe(true);
    expect(studyEventWindow([{ date: "2026-09-04", close: 3 }, { date: "2026-09-08", close: 3.25 }], { date: "2026-09-05", timing: "unknown" }, true).after[0]!.value).toBe(25);
  });
  it("aligns common endpoints for price returns versus basis points and enforces correlation sample size", () => {
    const a = days("2026-01-01", 40, i => 100 + i * i), b = days("2026-01-01", 40, i => 200 + i * i * 2).filter((_, i) => i !== 10);
    const paired = pairedStudy(a, b, "2026-01-01", "2026-03-01", false);
    expect(paired.points).toHaveLength(39); expect(paired.samples).toBe(38); expect(paired.correlation).toBeCloseTo(1);
    expect(pairedStudy(a.slice(0, 5), b, "2026-01-01", "2026-03-01", false).correlation).toBeNull();
    const rate = pairedStudy(a, [{ date: "2026-01-01", close: 3 }, { date: "2026-01-02", close: 3.5 }], "2026-01-01", "2026-03-01", true);
    expect(rate.points[1]!.b).toBe(50);
  });
});

describe("research history data contracts", () => {
  it("validates provider identity, preserves negative oil, skips invalid OHLC and today, and handles FRED missing values", () => {
    const valid = validateStudyBars([{ date: "2026-09-03", open: -10, high: -5, low: -40, close: -30 }, { date: "2026-09-04", open: 10, high: 5, low: 1, close: 2 }, { date: "2026-09-06", close: 7 }], "2020-01-01", "2026-09-06", true);
    expect(valid.bars).toHaveLength(1); expect(valid.bars[0]!.close).toBe(-30); expect(valid.warnings).toHaveLength(1);
    expect(parseFredStudy("observation_date,DGS10\n2026-09-03,4.1\n2026-09-04,.\n2026-09-05,\n", "DGS10", "2020-01-01", "2026-09-06").bars).toEqual([{ date: "2026-09-03", close: 4.1 }]);
    expect(() => parseFredStudy("observation_date,DFF\n2026-09-03,4", "DGS10", "2020-01-01", "2026-09-06")).toThrow();
    expect(() => parseYahooStudy({ chart: { result: [{ meta: { symbol: "SPY" }, timestamp: [] }] } }, STUDY_INSTRUMENTS[0]!, "2020-01-01", "2026-09-06")).toThrow();
    const missing = { chart: { result: [{ meta: { symbol: "^GSPC", exchangeTimezoneName: "America/New_York" }, timestamp: [Date.parse("2026-09-05T16:00:00Z") / 1000], indicators: { quote: [{ open: [null], high: [null], low: [null], close: [null] }] } }] } };
    expect(parseYahooStudy(missing, STUDY_INSTRUMENTS[0]!, "2020-01-01", "2026-09-06")).toEqual({ bars: [], warnings: [] });
    expect(studyEventWindow([{ date: "2026-09-04", close: -20 }, { date: "2026-09-08", close: 20 }], { date: "2026-09-05", timing: "unknown" }).after[0]!.value).toBeNull();
  });
  it("coalesces requests, retains a durable cache and serves marked old data on failure with backoff", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-06T15:00:00Z"));
    let saved: StudySeries | null = null;
    const storage = { getStudySeries: async () => saved, saveStudySeries: async (s: StudySeries) => { saved = s; } } as any;
    const raw = { chart: { result: [{ meta: { symbol: "^GSPC", exchangeTimezoneName: "America/New_York" }, timestamp: [Date.parse("2026-09-04T20:00:00Z") / 1000], indicators: { quote: [{ open: [100], high: [110], low: [99], close: [105] }] } }] } };
    const request = vi.fn(async () => ({ ok: true, value: { status: 200, body: new TextEncoder().encode(JSON.stringify(raw)) } }));
    const context = { storage, httpClient: { request } as any, tradierContext: null };
    const replies = await Promise.all([researchSeriesRequest("sp500", false, context), researchSeriesRequest("sp500", false, context)]);
    expect(request).toHaveBeenCalledTimes(1); expect(replies[0]!.status).toBe(200);
    vi.setSystemTime(new Date("2026-09-06T15:02:00Z"));
    expect((await researchSeriesRequest("sp500", false, context)).status).toBe(200); expect(request).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-09-08T15:00:00Z")); request.mockRejectedValue(new Error("network"));
    const failed = await researchSeriesRequest("sp500", false, context);
    expect((failed.body.series as StudySeries).stale).toBe(true); expect((failed.body.series as StudySeries).fetchedAt).toBe("2026-09-06T15:00:00.000Z");
    await researchSeriesRequest("sp500", true, context); expect(request).toHaveBeenCalledTimes(2);
    expect((await researchSeriesRequest("https://internal.invalid", false, context)).status).toBe(400);
  });
});

describe("research board persistence and authenticated API", () => {
  it.each(["node-sqlite", "better-sqlite3"] as const)("keeps the initial board empty, edits records, enforces unique slots, and archives with %s", async driver => {
    const path = await mkdtemp(join(tmpdir(), "invest-study-")); paths.push(path);
    const storage = createStorageDriver(driver, join(path, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      expect(await storage.getStudyRecords()).toEqual([]);
      const initial = await researchBoardRequest("GET", "/api/research/board", undefined, storage); expect(initial.body).toEqual({ events: [], companies: [], notes: [] });
      const created = await researchBoardRequest("POST", "/api/research/board/events", event, storage); expect(created.status).toBe(201);
      const id = (created.body.record as { id: string }).id;
      expect((await researchBoardRequest("PATCH", `/api/research/board/events/${id}`, { ...event, title: "修正后的事件" }, storage)).status).toBe(200);
      const results = await Promise.all([researchBoardRequest("POST", "/api/research/board/companies", company, storage), researchBoardRequest("POST", "/api/research/board/companies", { ...company, symbol: "OTHER" }, storage)]);
      expect(results.map(r => r.status)).toEqual([201, 409]);
      expect((await researchBoardRequest("POST", "/api/research/board/companies", { ...company, rank: 2 }, storage)).status).toBe(409);
      expect((await researchBoardRequest("DELETE", `/api/research/board/events/${id}`, undefined, storage)).status).toBe(200);
      expect((await storage.getStudyRecords()).some(r => r.kind === "event")).toBe(false);
      await storage.migrate(); expect(await storage.getStudyRecords()).toHaveLength(1);
      const series: StudySeries = { id: "sp500", fetchedAt: "2026-09-06", from: "2026-09-04", through: "2026-09-04", source: "test", bars: [{ date: "2026-09-04", close: 100 }], warnings: [], priceBasis: "fixture" };
      await storage.saveStudySeries(series); await storage.close(); await storage.open(); expect(await storage.getStudySeries("sp500")).toEqual(series);
    } finally { await storage.close(); }
  });
  it("requires auth and CSRF for every mutation, rejects invalid dates, links, assets and missing records", async () => {
    const path = await mkdtemp(join(tmpdir(), "invest-study-api-")); paths.push(path);
    const storage = createStorageDriver("node-sqlite", join(path, "test.sqlite")); await storage.open(); await storage.migrate();
    const deps = { storage, authMode: "off", authToken: null };
    try {
      const locked = { ...deps, authMode: "token", authToken: "test-only", sessions: { isValid: () => false } };
      expect((await api("GET", "/api/research/board", undefined, locked)).status).toBe(401);
      expect((await api("GET", "/api/research/market/catalog", undefined, deps)).body.instruments).toHaveLength(STUDY_INSTRUMENTS.length);
      for (const method of ["POST", "PATCH", "DELETE"]) expect((await api(method, "/api/research/board/events/id", event, deps, false)).status).toBe(403);
      for (const invalid of [{ date: "2026-02-30" }, { sourceUrl: "javascript:alert(1)" }, { assetIds: [] }, { assetIds: ["SPY"] }, { facts: "" }]) expect((await api("POST", "/api/research/board/events", { ...event, ...invalid }, deps)).status).toBe(400);
      expect((await api("PATCH", "/api/research/board/events/absent", event, deps)).status).toBe(404);
      expect((await api("POST", "/api/research/board/events", event, deps)).status).toBe(201);
    } finally { await storage.close(); }
  });
});

async function api(method: string, url: string, body: unknown, deps: unknown, csrf = true) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  request.method = method; request.url = url; request.headers = csrf ? { "x-requested-with": "XMLHttpRequest" } : {};
  let status = 0, text = "";
  const response = { set statusCode(v: number) { status = v; }, setHeader() {}, end(v: string) { text = v; } };
  await handleRequest(request, response as never, deps as never); return { status, body: JSON.parse(text) };
}
