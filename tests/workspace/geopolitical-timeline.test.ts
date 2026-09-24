import { describe, expect, it } from "vitest";
import { aggregateStudyBars, filterStudyEvents, studyEventComparisonIds, studyEventMarkers, studyEventWindow, US_STUDY_INDEX_IDS, type GeoEvent, type StudyBar } from "@invest/domain";

const event = (id: string, date: string, extra: Partial<GeoEvent> = {}): GeoEvent => ({ id, title: id, date, category: "politics", region: "美国／欧洲", facts: "测试事实", mechanism: "待验证", timing: "unknown", assetIds: ["gold-futures"], sourceUrl: "https://example.org/source", updatedAt: "2026-09-06T00:00:00Z", ...extra });
const bars: StudyBar[] = ["2025-04-01", "2025-04-02", "2025-04-03", "2025-04-04", "2025-04-07", "2025-04-08", "2025-04-09", "2025-04-10", "2025-04-11"].map((date, i) => ({ date, close: 100 + i, open: 100 + i, high: 102 + i, low: 99 + i }));

describe("geopolitical timeline comparison and filtering", () => {
  it("provides five chronological index baselines without mutating recorded associations", () => {
    const e = event("test", "2025-04-02", { assetIds: ["gold-futures", "sp500"] });
    expect(studyEventComparisonIds(e)).toEqual([...US_STUDY_INDEX_IDS, "gold-futures"]);
    expect(e.assetIds).toEqual(["gold-futures", "sp500"]);
    expect(studyEventMarkers(bars, bars, [e], "nasdaq")).toHaveLength(1);
    expect(studyEventMarkers(bars, bars, [e], "xlk")).toEqual([]);
  });
  it("intersects year, type, region and case-insensitive text filters with stable date ordering", () => {
    const rows = [event("earlier", "2024-04-02"), event("tariff", "2025-04-02", { category: "tariff", facts: "ABC贸易", region: "美国／中国" }), event("war", "2025-04-03", { category: "war" })];
    expect(filterStudyEvents(rows, {}).map(e => e.id)).toEqual(["war", "tariff", "earlier"]);
    expect(filterStudyEvents(rows, { year: "2025", category: "tariff", region: " 中国 ", query: " abc " }).map(e => e.id)).toEqual(["tariff"]);
    expect(filterStudyEvents(rows, { year: "2024", query: "不存在" })).toEqual([]);
    expect(rows[0]!.id).toBe("earlier");
  });
  it("maps after-close and weekend events to the same observation date used in event windows", () => {
    const rows = [event("after-close", "2025-04-02", { timing: "after-close" }), event("weekend", "2025-04-05")];
    const markers = studyEventMarkers(bars, bars, rows, "sp500");
    expect(markers.map(m => m.responseDate)).toEqual(["2025-04-03", "2025-04-07"]);
    for (const marker of markers) expect(marker.responseDate).toBe(studyEventWindow(bars, marker.event).reactionDate);
  });
  it("never puts later events on the last candle of a scrolled historical window", () => {
    const rows = [event("visible", "2025-04-02"), event("later", "2025-04-10")];
    expect(studyEventMarkers(bars, bars, rows, "sp500", 0, 4).map(m => m.event.id)).toEqual(["visible"]);
    expect(studyEventMarkers(bars, bars, rows, "sp500", 4, 9).map(m => [m.event.id, m.i])).toEqual([["later", 3]]);
  });
  it("clips the final aggregate bucket to the chart range and leaves prior true responses outside", () => {
    const buckets = aggregateStudyBars(bars.slice(0, 4), "month");
    const rows = [event("inside", "2025-04-02"), event("outside", "2025-04-10")];
    expect(studyEventMarkers(bars, buckets, rows, "sp500", 0, 1, "2025-04-04").map(m => m.event.id)).toEqual(["inside"]);
    expect(studyEventMarkers(bars, bars.slice(4), [event("before", "2025-04-02")], "sp500")).toEqual([]);
  });
  it("retains every event sharing a weekly/monthly candle and omits unsupported gaps or future observations", () => {
    const rows = [event("first", "2025-04-02"), event("second", "2025-04-03"), event("future", "2025-04-12"), event("gap", "2025-03-01")];
    const markers = studyEventMarkers(bars, aggregateStudyBars(bars, "month"), rows, "sp500");
    expect(markers.map(m => [m.event.id, m.i])).toEqual([["first", 0], ["second", 0]]);
  });
});
