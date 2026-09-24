import { useEffect, useRef } from "react";

// Unsaved form drafts survive tab switches, reloads and web updates in this browser only.
// Nothing here is sent to the server; saving or cancelling clears the local copy.
export interface LocalDraft<T> { value: T; savedAt: string }
export function readLocalDraft<T>(key: string): LocalDraft<T> | null {
  try { const raw = localStorage.getItem(key); if (!raw) return null; const parsed = JSON.parse(raw) as LocalDraft<T>; return parsed && typeof parsed.savedAt === "string" && "value" in parsed ? parsed : null; }
  catch { return null; }
}
export function clearLocalDraft(key: string): void { try { localStorage.removeItem(key); } catch { /* Storage unavailable; nothing to clear. */ } }
export function writeLocalDraft<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify({ value, savedAt: new Date().toISOString() })); } catch { /* Quota or private mode; the form still works. */ }
}
/** Persist `value` under `key` (debounced) while `enabled`; pass null as key to pause. */
export function useLocalDraft<T>(key: string | null, value: T, enabled: boolean): void {
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!key || !enabled) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { writeLocalDraft(key, value); timer.current = null; }, 400);
    return () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
  }, [key, value, enabled]);
}
export const draftTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
