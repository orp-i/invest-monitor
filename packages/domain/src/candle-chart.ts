import { Decimal } from "decimal.js";
import type { Candle } from "./schemas.js";

export const CHART_BAR_LIMIT = 240;
export const CHART_VISIBLE_BARS = 80;
export const MA_PERIODS = [5, 15, 30, 200] as const;
export type MovingAverages = Record<(typeof MA_PERIODS)[number], string | null>;
export type ChartCandle = Candle & { ma: MovingAverages };

// Seed rows precede the displayed window. Never average across instruments,
// sources, currencies or intervals, and never substitute a shorter period.
export function candleChartWindow(candles: readonly Candle[], limit = CHART_BAR_LIMIT): ChartCandle[] {
  const groups = new Map<string, { rows: Candle[]; sums: Decimal[] }>();
  const unique = new Map<string, Candle>();
  for (const candle of candles) unique.set(JSON.stringify([candle.instrumentId, candle.sourceId, candle.timeframe, candle.quoteAsset, candle.openTime]), candle);
  const sorted = [...unique.values()].sort((a, b) => a.openTime.localeCompare(b.openTime));
  return sorted.map(candle => {
    const key = JSON.stringify([candle.instrumentId, candle.sourceId, candle.timeframe, candle.quoteAsset]);
    const group = groups.get(key) ?? { rows: [], sums: MA_PERIODS.map(() => new Decimal(0)) };
    groups.set(key, group); group.rows.push(candle);
    const ma = {} as MovingAverages;
    MA_PERIODS.forEach((period, i) => {
      group.sums[i] = group.sums[i].plus(candle.close);
      if (group.rows.length > period) group.sums[i] = group.sums[i].minus(group.rows[group.rows.length - period - 1].close);
      ma[period] = group.rows.length >= period ? group.sums[i].div(period).toFixed() : null;
    });
    return { ...candle, ma };
  }).slice(-Math.max(1, Math.floor(limit)));
}
