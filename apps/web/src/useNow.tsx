import { useEffect, useState } from "react";
import { formatAge } from "./format";
import type { Freshness } from "./types";

/** Local clock for leaf components that show elapsed time; keeps the app root from re-rendering every second. */
export function useNow(stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), stepMs); return () => window.clearInterval(timer); }, [stepMs]);
  return now;
}
export function LiveAge({ freshness }: { freshness: Freshness }) {
  const now = useNow(1000);
  return <>{formatAge(freshness, now)}</>;
}
export function LiveClock({ format }: { format: (nowMs: number) => string }) {
  const now = useNow(1000);
  return <>{format(now)}</>;
}
