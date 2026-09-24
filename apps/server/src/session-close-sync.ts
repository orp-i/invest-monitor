import { newYorkTime, type MarketDaySchedule } from "@invest/domain";
import type { StorageDriver } from "@invest/storage";

// One extra Tradier read shortly before the regular-session close. Tradier only returns orders for the
// current session, so a sync just before the close captures the day's multi-leg orders (leg grouping,
// explicit open/close side, second-level fill time) before the nightly trade history arrives without them.
export interface CloseSyncPlan { date: string; closeAt: string; syncAt: string; basis: "calendar" | "weekday-default" }
export interface CloseSyncStatus { nextSyncAt: string | null; basis: CloseSyncPlan["basis"] | null; lastSyncedDate: string | null; leadMinutes: number }
export const CLOSE_SYNC_LEAD_MS = 60_000;
const DUE_WINDOW_MS = 90_000;

/** UTC instant of `hh:mm` New York wall-clock time on `date`, correct across daylight-saving changes. */
export function newYorkInstant(date: string, hhmm: string): string {
  const [year, month, day] = date.split("-").map(Number), [hour, minute] = hhmm.split(":").map(Number);
  let guess = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  for (let i = 0; i < 2; i++) {
    const ny = newYorkTime(guess);
    const [h, m] = ny.time.split(":").map(Number);
    const drift = (ny.date === date ? 0 : ny.date < date ? -1440 : 1440) + (h! * 60 + m!) - (hour! * 60 + minute!);
    if (!drift) break;
    guess -= drift * 60_000;
  }
  return new Date(guess).toISOString();
}

/** The next close-minus-lead sync at or after `nowMs`, looking ahead up to 7 New York dates. Closed days are skipped;
 * without calendar data a weekday is assumed to close at 16:00 ET. */
export function sessionCloseSyncPlan(nowMs: number, schedule: (nyDate: string) => MarketDaySchedule | undefined, leadMs = CLOSE_SYNC_LEAD_MS): CloseSyncPlan | null {
  for (let offset = 0; offset < 7; offset++) {
    const date = newYorkTime(nowMs + offset * 86_400_000).date;
    const day = schedule(date);
    let closeAt: string | null = null, basis: CloseSyncPlan["basis"] = "calendar";
    if (day) { if (day.status === "open" && day.open) closeAt = newYorkInstant(date, day.open.end); }
    else { const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); if (weekday >= 1 && weekday <= 5) { closeAt = newYorkInstant(date, "16:00"); basis = "weekday-default"; } }
    if (!closeAt) continue;
    const syncAt = new Date(Date.parse(closeAt) - leadMs).toISOString();
    if (Date.parse(syncAt) + DUE_WINDOW_MS <= nowMs) continue;
    return { date, closeAt, syncAt, basis };
  }
  return null;
}

/** True once per plan date when `nowMs` falls inside [syncAt, syncAt + window). */
export function closeSyncDue(nowMs: number, plan: CloseSyncPlan | null, lastSyncedDate: string | null): boolean {
  if (!plan || plan.date === lastSyncedDate) return false;
  const at = Date.parse(plan.syncAt);
  return nowMs >= at && nowMs < at + DUE_WINDOW_MS;
}

const statuses = new WeakMap<StorageDriver, CloseSyncStatus>();
export function setCloseSyncStatus(storage: StorageDriver, status: CloseSyncStatus): void { statuses.set(storage, status); }
export function closeSyncStatus(storage: StorageDriver): CloseSyncStatus | undefined { return statuses.get(storage); }
