import type { EgressHttpClient } from "@invest/egress";
import type { AdapterContext } from "../types.js";
import { computeTradeFreshness, classifyUsTrade, newYorkTime, type MarketDaySchedule } from "@invest/domain";
import { requestTradier, parseTradier } from "./adapter.js";
type State = "open" | "closed" | "premarket" | "postmarket" | "unknown";
const clocks = new WeakMap<EgressHttpClient, Map<string, { state: State; expires: number; pending?: Promise<void> }>>();
const key = (base: string, token: string | null) => JSON.stringify([base, token]);
export function tradierTradeFreshness(tradeAt: string, context: AdapterContext, assetClass: string = context.instrument.assetClass) {
  const delayed = new URL(context.source.baseUrl).hostname === "sandbox.tradier.com";
  return { ...computeTradeFreshness(tradeAt, context.now, tradeAt, delayed ? Math.max(1200, context.binding.staleAfterSeconds) : context.binding.staleAfterSeconds,
    new Date(context.now), delayed ? "delayed" : "realtime", context.clockSkewToleranceMs,
    tradierClockState(context.httpClient, context.source.baseUrl, context.authToken)),
    ...tradierTradeSession(context.httpClient, context.source.baseUrl, context.authToken, tradeAt, assetClass) };
}
interface CalendarEntry { days: Map<string, MarketDaySchedule>; expires: number; pending?: Promise<void> }
const calendars = new WeakMap<EgressHttpClient, Map<string, CalendarEntry>>();
export function tradierCalendarDay(client: EgressHttpClient, base: string, token: string | null, date: string): MarketDaySchedule | undefined {
  const entry = calendars.get(client)?.get(key(base, token) + date.slice(0, 7));
  return entry && entry.expires > Date.now() ? entry.days.get(date) : undefined;
}
export function tradierTradeSession(client: EgressHttpClient, base: string, token: string | null, at: string, assetClass: string) {
  return classifyUsTrade(at, tradierCalendarDay(client, base, token, newYorkTime(at).date), assetClass);
}
export async function refreshTradierCalendar(context: AdapterContext, date: string): Promise<void> {
  const cache = calendars.get(context.httpClient) ?? new Map<string, CalendarEntry>(); calendars.set(context.httpClient, cache);
  const id = key(context.source.baseUrl, context.authToken) + date.slice(0, 7), previous = cache.get(id);
  if (previous?.pending) return previous.pending;
  if (previous && previous.expires > Date.now()) return;
  const entry: CalendarEntry = { days: new Map(), expires: Date.now() + 30000 };
  entry.pending = (async () => {
    const response = await requestTradier(context, "markets/calendar", { month: String(Number(date.slice(5,7))), year: date.slice(0,4) }, AbortSignal.timeout(15000));
    if (!response.ok) return;
    const parsed = parseTradier(response.value, context);
    const rows = parsed.ok ? (parsed.value.calendar as { days?: { day?: unknown } } | undefined)?.days?.day : undefined;
    for (const raw of Array.isArray(rows) ? rows : rows ? [rows] : []) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as MarketDaySchedule;
      if (typeof row.date !== "string" || !row.date.startsWith(date.slice(0,7)) || !["open","closed"].includes(row.status)) continue;
      const valid = (r?: {start:string;end:string}) => !r || /^([01]\d|2[0-3]):[0-5]\d$/.test(r.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.end) && r.start < r.end;
      if (![row.premarket,row.open,row.postmarket].every(valid) || row.status === "open" && !row.open) continue;
      entry.days.set(row.date, row);
    }
    if (entry.days.size) entry.expires = Date.now() + 6 * 3600000;
  })().catch(() => {}).finally(() => { entry.pending = undefined; });
  cache.set(id, entry);
  if (cache.size > 8) for (const [k,v] of cache) { if (k !== id && !v.pending) { cache.delete(k); break; } }
  return entry.pending;
}
export function tradierClockState(client: EgressHttpClient, base: string, token: string | null): State {
  const clock = clocks.get(client)?.get(key(base, token));
  return clock && clock.expires > Date.now() ? clock.state : "unknown";
}
export async function refreshTradierClock(context: AdapterContext): Promise<void> {
  const date = newYorkTime(context.now).date;
  // One cached calendar per month/account, shared by every watched symbol.
  void refreshTradierCalendar(context, date);
  void refreshTradierCalendar(context, new Date(Date.parse(date) - 7 * 86400000).toISOString().slice(0,10));
  const cache = clocks.get(context.httpClient) ?? new Map(); clocks.set(context.httpClient, cache);
  const id = key(context.source.baseUrl, context.authToken), existing = cache.get(id);
  if (existing?.pending) return existing.pending;
  if (existing && existing.expires > Date.now() + 15000) return;
  const entry: { state: State; expires: number; pending?: Promise<void> } = { state: existing?.state ?? "unknown", expires: existing?.expires ?? 0 };
  entry.pending = (async () => {
    const response = await requestTradier(context, "markets/clock", {}, AbortSignal.timeout(15000));
    if (!response.ok) return;
    const parsed = parseTradier(response.value, context);
    const clock = parsed.ok ? parsed.value.clock as { state?: unknown } | undefined : undefined;
    if (clock && ["open","closed","premarket","postmarket"].includes(String(clock.state))) {
      entry.state = clock.state as State; entry.expires = Date.now() + 90000;
    }
  })().catch(() => {}).finally(() => { entry.pending = undefined; });
  cache.set(id,entry); return entry.pending;
}
