import { useState } from "react";
import type { MarketIntradayResponse } from "@invest/domain";
import { PriceChart } from "./PriceChart";
import { useChartData } from "./useChartData";

export function IntradayChart({ symbol, tradeAt, priceScale = 4 }: { symbol: string; tradeAt?: string | null; priceScale?: number }) {
  const latest = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(tradeAt ?? Date.now()));
  const [chosen, setChosen] = useState("");
  const date = chosen || latest;
  const [session, setSession] = useState("regular");
  const option = /\d{6}[CP]\d{8}$/.test(symbol);
  const result = useChartData<MarketIntradayResponse>(`/api/market/timesales?symbol=${encodeURIComponent(symbol)}&date=${date}&session=${session}`, 30000);
  return <div className="intraday-chart"><label className="intraday-date">交易日期（纽约）<input aria-label={`${symbol} 分时交易日期`} type="date" value={date} onChange={event => setChosen(event.target.value)} /></label>
    <div className="segmented-control" aria-label={`${symbol} 分时时段`}>{(option ? ["regular"] : ["pre", "regular", "post", "overnight"]).map(value => <button key={value} aria-pressed={session === value} onClick={() => setSession(value)}>{{pre:"盘前",regular:"盘中",post:"盘后",overnight:"夜盘"}[value]}</button>)}</div>
    {result.error && <p className="inline-error" role="alert">{result.error.message}</p>}
    {result.data ? <><p className="chart-note">{result.data.notice}</p>{result.data.points.length ? <PriceChart key={`${symbol}:${date}:${session}`} points={result.data.points} timeZone="America/New_York" quoteAsset="USD" priceScale={priceScale} /> : <p className="empty-state">该交易日没有可用分时数据，请选择其他日期。</p>}</> : !result.error && <p className="empty-state">正在加载分时行情…</p>}
  </div>;
}
