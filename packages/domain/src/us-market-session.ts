export interface MarketDaySchedule {
  date: string;
  status: "open" | "closed";
  premarket?: { start: string; end: string };
  open?: { start: string; end: string };
  postmarket?: { start: string; end: string };
}
export type TradeSession = "pre" | "regular" | "post" | "overnight" | "unknown";
const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
export function newYorkTime(at: string | number) {
  const p = Object.fromEntries(ny.formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
export function classifyUsTrade(at: string, schedule?: MarketDaySchedule, assetClass = "equity") {
  const { date, time } = newYorkTime(at);
  const result = { tradeSession: "unknown" as TradeSession, tradeSessionDate: date, sessionBasis: "unknown" as "calendar" | "time-window" | "unknown" };
  // Equity calendars cannot establish an option's exchange-specific extended
  // session (some contracts close at 16:15 or have global trading hours).
  if (assetClass !== "equity") return result;
  // Closing auctions and late-reported prints commonly carry subsecond
  // timestamps just after the nominal close. Without sale conditions the
  // first minute at either closing boundary cannot establish a new session.
  if (time.slice(0,5) === "20:00" || schedule?.open && time.slice(0,5) === schedule.open.end) return result;
  if (time >= "20:00:00" || time < "04:00:00") {
    // Classify only an actual timestamp; this does NOT assert feed coverage,
    // an open venue, or assign a clearing date without venue information.
    return { ...result, tradeSession: "overnight" as const, sessionBasis: "time-window" as const };
  }
  if (!schedule || schedule.date !== date || schedule.status !== "open" || !schedule.open) return result;
  for (const [session, range] of [["pre", schedule.premarket], ["regular", schedule.open], ["post", schedule.postmarket]] as const) {
    if (range && time >= `${range.start}:00` && time < `${range.end}:00`) return { ...result, tradeSession: session, sessionBasis: "calendar" as const };
  }
  return result;
}
