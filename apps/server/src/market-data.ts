import { Decimal } from "decimal.js";
import {
  marketList, marketRecord, normalizeMarketQuotes, optionSymbolPattern, stockSymbolPattern,
  parseTradier, requestTradier, tradierStocksAdapter, validMarketDay, refreshTradierCalendar, tradierCalendarDay, type AdapterContext,
} from "@invest/adapters";
import { candleChartWindow, newYorkTime, type MarketMeta, type SourceError } from "@invest/domain";
import type { EgressHttpClient } from "@invest/egress";

interface Reply { status: number; body: Record<string, unknown> }
interface CacheEntry { expiresAt: number; pending: boolean; reply: Promise<Reply> }
const caches = new WeakMap<EgressHttpClient, Map<string, CacheEntry>>();
const failure = (status: number, message: string): Reply => ({ status, body: { source: "Tradier", message } });
const fromError = (error: SourceError): Reply => failure(error.kind === "rate_limited" ? 429 : 502,
  error.kind === "auth" ? "Tradier Token 无效或缺少行情权限，请检查服务器 .env。"
    : error.kind === "rate_limited" ? `Tradier 行情请求限流，请约 ${error.retryAfterSeconds ?? 60} 秒后重试。`
      : "Tradier 行情暂时不可用，请稍后重试或检查网络及行情权限。");

// These authenticated, read-only endpoints use the exact same egress client,
// official-origin checks and token quota as scheduled equity quotes/search.
export async function tradierMarketData(url: URL, context: AdapterContext): Promise<Reply> {
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  const expiration = url.searchParams.get("expiration") ?? "";
  const symbols = [...new Set((url.searchParams.get("symbols") ?? "").split(",").map(s => s.trim().toUpperCase()))].sort();
  const quotes = url.pathname === "/api/market/quotes";
  const history = url.pathname === "/api/market/history";
  const intraday = url.pathname === "/api/market/timesales";
  const date = url.searchParams.get("date") ?? "";
  const session = url.searchParams.get("session") ?? "regular";
  const expirations = url.pathname === "/api/options/expirations";
  const validSymbol = (s: string) => optionSymbolPattern.test(s) || stockSymbolPattern.test(s);
  if (quotes ? symbols.length > 50 || symbols.some(s => !validSymbol(s)) : !validSymbol(symbol) || (!history && !intraday && optionSymbolPattern.test(symbol))) return failure(400, "请输入有效的美股代码或 OCC 期权代码，每次最多查询 50 个报价。");
  if (intraday && !["pre", "regular", "post", "overnight"].includes(session)) return failure(400, "请选择有效交易时段。");
  if (intraday && !validMarketDay(date)) return failure(400, "请选择有效交易日期（YYYY-MM-DD）。");
  if (!quotes && !history && !intraday && !expirations && !validMarketDay(expiration)) return failure(400, "请选择有效到期日（YYYY-MM-DD）。");
  if (!context.authToken?.trim()) return failure(503, "请在服务器 .env 填写 TRADIER_ACCESS_TOKEN 后重新创建服务容器。");
  const key = JSON.stringify([context.source.baseUrl, context.source.id, context.authToken, url.pathname, quotes ? symbols : symbol, expiration, date, session]);
  const cache = caches.get(context.httpClient) ?? new Map<string, CacheEntry>();
  caches.set(context.httpClient, cache);
  const now = Date.now();
  for (const [k, v] of cache) if (!v.pending && v.expiresAt <= now) cache.delete(k);
  const saved = cache.get(key);
  if (saved) return saved.reply;
  if (cache.size >= 64) {
    const oldest = [...cache].find(([, v]) => !v.pending);
    if (oldest) cache.delete(oldest[0]);
    else return failure(503, "行情查询繁忙，请稍后重试。");
  }
  const entry: CacheEntry = { pending: true, expiresAt: Infinity, reply: Promise.resolve(failure(503, "正在查询行情")) };
  entry.reply = load().catch(() => failure(502, "Tradier 行情请求未完成，请稍后重试。")).then(reply => {
    entry.pending = false;
    const marketToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    entry.expiresAt = Date.now() + (reply.status !== 200 ? 5000 : history || expirations || (intraday && date < marketToday) ? 6 * 3600000 : 30000);
    return reply;
  });
  cache.set(key, entry);
  return entry.reply;

  async function load(): Promise<Reply> {
    const environment = new URL(context.source.baseUrl).hostname === "sandbox.tradier.com" ? "sandbox" : "live";
    const meta: MarketMeta = { source: "Tradier", environment, currency: "USD", receivedAt: new Date().toISOString() };
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const occ = optionSymbolPattern.test(symbol) ? symbol.match(/(\d{2})(\d{2})(\d{2})[CP]\d{8}$/) : null;
    if (history && occ && `20${occ[1]}-${occ[2]}-${occ[3]}` < today) return { status: 200, body: { ...meta, symbol, candles: [], notice: "Tradier 不提供已到期期权的历史行情；成交与复盘记录仍保留。" } };
    const start = new Date(`${today}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 730);
    if (intraday && (date > today || Date.parse(today) - Date.parse(date) > 40 * 86400000)) return { status: 200, body: { ...meta, symbol, date, interval: "5min", points: [], notice: "Tradier 5 分钟分时数据最多回溯约 40 天；请选择最近的交易日。" } };
    let range = { start: "09:30", end: "16:00" };
    if (intraday) {
      const empty = (notice: string): Reply => ({ status: 200, body: { ...meta, symbol, date, session, interval: "5min", points: [], notice } });
      if (session === "overnight") return empty("夜盘 · 当前 Tradier 接口的夜盘覆盖未确认，暂无可确认夜盘行情；不以盘后或旧报价替代。");
      if (optionSymbolPattern.test(symbol) && session !== "regular") return empty("期权扩展交易时段取决于具体合约与交易所，尚未确认，不能套用股票时段。");
      await refreshTradierCalendar(context, date);
      const schedule = tradierCalendarDay(context.httpClient, context.source.baseUrl, context.authToken, date);
      if (!schedule) return failure(503, "交易日历暂不可用，无法确认交易时段，请稍后重试。");
      if (schedule.status === "closed") return empty("Tradier 交易日历：该日常规市场休市。");
      const selected = session === "pre" ? schedule.premarket : session === "post" ? schedule.postmarket : schedule.open;
      if (!selected) return empty("Tradier 交易日历未提供该日的所选交易时段。");
      range = selected;
    }
    const path = quotes ? "markets/quotes" : history ? "markets/history" : intraday ? "markets/timesales" : expirations ? "markets/options/expirations" : "markets/options/chains";
    const params: Record<string, string> = quotes ? { symbols: symbols.join(","), greeks: environment === "live" ? "true" : "false" }
      : history ? { symbol, interval: "daily", start: start.toISOString().slice(0, 10), end: today }
        : intraday ? { symbol, interval: "5min", start: `${date} ${range.start}`, end: `${date} ${range.end}`, session_filter: session === "regular" ? "open" : "all" }
        : expirations ? { symbol, includeAllRoots: "true", strikes: "false", contractSize: "false", expirationType: "false" }
          : { symbol, expiration, greeks: environment === "live" ? "true" : "false" };
    const response = await requestTradier(context, path, params, AbortSignal.timeout(30000));
    if (!response.ok) return fromError(response.error);
    const receivedContext = { ...context, now: response.value.receivedAt };
    meta.receivedAt = response.value.receivedAt;
    const parsed = parseTradier(response.value, receivedContext);
    if (!parsed.ok) return fromError(parsed.error);
    const root = parsed.value;
    if (intraday) {
      if (!("series" in root) || (root.series !== null && root.series !== "null" && !Object.hasOwn(marketRecord(root.series) ?? {}, "data"))) return failure(502, "Tradier 分时行情响应不完整。");
      const points = new Map<number, { time: number; price: string }>();
      for (const raw of marketList(marketRecord(root.series)?.data)) {
        const row = marketRecord(raw), time = Number(row?.timestamp) * 1000;
        const price = row?.close ?? row?.price;
        if (!Number.isSafeInteger(time) || !Number.isFinite(new Date(time).getTime()) || typeof price !== "string" || !new Decimal(price).isFinite() || new Decimal(price).lt(0)) return failure(502, "Tradier 分时价格或时间格式异常。");
        const local = newYorkTime(time);
        if (local.date === date && local.time >= `${range.start}:00` && local.time < `${range.end}:00`) points.set(time, { time, price });
      }
      return { status: 200, body: { ...meta, symbol, date, session, interval: "5min", points: [...points.values()].sort((a,b) => a.time - b.time).slice(0, 80), notice: `Tradier · 5 分钟分时 · ${{pre:"盘前",regular:"盘中",post:"盘后"}[session as "pre" | "regular" | "post"]} ${range.start}–${range.end} ET · 无成交区间保留缺口${optionSymbolPattern.test(symbol) ? " · 期权仅展示股票常规时段交集，其他合约时段未确认" : ""}` } };
    }
    if (history) {
      const result = tradierStocksAdapter.normalize(root, { ...receivedContext, capability: "candle", instrument: { ...context.instrument, id: symbol }, binding: { ...context.binding, providerSymbol: symbol } });
      if (!result.ok) return fromError(result.error);
      if (result.value.kind !== "candles") return failure(502, "Tradier 历史行情格式异常。");
      return { status: 200, body: { ...meta, symbol, candles: candleChartWindow(result.value.value), warnings: result.value.warnings ?? [], notice: "Tradier 日 K · 常规交易时段收盘价，不混入扩展时段报价 · 仅含已完成历史交易日 · 不保证股息复权；均线按有效收盘价计算，历史不足时留空。" } };
    }
    if (expirations) {
      if (!("expirations" in root)) return failure(502, "Tradier 到期日响应不完整。");
      const dates = marketList(marketRecord(root.expirations)?.date);
      if (dates.some(d => !validMarketDay(d)) || (root.expirations !== null && root.expirations !== "null" && !Object.hasOwn(marketRecord(root.expirations) ?? {}, "date"))) return failure(502, "Tradier 到期日格式异常。");
      return { status: 200, body: { ...meta, symbol, expirations: [...new Set(dates as string[])].filter(d => d >= today).sort() } };
    }
    const container = quotes ? "quotes" : "options", field = quotes ? "quote" : "option";
    if (!(container in root) || (root[container] !== null && root[container] !== "null" && !Object.hasOwn(marketRecord(root[container]) ?? {}, field))) return failure(502, "Tradier 行情响应不完整。");
    const normalized = normalizeMarketQuotes(marketRecord(root[container])?.[field], receivedContext);
    if (!normalized.ok) return fromError(normalized.error);
    const values = normalized.value;
    if (quotes) {
      if (values.some(q => !symbols.includes(q.symbol))) return failure(502, "Tradier 返回了不匹配的标的报价。");
      return { status: 200, body: { ...meta, quotes: values, missing: symbols.filter(s => !values.some(q => q.symbol === s)) } };
    }
    if (values.some(q => q.type !== "option" || q.underlying !== symbol || q.expiration !== expiration)) return failure(502, "Tradier 返回了不匹配的期权合约。");
    values.sort((a, b) => new Decimal(a.strike!).cmp(b.strike!) || a.symbol.localeCompare(b.symbol));
    return { status: 200, body: { ...meta, symbol, expiration, contracts: values } };
  }
}
