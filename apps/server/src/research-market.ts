import { randomUUID } from "node:crypto";
import { GeoEventSchema, SectorNoteSchema, StudyCompanySchema, RESEARCH_CLASSIFICATION, STUDY_INSTRUMENTS, SECTORS, type StudyBar, type StudyInstrument, type StudyRecord, type StudySeries } from "@invest/domain";
import { marketList, marketRecord, parseTradier, requestTradier, validMarketDay, type AdapterContext } from "@invest/adapters";
import type { StorageDriver } from "@invest/storage";
import type { EgressHttpClient } from "@invest/egress";

type Reply = { status: number; body: Record<string, unknown> };
const failure = (status: number, message: string): Reply => ({ status, body: { message } });
const todayNY = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const DAY = 86400000;
export function researchStart(today: string) { return `${Number(today.slice(0, 4)) - 11}-12-01`; }
export function validateStudyBars(rows: StudyBar[], from: string, today: string, allowNegative = false) {
  const warnings: string[] = [], byDate = new Map<string, StudyBar>();
  let invalid = 0;
  for (const b of rows) {
    if (!validMarketDay(b.date) || b.date < from || b.date >= today) continue;
    const values = [b.close, b.open, b.high, b.low].filter(v => v !== undefined);
    const hasOhlc = b.open !== undefined || b.high !== undefined || b.low !== undefined;
    if (values.some(v => !Number.isFinite(v) || !allowNegative && v < 0) || hasOhlc && (values.length !== 4 || b.high! < Math.max(b.open!, b.close, b.low!) || b.low! > Math.min(b.open!, b.close))) { invalid++; continue; }
    byDate.set(b.date, b);
  }
  if (invalid) warnings.push(`已跳过 ${invalid} 条缺失或异常价格，未补造 OHLC。`);
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.some((b, i) => i > 0 && Date.parse(b.date) - Date.parse(bars[i - 1]!.date) > 7 * DAY)) warnings.push("历史中存在超过 7 天的数据间隔，比较与事件窗口需核对覆盖范围。");
  return { bars, warnings };
}
export function parseYahooStudy(raw: unknown, instrument: StudyInstrument, from: string, today: string) {
  const root = marketRecord(raw), chart = marketRecord(root?.chart), result = marketRecord(marketList(chart?.result)[0]);
  const meta = marketRecord(result?.meta), indicators = marketRecord(result?.indicators), quote = marketRecord(marketList(indicators?.quote)[0]);
  if (chart?.error || !result || meta?.symbol !== instrument.symbol || !quote || !Array.isArray(result.timestamp)) throw new Error("历史响应格式或标的身份不符");
  const zone = typeof meta.exchangeTimezoneName === "string" ? meta.exchangeTimezoneName : "America/New_York";
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const field = (name: string, i: number) => { const v = Array.isArray(quote[name]) ? quote[name][i] : undefined; return typeof v === "number" ? v : NaN; };
  return validateStudyBars(result.timestamp.flatMap((t, i) => {
    if (typeof t !== "number" || !Number.isFinite(t)) return [];
    const values = { open: field("open", i), high: field("high", i), low: field("low", i), close: field("close", i) };
    // Yahoo can include all-null calendar slots (including market holidays).
    // Those are absent observations, not malformed OHLC rows.
    if (Object.values(values).every(v => !Number.isFinite(v))) return [];
    return [{ date: formatter.format(new Date(t * 1000)), ...values }];
  }), from, today, instrument.kind === "future");
}
export function parseFredStudy(csv: string, symbol: string, from: string, today: string) {
  const lines = csv.trim().split(/\r?\n/), header = lines.shift()?.replace(/^\uFEFF/, "").split(",");
  if (!header || !["DATE", "observation_date"].includes(header[0]!) || header[1] !== symbol) throw new Error("FRED 响应格式或序列不符");
  return validateStudyBars(lines.flatMap(line => { const [date, value] = line.split(","); return !date || !value?.trim() || value === "." ? [] : [{ date, close: Number(value) }]; }), from, today, true);
}

interface MarketContext { storage: StorageDriver; httpClient: EgressHttpClient; tradierContext: AdapterContext | null }
interface Job { retryAt: number; promise: Promise<Reply>; pending: boolean }
const jobs = new WeakMap<StorageDriver, Map<string, Job>>();
// Fixed catalog, demand driven, 24-hour durable cache. At most two external
// research loads at once; Tradier also enforces its shared token quota.
export async function researchSeriesRequest(id: string, refresh: boolean, context: MarketContext): Promise<Reply> {
  const instrument = STUDY_INSTRUMENTS.find(i => i.id === id);
  if (!instrument) return failure(400, "请选择目录中的研究标的。");
  const state = jobs.get(context.storage) ?? new Map<string, Job>(); jobs.set(context.storage, state);
  const existing = state.get(id);
  if (existing && (existing.pending || existing.retryAt > Date.now())) return existing.promise;
  const saved = await context.storage.getStudySeries(id);
  if (!refresh && saved && Date.now() - Date.parse(saved.fetchedAt) < DAY && saved.requestedFrom === researchStart(todayNY())) return { status: 200, body: { series: saved } };
  // Recheck after the storage await so simultaneous first loads coalesce.
  const raced = state.get(id);
  if (raced && (raced.pending || raced.retryAt > Date.now())) return raced.promise;
  if ([...state.values()].filter(j => j.pending).length >= 2) return failure(429, "两项历史正在加载，请稍后加载其他标的。");
  const job: Job = { retryAt: Infinity, pending: true, promise: Promise.resolve(failure(503, "加载中")) };
  job.promise = loadStudy(instrument, context).then(async series => {
    await context.storage.saveStudySeries(series);
    job.retryAt = Date.now() + 60000;
    return { status: 200, body: { series } };
  }).catch(() => {
    job.retryAt = Date.now() + 5 * 60000;
    const message = `${instrument.provider === "tradier" ? "Tradier" : instrument.provider === "fred" ? "FRED" : "Yahoo Finance"} 历史暂不可用，请稍后重试；不会用其他资产替代。`;
    return saved ? { status: 200, body: { series: { ...saved, stale: true, error: message } } } : failure(502, message);
  }).finally(() => { job.pending = false; });
  state.set(id, job);
  return job.promise;
}

async function loadStudy(instrument: StudyInstrument, context: MarketContext): Promise<StudySeries> {
  const today = todayNY(), from = researchStart(today);
  let parsed: { bars: StudyBar[]; warnings: string[] };
  if (instrument.provider === "tradier") {
    if (!context.tradierContext) throw new Error("Tradier not configured");
    const response = await requestTradier(context.tradierContext, "markets/history", { symbol: instrument.symbol, interval: "daily", start: from, end: today }, AbortSignal.timeout(30000));
    if (!response.ok) throw new Error("Tradier request failed");
    const result = parseTradier(response.value, context.tradierContext);
    if (!result.ok) throw new Error("Tradier parse failed");
    parsed = validateStudyBars(marketList(marketRecord(result.value.history)?.day).map(row => { const r = marketRecord(row) ?? {}; const num = (v: unknown) => typeof v === "string" && v.trim() || typeof v === "number" ? Number(v) : NaN; return { date: String(r.date ?? ""), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close) }; }), from, today);
  } else {
    const url = instrument.provider === "fred" ? new URL("https://fred.stlouisfed.org/graph/fredgraph.csv") : new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(instrument.symbol)}`);
    if (instrument.provider === "fred") { url.searchParams.set("id", instrument.symbol); url.searchParams.set("cosd", from); }
    else { url.searchParams.set("period1", String(Date.parse(from) / 1000)); url.searchParams.set("period2", String(Date.parse(today) / 1000)); url.searchParams.set("interval", "1d"); }
    // FRED's public CSV edge timed out with browser-style headers through the
    // configured egress. This download profile was verified against real CSV;
    // the same shared HTTP pool and strict post-download date filter still apply.
    const response = await context.httpClient.request({ url: url.href, egressProfile: context.tradierContext?.source.egressProfile ?? "corp", userAgent: instrument.provider === "fred" ? "curl/7.81.0" : "Mozilla/5.0 (compatible; InvestResearch/1.0)", followRedirects: false, maxRedirects: 0, connectTimeoutMs: 10000, requestTimeoutMs: 25000, signal: AbortSignal.timeout(30000), headers: { accept: instrument.provider === "fred" ? "*/*" : "application/json" } });
    if (!response.ok || response.value.status !== 200 || response.value.body.length > 5_000_000) throw new Error("Research source unavailable");
    const body = new TextDecoder().decode(response.value.body);
    parsed = instrument.provider === "fred" ? parseFredStudy(body, instrument.symbol, from, today) : parseYahooStudy(JSON.parse(body), instrument, from, today);
  }
  if (!parsed.bars.length || parsed.bars.length > 5000) throw new Error("Invalid research coverage");
  const through = parsed.bars.at(-1)!.date;
  if (Date.parse(today) - Date.parse(through) > 7 * DAY) parsed.warnings.push("来源最新观测距今超过 7 天，请核对发布日期及覆盖范围。");
  if (parsed.bars[0]!.date > `${Number(today.slice(0, 4)) - 11}-12-31`) parsed.warnings.push("来源未覆盖十个完整年份的全部月初基准，缺失月份留空。");
  return { id: instrument.id, fetchedAt: new Date().toISOString(), requestedFrom: from, from: parsed.bars[0]!.date, through, ...parsed, source: instrument.provider === "yahoo" ? "Yahoo Finance 公开历史" : instrument.provider === "fred" ? "FRED" : "Tradier", priceBasis: instrument.kind === "rate" || instrument.kind === "spot" ? "日度观测值；无 OHLC" : instrument.kind === "future" ? "供应商近月期货 OHLC；含换月影响" : "供应商价格 OHLC；非含分红总回报" };
}

const boardLocks = new WeakMap<StorageDriver, Promise<unknown>>();
export async function researchBoardRequest(method: string, path: string, body: unknown, storage: StorageDriver): Promise<Reply> {
  if (method === "GET" && path === "/api/research/market/catalog") return { status: 200, body: { instruments: STUDY_INSTRUMENTS, sectors: SECTORS, cadence: "按需加载，24 小时缓存", schemaVersion: 2, classification: RESEARCH_CLASSIFICATION } };
  if (method === "GET" && path === "/api/research/board") {
    const records = await storage.getStudyRecords();
    return { status: 200, body: { events: records.filter(r => r.kind === "event").map(r => r.value), notes: records.filter(r => r.kind === "note").map(r => r.value), companies: records.filter(r => r.kind === "company").map(r => r.value) } };
  }
  const match = /^\/api\/research\/board\/(events|notes|companies)(?:\/([a-zA-Z0-9-]{1,100}))?$/.exec(path);
  if (!match || !["POST", "PATCH", "DELETE"].includes(method) || (method === "POST") === !!match[2]) return failure(404, "研究接口不存在。");
  const kind = match[1] === "events" ? "event" : match[1] === "notes" ? "note" : "company", id = match[2];
  const previous = boardLocks.get(storage) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async (): Promise<Reply> => {
    const records = await storage.getStudyRecords();
    if (id && !records.some(r => r.kind === kind && r.value.id === id)) return failure(404, "记录不存在或已归档。");
    if (method === "DELETE") { await storage.archiveStudyRecord(kind, id!, new Date().toISOString()); return { status: 200, body: { archived: true } }; }
    const schema = kind === "event" ? GeoEventSchema : kind === "note" ? SectorNoteSchema : StudyCompanySchema;
    // Older clients know only the original fields. Omitted metadata must survive
    // their full-form PATCH; explicitly supplied [] / empty strings still clear it.
    let input = body;
    if (id && body && typeof body === "object" && !Array.isArray(body)) {
      const existing = records.find(r => r.kind === kind && r.value.id === id)!.value;
      const metadata = Object.fromEntries(["sources", ...(kind !== "event" ? ["subsector", "tags"] : []), ...(kind === "company" ? ["stage"] : [])].flatMap(key => key in existing ? [[key, (existing as unknown as Record<string, unknown>)[key]]] : []));
      input = { ...metadata, ...body };
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) return failure(400, parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("；"));
    if (kind === "company") {
      const c = StudyCompanySchema.parse(input);
      if (records.some(r => r.kind === "company" && r.value.id !== id && r.value.sector === c.sector && r.value.cohort === c.cohort && (r.value.rank === c.rank || r.value.symbol === c.symbol))) return failure(409, "该观察位或公司代码已存在，请编辑已有条目或选择空位。");
    }
    const record = { kind, value: { ...parsed.data, id: id ?? randomUUID(), updatedAt: new Date().toISOString() } } as StudyRecord;
    await storage.saveStudyRecord(record);
    return { status: method === "POST" ? 201 : 200, body: { record: record.value } };
  });
  boardLocks.set(storage, operation);
  return operation;
}
