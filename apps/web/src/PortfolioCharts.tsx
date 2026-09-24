import { useState } from "react";
import { Decimal } from "decimal.js";
import { formatMoney } from "./format";
export const CHART_COLORS = ["#50bfa9", "#668ff1", "#eda862", "#bd89df", "#df7385", "#84a0ac", "#a6b95d", "#d49056"];
export interface PieItem { id: string; label: string; value: string; signedValue?: string }
export function DonutChart({ title, items, currency, note, missing, centerLabel = "合计" }: { title: string; items: PieItem[]; currency: string; note: string; missing?: string; centerLabel?: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const valid = items.filter(item => new Decimal(item.value).gt(0));
  const total = valid.reduce((n, item) => n.plus(item.value), new Decimal(0));
  const active = valid.find(item => item.id === selected);
  let offset = 0;
  return <figure className="portfolio-chart"><figcaption><h3>{title}</h3><span>{currency}</span></figcaption>
    {missing || !valid.length ? <div className="chart-empty"><span aria-hidden="true">◯</span><p>{missing || "暂无可绘制的非零金额"}</p></div> : <div className="donut-layout"><svg viewBox="0 0 240 240" role="img" aria-label={`${title}：${valid.map(item => `${item.label} ${item.signedValue ?? item.value} ${currency}`).join('；')}`}>
      <circle cx="120" cy="120" r="82" fill="none" stroke="var(--line)" strokeWidth="28" />
      {valid.map((item, index) => { const share = new Decimal(item.value).div(total).toNumber() * 100; const start = offset; offset += share; return <circle key={item.id} cx="120" cy="120" r="82" pathLength="100" fill="none" stroke={CHART_COLORS[index % CHART_COLORS.length]} strokeWidth={active?.id === item.id ? 34 : 28} strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 120 120)" onMouseEnter={() => setSelected(item.id)} onMouseLeave={() => setSelected(null)}><title>{item.label} · {formatMoney(item.signedValue ?? item.value)} {currency} · {share.toFixed(1)}%</title></circle>; })}
      <text x="120" y="113" textAnchor="middle" className="donut-label">{active ? "所选金额" : centerLabel}</text><text x="120" y="139" textAnchor="middle" className="donut-total">{formatMoney(active?.signedValue ?? active?.value ?? total.toFixed())}</text>
    </svg><ul className="chart-legend">{valid.map((item, index) => <li key={item.id}><button type="button" aria-pressed={active?.id === item.id} onFocus={() => setSelected(item.id)} onBlur={() => setSelected(null)} onClick={() => setSelected(active?.id === item.id ? null : item.id)}><i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} /><span>{item.label}</span><strong>{formatMoney(item.signedValue ?? item.value)}</strong><small>{new Decimal(item.value).div(total).mul(100).toFixed(1)}%</small></button></li>)}</ul></div>}
    <p className="chart-note">{note}</p>
  </figure>;
}
