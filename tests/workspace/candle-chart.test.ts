import { describe, expect, it } from "vitest";
import { CandleSchema, candleChartWindow, computeFreshness } from "@invest/domain";
const candle = (index: number, close = String(index + 1), sourceId = "tradier") => {
  const at = new Date(Date.UTC(2024, 0, index + 1)).toISOString();
  return CandleSchema.parse({ instrumentId: "AAPL", sourceId, timeframe: "1d", openTime: at, closeTime: at, open: close, high: close, low: close, close, volume: null, tradeCount: null, session: "regular", quoteAsset: "USD", convertedTo: null, freshness: computeFreshness(at, at, 300, new Date(at), "eod") });
};
describe("240-bar candle window with seeded simple moving averages", () => {
  it("returns exactly 240 bars with accurate MA200 on the first visible and earliest draggable bars", () => {
    const result = candleChartWindow(Array.from({ length: 439 }, (_, i) => candle(i)).reverse());
    expect(result).toHaveLength(240);
    expect(result[0].close).toBe("200");
    expect(result[0].ma).toEqual({ 5: "198", 15: "193", 30: "185.5", 200: "100.5" });
    expect(result[160].ma[200]).toBe("260.5");
    expect(result.at(-1)!.ma[200]).toBe("339.5");
  });
  it("leaves insufficient periods empty and preserves decimal precision without future prices", () => {
    const rows = Array.from({ length: 5 }, (_, i) => candle(i, "0.1234567890123456789"));
    const result = candleChartWindow([...rows, candle(5, "9000000")]);
    expect(result[3].ma[5]).toBeNull();
    expect(result[4].ma[5]).toBe("0.1234567890123456789");
    expect(result[4].ma[15]).toBeNull();
    expect(result[4].ma[200]).toBeNull();
  });
  it("deduplicates corrected bars and keeps sources and currencies separate", () => {
    const rows = Array.from({ length: 5 }, (_, i) => candle(i, "1"));
    const other = Array.from({ length: 5 }, (_, i) => candle(i, "100", "other"));
    const result = candleChartWindow([...rows, ...other, candle(4, "6")]);
    expect(result).toHaveLength(10);
    expect(result.filter(c => c.sourceId === "tradier").at(-1)!.ma[5]).toBe("2");
    expect(result.filter(c => c.sourceId === "other").at(-1)!.ma[5]).toBe("100");
  });
});
