import { effectiveStatus } from "./format";
import type { ConnectionState, FreshnessStatus, PanelDescriptor, QuoteEnvelope, Snapshot } from "./types";

export function panelQuotes(panel: PanelDescriptor, snapshot: Snapshot): QuoteEnvelope[] {
  return snapshot.quotes.filter(row => row.instrumentId === panel.instrumentId)
    .sort((a, b) => a.priority - b.priority || a.sourceId.localeCompare(b.sourceId));
}

export function primaryQuote(panel: PanelDescriptor, snapshot: Snapshot): QuoteEnvelope | undefined {
  return panelQuotes(panel, snapshot).find(row => row.freshness.status !== "unavailable" && row.quote?.price != null);
}

export function panelStatus(panel: PanelDescriptor, snapshot: Snapshot, connection: ConnectionState, nowMs: number): FreshnessStatus {
  const marketWidgets = panel.widgets.filter(widget => widget.requiredCapabilities.length > 0);
  if (!marketWidgets.some(widget => widget.requiredCapabilities.every(cap => panel.availableCapabilities.includes(cap)))) return "unavailable";
  const rows = panelQuotes(panel, snapshot);
  return aggregateStatus(rows.map(row => effectiveStatus(row.freshness, connection, row.sourceHealth?.status, nowMs)));
}

export function aggregateStatus(statuses: FreshnessStatus[]): FreshnessStatus {
  if (!statuses.length || statuses.every(status => status === "unavailable")) return "unavailable";
  if (statuses.some(status => status === "stale" || status === "unavailable")) return "stale";
  return statuses.includes("delayed") ? "delayed" : "live";
}

export function uniqueNews<T extends { id: string; canonicalUrl: string }>(news: T[]): T[] {
  const seen = new Set<string>();
  return news.filter(item => {
    const key = item.canonicalUrl || item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
