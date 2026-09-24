import { memo, useCallback, useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { balancingActions, brokerLabel, renderRiskExposureMarkdown, riskExposureReference, themeById, EXPOSURE_METHOD, HEDGE_BENCHMARKS, type BalancingAction, type RiskExposureAnalysis, type ThemeStatus } from "@invest/domain";
import { getJson } from "./api";
import { formatMoney, formatTimestamp } from "./format";

type Response = RiskExposureAnalysis & { sources: { quotes: { status: string; symbols: number; received: number; missing: string[]; message?: string }; betas: { status: string; benchmarks: string[]; estimated: string[]; unavailable: string[]; pending: string[]; message?: string } } };
const statusTone: Record<ThemeStatus, string> = { "unhedged-long": "warn", "unhedged-short": "warn", "over-hedged": "stale", "partially-hedged": "muted", neutral: "live", incomplete: "error", empty: "muted" };
const directionLabel = { bullish: "看多", bearish: "看空", neutral: "中性", unknown: "待核算" } as const;
const priorityLabel = { now: "建议执行", standby: "备用", info: "提示" } as const;
const signed = (value: string | null | undefined) => value === null || value === undefined ? "—" : formatMoney(value);
const tone = (value: string | null | undefined) => value === null || value === undefined ? "" : new Decimal(value).gte(0) ? "study-positive" : "study-negative";

export const RiskExposure = memo(function RiskExposure() {
  const [data, setData] = useState<Response | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [ratio, setRatio] = useState(0.5), [putDelta, setPutDelta] = useState("0.30"), [tick, setTick] = useState(0);
  const [openTheme, setOpenTheme] = useState<string | null>(null), [copied, setCopied] = useState("");
  useEffect(() => {
    let alive = true, pending = false, retries = 0, timer = 0;
    // Betas are estimated in a background job on the server; re-read a few times while it reports "pending".
    const refresh = async () => { if (pending) return; pending = true; setLoading(true); try { const result = await getJson<Response>("/api/risk-exposure"); if (alive) { setData(result); setError(""); if (result.sources.betas.status === "pending" && retries++ < 8) { window.clearTimeout(timer); timer = window.setTimeout(() => void refresh(), 8000); } } } catch (e) { if (alive) setError(e instanceof Error ? e.message : "风险敞口读取失败"); } finally { pending = false; if (alive) setLoading(false); } };
    const onUpdate = () => void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("invest:broker-data-updated", onUpdate);
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => { alive = false; window.clearTimeout(timer); window.removeEventListener("invest:broker-data-updated", onUpdate); document.removeEventListener("visibilitychange", onVisible); };
  }, [tick]);
  const delta = Math.min(Math.max(Number(putDelta) || 0.3, 0.05), 0.95);
  const actions = useMemo(() => data ? balancingActions(data, { ratio, putDelta: delta }) : [], [data, ratio, delta]);
  const current = useMemo(() => data ? { ...data, actions, options: { ratio, putDelta: delta } } : null, [data, actions, ratio, delta]);
  const exportJson = useCallback(() => {
    if (!current) return;
    const blob = new Blob([JSON.stringify(riskExposureReference(current), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `risk-exposure-${current.capturedAt.slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
  }, [current]);
  const copyMarkdown = useCallback(async () => {
    if (!current) return;
    try { await navigator.clipboard.writeText(renderRiskExposureMarkdown(current)); setCopied("Markdown 已复制"); }
    catch { setCopied("复制失败，请使用导出 JSON"); }
    window.setTimeout(() => setCopied(""), 3000);
  }, [current]);
  const byTheme = useMemo(() => { const map = new Map<string, BalancingAction[]>(); for (const a of actions) map.set(a.themeLabel, [...(map.get(a.themeLabel) ?? []), a]); return [...map]; }, [actions]);
  return <section className="risk-exposure widget"><header className="content-heading"><div><p className="eyebrow">RISK EXPOSURE · USD</p><h3>风险敞口分析</h3><p className="muted">按标的 Delta 名义 → 主题系数 → 平衡规则 R1–R5；参考结论，不下单。</p></div><div className="study-actions"><button className="text-button" onClick={() => setTick(n => n + 1)} disabled={loading}>{loading ? "核算中…" : "重新核算"}</button><button className="text-button" onClick={exportJson} disabled={!current}>导出参考包 JSON</button><button className="secondary-button" onClick={() => void copyMarkdown()} disabled={!current}>复制 Markdown 给 LLM</button></div></header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {copied && <p className="chart-note">{copied}</p>}
    {!current ? <p className="empty-state">{loading ? "正在读取持仓、报价与 Delta…（首次需读取基准历史估算 β，可能需要数秒）" : "同步券商持仓后显示风险敞口。"}</p> : <>
      <div className={`risk-verdict risk-verdict--${current.overall.direction}`}><div><span>总体方向 · 以美股市场 β 为主视角</span><strong>{current.overall.label}</strong><p>{current.overall.summary}</p></div></div>
      <div className="overview-metrics risk-metrics">
        <div><span>多头 Delta 名义</span><strong className="numeric">{formatMoney(current.totals.long)}</strong><p>按标的分组轧差后的多头合计</p></div>
        <div><span>空头 Delta 名义</span><strong className="numeric">{formatMoney(current.totals.short)}</strong><p>看空期权按 Delta 折算</p></div>
        <div><span>净敞口 / 占净资产</span><strong className={`numeric ${tone(current.totals.net)}`}>{formatMoney(current.totals.net)}</strong><p>{current.totals.netToEquity === null ? "净资产未知" : `${current.totals.netToEquity}% · 毛敞口 ${formatMoney(current.totals.gross)}（${current.totals.grossToEquity ?? "—"} 倍）`}</p></div>
        <div><span>限定风险最大亏损</span><strong className="numeric">{signed(current.totals.definedMaxLoss)}</strong><p>{current.totals.definedRiskGroups} 组结构{current.totals.definedMaxLossToEquity === null ? "" : ` · 占净资产 ${current.totals.definedMaxLossToEquity}%`}{current.totals.unlimitedRiskGroups ? ` · ${current.totals.unlimitedRiskGroups} 组无上限` : ""}</p></div>
      </div>
      <div className="content-heading"><div><h4>主题敞口</h4><p className="muted">主题敞口 = Delta 名义 × 目录系数；一个标的可同时属于多个主题（如 EWY 同时计入韩国股市与存储芯片 0.5）。“占比大”= |净| ≥ 净资产 {Math.round(current.thresholds.significantToEquity * 100)}%。</p></div></div>
      <div className="position-table-wrap"><table className="position-table risk-table"><thead><tr><th>主题</th><th>多头</th><th>空头</th><th>净</th><th>占净资产</th><th>覆盖率</th><th>状态</th><th>构成</th></tr></thead><tbody>
        {current.themes.map(t => <tr key={t.id} className={openTheme === t.id ? "risk-row--open" : ""} onClick={() => setOpenTheme(openTheme === t.id ? null : t.id)}>
          <td><strong>{t.label}</strong><span>{themeById(t.id)?.description}</span></td><td className="numeric">{formatMoney(t.long)}</td><td className="numeric">{formatMoney(t.short)}</td><td className={`numeric ${tone(t.net)}`}>{formatMoney(t.net)}{t.id === "us-equity" && t.netBetaAdjusted.SPY ? <span>β 调整 {formatMoney(t.netBetaAdjusted.SPY)}</span> : null}</td><td className="numeric">{t.netToEquity === null ? "—" : `${t.netToEquity}%`}</td><td className="numeric">{t.coverage === null ? "—" : `${t.coverage}%`}</td>
          <td><span className={`risk-chip risk-chip--${statusTone[t.status]}`}>{t.statusLabel}</span>{t.significant ? <span className="risk-chip risk-chip--warn">占比大</span> : null}</td>
          <td className="risk-contributions">{(openTheme === t.id ? t.contributions : t.contributions.slice(0, 3)).map(c => <span key={c.underlying}>{c.underlying} × {c.coefficient} = {formatMoney(c.notional)}{openTheme === t.id ? <small>{c.basis}</small> : null}</span>)}{openTheme !== t.id && t.contributions.length > 3 ? <span>… 共 {t.contributions.length} 项，点击展开</span> : null}</td>
        </tr>)}
      </tbody></table></div>
      {current.themes.some(t => t.id === "us-equity") ? <p className="chart-note">美股权益 β 调整净敞口：{HEDGE_BENCHMARKS.map(b => `对 ${b} ${signed(current.themes.find(t => t.id === "us-equity")!.netBetaAdjusted[b])} USD`).join(" · ")}；β 来自本地日 K 与 Tradier 历史的 250 日回归{current.sources.betas.status === "pending" ? <span className="risk-chip risk-chip--warn">β 后台估算中，稍后自动更新</span> : null}{current.sources.betas.unavailable.length ? `，${current.sources.betas.unavailable.join("、")} 暂无 β（按 1 计）` : ""}。</p> : null}
      <div className="content-heading"><div><h4>标的明细与结构</h4><p className="muted">Delta 名义 = 数量 × 合约规模 × Delta × 标的价格；最大亏损按结构规则计算，不含手续费与流动性风险。</p></div></div>
      <div className="position-table-wrap"><table className="position-table risk-table"><thead><tr><th>标的 / 结构</th><th>方向</th><th>Delta 股数</th><th>Delta 名义</th><th>市值</th><th>最大亏损</th><th>最近到期</th><th>主题归属</th><th>β (SPY)</th></tr></thead><tbody>
        {current.groups.map(g => <tr key={g.underlying}><td><strong>{g.underlying}</strong><span>{g.profileLabel}</span><span>{g.structure}</span><details className="risk-legs"><summary>{g.legs.length} 腿</summary>{g.legs.map(l => <p key={`${l.broker}:${l.accountId}:${l.symbol}`}>{brokerLabel(l.broker)} {l.symbol} · {l.quantity} × {l.multiplier ?? "?"} × Δ{l.delta ?? "?"} × {l.kind === "option" ? `${g.underlyingPrice ?? "?"}` : l.markPrice ?? "?"} = {signed(l.deltaNotional)}{l.markSource === "tradier" && l.markAt ? ` · 报价 ${formatTimestamp(l.markAt)}` : ""}{l.notes.length ? ` · ${l.notes.join("；")}` : ""}</p>)}</details></td>
          <td><span className={`risk-chip risk-chip--${g.direction === "bullish" ? "live" : g.direction === "bearish" ? "stale" : "muted"}`}>{directionLabel[g.direction]}</span></td><td className="numeric">{g.deltaShares ?? "—"}</td><td className={`numeric ${tone(g.deltaNotional)}`}>{signed(g.deltaNotional)}</td><td className="numeric">{signed(g.marketValue)}</td>
          <td>{g.maxLoss ? <><strong className="numeric">{formatMoney(g.maxLoss.value)}</strong><span>{g.maxLoss.basis}</span></> : g.unlimitedRisk ? <span className="risk-chip risk-chip--error">无上限</span> : "—"}</td><td>{g.nearestExpiry ? <>{g.nearestExpiry}<span>{g.daysToExpiry} 天</span></> : "—"}</td>
          <td className="risk-contributions">{g.memberships.map(m => <span key={m.theme}>{themeById(m.theme)?.label ?? m.theme} × {m.coefficient}</span>)}{!g.listed ? <span className="risk-chip risk-chip--muted">目录外</span> : null}</td><td className="numeric">{g.betas.SPY ? <>{g.betas.SPY.beta}<span>r={g.betas.SPY.correlation} · n={g.betas.SPY.samples}</span></> : g.memberships.some(m => m.theme === "us-equity") ? "按 1" : "—"}</td></tr>)}
      </tbody></table></div>
      <div className="content-heading"><div><h4>发现与未对冲敞口</h4></div></div>
      <ul className="risk-findings">{current.findings.map(f => <li key={f.title} className={`risk-finding risk-finding--${f.severity}`}><span className={`risk-chip risk-chip--${f.severity === "high" ? "error" : f.severity === "medium" ? "warn" : "muted"}`}>{{ high: "高", medium: "中", info: "参考" }[f.severity]}</span><div><strong>{f.title}</strong><p>{f.detail}</p></div></li>)}</ul>
      <div className="content-heading"><div><h4>平衡 / 对冲动作参考</h4><p className="muted">R1 大量空头配置部分同主题多头 · R2 大量正股在下跌判断下备兑/买入认沽 · R3 跨资产关系对冲 · R4 指数对冲按 β 与 Delta 定量 · R5 限定风险按最大亏损占比控制。最新日报判断：{current.marketContext.latestDaily ? `${current.marketContext.latestDaily.date} ${current.marketContext.latestDaily.stanceLabel}` : "无"}。</p></div><div className="filter-toolbar risk-controls"><label>对冲比例<div className="segmented-control">{[0.25, 0.5, 1].map(r => <button key={r} aria-pressed={ratio === r} onClick={() => setRatio(r)}>{Math.round(r * 100)}%</button>)}</div></label><label>认沽 |Delta| 假设<input aria-label="认沽 Delta 假设" type="number" min="0.05" max="0.95" step="0.05" value={putDelta} onChange={e => setPutDelta(e.target.value)} /></label></div></div>
      {byTheme.length ? byTheme.map(([theme, rows]) => <div key={theme} className="risk-action-group"><h5>{theme}</h5><div className="position-table-wrap"><table className="position-table risk-table"><thead><tr><th>规则</th><th>优先级</th><th>动作</th><th>数量</th><th>参考价</th><th>目标 / 工具名义</th><th>附带敞口</th><th>说明</th></tr></thead><tbody>
        {rows.map((a, i) => <tr key={`${a.rule}:${a.tool.symbol}:${a.title}:${i}`}><td><strong>{a.rule}</strong></td><td><span className={`risk-chip risk-chip--${a.priority === "now" ? "warn" : a.priority === "standby" ? "muted" : "live"}`}>{priorityLabel[a.priority]}</span></td><td><strong>{a.title}</strong><span>{a.tool.label}</span></td><td className="numeric">{a.quantity === null ? "—" : `${a.quantity} ${a.unit}`}</td><td className="numeric">{a.price ?? "—"}{a.priceAt ? <span>{formatTimestamp(a.priceAt)}</span> : null}</td><td className="numeric">{signed(a.notional)}</td><td className="risk-contributions">{a.sideEffects.length ? a.sideEffects.map(e => <span key={e.theme}>{e.label} {formatMoney(e.notional)}</span>) : "—"}</td><td className="risk-note">{a.note}</td></tr>)}
      </tbody></table></div></div>) : <p className="empty-state">没有达到“占比大”阈值的失衡主题，暂无建议动作；限定风险结构见上表最大亏损。</p>}
      <details className="risk-method"><summary>判断方法、假设与数据来源</summary>
        <ol>{EXPOSURE_METHOD.steps.map(s => <li key={s}>{s}</li>)}</ol>
        <ul>{EXPOSURE_METHOD.rules.map(r => <li key={r.id}><strong>{r.id} {r.title}</strong>：条件 — {r.condition}；动作 — {r.action}</li>)}</ul>
        <p className="chart-note">假设：{current.assumptions.join(" ")}</p>
        {current.missing.length ? <p className="chart-note">缺失：{current.missing.join("；")}</p> : null}
        <p className="chart-note">数据：报价 {current.sources.quotes.status === "tradier" ? `Tradier ${current.sources.quotes.received}/${current.sources.quotes.symbols} 个代码` : `不可用（${current.sources.quotes.message ?? "未启用"}）`}；β {current.sources.betas.status === "ok" ? "全部估算完成" : current.sources.betas.status === "partial" ? `部分完成，缺 ${current.sources.betas.unavailable.join("、")}` : "不可用"}{current.sources.betas.message ? `（${current.sources.betas.message}）` : ""}；净资产 {signed(current.equity)} USD；核算时间 {formatTimestamp(current.capturedAt)}。方法版本 {current.methodVersion}。</p>
        <p className="chart-note">导出的参考包含方法步骤、规则、涉及主题的目录切片、全部数据与 Markdown；可直接交给其他模型按同一流程复核。目录外的标的默认只计入美股市场 β，模型可按自身知识补充并标注为推断。</p>
      </details>
    </>}
  </section>;
});
