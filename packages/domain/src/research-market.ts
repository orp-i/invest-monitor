import { z } from "zod";

export type StudyProvider = "yahoo" | "fred" | "tradier";
export interface StudyInstrument { id: string; name: string; symbol: string; provider: StudyProvider; kind: "index" | "future" | "etf" | "rate" | "spot"; unit: string; description: string; sourceUrl: string }
const yahoo = (id: string, name: string, symbol: string, kind: StudyInstrument["kind"], unit: string, description: string): StudyInstrument => ({ id, name, symbol, provider: "yahoo", kind, unit, description, sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history/` });
const fred = (id: string, name: string, symbol: string, kind: "rate" | "spot", unit: string, description: string): StudyInstrument => ({ id, name, symbol, provider: "fred", kind, unit, description, sourceUrl: `https://fred.stlouisfed.org/series/${symbol}` });
const etf = (id: string, name: string, symbol: string, description: string, sourceUrl: string): StudyInstrument => ({ id, name, symbol, provider: "tradier", kind: "etf", unit: "USD/股", description, sourceUrl });
const ssga = (slug: string) => `https://www.ssga.com/us/en/individual/etfs/${slug}`;
export const STUDY_INSTRUMENTS: StudyInstrument[] = [
  yahoo("sp500", "标普 500", "^GSPC", "index", "点", "美国大盘价格指数，不含股息再投资。"),
  yahoo("nasdaq", "纳斯达克综合", "^IXIC", "index", "点", "纳斯达克综合指数；与纳斯达克 100 区分。"),
  yahoo("nasdaq100", "纳斯达克 100", "^NDX", "index", "点", "纳斯达克上市大型非金融企业价格指数。"),
  yahoo("dow", "道琼斯工业", "^DJI", "index", "点", "30 家大型公司价格加权指数。"),
  yahoo("russell", "罗素 2000", "^RUT", "index", "点", "美国小盘股价格指数。"),
  yahoo("gold-futures", "黄金期货", "GC=F", "future", "USD/金衡盎司", "供应商近月期货序列，换月可能产生跳空；不是 XAU/USD 现货或 GLD。"),
  yahoo("wti-futures", "WTI 原油期货", "CL=F", "future", "USD/桶", "供应商近月期货序列，包含换月影响及历史负价格；不是现货。"),
  yahoo("brent-futures", "Brent 原油期货", "BZ=F", "future", "USD/桶", "供应商近月布伦特期货序列，包含换月影响。"),
  fred("us10y", "美债 10 年收益率", "DGS10", "rate", "%", "美国国债恒定期限收益率，日度观测；不是债券价格。"),
  fred("us2y", "美债 2 年收益率", "DGS2", "rate", "%", "美国国债恒定期限收益率，日度观测。"),
  fred("fedfunds", "联邦基金有效利率", "DFF", "rate", "%", "实际隔夜有效利率，不是 FOMC 目标区间或市场预期。"),
  fred("wti-spot", "WTI 原油现货", "DCOILWTICO", "spot", "USD/桶", "EIA 库欣 WTI 现货日度观测，仅有价格点，不补造 OHLC。"),
  etf("tlt", "长期美债 · TLT", "TLT", "20 年以上美债 ETF；价格变化不等于收益率变化，不含派息再投资。", "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf"),
  etf("gld", "黄金 ETF · GLD", "GLD", "黄金 ETF 每股价格，与现货/期货独立展示。", "https://www.spdrgoldshares.com/usa/"),
  etf("xlk", "科技 · XLK", "XLK", "科技板块 ETF，跟踪 Technology Select Sector Index；不覆盖全部互联网平台。", ssga("the-technology-select-sector-spdr-fund-xlk")),
  etf("xly", "可选消费 · XLY", "XLY", "可选消费板块 ETF，跟踪 Consumer Discretionary Select Sector Index。", ssga("the-consumer-discretionary-select-sector-spdr-fund-xly")),
  etf("xlp", "必需消费 · XLP", "XLP", "必需消费板块 ETF，跟踪 Consumer Staples Select Sector Index。", ssga("the-consumer-staples-select-sector-spdr-fund-xlp")),
  etf("xlv", "医药健康 · XLV", "XLV", "医疗保健板块 ETF，包含制药、器械与服务。", ssga("the-health-care-select-sector-spdr-fund-xlv")),
  etf("xbi", "生物科技 · XBI", "XBI", "生物科技行业 ETF，跟踪 S&P Biotechnology Select Industry Index。", ssga("spdr-sp-biotech-etf-xbi")),
  etf("xli", "工业制造 · XLI", "XLI", "工业板块 ETF，亦含运输、服务等，不能视为纯制造业指数。", ssga("the-industrial-select-sector-spdr-fund-xli")),
  etf("xme", "金属矿产 · XME", "XME", "美国金属与采矿 ETF，亦含钢铁，不代表全球所有矿产。", ssga("spdr-sp-metals-mining-etf-xme")),
  etf("soxx", "半导体 · SOXX", "SOXX", "半导体 ETF，跟踪 NYSE Semiconductor Index；不是纯存储指数，也不等于研究观察名单。", "https://www.ishares.com/us/products/239705/ishares-phlx-semiconductor-etf"),
  etf("xlb", "材料 · XLB", "XLB", "材料板块 ETF，包含化学品、金属矿业等；不是矿产现货价格。", ssga("state-street-materials-select-sector-spdr-etf-xlb")),
  etf("spy", "标普 500 ETF · SPY", "SPY", "标普 500 ETF 每股价格；与 SPX 指数点位及 ES 期货分别核对，不含股息再投资。", "https://www.ssga.com/us/en/individual/etfs/state-street-spdr-sp-500-etf-trust-spy"),
  etf("qqq", "纳指 100 ETF · QQQ", "QQQ", "纳斯达克 100 ETF 每股价格；与 NDX 指数及 NQ 期货分别核对。", "https://www.invesco.com/qqq-etf/en/home.html"),
  etf("iwm", "小盘股 · IWM", "IWM", "罗素 2000 ETF 每股价格，不等于罗素指数点位。", "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf"),
  etf("smh", "半导体 · SMH", "SMH", "半导体行业 ETF，与 SOXX 的成分和权重不同，不代表单只芯片股。", "https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/"),
  etf("xle", "能源 · XLE", "XLE", "能源股 ETF；股票收益不等于原油期货变化。", ssga("the-energy-select-sector-spdr-fund-xle")),
  etf("xlf", "金融 · XLF", "XLF", "金融板块 ETF，不能替代某一家银行或私募公司的股价。", ssga("the-financial-select-sector-spdr-fund-xlf")),
  etf("oih", "油服 · OIH", "OIH", "油田服务企业 ETF；与油价有关，但不直接跟踪原油价格。", "https://www.vaneck.com/us/en/investments/oil-services-etf-oih/"),
  etf("remx", "稀土与战略金属 · REMX", "REMX", "稀土与战略金属企业 ETF，不是稀土现货或金属期货价格。", "https://www.vaneck.com/us/en/investments/rare-earth-strategic-metals-etf-remx/"),
  etf("igv", "软件 · IGV", "IGV", "软件行业 ETF，不代表所有软件股；用于日报板块对照。", "https://www.ishares.com/us/products/239771/ishares-north-american-techsoftware-etf"),
  etf("sil", "白银矿业 · SIL", "SIL", "白银矿业企业 ETF；经营、股市与成本风险使其不同于白银价格。", "https://www.globalxetfs.com/funds/sil/"),
  etf("slv", "白银信托 · SLV", "SLV", "白银信托每股价格，与白银期货及矿业股分别展示。", "https://www.ishares.com/us/products/239855/ishares-silver-trust-fund"),
  etf("gdx", "黄金矿业 · GDX", "GDX", "黄金矿业企业 ETF，不等于黄金现货、期货或 GLD。", "https://www.vaneck.com/us/en/investments/gold-miners-etf-gdx/"),
  yahoo("es-futures", "标普股指期货 · ES", "ES=F", "future", "指数点", "供应商近月 E-mini 标普 500 期货，含换月影响；不是 SPY 每股价格。"),
  yahoo("nq-futures", "纳指股指期货 · NQ", "NQ=F", "future", "指数点", "供应商近月 E-mini 纳斯达克 100 期货，含换月影响；不是 QQQ 每股价格。"),
  yahoo("silver-futures", "白银期货 · SI", "SI=F", "future", "USD/金衡盎司", "供应商近月白银期货，含换月影响；不是 SIL 矿业股。"),
  yahoo("dollar-index", "美元指数 · DXY", "DX-Y.NYB", "index", "指数点", "美元指数观测值，不等于美元/日元汇率，也不是美元指数期货。"),
  yahoo("vix", "波动率指数 · VIX", "^VIX", "index", "波动率点", "Cboe 波动率指数；不能直接持有，不等于 VIX 期货或相关 ETF 回报。"),
];
export interface StudyBar { date: string; close: number; open?: number; high?: number; low?: number }
export interface StudySeries { id: string; fetchedAt: string; requestedFrom?: string; from: string; through: string; bars: StudyBar[]; warnings: string[]; source: string; priceBasis: string; stale?: boolean; error?: string }
export const SECTORS = [
  { id: "technology", name: "科技", benchmarks: ["xlk", "soxx"], keywords: ["科技", "芯片", "半导体", "人工智能", "semiconductor", "software", "artificial intelligence"], drivers: "AI 投入 → 芯片/云收入 → 毛利与现金流；同时核对估值和出口限制。" },
  { id: "consumer", name: "消费", benchmarks: ["xly", "xlp"], keywords: ["消费", "零售", "电商", "retail", "consumer", "ecommerce"], drivers: "就业与实际收入 → 消费量价 → 库存、促销和利润率；区分必需与可选消费。" },
  { id: "healthcare", name: "医疗健康", benchmarks: ["xlv", "xbi"], keywords: ["医药", "制药", "临床", "biotech", "healthcare", "drug", "fda"], drivers: "临床证据/审批 → 支付与渗透率 → 销售和研发回报；关注专利与现金储备。" },
  { id: "manufacturing", name: "工业与制造", benchmarks: ["xli"], keywords: ["制造", "工业", "航空", "机器人", "manufacturing", "industrial", "aerospace"], drivers: "资本开支与订单 → 产能利用 → 交付和现金流；观察融资、原料与供应链。" },
  { id: "mining", name: "材料与矿产", benchmarks: ["xme", "xlb"], keywords: ["矿产", "采矿", "铜", "锂", "稀土", "mining", "copper", "lithium", "rare earth"], drivers: "商品价格与供需 → 矿山成本/产量 → 自由现金流；核对许可、国别与项目融资。" },
] as const;
export const SectorIdSchema = z.enum(["technology", "consumer", "healthcare", "manufacturing", "mining"]);
export type SectorId = z.infer<typeof SectorIdSchema>;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, "日期无效");
const url = z.string().max(2000).refine(v => { try { return !v || ["http:", "https:"].includes(new URL(v).protocol); } catch { return false; } }, "来源必须为 http/https 链接");
// Optional fields preserve existing manual records; source dates may be unknown.
export const ResearchSourceSchema = z.object({
  title: z.string().trim().min(1).max(300), publisher: z.string().trim().min(1).max(150),
  url: url.refine(v => !!v, "来源链接不能为空"), publishedAt: day.or(z.literal("")), accessedAt: day,
  evidence: z.string().trim().max(3000), confidence: z.enum(["high", "medium", "low"]),
}).strict();
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;
const provenance = { sources: z.array(ResearchSourceSchema).max(20).optional() };
const classification = {
  subsector: z.string().trim().max(80).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
};
export const RESEARCH_CLASSIFICATION = {
  basis: "以 GICS 业务定义为参考的五个研究入口；不是完整的 11 板块分类。细分与主题标签由研究维护，跨业务公司按研究目的观察。",
  sourceUrl: "https://www.msci.com/indexes/documents/methodology/1_MSCI_Global_Industry_Classification_Standard_GICS_Methodology_20250220.pdf",
  asOf: "2026-09-06",
  sectors: {
    technology: ["软件与云", "网络安全", "半导体·计算与设计", "半导体·互联与IP", "半导体·代工", "半导体·设备", "存储·DRAM/HBM", "存储·NAND", "存储·HDD", "存储·企业系统"],
    consumer: ["必需·零售", "必需·食品饮料", "必需·个人护理", "可选·零售电商", "可选·餐饮", "可选·服饰", "可选·教育"],
    healthcare: ["制药", "生物技术", "器械与诊断", "生命科学工具", "医疗服务"],
    manufacturing: ["机械与自动化", "电气与数据中心", "航空航天与国防", "工业部件与服务"],
    mining: ["综合矿业", "铜", "黄金", "钢铁", "工业气体", "锂", "稀土", "铀与关键矿产", "开发阶段资源"],
  },
} as const;
export const GeoEventSchema = z.object({ ...provenance, title: z.string().trim().min(1).max(200), date: day, category: z.enum(["war", "sanctions", "tariff", "politics", "supply", "other"]), region: z.string().trim().max(100), facts: z.string().trim().min(1).max(10000), mechanism: z.string().trim().max(5000), sourceUrl: url, assetIds: z.array(z.string().refine(id => STUDY_INSTRUMENTS.some(i => i.id === id))).min(1).max(STUDY_INSTRUMENTS.length), timing: z.enum(["before-close", "after-close", "unknown"]).default("unknown") }).strict();
export type GeoEventWrite = z.infer<typeof GeoEventSchema>;
export type GeoEvent = GeoEventWrite & { id: string; updatedAt: string };
// These are chronological comparison baselines, not asserted economic exposures.
export const US_STUDY_INDEX_IDS = ["sp500", "nasdaq", "nasdaq100", "dow", "russell"] as const;
export function studyEventComparisonIds(event: Pick<GeoEvent, "assetIds">): string[] {
  return [...new Set([...US_STUDY_INDEX_IDS, ...event.assetIds])];
}
export function filterStudyEvents(events: GeoEvent[], filters: { year?: string; category?: string; region?: string; query?: string }) {
  const region = filters.region?.trim().toLowerCase() ?? "", query = filters.query?.trim().toLowerCase() ?? "";
  return events.filter(e => (!filters.year || e.date.startsWith(`${filters.year}-`)) && (!filters.category || e.category === filters.category)
    && (!region || e.region.toLowerCase().includes(region)) && (!query || `${e.title} ${e.region} ${e.facts} ${e.mechanism}`.toLowerCase().includes(query)))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}
export function studyEventMarkers(rawBars: StudyBar[], buckets: StudyBar[], events: GeoEvent[], instrumentId: string, start = 0, end = buckets.length, through = rawBars.at(-1)?.date ?? "") {
  return events.flatMap(event => {
    if (!studyEventComparisonIds(event).includes(instrumentId)) return [];
    const response = rawBars.find(b => event.timing === "after-close" ? b.date > event.date : b.date >= event.date);
    if (!response || response.date > through || Date.parse(response.date) - Date.parse(event.date) > 7 * 86400000) return [];
    // Use the full bucket sequence to locate a response before clipping to the
    // viewport; future events must never fall into the last visible candle.
    const bucket = buckets.findIndex((b, i) => response.date >= b.date && response.date < (buckets[i + 1]?.date ?? `${through}~`));
    return bucket < start || bucket >= end ? [] : [{ event, i: bucket - start, responseDate: response.date }];
  }).sort((a, b) => a.i - b.i || a.event.date.localeCompare(b.event.date) || a.event.title.localeCompare(b.event.title));
}
export const SectorNoteSchema = z.object({ ...provenance, ...classification, sector: SectorIdSchema, type: z.enum(["information", "report", "change", "narrative"]), title: z.string().trim().min(1).max(200), date: day, body: z.string().trim().min(1).max(12000), sourceUrl: url, symbol: z.string().trim().max(20).default("") }).strict();
export type SectorNote = z.infer<typeof SectorNoteSchema> & { id: string; updatedAt: string };
export const StudyCompanySchema = z.object({ ...provenance, ...classification, stage: z.string().trim().max(80).optional(), sector: SectorIdSchema, cohort: z.enum(["established", "emerging"]), rank: z.number().int().min(1).max(10), symbol: z.string().trim().regex(/^[A-Z][A-Z0-9.-]{0,19}$/), name: z.string().trim().min(1).max(150), narrative: z.string().trim().min(1).max(5000), watch: z.string().trim().min(1).max(5000), sourceUrl: url, asOf: day }).strict();
export type StudyCompany = z.infer<typeof StudyCompanySchema> & { id: string; updatedAt: string };
export type StudyRecord = { kind: "event"; value: GeoEvent } | { kind: "note"; value: SectorNote } | { kind: "company"; value: StudyCompany };

export function aggregateStudyBars(bars: StudyBar[], interval: "day" | "week" | "month"): StudyBar[] {
  if (interval === "day") return bars;
  const groups = new Map<string, StudyBar[]>();
  for (const b of bars) {
    const date = new Date(`${b.date}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    const key = interval === "month" ? b.date.slice(0, 7) : date.toISOString().slice(0, 10);
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  return [...groups.values()].map(g => ({ date: g[0]!.date, close: g.at(-1)!.close, ...(g.every(b => b.open !== undefined && b.high !== undefined && b.low !== undefined) ? { open: g[0]!.open!, high: Math.max(...g.map(b => b.high!)), low: Math.min(...g.map(b => b.low!)) } : {}) }));
}
export const priceChange = (end: number, start: number): number | null => start > 0 ? (end / start - 1) * 100 : null;
export function monthObservation(bars: StudyBar[], year: number, month: number, today: string) {
  const key = `${year}-${String(month).padStart(2, "0")}`, start = `${key}-01`;
  const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const previous = bars.filter(b => b.date < start).at(-1);
  const rows = bars.filter(b => b.date >= start && b.date < next);
  // Do not turn a partial boundary month or absent prior close into a return.
  const covered = !!previous && Date.parse(start) - Date.parse(previous.date) <= 7 * 86400000 && rows.length >= 10 && Date.parse(next) - Date.parse(rows.at(-1)!.date) <= 7 * 86400000 && Date.parse(rows[0]!.date) - Date.parse(start) <= 7 * 86400000;
  const complete = next <= today && covered;
  return { year, month, complete, value: complete ? priceChange(rows.at(-1)!.close, previous!.close) : null, base: covered ? previous! : null, rows };
}
export function seasonality(bars: StudyBar[], today: string) {
  const year = Number(today.slice(0, 4));
  return Array.from({ length: 10 }, (_, i) => Array.from({ length: 12 }, (_, m) => monthObservation(bars, year - 10 + i, m + 1, today)));
}
export function studyEventWindow(bars: StudyBar[], event: Pick<GeoEvent, "date" | "timing">, rate = false) {
  const index = bars.findIndex(b => event.timing === "after-close" ? b.date > event.date : b.date >= event.date);
  const base = index > 0 ? bars[index - 1]! : null;
  const valid = !!base && index >= 0 && Math.abs(Date.parse(bars[index]!.date) - Date.parse(event.date)) <= 7 * 86400000 && Date.parse(event.date) - Date.parse(base.date) <= 7 * 86400000;
  const change = (a?: StudyBar, b?: StudyBar | null) => a && b ? rate ? (a.close - b.close) * 100 : priceChange(a.close, b.close) : null;
  return { baseDate: valid ? base!.date : null, reactionDate: valid ? bars[index]!.date : null, before5: valid ? change(base!, bars[index - 6]) : null, after: [1, 5, 20, 60].map(n => ({ sessions: n, date: valid ? bars[index + n - 1]?.date ?? null : null, value: valid ? change(bars[index + n - 1], base) : null })) };
}

// Same observation dates and same endpoints for both changes; no forward fill.
export function pairedStudy(a: StudyBar[], b: StudyBar[], from: string, through: string, bRate: boolean) {
  const lookup = new Map(b.filter(p => p.date >= from && p.date <= through).map(p => [p.date, p]));
  const pairs = a.filter(p => p.date >= from && p.date <= through && lookup.has(p.date)).map(p => ({ a: p, b: lookup.get(p.date)! }));
  const first = pairs[0];
  const points = first ? pairs.map(p => ({ date: p.a.date, a: priceChange(p.a.close, first.a.close), b: bRate ? (p.b.close - first.b.close) * 100 : priceChange(p.b.close, first.b.close) })) : [];
  const changes = pairs.slice(1).flatMap((p, i) => { const prev = pairs[i]!; const x = priceChange(p.a.close, prev.a.close), y = bRate ? (p.b.close - prev.b.close) * 100 : priceChange(p.b.close, prev.b.close); return x === null || y === null || Date.parse(p.a.date) - Date.parse(prev.a.date) > 7 * 86400000 ? [] : [{ x, y }]; });
  const n = changes.length, mx = changes.reduce((s, p) => s + p.x, 0) / n, my = changes.reduce((s, p) => s + p.y, 0) / n;
  const vx = changes.reduce((s, p) => s + (p.x - mx) ** 2, 0), vy = changes.reduce((s, p) => s + (p.y - my) ** 2, 0);
  const correlation = n >= 30 && vx > 0 && vy > 0 ? changes.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / Math.sqrt(vx * vy) : null;
  return { points, correlation, samples: n };
}
