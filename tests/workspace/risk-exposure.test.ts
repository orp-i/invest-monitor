import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRiskExposure, balancingActions, computeFreshness, estimateBeta, exposureBetaSymbols, exposureQuoteSymbols, renderRiskExposureMarkdown, riskExposureReference, BrokerSnapshotSchema, CandleSchema, InstrumentSchema, EXPOSURE_THEMES, INSTRUMENT_PROFILES, UNLISTED_PROFILE, instrumentProfile, type BrokerSnapshot, type MarketQuote } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { handleRequest } from "../../apps/server/src/app.js";
import { estimateBetas, resetBetaCache, riskExposureData } from "../../apps/server/src/risk-exposure.js";

const at = "2026-09-23T10:00:00Z";
const position = (symbol: string, quantity: string, costBasis: string, multiplier = "100", assetType = "OPT") => ({ id: symbol, symbol, quantity, currency: "USD", costBasis, marketValue: null, unrealizedPnl: null, assetType, multiplier });
const stock = (symbol: string, quantity: string, costBasis: string) => position(symbol, quantity, costBasis, "1", "STK");
const account = (broker: "ibkr" | "tradier" | "elephant", positions: unknown[], equity = "2513.08"): BrokerSnapshot => BrokerSnapshotSchema.parse({ broker, accountId: `${broker}-test`, environment: broker === "tradier" ? "live" : "statement", asOf: "2026-09-22", syncedAt: at, currency: "USD", equity, cash: "100", unrealizedPnl: null, sessionRealizedPnl: null, positions, trades: [], notes: [] });
const quote = (symbol: string, last: string, extra: Partial<MarketQuote> = {}): MarketQuote => ({ symbol, description: symbol, type: extra.right ? "option" : "etf", last, bid: null, ask: null, tradeAt: "2026-09-22T20:00:00Z", bidAt: null, askAt: null, change: null, changePercent: null, volume: null, openInterest: null, underlying: null, expiration: null, strike: null, right: null, contractSize: null, greeks: null, freshness: null, ...extra });
const optionQuote = (symbol: string, last: string, delta: string, right: "put" | "call") => quote(symbol, last, { right, contractSize: "100", greeks: { delta, gamma: null, theta: null, vega: null, rho: null, midIv: null, updatedAt: null } });

// A book shaped like the production one on 2026-09-23: small stock longs, IWM/EWY bear put spreads, a UCO bull call spread and a DRAM put.
const book = () => [
  account("ibkr", [stock("DG", "2", "266.74"), stock("USAR", "20", "346.33")]),
  account("elephant", [position("IWM261002P00285000", "1", "263.51"), position("IWM261002P00275000", "-1", "-58.47"), position("EWY261002P00170000", "1", "224.51"), position("EWY261002P00160000", "-1", "-79.47"), stock("NOK", "13", "223.55")]),
  account("tradier", [position("UCO261016C00055000", "1", "355"), position("UCO261016C00065000", "-1", "-135"), position("DRAM261218P00045000", "1", "170")]),
];
const quotes = () => new Map<string, MarketQuote>([
  ["DG", quote("DG", "122.63")], ["USAR", quote("USAR", "16.99")], ["NOK", quote("NOK", "10.94")], ["IWM", quote("IWM", "287.21")], ["EWY", quote("EWY", "192.62")], ["UCO", quote("UCO", "50.63")], ["DRAM", quote("DRAM", "63.62")],
  ["SPY", quote("SPY", "773.38")], ["QQQ", quote("QQQ", "747.46")], ["SH", quote("SH", "31.90")], ["RWM", quote("RWM", "13.92")], ["PSQ", quote("PSQ", "24.52")], ["JETS", quote("JETS", "26.10")], ["SCO", quote("SCO", "18.40")], ["MU", quote("MU", "180")],
  ["IWM261002P00285000", optionQuote("IWM261002P00285000", "2.02", "-0.368", "put")], ["IWM261002P00275000", optionQuote("IWM261002P00275000", "0.42", "-0.1143", "put")],
  ["EWY261002P00170000", optionQuote("EWY261002P00170000", "0.63", "-0.0768", "put")], ["EWY261002P00160000", optionQuote("EWY261002P00160000", "0.28", "-0.0217", "put")],
  ["UCO261016C00055000", optionQuote("UCO261016C00055000", "1.89", "0.3515", "call")], ["UCO261016C00065000", optionQuote("UCO261016C00065000", "0.55", "0.1186", "call")],
  ["DRAM261218P00045000", optionQuote("DRAM261218P00045000", "1.01", "-0.0905", "put")],
]);

describe("exposure catalog", () => {
  it("derives multi-theme instrument profiles from theme definitions", () => {
    expect(INSTRUMENT_PROFILES.EWY!.memberships.map(m => `${m.theme}:${m.coefficient}`).sort()).toEqual(["korea-equity:1", "memory-semis:0.5"]);
    expect(INSTRUMENT_PROFILES.EWY!.memberships.some(m => m.theme === "us-equity")).toBe(false);
    expect(INSTRUMENT_PROFILES.DRAM!.memberships.map(m => `${m.theme}:${m.coefficient}`).sort()).toEqual(["memory-semis:1", "semis:1", "us-equity:1"]);
    expect(INSTRUMENT_PROFILES.JETS!.memberships.map(m => `${m.theme}:${m.coefficient}`).sort()).toEqual(["crude-oil:-0.3", "travel-leisure:1", "us-equity:1"]);
    expect(INSTRUMENT_PROFILES.SOXL!.memberships.find(m => m.theme === "us-equity")?.coefficient).toBe(3);
    expect(INSTRUMENT_PROFILES.GDX!.memberships.map(m => `${m.theme}:${m.coefficient}`).sort()).toEqual(["gold-miners:1", "gold:1.5", "us-equity:0.5"]);
    expect(INSTRUMENT_PROFILES.UCO!.memberships).toEqual([expect.objectContaining({ theme: "crude-oil", coefficient: 2 })]);
    expect(INSTRUMENT_PROFILES.QQQ!.benchmark).toBe("QQQ"); expect(INSTRUMENT_PROFILES.KRE!.benchmark).toBe("IWM"); expect(INSTRUMENT_PROFILES.XLE!.benchmark).toBe("SPY");
    expect(instrumentProfile("ZZZZ")).toBe(UNLISTED_PROFILE);
    expect(EXPOSURE_THEMES.length).toBeGreaterThanOrEqual(40);
  });
  it("keeps every hedge tool resolvable in the catalog", () => {
    const missing = EXPOSURE_THEMES.flatMap(t => [...t.longTools, ...t.shortTools]).filter(tool => tool.symbol !== "*" && !INSTRUMENT_PROFILES[tool.symbol]).map(t => t.symbol);
    expect([...new Set(missing)]).toEqual([]);
    for (const theme of EXPOSURE_THEMES) { expect(theme.longTools.length).toBeGreaterThan(0); expect(theme.shortTools.length).toBeGreaterThan(0); }
  });
});

describe("risk exposure analysis", () => {
  it("computes delta notional, structures, themes and the overall direction", () => {
    const a = analyzeRiskExposure({ accounts: book(), quotes: quotes(), equity: "2513.08", capturedAt: at });
    const iwm = a.groups.find(g => g.underlying === "IWM")!;
    expect(iwm).toMatchObject({ structure: "看空认沽价差（买 285 / 卖 275）", direction: "bearish", deltaShares: "-25.37", deltaNotional: "-7286.52", maxLoss: { value: "205.04" }, unlimitedRisk: false, nearestExpiry: "2026-10-02", daysToExpiry: 9, complete: true });
    expect(a.groups.find(g => g.underlying === "DG")).toMatchObject({ structure: "股票多头 · 2 股", deltaNotional: "245.26", maxLoss: { value: "245.26" } });
    expect(a.groups.find(g => g.underlying === "UCO")).toMatchObject({ structure: "看多认购价差（买 55 / 卖 65）", deltaNotional: "1179.17", maxLoss: { value: "220.00" } });
    expect(a.groups.find(g => g.underlying === "EWY")).toMatchObject({ structure: "看空认沽价差（买 170 / 卖 160）", deltaNotional: "-1061.33", maxLoss: { value: "145.04" } });
    expect(a.groups.find(g => g.underlying === "DRAM")).toMatchObject({ structure: "买入认沽（看空）", deltaNotional: "-575.76", maxLoss: { value: "170.00" } });
    const us = a.themes.find(t => t.id === "us-equity")!;
    expect(us.contributions.map(c => c.underlying).sort()).toEqual(["DG", "DRAM", "IWM", "NOK", "USAR"]);
    expect(us).toMatchObject({ long: "727.28", short: "-7862.28", net: "-7135.00", status: "over-hedged", significant: true, netToEquity: "-283.9" });
    expect(us.netBetaAdjusted.SPY).toBe("-7135.00"); expect(us.betaAssumedGroups.sort()).toEqual(["DG", "DRAM", "IWM", "NOK", "USAR"]);
    expect(a.themes.find(t => t.id === "memory-semis")).toMatchObject({ net: "-1106.43", status: "unhedged-short", significant: true });
    expect(a.themes.find(t => t.id === "korea-equity")).toMatchObject({ net: "-1061.33", status: "unhedged-short", significant: true });
    expect(a.themes.find(t => t.id === "crude-oil")).toMatchObject({ long: "2358.34", short: "0.00", net: "2358.34", status: "unhedged-long", significant: true });
    expect(a.themes.find(t => t.id === "retail")).toMatchObject({ net: "245.26", status: "unhedged-long", significant: false });
    expect(a.totals).toMatchObject({ long: "1906.45", short: "-8923.61", gross: "10830.06", definedRiskGroups: 4, definedMaxLoss: "740.08", unlimitedRiskGroups: 0, legs: 10, valuedLegs: 10 });
    expect(a.overall.direction).toBe("net-short"); expect(a.overall.summary).toContain("净空头");
    expect(a.findings.some(f => f.severity === "medium" && f.title.startsWith("IWM：") && f.title.includes("距到期 9 天"))).toBe(true);
    expect(a.findings.some(f => f.title.includes("超过 R5 参考上限 5%"))).toBe(true);
    expect(a.findings.find(f => f.title.includes("反向仓位 7862.28 USD 超过多头 727.28 USD"))).toBeTruthy();
  });
  it("flags legs without greeks or quotes instead of guessing", () => {
    const q = quotes(); q.delete("DRAM261218P00045000"); q.delete("NOK");
    const a = analyzeRiskExposure({ accounts: book(), quotes: q, equity: "2513.08", capturedAt: at });
    expect(a.groups.find(g => g.underlying === "DRAM")).toMatchObject({ complete: false, deltaNotional: null, direction: "unknown" });
    expect(a.groups.find(g => g.underlying === "NOK")).toMatchObject({ complete: false, deltaNotional: null });
    expect(a.missing.some(m => m.includes("DRAM261218P00045000") && m.includes("缺少 Tradier Delta"))).toBe(true);
    expect(a.themes.find(t => t.id === "memory-semis")).toMatchObject({ net: "-530.67", incompleteGroups: ["DRAM"] });
    expect(a.themes.find(t => t.id === "networking-telecom-equipment")?.status).toBe("incomplete");
    expect(a.totals.valuedLegs).toBe(8);
    const broker = analyzeRiskExposure({ accounts: [account("ibkr", [{ ...stock("DG", "2", "266.74"), markPrice: "120", marketValue: "240" }])], quotes: new Map(), equity: "1000", capturedAt: at });
    expect(broker.groups[0]).toMatchObject({ deltaNotional: "240.00", legs: [expect.objectContaining({ markSource: "broker", notes: ["采用券商报告价格"] })] });
  });
  it("estimates beta from common-date log returns and refuses short samples", () => {
    const dates = Array.from({ length: 120 }, (_, i) => `2026-0${Math.floor(i / 28) + 1}-${String(i % 28 + 1).padStart(2, "0")}`);
    const bench = dates.map((date, i) => ({ date, close: (100 * Math.exp(Math.sin(i) * 0.01)).toFixed(6) }));
    const asset = dates.map((date, i) => ({ date, close: (50 * Math.exp(Math.sin(i) * 0.02)).toFixed(6) }));
    expect(estimateBeta(asset, bench, "SPY")).toMatchObject({ benchmark: "SPY", beta: "2.000", correlation: "1.000", samples: 119 });
    expect(estimateBeta(asset.slice(0, 40), bench, "SPY")).toBeNull();
    expect(estimateBeta(asset, bench.map(r => ({ ...r, date: `2025${r.date.slice(4)}` })), "SPY")).toBeNull();
  });
  it("sizes balancing actions by rule, ratio and assumed put delta", () => {
    const a = analyzeRiskExposure({ accounts: book(), quotes: quotes(), equity: "2513.08", capturedAt: at, options: { ratio: 0.5, putDelta: 0.3 } });
    const oil = a.actions.filter(x => x.theme === "crude-oil");
    const jets = oil.find(x => x.tool.symbol === "JETS")!;
    // R3: 50% × 2358.34 = 1179.17 target; JETS coefficient -0.3 → 3930.57 USD of JETS ≈ 150.60 shares, carrying US-equity beta as a side exposure.
    // The side exposure (3930 USD of US-equity beta) exceeds 20% of NAV, so the cross-asset hedge is only a standby option here.
    expect(jets).toMatchObject({ rule: "R3", priority: "standby", quantity: "150.60", unit: "股", notional: "3930.57", price: "26.10" });
    expect(jets.note).toContain("会显著改变其他主题方向");
    expect(jets.sideEffects).toEqual(expect.arrayContaining([{ theme: "us-equity", label: expect.stringContaining("美股权益"), notional: "3930.57" }, { theme: "travel-leisure", label: expect.any(String), notional: "3930.57" }]));
    expect(oil.find(x => x.tool.symbol === "SCO")).toMatchObject({ rule: "R3", priority: "now", quantity: "32.04", notional: "589.59" });
    expect(oil.find(x => x.tool.symbol === "*")).toMatchObject({ title: expect.stringContaining("减少多头"), notional: "1179.17" });
    const memory = a.actions.filter(x => x.theme === "memory-semis");
    expect(memory.find(x => x.tool.symbol === "MU")).toMatchObject({ rule: "R1", quantity: "3.07", notional: "553.22" });
    expect(memory.find(x => x.tool.symbol === "EWY")).toMatchObject({ rule: "R3", quantity: "5.74", notional: "1106.43", sideEffects: [{ theme: "korea-equity", label: "韩国股市", notional: "1106.43" }] });
    const us = a.actions.filter(x => x.theme === "us-equity");
    expect(us.find(x => x.tool.symbol === "SPY")).toMatchObject({ rule: "R1", unit: "股", quantity: "4.61", notional: "3567.50" });
    expect(a.actions.find(x => x.rule === "R5")).toMatchObject({ theme: "all", notional: "614.43" });
    const full = balancingActions(a, { ratio: 1, putDelta: 0.3 });
    expect(full.find(x => x.theme === "crude-oil" && x.tool.symbol === "JETS")?.quantity).toBe("301.19");
    expect(full.find(x => x.theme === "memory-semis" && x.tool.symbol === "MU")?.quantity).toBe("3.07");
  });
  it("applies R2 and R4 to a plain long stock book, respecting the market context", () => {
    const accounts = [account("ibkr", [stock("AAPL", "150", "30000"), stock("DG", "10", "1200")], "40000")];
    const q = new Map<string, MarketQuote>([["AAPL", quote("AAPL", "200")], ["DG", quote("DG", "120")], ["SPY", quote("SPY", "773.38")], ["IWM", quote("IWM", "287.21")], ["QQQ", quote("QQQ", "747.46")], ["SH", quote("SH", "31.90")], ["RWM", quote("RWM", "13.92")], ["PSQ", quote("PSQ", "24.52")], ["XRT", quote("XRT", "80")]]);
    const betas = new Map([["AAPL", { SPY: { benchmark: "SPY", beta: "1.200", correlation: "0.8", samples: 250, from: "2025-09-23", to: "2026-09-22" }, QQQ: { benchmark: "QQQ", beta: "1.000", correlation: "0.9", samples: 250, from: "2025-09-23", to: "2026-09-22" }, IWM: null }]]);
    const calm = analyzeRiskExposure({ accounts, quotes: q, betas, equity: "40000", capturedAt: at, options: { ratio: 0.5, putDelta: 0.3 } });
    const us = calm.themes.find(t => t.id === "us-equity")!;
    expect(us).toMatchObject({ long: "31200.00", short: "0.00", status: "unhedged-long", significant: true });
    expect(us.netBetaAdjusted).toEqual({ SPY: "37200.00", IWM: "31200.00", QQQ: "31200.00" });
    expect(calm.overall).toMatchObject({ direction: "net-long", usEquityBetaNet: "37200.00" });
    const spyPut = calm.actions.find(x => x.tool.symbol === "SPY" && x.tool.kind === "option")!;
    // R4: 50% × 37200 = 18600 ÷ (773.38 × 100 × 0.3) = 0.80 contracts → one contract already exceeds the target.
    expect(spyPut).toMatchObject({ rule: "R4", priority: "standby", quantity: "0.80", unit: "张", notional: "18600.00" });
    expect(spyPut.note).toContain("一张就会超额");
    expect(calm.actions.find(x => x.tool.symbol === "SH")).toMatchObject({ rule: "R4", quantity: "583.07", notional: "18600.00" });
    expect(calm.actions.find(x => x.tool.symbol === "RWM")).toMatchObject({ quantity: "1120.69", notional: "15600.00" });
    const covered = calm.actions.filter(x => x.tool.kind === "covered-call");
    expect(covered).toEqual([expect.objectContaining({ rule: "R2", priority: "standby", tool: expect.objectContaining({ symbol: "AAPL" }), quantity: "1", notional: "20000.00" })]);
    const bearish = analyzeRiskExposure({ accounts, quotes: q, betas, equity: "40000", capturedAt: at, marketContext: { latestDaily: { id: "d1", date: "2026-09-22", title: "风险偏好下降", stance: "risk-off", stanceLabel: "风险偏好下降" }, bearish: true } });
    expect(bearish.actions.find(x => x.tool.kind === "protective-put")).toMatchObject({ priority: "now", note: expect.stringContaining("风险偏好下降") });
    expect(bearish.actions.find(x => x.tool.symbol === "SPY" && x.tool.kind === "option")?.priority).toBe("now");
    const small = analyzeRiskExposure({ accounts: [account("ibkr", [stock("AAPL", "20", "4000")], "5000")], quotes: q, equity: "5000", capturedAt: at });
    expect(small.actions.find(x => x.tool.kind === "covered-call")).toMatchObject({ priority: "info", note: expect.stringContaining("仅 20 股") });
  });
  it("lists the quote and beta symbols an analysis needs", () => {
    const symbols = exposureQuoteSymbols(book());
    expect(symbols).toEqual(expect.arrayContaining(["SPY", "IWM", "QQQ", "SH", "RWM", "PSQ", "DG", "USAR", "NOK", "EWY", "UCO", "DRAM", "JETS", "SCO", "MU", "SNDK", "KORU", "IWM261002P00285000", "UCO261016C00065000"]));
    expect(symbols).not.toContain("*");
    expect(exposureBetaSymbols(book())).toEqual(["DG", "DRAM", "IWM", "NOK", "USAR"]);
    expect(exposureQuoteSymbols([{ ...book()[2]!, environment: "sandbox" }])).toEqual(["IWM", "QQQ", "SPY"]);
  });
  it("renders a reference pack with the method, the touched catalog slice and Markdown tables", () => {
    const a = analyzeRiskExposure({ accounts: book(), quotes: quotes(), equity: "2513.08", capturedAt: at });
    const pack = riskExposureReference(a);
    expect(pack.method.version).toBe("risk-exposure-method-v1"); expect(pack.method.rules.map(r => r.id)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
    expect(pack.catalog.themes.map(t => t.id)).toEqual(expect.arrayContaining(["us-equity", "memory-semis", "korea-equity", "crude-oil"]));
    expect(pack.catalog.themes.some(t => t.id === "gold")).toBe(false);
    expect(Object.keys(pack.catalog.instruments)).toEqual(expect.arrayContaining(["EWY", "DRAM", "UCO", "JETS", "SH"]));
    const md = renderRiskExposureMarkdown(a);
    for (const text of ["# 持仓风险敞口分析", "## 2. 主题敞口", "| 韩国股市 |", "看空认沽价差（买 285 / 卖 275）", "## 5. 平衡 / 对冲动作参考", "R3", "### 提示模板", "标注为“推断”"]) expect(md).toContain(text);
    expect(pack.markdown).toBe(md);
  });
});

const dirs: string[] = [];
afterEach(async () => { resetBetaCache(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function api(url: string, deps: unknown) {
  const request = Readable.from([]) as any; request.method = "GET"; request.url = url; request.headers = {};
  let status = 0, text = "";
  const response = { set statusCode(v: number) { status = v; }, setHeader() {}, end(v?: string) { text = v ?? ""; } };
  await handleRequest(request, response as never, deps as never);
  return { status, body: JSON.parse(text) };
}
describe("risk exposure server composition", () => {
  it("combines stored snapshots, injected quotes, stored candles and the latest ready daily", async () => {
    const dir = await mkdtemp(join(tmpdir(), "invest-risk-")); dirs.push(dir);
    const storage = createStorageDriver("node-sqlite", join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      await storage.saveBrokerSnapshots(book());
      await storage.saveMarketDailyReport("daily-risk-off", { date: "2026-09-22", title: "风险偏好下降的一天", summary: "", body: "正文", stance: "risk-off", drivers: "", watch: "", sourceUrl: "", assetIds: [], status: "ready" }, 0);
      const stored = InstrumentSchema.parse({ id: "held-dg", assetClass: "equity", symbol: "DG/USD", displayName: "DG", venue: null, baseAsset: "DG", quoteAsset: "USD", contractMultiplier: "1", underlyingId: null, precision: { priceScale: 2, quantityScale: 0 }, tags: [], active: true, metadata: {} });
      await storage.upsertInstrument(stored, Date.parse(at));
      const instrument = { ...stored, sourceBindings: [{ sourceId: "tradier-stocks-history", instrumentId: "held-dg", enabled: true, priority: 0, capabilities: ["candle"], providerSymbol: "DG", quoteAsset: "USD", conversion: null, params: {}, egressFallback: false }] };
      // 05:00Z is midnight in New York during winter, so stored candles and injected history share the same trading dates.
      const day = (i: number) => Date.UTC(2026, 0, 1, 5) + i * 86400000;
      await storage.appendCandles(Array.from({ length: 120 }, (_, i) => { const open = new Date(day(i)).toISOString(); return CandleSchema.parse({ instrumentId: "held-dg", sourceId: "tradier-stocks-history", timeframe: "1d", openTime: open, closeTime: new Date(day(i) + 86399000).toISOString(), open: "1", high: "200", low: "1", close: (100 * Math.exp(Math.sin(i) * 0.02)).toFixed(6), volume: null, tradeCount: null, session: "regular", quoteAsset: "USD", convertedTo: null, freshness: computeFreshness(open, open, 86400, new Date(open), "eod") }); }));
      const history = async (symbol: string) => Array.from({ length: 120 }, (_, i) => ({ date: new Date(day(i)).toISOString().slice(0, 10), close: (100 * Math.exp(Math.sin(i) * (symbol === "SPY" ? 0.01 : 0.02))).toFixed(6) }));
      const requested: string[][] = [];
      const deps = { storage, config: { sources: [], instruments: [instrument] } as never, fetchQuotes: async (symbols: string[]) => { requested.push(symbols); return [...quotes().values()].filter(q => symbols.includes(q.symbol)); }, fetchHistory: history, now: () => Date.parse(at), waitForBetas: true };
      const result = await riskExposureData(deps);
      expect(result.marketContext).toMatchObject({ bearish: true, latestDaily: { date: "2026-09-22", stance: "risk-off", stanceLabel: "风险偏好下降" } });
      expect(result.sources.quotes).toMatchObject({ status: "tradier", received: 22 });
      expect(new Set(requested.flat()).size).toBe(requested.flat().length);
      expect(result.sources.betas).toMatchObject({ status: "ok", estimated: ["DG", "DRAM", "IWM", "NOK", "USAR"], unavailable: [] });
      expect(result.groups.find(g => g.underlying === "IWM")?.betas).toMatchObject({ IWM: { beta: "1.000" }, SPY: { beta: "2.000" } });
      expect(result.groups.find(g => g.underlying === "DG")?.betas.SPY).toMatchObject({ beta: "2.000", samples: 119 });
      expect(result.groups.find(g => g.underlying === "DRAM")?.betas.SPY).toMatchObject({ beta: "2.000" });
      expect(result.groups.find(g => g.underlying === "NOK")?.betas.SPY).toMatchObject({ beta: "2.000" });
      expect(result.themes.find(t => t.id === "us-equity")?.netBetaAdjusted.SPY).toBe("-14270.00");
      expect(result.equity).toBe("7539.24");
      const again = await estimateBetas(["DG"], { ...deps, fetchHistory: async () => { throw new Error("no network"); } }, Date.parse(at));
      expect(again.betas.get("DG")?.SPY?.beta).toBe("2.000");
      // A cold cache answers immediately with a pending status and β=1, while one background job fills the cache.
      resetBetaCache();
      let slowCalls = 0; const slow = async (symbol: string) => { slowCalls++; await new Promise(r => setTimeout(r, 20)); return history(symbol); };
      const cold = await riskExposureData({ ...deps, fetchHistory: slow, waitForBetas: false });
      expect(cold.sources.betas).toMatchObject({ status: "pending", pending: expect.arrayContaining(["DG", "IWM"]) });
      expect(cold.themes.find(t => t.id === "us-equity")?.netBetaAdjusted.SPY).toBe("-7135.00");
      expect(cold.assumptions.some(a => a.includes("β 正在后台估算"))).toBe(true);
      const concurrent = await riskExposureData({ ...deps, fetchHistory: slow, waitForBetas: false });
      expect(concurrent.sources.betas.status).toBe("pending");
      const warm = await riskExposureData({ ...deps, fetchHistory: slow, waitForBetas: true });
      expect(warm.sources.betas.status).toBe("ok"); expect(warm.themes.find(t => t.id === "us-equity")?.netBetaAdjusted.SPY).toBe("-14270.00");
      expect(slowCalls).toBe(6); // SPY, IWM, QQQ benchmarks + DRAM, NOK, USAR; DG comes from stored candles and IWM is loaded once
    } finally { await storage.close(); }
  });
  it("serves the analysis and the reference pack without Tradier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "invest-risk-api-")); dirs.push(dir);
    const storage = createStorageDriver("node-sqlite", join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      await storage.saveBrokerSnapshots([account("ibkr", [{ ...stock("DG", "2", "266.74"), markPrice: "120", marketValue: "240" }], "1000")]);
      const deps = { storage, authMode: "off", authToken: null, configManager: { snapshot: { config: { sources: [], instruments: [] } } } };
      const plain = await api("/api/risk-exposure", deps);
      expect(plain.status).toBe(200);
      expect(plain.body.sources.quotes.status).toBe("unavailable");
      expect(plain.body.groups[0]).toMatchObject({ underlying: "DG", deltaNotional: "240.00" });
      expect(plain.body.themes.find((t: { id: string }) => t.id === "us-equity")).toMatchObject({ net: "240.00", status: "unhedged-long", significant: true });
      expect(plain.body.missing.some((m: string) => m.includes("Tradier 行情数据源未启用"))).toBe(true);
      const reference = await api("/api/risk-exposure/reference", deps);
      expect(reference.status).toBe(200);
      expect(reference.body.method.version).toBe("risk-exposure-method-v1");
      expect(reference.body.markdown).toContain("## 7. 判断方法");
      expect((await api("/api/risk-exposure?ratio=1&putDelta=0.2", deps)).body.options).toEqual({ ratio: 1, putDelta: 0.2 });
    } finally { await storage.close(); }
  });
});
