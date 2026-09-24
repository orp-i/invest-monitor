import { describe, expect, it } from "vitest";
import { classifyUsTrade, newYorkTime, type MarketDaySchedule } from "@invest/domain";
const day = (date: string, close = "16:00"): MarketDaySchedule => ({ date, status: "open", premarket: { start: "04:00", end: "09:30" }, open: { start: "09:30", end: close }, postmarket: { start: close, end: "20:00" } });

describe("US execution sessions", () => {
  it("uses New York DST and actual execution time instead of the time a quote is read", () => {
    expect(classifyUsTrade("2026-09-04T13:29:59Z", day("2026-09-04")).tradeSession).toBe("pre");
    expect(classifyUsTrade("2026-09-04T13:30:00Z", day("2026-09-04")).tradeSession).toBe("regular");
    expect(classifyUsTrade("2026-01-05T14:30:00Z", day("2026-01-05")).tradeSession).toBe("regular");
    expect(classifyUsTrade("2026-01-05T13:30:00Z", day("2026-01-05")).tradeSession).toBe("pre");
    expect(classifyUsTrade("2026-09-04T20:01:00Z", day("2026-09-04")).tradeSession).toBe("post");
    expect(newYorkTime("2026-09-05T01:00:00Z")).toEqual({date:"2026-09-04",time:"21:00:00"});
    expect(classifyUsTrade("2026-09-05T01:00:00Z", day("2026-09-04"))).toMatchObject({tradeSession:"overnight",tradeSessionDate:"2026-09-04",sessionBasis:"time-window"});
    // The same afternoon quote remains regular even if received at night.
    expect(classifyUsTrade("2026-09-04T19:59:59Z", day("2026-09-04"))).toMatchObject({tradeSession:"regular",tradeSessionDate:"2026-09-04"});
  });
  it("honors early closes and leaves holidays, exact close boundaries and options unconfirmed", () => {
    expect(classifyUsTrade("2026-11-27T18:01:00Z", day("2026-11-27","13:00")).tradeSession).toBe("post");
    expect(classifyUsTrade("2026-09-04T20:00:00.292Z", day("2026-09-04")).tradeSession).toBe("unknown");
    expect(classifyUsTrade("2026-09-05T00:00:00.078Z", day("2026-09-04")).tradeSession).toBe("unknown");
    expect(classifyUsTrade("2026-09-04T20:00:59.999Z", day("2026-09-04")).tradeSession).toBe("unknown");
    expect(classifyUsTrade("2026-11-27T18:00:00Z", day("2026-11-27","13:00")).tradeSession).toBe("unknown");
    expect(classifyUsTrade("2026-09-07T15:00:00Z", {date:"2026-09-07",status:"closed"}).tradeSession).toBe("unknown");
    expect(classifyUsTrade("2026-09-04T15:00:00Z").tradeSession).toBe("unknown");
    expect(classifyUsTrade("2026-09-04T20:10:00Z",day("2026-09-04"),"option").tradeSession).toBe("unknown");
  });
});
