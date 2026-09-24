import { useCallback, useEffect, useState } from "react";

export function entryModule(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/"]')?.getAttribute("src") ?? null;
}

/** Keep long-open tabs informed without discarding an unfinished journal form. */
export function useWebUpdate() {
  const [available, setAvailable] = useState(false);
  const check = useCallback(async () => {
    const current = document.querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/"]')?.getAttribute("src");
    if (!current) return false; // Vite development entry points are not versioned.
    try {
      const response = await fetch(`/index.html?version-check=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) return false;
      const latest = entryModule(await response.text());
      const changed = latest !== null && latest !== current;
      if (changed) setAvailable(true);
      return changed;
    } catch { return false; }
  }, []);
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    const timer = window.setInterval(onFocus, 60000);
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [check]);
  return { available, check };
}
