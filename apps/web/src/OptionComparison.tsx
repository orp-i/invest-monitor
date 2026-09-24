import Decimal from "decimal.js";
import { useMemo, useState } from "react";
import type { MarketHistoryResponse, MarketQuote, MarketQuotesResponse } from "@invest/domain";
import { useChartData } from "./useChartData";
import { PriceChart } from "./PriceChart";
import { IntradayChart } from "./IntradayChart";
import { formatMoney, formatMarketTimestamp } from "./format";

const money = (value: string | null | undefined) => formatMoney(value ?? null, 4);
export function OptionComparison({ selected, contracts, spot }: { selected: MarketQuote | null; contracts: MarketQuote[]; spot?: string | null }) {
  const base = useMemo(() => selected ?? contracts.reduce<MarketQuote | null>((best, q) => {
    if (!q.strike) return best;
    if (!best) return q;
    return new Decimal(q.strike).minus(spot ?? q.strike).abs().lt(new Decimal(best.strike!).minus(spot ?? best.strike!).abs()) ? q : best;
  }, null), [selected, contracts, spot]);
  if (!base) return <p className="empty-state">选择到期日后，自动显示平值附近的 Call / Put；点击合约可切换行权价。</p>;
  return <ComparisonPair key={`${base.underlying}:${base.expiration}:${base.strike}:${base.symbol.replace(/(\d{6})[CP](\d{8})$/, "$1X$2")}`} base={base} contracts={contracts} />;
}

function ComparisonPair({ base, contracts }: { base: MarketQuote; contracts: MarketQuote[] }) {
  const [date, setDate] = useState("");
  const [mode, setMode] = useState("daily");
  const codes = useMemo(() => ({ call: base.symbol.replace(/(\d{6})[CP](\d{8})$/, "$1C$2"), put: base.symbol.replace(/(\d{6})[CP](\d{8})$/, "$1P$2") }), [base.symbol]);
  const known = [base, ...contracts];
  const missing = Object.values(codes).filter(code => !known.some(q => q.symbol === code));
  const extra = useChartData<MarketQuotesResponse>(missing.length ? `/api/market/quotes?symbols=${missing.sort().join(",")}` : "", 30000);
  const call = useChartData<MarketHistoryResponse>(`/api/market/history?symbol=${encodeURIComponent(codes.call)}`, 6 * 3600000);
  const put = useChartData<MarketHistoryResponse>(`/api/market/history?symbol=${encodeURIComponent(codes.put)}`, 6 * 3600000);
  const days = useMemo(() => [...new Set([...(call.data?.candles ?? []), ...(put.data?.candles ?? [])].map(c => c.openTime.slice(0, 10)))].sort().reverse(), [call.data, put.data]);
  const selectedDate = days.includes(date) ? date : days[0] ?? "";
  const callDay = call.data?.candles.find(c => c.openTime.startsWith(selectedDate));
  const putDay = put.data?.candles.find(c => c.openTime.startsWith(selectedDate));
  return <section className="option-comparison" aria-label="Call 和 Put 对照">
    <div className="content-heading"><div><p className="eyebrow">CALL / PUT · DAILY CANDLES</p><h4>{base.underlying} · {base.expiration} 到期 · 行权价 {money(base.strike)}</h4><p className="muted">同一到期日、行权价的双向合约 · 价格单位 USD / 股</p></div></div>
    <div className="segmented-control" aria-label="期权图表类型"><button aria-pressed={mode === "daily"} onClick={() => setMode("daily")}>日 K</button><button aria-pressed={mode === "intraday"} onClick={() => setMode("intraday")}>分时图</button></div>
    <div className="option-date-comparison"><label>交易日期<select aria-label="期权历史交易日期" value={selectedDate} disabled={!days.length} onChange={event => setDate(event.target.value)}>{!days.length && <option value="">等待历史数据</option>}{days.map(day => <option key={day}>{day}</option>)}</select></label><div><span>Call 当日收盘</span><strong>{money(callDay?.close)}</strong></div><div><span>Put 当日收盘</span><strong>{money(putDay?.close)}</strong></div><p>日期为交易日；无数据的一侧显示「—」。</p></div>
    <div className="option-comparison-grid">{(["call", "put"] as const).map(right => {
      const history = right === "call" ? call : put, day = right === "call" ? callDay : putDay;
      const quote = known.find(q => q.symbol === codes[right]) ?? extra.data?.quotes.find(q => q.symbol === codes[right]);
      return <article key={right} className={`option-comparison-card option-comparison-card--${right}`} data-option-right={right}>
        <header><span className={`option-right option-right--${right}`}>{right === "call" ? "看涨 CALL" : "看跌 PUT"}</span><strong>{codes[right]}</strong></header>
        <dl className="option-pair-stats"><div><dt>最近成交</dt><dd>{money(quote?.last)}</dd></div><div><dt>买 / 卖</dt><dd>{money(quote?.bid)} / {money(quote?.ask)}</dd></div><div><dt>IV / Delta</dt><dd>{quote?.greeks?.midIv == null ? "—" : `${new Decimal(quote.greeks.midIv).mul(100).toFixed(2)}%`} / {money(quote?.greeks?.delta)}</dd></div><div><dt>合约规模</dt><dd>{quote?.contractSize ?? "—"}</dd></div></dl>
        <p className="chart-note">成交时间 {quote?.tradeAt ? formatMarketTimestamp(quote.tradeAt) : "无成交时间"}</p>
        {day && <p className="option-date-ohlc">{selectedDate} · 开 {money(day.open)} / 高 {money(day.high)} / 低 {money(day.low)} / 收 {money(day.close)}</p>}
        {history.error && <p className="inline-error" role="alert">{history.error.message}</p>}
        {!!history.data?.warnings?.length && <details className="chart-data-warning"><summary>历史数据有异常日期，均线按有效 K 线计算</summary>{history.data.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
        {mode === "intraday" ? <IntradayChart symbol={codes[right]} tradeAt={quote?.tradeAt} /> : history.data ? history.data.candles.length ? <PriceChart points={history.data.candles.map(c => ({ time: Date.parse(c.openTime), price: c.close, open: c.open, high: c.high, low: c.low, ma: c.ma }))} quoteAsset="USD" priceScale={4} timeframe="1d" candles /> : <p className="empty-state">{history.data.notice || "该合约没有可用日 K 线。"}</p> : !history.error && <p className="empty-state">正在加载 {right.toUpperCase()} 历史 K 线…</p>}
      </article>;
    })}</div>
    {extra.error && <p className="inline-error">另一侧合约报价：{extra.error.message}</p>}
    <p className="chart-note">最多加载 240 根日 K，默认显示最近 80 根；MA5 / 15 / 30 / 200 按已完成 K 线收盘价计算。上市较短或缺少成交的合约可能不足 240 根，均线不足周期时留空。</p>
  </section>;
}
