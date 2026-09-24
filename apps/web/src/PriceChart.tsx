import Decimal from "decimal.js";
import { useId, useMemo, useRef, useState } from "react";
import { CHART_BAR_LIMIT, CHART_VISIBLE_BARS, MA_PERIODS, type MovingAverages } from "@invest/domain";
import { formatMoney, formatTimestamp } from "./format";

export interface ChartPoint { time: number; price: string; open?: string; high?: string; low?: string; ma?: MovingAverages }
const LEFT = 18, RIGHT = 542, TOP = 22, BOTTOM = 204, WIDTH = 640;
const COLORS = { 5: "#d89b27", 15: "#568de5", 30: "#b172d0", 200: "#dc7263" };
const valid = (p: ChartPoint) => {
  try { return Number.isFinite(p.time) && [p.price, p.open ?? p.price, p.high ?? p.price, p.low ?? p.price].every(v => new Decimal(v).isFinite()); } catch { return false; }
};

export function PriceChart({ points, quoteAsset, priceScale, candles = false, timeframe, timeZone, showMovingAverages = true, caption }: {
  points: ChartPoint[]; quoteAsset: string; priceScale: number; candles?: boolean; timeframe?: string; timeZone?: string; showMovingAverages?: boolean; caption?: string;
}) {
  const [windowSize, setWindowSize] = useState(CHART_VISIBLE_BARS);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [enabled, setEnabled] = useState<readonly number[]>(MA_PERIODS);
  const drag = useRef<{ x: number; start: number; width: number } | null>(null);
  const gradientId = useId().replace(/:/g, "");
  const allRows = useMemo(() => [...new Map(points.filter(valid).map(p => [p.time, p])).values()].sort((a, b) => a.time - b.time).slice(-CHART_BAR_LIMIT), [points]);
  const size = windowSize;
  const maxStart = Math.max(0, allRows.length - size);
  const anchor = endTime === null ? allRows.length - 1 : allRows.reduce((last, p, i) => p.time <= endTime ? i : last, -1);
  const start = Math.max(0, Math.min(maxStart, anchor - size + 1));
  const rows = useMemo(() => allRows.slice(start, start + size), [allRows, start, size]);
  const pan = (next: number) => {
    const offset = Math.max(0, Math.min(maxStart, Math.round(next)));
    setEndTime(offset === maxStart ? null : allRows[Math.min(allRows.length - 1, offset + size - 1)]?.time ?? null);
    setActiveIndex(null);
  };
  const geometry = useMemo(() => {
    if (!rows.length) return null;
    const values = rows.flatMap(point => [point.low ?? point.price, point.high ?? point.price,
      ...(candles && showMovingAverages ? MA_PERIODS.filter(p => enabled.includes(p)).flatMap(p => point.ma?.[p] == null ? [] : [point.ma[p]!]) : [])]).map(v => new Decimal(v));
    const min = Decimal.min(...values), max = Decimal.max(...values);
    const margin = max.eq(min) ? Decimal.max(min.abs().mul("0.001"), "0.00000001") : max.minus(min).mul("0.12");
    const low = min.minus(margin), high = max.plus(margin), span = high.minus(low);
    const y = (price: string) => BOTTOM - new Decimal(price).minus(low).div(span).mul(BOTTOM - TOP).toNumber();
    const first = rows[0].time, duration = rows.at(-1)!.time - first;
    const x = (i: number) => candles ? LEFT + (i + .5) / rows.length * (RIGHT - LEFT)
      : duration === 0 ? (LEFT + RIGHT) / 2 : LEFT + (rows[i].time - first) / duration * (RIGHT - LEFT);
    return { low, span, x, y };
  }, [rows, candles, enabled, showMovingAverages]);
  if (!rows.length || !geometry) return <div className="chart-empty"><span aria-hidden="true">⌁</span><strong>尚无可绘制的数据</strong><p>数据源采集到历史行情后会自动显示。</p></div>;
  const { x, y, low, span } = geometry;
  const index = activeIndex === null ? rows.length - 1 : Math.min(activeIndex, rows.length - 1), selected = rows[index];
  const path = rows.map((point, i) => `${x(i)},${y(point.price)}`).join(" ");
  const daily = timeframe === "1d" || (candles && rows.length > 1 && (rows.at(-1)!.time - rows[0].time) / (rows.length - 1) >= 20 * 3600000);
  const dateLabel = (time: number) => new Intl.DateTimeFormat("zh-CN", daily ? { timeZone: "UTC", month: "2-digit", day: "2-digit" }
    : rows.at(-1)!.time - rows[0].time > 86400000 ? { timeZone, month: "2-digit", day: "2-digit" } : { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(time);
  const fullDate = (time: number) => daily ? new Date(time).toISOString().slice(0, 10) : timeZone ? `${new Intl.DateTimeFormat("zh-CN", {timeZone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).format(time)} ET` : formatTimestamp(new Date(time).toISOString());
  return <div className="interactive-chart" data-loaded-bars={allRows.length} data-visible-bars={rows.length} data-first-time={rows[0].time} data-last-time={rows.at(-1)!.time}>
    <div className="chart-toolbar"><span>{quoteAsset} · 已加载 {allRows.length} · 显示 {rows.length} {candles ? "根 K 线" : "个采样点"}</span>
      {candles ? <button className="text-button" onClick={() => pan(maxStart)} disabled={start === maxStart}>回到最新</button> : <div className="segmented-control" aria-label="图表范围">{[20, 40, 80].map(n => <button key={n} aria-pressed={n === windowSize} onClick={() => { setWindowSize(n); setEndTime(null); setActiveIndex(null); }}>最近 {n}</button>)}</div>}
    </div>
    {candles && <label className="chart-window-size">显示数量<input type="range" aria-label="K 线显示数量" min={Math.min(10, allRows.length)} max={allRows.length} step={1} value={Math.min(windowSize, allRows.length)} disabled={allRows.length <= 10} onChange={event => { setWindowSize(Number(event.target.value)); setActiveIndex(null); }} /><output>{Math.min(windowSize, allRows.length)} 根</output></label>}
    <div className="chart-readout numeric" aria-live="off"><time>{fullDate(selected.time)}</time>
      {candles ? <span>开 {formatMoney(selected.open, priceScale)} · 高 {formatMoney(selected.high, priceScale)} · 低 {formatMoney(selected.low, priceScale)} · 收 <strong>{formatMoney(selected.price, priceScale)}</strong></span> : <strong>{formatMoney(selected.price, priceScale)} <small>{quoteAsset}</small></strong>}
    </div>
    {candles && showMovingAverages && <div className="chart-ma-legend" aria-label="移动平均线">{MA_PERIODS.map(period => <button key={period} style={{ color: COLORS[period] }} aria-pressed={enabled.includes(period)} title={`最近 ${period} 根已完成 K 线收盘价的算术平均；不足 ${period} 根时留空`} onClick={() => setEnabled(current => current.includes(period) ? current.filter(p => p !== period) : [...current, period])}><i />MA{period} <b>{selected.ma?.[period] == null ? "—" : formatMoney(selected.ma[period], priceScale)}</b></button>)}</div>}
    <div className={`chart-wrap ${candles ? "chart-wrap--pan" : ""}`} tabIndex={0} role="group" aria-label={`${candles ? "K 线" : "价格走势"}，左右键查看读数，Shift 加方向键或 PageUp、PageDown 拖动区间`}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Home") pan(0);
        else if (event.key === "End") pan(maxStart);
        else if (event.key === "PageUp" || event.key === "PageDown") pan(start + (event.key === "PageUp" ? -size : size));
        else if (event.shiftKey) pan(start + (event.key === "ArrowLeft" ? -1 : 1));
        else setActiveIndex(Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1))));
      }}>
      <svg className="price-chart" viewBox="0 0 640 244" role="img" aria-label={`${candles ? "K 线" : "价格走势"} · ${quoteAsset}`}
        onPointerDown={event => { if (event.button !== 0 || !candles) return; const box = event.currentTarget.getBoundingClientRect(); drag.current = { x: event.clientX, start, width: box.width * (RIGHT - LEFT) / WIDTH }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onPointerMove={event => {
          if (drag.current) { pan(drag.current.start - (event.clientX - drag.current.x) / drag.current.width * size); return; }
          const box = event.currentTarget.getBoundingClientRect(), target = (event.clientX - box.left) / box.width * WIDTH;
          let nearest = 0; rows.forEach((_, i) => { if (Math.abs(x(i) - target) < Math.abs(x(nearest) - target)) nearest = i; });
          setActiveIndex(nearest);
        }} onPointerLeave={() => { if (!drag.current) setActiveIndex(null); }}>
        <defs><linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".22" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
        {[0, 1, 2, 3, 4].map(tick => { const value = low.plus(span.mul(tick).div(4)), py = y(value.toFixed()); return <g key={tick} className="chart-grid"><line x1={LEFT} x2={RIGHT} y1={py} y2={py} /><text x={RIGHT + 12} y={py + 4}>{formatMoney(value.toFixed(), priceScale)}</text></g>; })}
        {candles ? <>
          {MA_PERIODS.filter(p => showMovingAverages && enabled.includes(p)).map(period => {
            let previous = false;
            const line = rows.map((point, i) => { const value = point.ma?.[period]; if (value == null) { previous = false; return ""; } const command = previous ? "L" : "M"; previous = true; return `${command}${x(i)},${y(value)}`; }).join(" ");
            return <path key={period} data-ma={period} d={line} fill="none" stroke={COLORS[period]} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />;
          })}
          {rows.map((point, i) => { const px = x(i), open = y(point.open ?? point.price), close = y(point.price), width = Math.max(1, Math.min(12, (RIGHT - LEFT) / rows.length * .65)); return <g key={point.time} className={`candle candle--${new Decimal(point.price).gte(point.open ?? point.price) ? "up" : "down"}`}><line x1={px} x2={px} y1={y(point.high ?? point.price)} y2={y(point.low ?? point.price)} /><rect x={px - width / 2} y={Math.min(open, close)} width={width} height={Math.max(1, Math.abs(open - close))} /></g>; })}
        </> : <><polygon points={`${x(0)},${BOTTOM} ${path} ${x(rows.length - 1)},${BOTTOM}`} fill={`url(#${gradientId})`} /><polyline points={path} className="sparkline-path" fill="none" />{rows.length === 1 && <circle cx={x(0)} cy={y(rows[0].price)} r="4" fill="var(--accent)" />}</>}
        {[0, Math.floor((rows.length - 1) / 2), rows.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i, tick) => <text key={i} className="chart-time" x={x(i)} y="234" textAnchor={tick === 0 ? "start" : i === rows.length - 1 ? "end" : "middle"}>{dateLabel(rows[i].time)}</text>)}
        {activeIndex !== null && <g className="chart-crosshair"><line x1={x(index)} x2={x(index)} y1={TOP} y2={BOTTOM} /><line x1={LEFT} x2={RIGHT} y1={y(selected.price)} y2={y(selected.price)} /><circle cx={x(index)} cy={y(selected.price)} r="4" /></g>}
      </svg>
    </div>
    {candles && <div className="chart-scroll"><button className="text-button" aria-label="更早的 K 线" disabled={!start} onClick={() => pan(start - 40)}>←</button><input type="range" aria-label="拖动 K 线历史区间" min={0} max={maxStart} step={1} value={start} disabled={!maxStart} onChange={event => pan(Number(event.target.value))} /><button className="text-button" aria-label="更新的 K 线" disabled={start === maxStart} onClick={() => pan(start + 40)}>→</button><span>{fullDate(rows[0].time)} — {fullDate(rows.at(-1)!.time)}</span></div>}
    <p className="chart-caption">{caption ?? (candles ? "拖动图表或下方滑块查看历史 · 每个交易周期等距排列 · 均线不足周期时留空" : "按真实时间间隔绘制 · 悬浮、触摸或方向键查看读数")}</p>
  </div>;
}
