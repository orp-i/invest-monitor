export type FreshnessStatus = "live" | "delayed" | "stale" | "unavailable";
export type FreshnessBasis = "capturedAt" | "receivedAt";
export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface Freshness {
  capturedAt: string;
  receivedAt: string;
  staleAfterSeconds: number;
  isStale: boolean;
  status: FreshnessStatus;
  clockSkewMs: number | null;
  skewSuspected: boolean;
  freshnessBasis: FreshnessBasis;
  clockSkewToleranceMs: number;
  tradeReferenceAt?: string;
  dataLagMs?: number;
  tradeSession?: "pre" | "regular" | "post" | "overnight" | "unknown";
  tradeSessionDate?: string;
  sessionBasis?: "calendar" | "time-window" | "unknown";
  marketState?: "open" | "closed" | "premarket" | "postmarket" | "unknown";
}

export interface QuoteValue {
  instrumentId: string;
  sourceId: string;
  providerSymbol: string;
  price: string | null;
  bid: string | null;
  ask: string | null;
  mid: string | null;
  dayOpen: string | null;
  dayHigh: string | null;
  dayLow: string | null;
  previousClose: string | null;
  volume: string | null;
  quoteAsset: string;
  convertedTo: {
    currency: string;
    rate: string;
    fxSourceId: string;
    fxCapturedAt: string;
  } | null;
  capturedAt: string;
  receivedAt: string;
  freshness: Freshness;
  quality: "authoritative" | "indicative" | "derived" | "unknown";
  rawRef: string | null;
}

export interface SourceHealth {
  sourceId: string;
  capability: string;
  observedAtMs: number;
  status: string;
  successRate: string;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  quotaUsed: string | null;
  circuitState: string;
  lastSuccessAtMs: number | null;
  lastErrorJson: string | null;
  clockSkewMedianMs: number | null;
  clockSkewStatus: "unknown" | "normal" | "suspected";
  clockSkewToleranceMs: number;
  egressProfileUsed: "direct" | "corp" | "vpn" | null;
}

export interface SourceEgressStatus {
  sourceId: string;
  configuredPrimaryEgress: "direct" | "corp" | "vpn";
  latestActualEgress: "direct" | "corp" | "vpn" | null;
  fallbackCount1h: number;
}

export interface QuoteEnvelope {
  instrumentId: string;
  sourceId: string;
  providerSymbol: string;
  quoteAsset: string;
  priority: number;
  egressProfile: string;
  quote: QuoteValue | null;
  freshness: Freshness;
  sourceHealth: SourceHealth | null;
}

export interface StoredQuoteRow {
  id: number;
  instrumentId: string;
  sourceId: string;
  providerSymbol: string;
  capturedAtMs: number;
  receivedAtMs: number;
  price: string | null;
  quoteAsset: string;
  quality: string;
  freshnessStatus: FreshnessStatus;
}

export interface Candle {
  instrumentId: string;
  sourceId: string;
  timeframe: string;
  openTime: string;
  closeTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  quoteAsset: string;
  freshness: Freshness;
}

export interface NewsItem {
  id: string;
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  contentText: string | null;
  summary: string | null;
  language: string;
  publishedAt: string | null;
  fetchedAt: string;
  instrumentIds: string[];
  tags: string[];
  sentiment: "positive" | "negative" | "neutral" | "mixed" | "unknown";
  importance: "low" | "medium" | "high" | "critical";
  contentHash: string;
  duplicateOf: string | null;
  enrichment: {
    providerId: string | null;
    model: string | null;
    promptVersion: string | null;
    completedAt: string | null;
  };
}

export interface WidgetDescriptor {
  id: string;
  kind: WidgetKind;
  title: string;
  dataEndpoint: string;
  requiredCapabilities: string[];
  fieldMap: Record<string, string>;
  options: Record<string, unknown>;
}

export type WidgetKind =
  | "quote-card"
  | "sparkline"
  | "candlestick"
  | "option-chain"
  | "greeks-grid"
  | "news-feed"
  | "position-table"
  | "pnl-summary"
  | "transaction-form"
  | "transaction-history"
  | "pnl-card"
  | "health-badge"
  | "research-journal"
  | "trading-review"
  | "broker-accounts"
  | "account-settings";

export interface PanelDescriptor {
  panelId: string;
  instrumentId: string;
  title: string;
  assetClass: string;
  widgets: WidgetDescriptor[];
  availableCapabilities: string[];
  freshness: Freshness | null;
}

export interface SectionDescriptor {
  id: string;
  title: string;
  order: number;
  showPositionSummary: boolean;
  panels: PanelDescriptor[];
}

export interface ViewDescriptor {
  viewId: string;
  title: string;
  generation?: number;
  sections: SectionDescriptor[];
  layout: Array<{ widgetId: string; x: number; y: number; w: number; h: number }>;
  panels: PanelDescriptor[];
}

export interface InstrumentMeta {
  id: string;
  displayName: string;
  symbol: string;
  assetClass: string;
  quoteAsset: string;
  precision: { priceScale: number; quantityScale: number };
  origin: "config" | "user";
}

export type TransactionType = "buy" | "sell" | "dividend" | "withholding_tax";

export interface TransactionRecord {
  id: string;
  accountId: string;
  instrumentId: string;
  type: TransactionType;
  quantity: string;
  price: string | null;
  fees: string;
  currency: string;
  tradeAtMs: number;
}

export interface TransactionInput {
  instrumentId: string;
  type: TransactionType;
  quantity: string;
  price: string | null;
  fees: string;
  currency: string;
  tradeAtMs: number;
}

export interface PositionView {
  id: string;
  accountId: string;
  instrumentId: string;
  quantity: string;
  averageCost: string;
  costBasis: string;
  markPrice: string | null;
  marketValue: string | null;
  realizedPnl: string;
  unrealizedPnl: string | null;
  quoteAsset: string;
  markQuoteAsset: string | null;
  markSourceId: string | null;
  asOfMs: number;
  freshnessStatus: FreshnessStatus;
  freshness: Freshness;
}

export interface CostSubtotal {
  currency: string;
  costBasis: string;
  realizedPnl: string;
  grossDividend: string;
  withholdingTax: string;
  netIncome: string;
}

export interface ValuationSubtotal {
  currency: string;
  marketValue: string | null;
  unrealizedPnl: string | null;
  allocationPercent: string | null;
}

export interface PnlSummary {
  positionsCount: number;
  costSubtotals: CostSubtotal[];
  valuationSubtotals: ValuationSubtotal[];
  canCombine: boolean;
  combinedTotals: {
    currency: string;
    costBasis: string;
    marketValue: string;
    realizedPnl: string;
    unrealizedPnl: string;
    netIncome: string;
    totalPnl: string;
  } | null;
  explanation: string | null;
  sectionSummaries: Record<string, Omit<PnlSummary, "sectionSummaries">>;
}

export interface InstrumentCandidate {
  sourceId: string;
  providerSymbol: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  baseAsset: string;
  quoteAsset: string;
  capabilities: string[];
  rank: number | null;
  venue: string | null;
}

export interface InstrumentSearchSource {
  sourceId: string;
  enabled: boolean;
  available: boolean;
  unavailableReason: { code: string; message: string; steps: string[] } | null;
  candidates: InstrumentCandidate[];
}

export interface InstrumentSearchResponse {
  query: string;
  generation: number;
  candidates: InstrumentCandidate[];
  groups: Array<{ baseAsset: string; candidates: InstrumentCandidate[] }>;
  sources: InstrumentSearchSource[];
}

export interface InstrumentProbeEvidence {
  candidate: InstrumentCandidate;
  ok: boolean;
  price: string | null;
  quoteAsset: string | null;
  capturedAt: string | null;
  freshness: Freshness | null;
  egressUsed: "direct" | "corp" | "vpn" | null;
  latencyMs: number;
  error: { message?: string; code?: string; causeCode?: string } | null;
}

export interface ServerEvent {
  id: string;
  type: string;
  generation: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface Snapshot {
  view: ViewDescriptor;
  quotes: QuoteEnvelope[];
  health: SourceHealth[];
  egress: SourceEgressStatus[];
  news: NewsItem[];
  instruments: Record<string, InstrumentMeta>;
  positions: PositionView[];
  transactions: TransactionRecord[];
  pnlSummary: PnlSummary;
  generation: number;
}

export type { ResearchEntry, ResearchWrite, ResearchReview, BrokerSnapshot, BrokerConnectionStatus } from "@invest/domain";
