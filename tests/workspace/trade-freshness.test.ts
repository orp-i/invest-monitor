import { describe, expect, it } from "vitest";
import { computeTradeFreshness } from "@invest/domain";
import { effectiveStatus, freshnessLabel } from "../../apps/web/src/format.js";
describe("last-trade freshness", () => {
  const trade="2026-09-04T20:00:00.000Z", received="2026-09-05T17:00:00.000Z";
  it("does not label a confirmed last trade as delayed during a closed/illiquid session", () => {
    const value=computeTradeFreshness(trade,received,trade,120,new Date(received),"realtime",2000,"closed");
    expect(value).toMatchObject({status:"live",isStale:false,capturedAt:trade,receivedAt:received,dataLagMs:0});
    expect(effectiveStatus(value,"connected",undefined,Date.parse(received)+30000)).toBe("live");
    expect(freshnessLabel(value,"live")).toBe("休市 · 最近成交");
    expect(computeTradeFreshness(trade,received,trade,120,new Date(received),"realtime",2000,"open").status).toBe("live");
  });
  it("distinguishes actual missing trades, stopped receipts, delayed feeds and clock skew", () => {
    expect(computeTradeFreshness(trade,received,"2026-09-04T20:01:00.000Z",120,new Date(received))).toMatchObject({status:"delayed",dataLagMs:60000});
    const old=computeTradeFreshness(trade,received,trade,120,new Date(Date.parse(received)+121000));expect(old.status).toBe("stale");
    const recent=computeTradeFreshness(trade,received,trade,120,new Date(received));
    expect(effectiveStatus(recent,"connected",undefined,Date.parse(received)+121000)).toBe("stale");
    expect(effectiveStatus(recent,"disconnected",undefined,Date.parse(received))).toBe("stale");
    expect(effectiveStatus(recent,"connected","degraded",Date.parse(received))).toBe("stale");
    expect(computeTradeFreshness(received,received,received,1200,new Date(received),"delayed").status).toBe("delayed");
    const future="2026-09-05T17:05:00.000Z";
    expect(computeTradeFreshness(future,received,future,120,new Date(received)).skewSuspected).toBe(true);
  });
});
