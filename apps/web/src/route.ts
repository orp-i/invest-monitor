import { useSyncExternalStore } from "react";

// Hash routes: "#/section", "#/section/sub", "#/section/sub/id". Sections change history entries;
// sub-views and selections replace the current entry so refresh and shared links restore the same view.
export interface Route { section: string; rest: string[] }
const ROUTE_EVENT = "invest:route";

export function parseRoute(hash = window.location.hash): Route {
  const [section = "", ...rest] = hash.replace(/^#\/?/, "").split("/").map(part => { try { return decodeURIComponent(part.trim()); } catch { return part.trim(); } });
  return { section, rest: rest.filter(Boolean) };
}
export function routeHash(section: string, ...rest: (string | null | undefined)[]): string {
  return `#/${[section, ...rest.filter((part): part is string => !!part)].map(encodeURIComponent).join("/")}`;
}
export function navigateRoute(section: string, ...rest: (string | null | undefined)[]): void {
  const hash = routeHash(section, ...rest);
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}
export function replaceRoute(section: string, ...rest: (string | null | undefined)[]): void {
  const hash = routeHash(section, ...rest);
  if (window.location.hash === hash) return;
  window.history.replaceState(null, "", hash);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}
function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback); window.addEventListener(ROUTE_EVENT, callback);
  return () => { window.removeEventListener("hashchange", callback); window.removeEventListener(ROUTE_EVENT, callback); };
}
const current = () => window.location.hash;
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, current, current);
  return parseRoute(hash);
}
