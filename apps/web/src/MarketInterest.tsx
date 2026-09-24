import { useEffect, useRef } from "react";
import { writeJson } from "./api";

// Render only for the selected detail panel. One tab replaces its own lease;
// other tabs keep independent selections, and hidden tabs release demand.
export function MarketInterest({ instrumentId }: { instrumentId: string | null }) {
  const clientId = useRef(`tab-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  useEffect(() => {
    const announce = () => {
      const version = ++revision.current, selected = document.hidden ? null : instrumentId;
      queue.current = queue.current.then(async () => {
        if (version !== revision.current) return;
        try { await writeJson("/api/market/interest", "POST", { clientId: clientId.current, instrumentId: selected }, AbortSignal.timeout(8000)); }
        catch { /* A lost lease expires safely; the next heartbeat retries it. */ }
      });
    };
    void announce();
    const timer = instrumentId ? window.setInterval(() => { if (!document.hidden) void announce(); }, 30000) : null;
    document.addEventListener("visibilitychange", announce);
    return () => { ++revision.current; if (timer !== null) window.clearInterval(timer); document.removeEventListener("visibilitychange", announce); };
  }, [instrumentId]);
  return null;
}
