import { Decimal } from "decimal.js";
import type { PerformanceSample } from "./account-performance.js";

export const PERFORMANCE_TIME_ZONE = "Asia/Shanghai";
/** Daily candles follow the US trading day so the pre-close observation is that day's close. */
export const PERFORMANCE_CANDLE_TIME_ZONE = "America/New_York";
export const SESSION_SAMPLE_MINUTES = 30, SESSION_PRE_CLOSE_MINUTES = 1;
export type PerformanceSlotKind = "half-day" | "session";
export interface SessionDaySchedule { date: string; status: "open" | "closed"; open?: { start: string; end: string } }
export interface PerformanceScheduleOptions {
  /** Regular-session hours for a New York date (e.g. the Tradier calendar). Without it weekdays assume 09:30–16:00 ET. */
  sessionSchedule?: (nyDate: string) => SessionDaySchedule | undefined;
}
export interface PerformanceSchedule {
  timeZone: string; hours: readonly number[]; latestSlotAt: string; nextUpdateAt: string;
  /** Which schedule produced latestSlotAt: Beijing noon/midnight ("half-day", both brokers synced first) or a US session sample. */
  latestSlotKind: PerformanceSlotKind; candleTimeZone: string;
  session: { timeZone: string; everyMinutes: number; preCloseMinutes: number };
}
const partsAt = (time: number, timeZone: string) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).formatToParts(time).map(p => [p.type, p.value]));
const wallTime = (p: Record<string, string>) => Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
const localInstant = (wall: number, timeZone: string) => {
  let instant = wall;
  for (let i = 0; i < 3; i++) instant += wall - wallTime(partsAt(instant, timeZone));
  return instant;
};
const weekdayDefault = (date: string): SessionDaySchedule => { const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); return dow >= 1 && dow <= 5 ? { date, status: "open", open: { start: "09:30", end: "16:00" } } : { date, status: "closed" }; };
/** US regular-session sample instants (every 30 minutes from the open, plus close minus one minute) for the New York dates around `now`. */
export function sessionSampleSlots(now: number, options: PerformanceScheduleOptions = {}): number[] {
  const slots: number[] = [];
  for (const offset of [-1, 0, 1]) {
    const date = (p => `${p.year}-${p.month}-${p.day}`)(partsAt(now + offset * 86_400_000, PERFORMANCE_CANDLE_TIME_ZONE));
    const day = options.sessionSchedule?.(date) ?? weekdayDefault(date);
    if (day.status !== "open" || !day.open) continue;
    const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h! * 60 + m!; };
    const start = minutes(day.open.start), end = minutes(day.open.end);
    if (!(start < end)) continue;
    const at = (minute: number) => localInstant(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Math.floor(minute / 60), minute % 60), PERFORMANCE_CANDLE_TIME_ZONE);
    for (let m = start; m < end; m += SESSION_SAMPLE_MINUTES) slots.push(at(m));
    slots.push(at(end - SESSION_PRE_CLOSE_MINUTES));
  }
  return [...new Set(slots)].sort((a, b) => a - b);
}
export function performanceSchedule(now = Date.now(), timeZone = PERFORMANCE_TIME_ZONE, options: PerformanceScheduleOptions = {}): PerformanceSchedule {
  const p = partsAt(now, timeZone), hour = Number(p.hour) < 12 ? 0 : 12;
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour);
  const halfLatest = localInstant(wall, timeZone), halfNext = localInstant(wall + 12 * 3600000, timeZone);
  const session = sessionSampleSlots(now, options);
  const sessionLatest = session.filter(t => t <= now).at(-1), sessionNext = session.find(t => t > now);
  // A session sample that coincides with noon/midnight keeps the half-day semantics (both brokers refreshed).
  const latestSlotKind: PerformanceSlotKind = sessionLatest !== undefined && sessionLatest > halfLatest ? "session" : "half-day";
  const latestSlotAt = latestSlotKind === "session" ? sessionLatest! : halfLatest;
  const nextUpdateAt = sessionNext !== undefined && sessionNext < halfNext ? sessionNext : halfNext;
  return { timeZone, hours: [0, 12], latestSlotAt: new Date(latestSlotAt).toISOString(), nextUpdateAt: new Date(nextUpdateAt).toISOString(), latestSlotKind,
    candleTimeZone: PERFORMANCE_CANDLE_TIME_ZONE, session: { timeZone: PERFORMANCE_CANDLE_TIME_ZONE, everyMinutes: SESSION_SAMPLE_MINUTES, preCloseMinutes: SESSION_PRE_CLOSE_MINUTES } };
}
export interface PerformanceOhlc { open: string; high: string; low: string; close: string }
export interface PerformanceDailyCandle {
  day: string; time: number; totalNet: PerformanceOhlc; unrealizedNet: PerformanceOhlc;
  samples: number; firstCapturedAt: string; lastCapturedAt: string; complete: boolean; basis: string;
}
// Use only persisted observations, never an API read's live estimate. The last
// contiguous accounting scope is retained; imports/cost changes must not create
// a candle spanning unrelated bases. High/low are observed, not full-day extrema.
export function dailyPerformanceCandles(samples: readonly PerformanceSample[], timeZone = PERFORMANCE_TIME_ZONE): PerformanceDailyCandle[] {
  const ordered = [...new Map(samples.filter(s => Number.isFinite(Date.parse(s.capturedAt))).map(s => [Date.parse(s.capturedAt), s])).values()].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const basis = ordered.at(-1)?.basis;
  const cutoff = ordered.reduce((last, s, i) => s.basis !== basis ? i : last, -1);
  const days = new Map<string, PerformanceDailyCandle>();
  for (const sample of ordered.slice(cutoff + 1)) {
    const p = partsAt(Date.parse(sample.capturedAt), timeZone), day = `${p.year}-${p.month}-${p.day}`;
    const row = days.get(day);
    const initial = (value: string): PerformanceOhlc => ({ open: value, high: value, low: value, close: value });
    if (!row) days.set(day, { day, time: Date.parse(`${day}T00:00:00Z`), totalNet: initial(sample.totalNet), unrealizedNet: initial(sample.unrealizedNet), samples: 1, firstCapturedAt: sample.capturedAt, lastCapturedAt: sample.capturedAt, complete: sample.complete, basis: sample.basis });
    else {
      for (const series of ["totalNet", "unrealizedNet"] as const) {
        row[series].high = Decimal.max(row[series].high, sample[series]).toFixed();
        row[series].low = Decimal.min(row[series].low, sample[series]).toFixed();
        row[series].close = sample[series];
      }
      row.samples++; row.lastCapturedAt = sample.capturedAt; row.complete &&= sample.complete;
    }
  }
  return [...days.values()];
}
