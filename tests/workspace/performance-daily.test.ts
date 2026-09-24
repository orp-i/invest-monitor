import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyPerformanceCandles, performanceSchedule, sessionSampleSlots, type PerformanceSample } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { createPerformanceRecorder } from "../../apps/server/src/performance.js";

const sample = (capturedAt: string, totalNet: string, extra: Partial<PerformanceSample> = {}): PerformanceSample => ({ capturedAt, totalNet, unrealizedNet: totalNet, realizedNet: "0", fees: "0", complete: true, basis: "a", ...extra });
describe("twice-daily profit history", () => {
  it.each([
    // Friday 11:59:59 ET: the 11:30 ET session sample is the latest slot; 12:00 ET coincides with Beijing midnight.
    ["2026-09-11T15:59:59Z", "2026-09-11T15:30:00.000Z", "session", "2026-09-11T16:00:00.000Z"],
    ["2026-09-11T16:00:00Z", "2026-09-11T16:00:00.000Z", "half-day", "2026-09-11T16:30:00.000Z"],
    // Friday 23:59:59 ET: the pre-close 15:59 ET sample was the last one; Saturday has no session, so Beijing noon follows.
    ["2026-09-12T03:59:59Z", "2026-09-11T19:59:00.000Z", "session", "2026-09-12T04:00:00.000Z"],
    ["2026-09-12T04:00:00Z", "2026-09-12T04:00:00.000Z", "half-day", "2026-09-12T16:00:00.000Z"],
    ["2026-12-31T16:00:00Z", "2026-12-31T16:00:00.000Z", "half-day", "2026-12-31T16:30:00.000Z"],
  ])("combines Beijing noon/midnight with US session samples at %s", (now, latestSlotAt, latestSlotKind, nextUpdateAt) => {
    expect(performanceSchedule(Date.parse(now))).toMatchObject({ timeZone: "Asia/Shanghai", hours: [0, 12], latestSlotAt, latestSlotKind, nextUpdateAt, candleTimeZone: "America/New_York", session: { everyMinutes: 30, preCloseMinutes: 1 } });
  });
  it("samples every 30 minutes from the open plus one minute before the close, honouring early closes and holidays", () => {
    const friday = sessionSampleSlots(Date.parse("2026-09-11T18:00:00Z")).map(t => new Date(t).toISOString()).filter(t => t.startsWith("2026-09-11"));
    expect(friday[0]).toBe("2026-09-11T13:30:00.000Z"); expect(friday.at(-2)).toBe("2026-09-11T19:30:00.000Z"); expect(friday.at(-1)).toBe("2026-09-11T19:59:00.000Z"); expect(friday).toHaveLength(14);
    expect(sessionSampleSlots(Date.parse("2026-09-12T18:00:00Z")).filter(t => new Date(t).toISOString().startsWith("2026-09-12"))).toEqual([]);
    const calendar = (date: string) => date === "2026-11-27" ? { date, status: "open" as const, open: { start: "09:30", end: "13:00" } } : date === "2026-11-26" ? { date, status: "closed" as const } : undefined;
    const early = sessionSampleSlots(Date.parse("2026-11-27T15:00:00Z"), { sessionSchedule: calendar }).map(t => new Date(t).toISOString());
    expect(early.filter(t => t.startsWith("2026-11-26"))).toEqual([]);
    expect(early.filter(t => t.startsWith("2026-11-27"))).toEqual(["2026-11-27T14:30:00.000Z", "2026-11-27T15:00:00.000Z", "2026-11-27T15:30:00.000Z", "2026-11-27T16:00:00.000Z", "2026-11-27T16:30:00.000Z", "2026-11-27T17:00:00.000Z", "2026-11-27T17:30:00.000Z", "2026-11-27T17:59:00.000Z"]);
    expect(performanceSchedule(Date.parse("2026-11-27T17:58:30Z"), undefined, { sessionSchedule: calendar })).toMatchObject({ latestSlotAt: "2026-11-27T17:30:00.000Z", nextUpdateAt: "2026-11-27T17:59:00.000Z", latestSlotKind: "session" });
  });
  it("refreshes only the live broker for session samples and every broker for the half-day slots", async () => {
    const kinds: string[] = [], record = vi.fn(async () => {});
    const recorder = (now: string) => createPerformanceRecorder({ storage: { getPerformanceHistory: async () => [] }, now: () => Date.parse(now), refreshBrokers: async kind => { kinds.push(kind); }, record, onRecorded: vi.fn() });
    await recorder("2026-09-11T15:45:00Z").runDue(); await recorder("2026-09-12T04:30:00Z").runDue();
    expect(kinds).toEqual(["session", "half-day"]);
    expect(record.mock.calls.map(c => c[0])).toEqual(["2026-09-11T15:30:00.000Z", "2026-09-12T04:00:00.000Z"]);
  });
  it("uses local wall-clock hours across DST when another time zone is selected", () => {
    expect(performanceSchedule(Date.parse("2026-03-08T06:59:00Z"), "America/New_York")).toMatchObject({ latestSlotAt: "2026-03-08T05:00:00.000Z", nextUpdateAt: "2026-03-08T16:00:00.000Z" });
    expect(performanceSchedule(Date.parse("2026-11-01T05:59:00Z"), "America/New_York")).toMatchObject({ latestSlotAt: "2026-11-01T04:00:00.000Z", nextUpdateAt: "2026-11-01T17:00:00.000Z" });
  });
  it("aggregates old intraday observations by local day with exact negative OHLC and separate series", () => {
    const observations = [sample("2026-09-11T15:59:00Z", "-5", { unrealizedNet: "4" }), sample("2026-09-10T16:00:00Z", "-10.00000001", { unrealizedNet: "3" }), sample("2026-09-11T04:00:00Z", "-2", { unrealizedNet: "1", complete: false }), sample("2026-09-11T16:00:00Z", "-8")];
    const bars = dailyPerformanceCandles(observations);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ day: "2026-09-11", time: Date.parse("2026-09-11T00:00:00Z"), samples: 3, complete: false, totalNet: { open: "-10.00000001", high: "-2", low: "-10.00000001", close: "-5" }, unrealizedNet: { open: "3", high: "4", low: "1", close: "4" } });
    expect(bars[1]).toMatchObject({ day: "2026-09-12", samples: 1, totalNet: { open: "-8", high: "-8", low: "-8", close: "-8" } });
  });
  it("does not bridge gaps or accounting changes, even when a prior basis later returns", () => {
    const rows = [sample("2026-09-09T16:00:00Z", "999"), sample("2026-09-10T16:00:00Z", "500", { basis: "b" }), sample("2026-09-11T16:00:00Z", "-1"), sample("2026-09-13T04:00:00Z", "-2")];
    expect(dailyPerformanceCandles(rows).map(d => [d.day, d.totalNet.close])).toEqual([["2026-09-12", "-1"], ["2026-09-13", "-2"]]);
    rows[3] = sample("2026-09-11T20:00:00Z", "20", { basis: "new" });
    expect(dailyPerformanceCandles(rows)[0]).toMatchObject({ samples: 1, totalNet: { open: "20", close: "20", high: "20", low: "20" } });
  });
  it("skips in-slot legacy samples and records once at the next slot, including after restart", async () => {
    let now = Date.parse("2026-09-12T03:59:00Z");
    const saved = [sample("2026-09-12T03:55:00Z", "1")];
    const record = vi.fn(async (scheduledFor: string) => { saved.push(sample(new Date(now).toISOString(), "2", { scheduledFor })); });
    const deps = { storage: { getPerformanceHistory: vi.fn(async () => saved.slice(-1)) }, record, onRecorded: vi.fn(), now: () => now };
    const recorder = createPerformanceRecorder(deps);
    await recorder.runDue(); expect(record).not.toHaveBeenCalled();
    now = Date.parse("2026-09-12T04:00:00Z");
    await Promise.all([recorder.runDue(), recorder.runDue()]); expect(record).toHaveBeenCalledTimes(1);
    now += 5 * 60000; await recorder.runDue(); expect(record).toHaveBeenCalledTimes(1);
    await createPerformanceRecorder(deps).runDue(); expect(record).toHaveBeenCalledTimes(1);
    now = Date.parse("2026-09-12T16:00:00Z"); await recorder.runDue(); expect(record).toHaveBeenCalledTimes(2);
    expect(deps.onRecorded).toHaveBeenCalledTimes(2);
  });
  it("catches up only the latest missed slot using actual capture time, and retries a failure", async () => {
    const now = Date.parse("2026-09-15T07:30:00Z"), history = [sample("2026-09-10T01:00:00Z", "1")];
    const record = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockImplementation(async (scheduledFor: string) => { history.push(sample(new Date(now).toISOString(), "2", { scheduledFor })); });
    const onRecorded = vi.fn(), recorder = createPerformanceRecorder({ storage: { getPerformanceHistory: async () => history.slice(-1) }, now: () => now, record, onRecorded });
    await expect(recorder.runDue()).rejects.toThrow("temporary"); expect(onRecorded).not.toHaveBeenCalled();
    await recorder.runDue(); await recorder.runDue();
    expect(record).toHaveBeenCalledTimes(2); expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ scheduledFor: "2026-09-15T04:00:00.000Z", capturedAt: "2026-09-15T07:30:00.000Z" });
  });
  it("joins an in-flight recording and waits for it before closing", async () => {
    let release!: () => void;
    const record = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const recorder = createPerformanceRecorder({ storage: { getPerformanceHistory: async () => [] }, record, onRecorded: vi.fn(), now: () => Date.parse("2026-09-12T04:00:00Z") });
    const first = recorder.runDue(); await Promise.resolve();
    expect(recorder.runDue()).toBe(first);
    const closed = recorder.close(); release(); await closed; await recorder.runDue();
    expect(record).toHaveBeenCalledTimes(1);
  });
  it.each(["node-sqlite", "better-sqlite3"] as const)("persists two daily slots and legacy evidence through restart with %s", async driver => {
    const dir = await mkdtemp(join(tmpdir(), "performance-daily-")), storage = createStorageDriver(driver, join(dir, "test.sqlite"));
    await storage.open(); await storage.migrate();
    try {
      const old = sample("2026-09-11T03:55:00Z", "-4"), noon = sample("2026-09-11T04:00:02Z", "-3", { scheduledFor: "2026-09-11T04:00:00Z" }), midnight = sample("2026-09-11T16:00:01Z", "-2", { scheduledFor: "2026-09-11T16:00:00Z" });
      for (const row of [old, noon, midnight, midnight]) await storage.savePerformanceSample(row);
      await storage.close(); await storage.open();
      expect(await storage.getPerformanceHistory()).toEqual([old, noon, midnight]);
      expect(await storage.getPerformanceHistory(1)).toEqual([midnight]);
      await expect(storage.savePerformanceSample({ ...midnight, scheduledFor: "2026-09-12T04:00:00Z" })).rejects.toThrow("Invalid performance timestamp");
    } finally { await storage.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
