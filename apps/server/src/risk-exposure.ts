import { analyzeRiskExposure, estimateBeta, exposureBetaSymbols, exposureQuoteSymbols, marketReportToday, newYorkTime, tradierSymbol, HEDGE_BENCHMARKS, MARKET_STANCES, type BetaEstimate, type HedgeBenchmark, type MarketContext, type MarketQuote, type RiskExposureAnalysis } from "@invest/domain";
import type { AppConfig } from "@invest/config";
import type { StorageDriver } from "@invest/storage";
import { currentPerformance } from "./performance.js";

// Composes the risk-exposure analysis from stored broker snapshots, live Tradier quotes (with option Greeks),
// betas estimated from stored daily candles (holdings) plus Tradier history (benchmarks / unlisted underlyings)
// and the latest ready market daily. External reads are injected so the analysis works without Tradier.
// Beta history shares the Tradier queue with scheduled collection, so betas are computed in the background:
// a request that finds them missing answers with β=1 and `betas.status = "pending"`, and the page re-reads.
export interface RiskExposureDeps {
  storage: Pick<StorageDriver, "getBrokerSnapshots" | "getStatementImports" | "getLatestQuotes" | "getCandles" | "getMarketDailyReports">;
  config: AppConfig;
  fetchQuotes?: (symbols: string[]) => Promise<MarketQuote[]>;
  fetchHistory?: (symbol: string) => Promise<{ date: string; close: string }[]>;
  now?: () => number;
  options?: { ratio?: number; putDelta?: number };
  /** Wait for the beta job instead of answering with a pending status (tests, CLI). */
  waitForBetas?: boolean;
}
export interface BetaSourceStatus { status: "ok" | "partial" | "unavailable" | "pending"; benchmarks: string[]; estimated: string[]; unavailable: string[]; pending: string[]; message?: string }
export interface RiskExposureResponse extends RiskExposureAnalysis {
  sources: { quotes: { status: "tradier" | "unavailable"; symbols: number; received: number; missing: string[]; message?: string }; betas: BetaSourceStatus };
}
type DailyClose = { date: string; close: string };
type BetaRecord = Partial<Record<HedgeBenchmark, BetaEstimate | null>>;
const BETA_TTL_MS = 6 * 3600000, BETA_RETRY_MS = 5 * 60000, HISTORY_BARS = 320;
const betaCache = new Map<string, { expiresAt: number; value: BetaEstimate | null; message?: string }>();
let betaJob: Promise<void> | null = null;
const nyDate = (ms: number) => newYorkTime(ms).date;
const key = (symbol: string, benchmark: string) => `${symbol}|${benchmark}`;

export async function loadMarketContext(storage: Pick<StorageDriver, "getMarketDailyReports">, nowMs: number): Promise<MarketContext> {
  const to = marketReportToday(new Date(nowMs)), from = new Date(nowMs - 45 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const reports = await storage.getMarketDailyReports({ from, to, status: "ready", limit: 1 });
  const latest = reports[0];
  if (!latest) return { latestDaily: null, bearish: false };
  return { latestDaily: { id: latest.id, date: latest.date, title: latest.title, stance: latest.stance, stanceLabel: MARKET_STANCES[latest.stance] }, bearish: latest.stance === "risk-off" };
}

async function storedCloses(symbol: string, deps: RiskExposureDeps): Promise<DailyClose[] | null> {
  const instrument = deps.config.instruments.find(i => i.active && i.assetClass === "equity" && i.sourceBindings.some(b => b.enabled && b.quoteAsset === "USD" && tradierSymbol(b.providerSymbol) === symbol));
  if (!instrument) return null;
  const rows = await deps.storage.getCandles(instrument.id, undefined, "1d", HISTORY_BARS);
  if (!rows.length) return null;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1);
  const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  return rows.filter(r => r.sourceId === dominant).map(r => ({ date: nyDate(r.openTimeMs), close: r.close }));
}

/** Cached betas for `symbols`; `pending` lists the symbols with at least one benchmark not yet estimated. */
export function readBetaCache(symbols: readonly string[], nowMs: number): { betas: Map<string, BetaRecord>; pending: string[] } {
  const betas = new Map<string, BetaRecord>(), pending: string[] = [];
  for (const symbol of symbols) {
    const record: BetaRecord = {};
    let complete = true;
    for (const benchmark of HEDGE_BENCHMARKS) {
      const cached = betaCache.get(key(symbol, benchmark));
      if (cached && cached.expiresAt > nowMs) record[benchmark] = cached.value; else complete = false;
    }
    betas.set(symbol, record);
    if (!complete) pending.push(symbol);
  }
  return { betas, pending };
}

/** Fills the beta cache for every missing symbol/benchmark pair (sequential reads: history shares the Tradier quota). */
export async function computeBetas(symbols: readonly string[], deps: RiskExposureDeps, nowMs: number): Promise<void> {
  const { pending } = readBetaCache(symbols, nowMs);
  if (!pending.length) return;
  const series = new Map<string, DailyClose[] | null>();
  let message: string | undefined;
  const load = async (symbol: string): Promise<DailyClose[] | null> => {
    if (series.has(symbol)) return series.get(symbol)!;
    let closes: DailyClose[] | null = null;
    try { closes = await storedCloses(symbol, deps); if (!closes && deps.fetchHistory) closes = await deps.fetchHistory(symbol); }
    catch (error) { message = error instanceof Error ? error.message : String(error); closes = null; }
    series.set(symbol, closes);
    return closes;
  };
  for (const b of HEDGE_BENCHMARKS) await load(b);
  for (const symbol of pending) for (const benchmark of HEDGE_BENCHMARKS) {
    const cached = betaCache.get(key(symbol, benchmark));
    if (cached && cached.expiresAt > nowMs) continue;
    const asset = await load(symbol), bench = series.get(benchmark) ?? null;
    const value = asset && bench ? estimateBeta(asset, bench, benchmark) : null;
    betaCache.set(key(symbol, benchmark), { expiresAt: nowMs + (asset && bench ? BETA_TTL_MS : BETA_RETRY_MS), value, ...(asset && bench ? {} : { message: message ?? "缺少可用的日 K 历史" }) });
  }
}
/** Betas for `symbols`: served from cache; missing pairs are computed in one shared background job unless `wait` is set. */
export async function estimateBetas(symbols: readonly string[], deps: RiskExposureDeps, nowMs: number, wait = true): Promise<{ betas: Map<string, BetaRecord>; status: BetaSourceStatus }> {
  let { betas, pending } = readBetaCache(symbols, nowMs);
  if (pending.length) {
    const job = betaJob ?? (betaJob = computeBetas(symbols, deps, nowMs).catch(() => undefined).finally(() => { betaJob = null; }));
    if (wait) { await job; ({ betas, pending } = readBetaCache(symbols, nowMs)); }
  }
  const estimated = symbols.filter(s => betas.get(s)?.SPY), unavailable = symbols.filter(s => !pending.includes(s) && !betas.get(s)?.SPY);
  const message = unavailable.map(s => betaCache.get(key(s, "SPY"))?.message).find(Boolean);
  return { betas, status: { status: pending.length ? "pending" : unavailable.length === 0 ? "ok" : estimated.length ? "partial" : "unavailable", benchmarks: [...HEDGE_BENCHMARKS], estimated, unavailable, pending, ...(message ? { message } : {}) } };
}
/** Starts the beta job for the current book so the first page load already finds the cache warm. */
export async function warmRiskBetas(deps: RiskExposureDeps): Promise<void> {
  const accounts = (await deps.storage.getBrokerSnapshots()).filter(a => a.environment !== "sandbox");
  await estimateBetas(exposureBetaSymbols(accounts), deps, deps.now?.() ?? Date.now(), true);
}
/** Test hook: forget cached betas. */
export function resetBetaCache(): void { betaCache.clear(); }

export async function riskExposureData(deps: RiskExposureDeps): Promise<RiskExposureResponse> {
  const nowMs = deps.now?.() ?? Date.now(), capturedAt = new Date(nowMs).toISOString();
  const [accounts, performance, marketContext] = await Promise.all([deps.storage.getBrokerSnapshots(), currentPerformance(deps.storage as StorageDriver, deps.config), loadMarketContext(deps.storage, nowMs)]);
  const real = accounts.filter(a => a.environment !== "sandbox");
  const symbols = exposureQuoteSymbols(real);
  const quotes = new Map<string, MarketQuote>();
  let quoteMessage: string | undefined, quoteStatus: RiskExposureResponse["sources"]["quotes"]["status"] = deps.fetchQuotes ? "tradier" : "unavailable";
  if (deps.fetchQuotes && symbols.length) {
    try { for (let i = 0; i < symbols.length; i += 50) for (const q of await deps.fetchQuotes(symbols.slice(i, i + 50))) quotes.set(q.symbol, q); }
    catch (error) { quoteStatus = "unavailable"; quoteMessage = error instanceof Error ? error.message : String(error); }
  } else if (!deps.fetchQuotes) quoteMessage = "Tradier 行情数据源未启用，采用券商报告价格，期权缺少 Delta";
  const { betas, status: betaStatus } = await estimateBetas(exposureBetaSymbols(real), deps, nowMs, deps.waitForBetas ?? false);
  const analysis = analyzeRiskExposure({ accounts: real, quotes, betas, equity: performance.equity, capturedAt, marketContext, options: deps.options });
  if (quoteMessage) analysis.missing.push(`行情：${quoteMessage}`);
  if (betaStatus.status === "pending") analysis.assumptions.push(`β 正在后台估算（${betaStatus.pending.join("、")}），本次按 β=1 计算；页面会自动重新读取`);
  return { ...analysis, sources: { quotes: { status: quoteStatus, symbols: symbols.length, received: quotes.size, missing: symbols.filter(s => !quotes.has(s)), ...(quoteMessage ? { message: quoteMessage } : {}) }, betas: betaStatus } };
}
