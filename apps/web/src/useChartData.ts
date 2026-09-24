import { useEffect, useState } from "react";
import { getJson } from "./api";

// Small in-memory cache shared by mounted charts. No disk writes, no prefetch
// for unselected instruments, one request per endpoint even during remounts.
interface Entry { data?: unknown; expires: number; pending?: Promise<unknown> }
const cache = new Map<string, Entry>();
export function invalidateChartSource(sourceId: string, instrumentId?: string): void {
  for (const [endpoint, entry] of cache) {
    const params = new URL(endpoint, window.location.origin).searchParams;
    if (endpoint.startsWith("/api/candles?") && params.get("sourceId") === sourceId && (!instrumentId || params.get("instrumentId") === instrumentId)) entry.expires = 0;
  }
  window.dispatchEvent(new Event("invest:chart-history"));
}
function load(endpoint: string, ttl: number): Promise<unknown> {
  const saved = cache.get(endpoint);
  if (saved?.pending) return saved.pending;
  if (saved?.data && saved.expires > Date.now()) return Promise.resolve(saved.data);
  if (!saved && cache.size >= 48) {
    const oldest = [...cache].find(([, entry]) => !entry.pending);
    if (oldest) cache.delete(oldest[0]);
    else return Promise.reject(new Error("图表查询繁忙，请稍后重试。"));
  }
  const entry: Entry = saved ?? { expires: 0 };
  entry.pending = getJson(endpoint, AbortSignal.timeout(35000)).then(data => {
    entry.data = data;
    const empty = Array.isArray((data as { candles?: unknown[] })?.candles) && !(data as { candles: unknown[] }).candles.length;
    entry.expires = Date.now() + (empty ? Math.min(ttl, 5000) : ttl); return data;
  }).finally(() => { entry.pending = undefined; });
  cache.set(endpoint, entry); return entry.pending;
}
export function useChartData<T>(endpoint: string, ttl = 60000): { data: T | null; error: Error | null } {
  const [state, setState] = useState<{ endpoint: string; data: T | null; error: Error | null }>(() => ({ endpoint, data: cache.get(endpoint)?.data as T ?? null, error: null }));
  useEffect(() => {
    let alive = true, pending = false;
    setState({ endpoint, data: cache.get(endpoint)?.data as T ?? null, error: null });
    if (!endpoint) return;
    const refresh = async () => {
      if (pending || document.hidden || !endpoint) return;
      const saved = cache.get(endpoint);
      if (saved?.data && saved.expires > Date.now()) return;
      pending = true;
      try { const data = await load(endpoint, ttl) as T; if (alive) setState({ endpoint, data, error: null }); }
      catch (error) { if (alive) setState(current => ({ ...current, error: error instanceof Error ? error : new Error(String(error)) })); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), ttl > 60000 ? 60000 : 5000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("invest:chart-history", refresh);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("invest:chart-history", refresh); };
  }, [endpoint, ttl]);
  return state.endpoint === endpoint ? state : { data: cache.get(endpoint)?.data as T ?? null, error: null };
}
