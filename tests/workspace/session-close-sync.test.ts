import { describe, expect, it } from "vitest";
import type { MarketDaySchedule } from "@invest/domain";
import { closeSyncDue, newYorkInstant, sessionCloseSyncPlan } from "../../apps/server/src/session-close-sync.js";

const day = (date: string, end = "16:00", status: "open" | "closed" = "open"): MarketDaySchedule => ({ date, status, ...(status === "open" ? { open: { start: "09:30", end } } : {}) });

describe("pre-close Tradier sync schedule", () => {
  it("converts New York wall-clock times across daylight saving", () => {
    expect(newYorkInstant("2026-09-21", "16:00")).toBe("2026-09-21T20:00:00.000Z"); // EDT
    expect(newYorkInstant("2026-11-02", "16:00")).toBe("2026-11-02T21:00:00.000Z"); // EST after the November change
    expect(newYorkInstant("2026-03-09", "09:30")).toBe("2026-03-09T13:30:00.000Z"); // EDT after the March change
  });
  it("plans one minute before the calendar close, honours early closes and skips closed days", () => {
    const calendar = new Map([["2026-09-21", day("2026-09-21")], ["2026-11-27", day("2026-11-27", "13:00")], ["2026-11-26", day("2026-11-26", "16:00", "closed")]]);
    const lookup = (d: string) => calendar.get(d);
    expect(sessionCloseSyncPlan(Date.parse("2026-09-21T12:00:00Z"), lookup)).toEqual({ date: "2026-09-21", closeAt: "2026-09-21T20:00:00.000Z", syncAt: "2026-09-21T19:59:00.000Z", basis: "calendar" });
    expect(sessionCloseSyncPlan(Date.parse("2026-11-26T12:00:00Z"), lookup)).toMatchObject({ date: "2026-11-27", syncAt: "2026-11-27T17:59:00.000Z", basis: "calendar" });
    // After today's window has passed, the plan moves to the next open day (weekday default when the calendar is missing).
    expect(sessionCloseSyncPlan(Date.parse("2026-09-21T20:30:00Z"), lookup)).toMatchObject({ date: "2026-09-22", syncAt: "2026-09-22T19:59:00.000Z", basis: "weekday-default" });
    expect(sessionCloseSyncPlan(Date.parse("2026-09-19T15:00:00Z"), () => undefined)).toMatchObject({ date: "2026-09-21", basis: "weekday-default" }); // Saturday → Monday
    expect(sessionCloseSyncPlan(Date.parse("2026-09-21T12:00:00Z"), () => day("x", "16:00", "closed"))).toBeNull();
  });
  it("is due exactly once inside the 90-second window and never twice for the same date", () => {
    const plan = sessionCloseSyncPlan(Date.parse("2026-09-21T12:00:00Z"), d => day(d))!;
    expect(closeSyncDue(Date.parse("2026-09-21T19:58:59Z"), plan, null)).toBe(false);
    expect(closeSyncDue(Date.parse("2026-09-21T19:59:00Z"), plan, null)).toBe(true);
    expect(closeSyncDue(Date.parse("2026-09-21T20:00:29Z"), plan, null)).toBe(true);
    expect(closeSyncDue(Date.parse("2026-09-21T20:00:30Z"), plan, null)).toBe(false);
    expect(closeSyncDue(Date.parse("2026-09-21T19:59:30Z"), plan, "2026-09-21")).toBe(false);
    expect(closeSyncDue(Date.parse("2026-09-21T19:59:30Z"), null, null)).toBe(false);
  });
});
