import { useCallback, useEffect, useRef, useState } from "react";
import { DAILY_HORIZONS, DAILY_REASONING_VERSION, DAILY_TREND_GUIDANCE, MARKET_STANCES, STUDY_INSTRUMENTS, marketDailyExcerpt, marketReportToday,
  type DailyInferenceRun, type DailyInferenceRunSummary, type DailyInferenceState, type DailyLlmStatus, type MarketDailyReport } from "@invest/domain";
import { getJson, writeJson } from "./api";
import { DailyObservations, dailyChanged } from "./DailyObservations";

const API = "/api/research/daily-inference";
const DECISIONS = { observe: "继续观察", "manage-existing": "优先管理已有仓位", "conditional-opportunity": "存在条件式机会" };
const EVOLUTION = { strengthening: "观点增强", weakening: "观点减弱", unchanged: "方向延续", reversal: "出现反转", unclear: "尚不明确" };
const ACTIONS = { watch: "观察", hold: "持有观察", increase: "条件式加仓", reduce: "减仓评估", hedge: "对冲评估", exit: "退出评估" };
const DIRECTIONS = { bullish: "看多", bearish: "看空", neutral: "中性", mixed: "多空分化" };
const INSTRUMENTS = { option: "期权", "put-spread": "Put Spread", "call-spread": "Call Spread", stock: "股票 / ETF", portfolio: "现有组合" };
const ROUTES = { auto: "自动选择", direct: "直连", vpn: "VPN（代理）", corp: "公司代理" };
const stamp = (date: string) => new Date(date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const errorText = (e: unknown) => e instanceof Error ? e.message : "日报推理读取失败";
function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function DailyInference({ active, focus, onMarket }: { active: boolean; focus: { reportId: string; nonce: number } | null; onMarket: (date: string, assetId: string) => void }) {
  const [reportId, setReportId] = useState(focus?.reportId ?? ""), [historyDays, setHistoryDays] = useState(60);
  const [state, setState] = useState<DailyInferenceState | null>(null), [run, setRun] = useState<DailyInferenceRun | null>(null);
  const [loading, setLoading] = useState(false), [starting, setStarting] = useState(false), [error, setError] = useState("");
  const [includePositions, setIncludePositions] = useState(true), [refreshMarkets, setRefreshMarkets] = useState(true), [question, setQuestion] = useState("");
  const [source, setSource] = useState<MarketDailyReport | null>(null), [reload, setReload] = useState(0);
  const [checking, setChecking] = useState(false);
  const selection = useRef<string | null>(null), generation = useRef(0);
  useEffect(() => { if (focus) { setReportId(focus.reportId); selection.current = null; setRun(null); setSource(null); setReload(n => n + 1); } }, [focus]);
  const refresh = useCallback(() => setReload(n => n + 1), []);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController(), gen = ++generation.current;
    setLoading(true); setError("");
    void getJson<{ state: DailyInferenceState }>(`${API}/state?historyDays=${historyDays}${reportId ? `&reportId=${encodeURIComponent(reportId)}` : ""}`, abort.signal)
      .then(async result => {
        if (gen !== generation.current) return;
        setState(result.state);
        const id = result.state.runs.find(r => r.id === selection.current)?.id ?? result.state.runs[0]?.id;
        if (!id) { setRun(null); return; }
        const fetched = await getJson<{ run: DailyInferenceRun }>(`${API}/runs/${id}`, abort.signal);
        if (gen === generation.current) { selection.current = id; setRun(fetched.run); }
      }).catch(e => { if (!abort.signal.aborted && gen === generation.current) setError(errorText(e)); })
      .finally(() => { if (!abort.signal.aborted && gen === generation.current) setLoading(false); });
    return () => { abort.abort(); generation.current++; };
  }, [active, reportId, historyDays, reload]);
  useEffect(() => {
    if (!active || run?.status !== "running") return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const poll = async () => {
      try {
        const result = await getJson<{ run: DailyInferenceRun }>(`${API}/runs/${run.id}`, abort.signal);
        if (cancelled) return;
        setRun(result.run);
        if (result.run.status !== "running") { dailyChanged(); refresh(); return; }
      } catch (e) { if (!cancelled) { setError(errorText(e)); return; } }
      if (!cancelled) timer = setTimeout(() => void poll(), 1800);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { cancelled = true; clearTimeout(timer); abort.abort(); };
  }, [active, run?.id, run?.status, refresh]);
  const chooseRun = async (id: string) => {
    setError(""); selection.current = id;
    const gen = generation.current;
    try { const result = await getJson<{ run: DailyInferenceRun }>(`${API}/runs/${id}`); if (gen === generation.current && selection.current === id) { setRun(result.run); setSource(null); } }
    catch (e) { if (gen === generation.current && selection.current === id) setError(errorText(e)); }
  };
  const start = async () => {
    if (!state?.selected) return; setStarting(true); setError(""); setSource(null);
    try {
      const result = await writeJson<{ run: DailyInferenceRunSummary }>(`${API}/runs`, "POST", { requestId: requestId(), reportId: state.selected.id,
        expectedRevision: state.selected.revision, historyDays, includePositions, refreshMarkets, question });
      selection.current = result.run.id;
      await chooseRun(result.run.id); refresh();
    } catch (e) { setError(errorText(e)); } finally { setStarting(false); }
  };
  const checkConnection = async () => {
    setChecking(true); setError("");
    try { const result = await writeJson<{ provider: DailyLlmStatus }>(`${API}/connection-check`, "POST", {}); setState(s => s ? { ...s, provider: result.provider } : s); }
    catch (e) { setError(errorText(e)); } finally { setChecking(false); }
  };
  const download = () => {
    if (!run) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `daily-inference-${run.reportDate}-${run.id}.json`; a.click(); URL.revokeObjectURL(url);
  };
  const refs = (citations: string[]) => <div className="inference-citations">{citations.map(ref => {
    const report = run?.input.reports.find(r => r.citation === ref);
    const market = run?.input.markets.find(m => m.citation === ref);
    return report ? <button className="text-button" key={ref} onClick={() => setSource(report)}>{report.date} · v{report.revision}</button>
      : market ? <button className="text-button" key={ref} onClick={() => onMarket(run!.reportDate, market.instrument.id)}>{market.instrument.name} · {market.through}</button>
        : <span key={ref}>本次持仓快照</span>;
  })}</div>;
  const selected = state?.selected, output = run?.status === "completed" ? run.output : null;
  const connection = state?.provider.connection;
  const working = starting || run?.status === "running";
  const outdated = !!run && (run.promptVersion !== DAILY_REASONING_VERSION || run.options.historyDays !== historyDays
    || run.input.reports.some(r => !state?.history.some(h => h.id === r.id && h.revision === r.revision))
    || state?.history.some(r => !run.input.reports.some(h => h.id === r.id && h.revision === r.revision)));
  return <div className="study-panel daily-inference">
    <div className="content-heading"><div><p className="eyebrow">DAILY RESEARCH DECISION</p><h3>日报推理</h3><p className="muted">结合当前日报、历史观点与已有持仓，形成短线、中线、长线的操作参考。</p></div><button className="text-button" disabled={loading} onClick={refresh}>重新读取资料</button></div>
    <p className="chart-note">{DAILY_TREND_GUIDANCE}</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {loading && !state && <p className="empty-state">读取日报与推理记录…</p>}
    {state && <>
      <div className="study-controls"><label>分析日报<select aria-label="分析日报" disabled={starting} value={selected?.id ?? ""} onChange={e => { setReportId(e.target.value); setRun(null); setSource(null); selection.current = null; }}>
        {!state.reports.length && <option value="">尚无正式日报</option>}{state.reports.map(r => <option key={r.id} value={r.id}>{r.date} · {r.title}</option>)}</select></label>
        <label>历史参考范围<select aria-label="历史参考范围" value={historyDays} disabled={starting} onChange={e => setHistoryDays(Number(e.target.value))}>{[14, 30, 60, 90, 180].map(n => <option value={n} key={n}>过去 {n} 个日历日</option>)}</select></label>
      </div>
      {!selected ? <p className="empty-state">先在市场日报中保存当天内容，再到这里结合历史分析。</p> : <>
        <section className="inference-current"><div><p className="eyebrow">{selected.date}{selected.date === marketReportToday() ? " · 今日" : " · 所选日报"} · v{selected.revision}</p><h4>当前日报宏观判断</h4><span className={`daily-stance stance-${selected.stance}`}>{MARKET_STANCES[selected.stance]}</span><p>{selected.summary || selected.drivers || (selected.body ? marketDailyExcerpt(selected.body, 240) : "已记录趋势标签，可查看原文了解依据。")}</p><button className="text-button" onClick={() => setSource(selected)}>阅读当前日报</button></div><div><strong>历史参考</strong><p>{state.historyFrom} 至 {selected.date}</p><p>{state.history.length} 篇正式日报 · {state.observations.length} 条未结束观察</p><small>按本次实际保存版本读取；不把历史补填当作过去已知信息。</small></div></section>
        <div className="inference-compose">
          <label className="daily-wide">本次重点（选填）<textarea aria-label="本次推理重点" maxLength={2000} value={question} disabled={working} onChange={e => setQuestion(e.target.value)} placeholder="例如：已有指数空头是否需要调整？短线、中线和长线分别等待什么证据？" /></label>
          <div className="inference-options"><label><input type="checkbox" checked={includePositions} disabled={working} onChange={e => setIncludePositions(e.target.checked)} />结合已同步持仓与多空方向</label><label><input type="checkbox" checked={refreshMarkets} disabled={working} onChange={e => setRefreshMarkets(e.target.checked)} />分析时读取关联日 K（复用有效缓存）</label></div>
          <div className="study-actions"><button className="primary-button" disabled={!state.provider.configured || working || checking || loading || !!error} onClick={() => void start()}>{working ? "推理进行中…" : "生成操作参考并更新观察"}</button><span className="muted">{state.provider.configured ? `模型：${state.provider.model}` : "LLM 尚未配置"}</span></div>
          <p className="chart-note">点击后，将所选日报、历史日报及勾选的数据发送给已配置的模型；结果与引用会保存，并更新观察状态。操作建议由你们审阅执行。</p>
          {!state.provider.configured && <p className="daily-notice">在服务端 .env 配置 DAILY_LLM_BASE_URL、DAILY_LLM_API_KEY 和 DAILY_LLM_MODEL，重建容器配置后即可使用。{state.provider.issue}</p>}
          {connection && <section className="inference-connection"><div className="content-heading"><div><h4>LLM 连接</h4><p>{ROUTES[connection.mode]}{connection.selected ? ` · 当前出口：${ROUTES[connection.selected]}` : " · 等待检测"}</p></div><button className="text-button" disabled={!state.provider.configured || checking || working} onClick={() => void checkConnection()}>{checking ? "检测连接中…" : "检测直连 / VPN"}</button></div>
            <p className="chart-note">{connection.note} 连接检测只读取模型列表，不生成日报分析。</p>
            {!!connection.probes.length && <div className="daily-table-scroll"><table><thead><tr><th>线路</th><th>成功 / 检测</th><th>响应中位数</th><th>模型与连接</th></tr></thead><tbody>{connection.probes.map(p => <tr key={p.profile}><td>{ROUTES[p.profile]}{connection.recommended === p.profile ? " · 推荐" : ""}</td><td>{p.successes} / {p.attempts}</td><td>{p.medianMs === null ? "—" : `${Math.round(p.medianMs)} ms`}</td><td>{p.issue || (p.modelAvailable ? "配置模型可用" : "未确认")}</td></tr>)}</tbody></table></div>}
            {connection.checkedAt && <small className="muted">检测于 {stamp(connection.checkedAt)} · 以上为模型列表响应时间</small>}
          </section>}
          {!!state.warnings.length && <details><summary>参考范围说明</summary>{state.warnings.map(w => <p key={w}>{w}</p>)}</details>}
        </div>
        {!!state.runs.length && <div className="study-controls"><label>历史推理<select aria-label="历史推理记录" value={run?.id ?? state.runs[0]?.id} onChange={e => void chooseRun(e.target.value)}>{state.runs.map(r => <option key={r.id} value={r.id}>{stamp(r.createdAt)} · v{r.reportRevision} · {r.status === "completed" ? "已完成" : r.status === "failed" ? "未完成" : "推理中"}</option>)}</select></label><button className="text-button" disabled={!run} onClick={download}>导出本次推理与依据</button></div>}
        {run?.status === "running" && <p role="status" className="daily-notice">正在整理关联市场并请求模型。切换栏目后任务仍会继续，返回时可读取结果。</p>}
        {run?.status === "failed" && <p role="alert" className="inline-error">{run.error} 本次没有应用观察状态更新。</p>}
        {run && (run.attempts?.length ?? 0) > 1 && <p className="chart-note">第 1 次模型回复{run.attempts![0]!.issue ?? "未被采用"}，已自动以压缩格式重试一次{run.status === "completed" ? "并成功" : ""}；token 用量为两次合计。</p>}
        {outdated && <p className="daily-notice">参考日报、范围或周期口径已变化。下方为此前保存的推理，可重新分析以获得当前结论。</p>}
        {output && <section className="inference-result">
          <div className="content-heading"><div><p className="eyebrow">模型研究结论 · {stamp(run!.completedAt!)}</p><h4>结合历史后的宏观判断</h4></div><span className={`daily-stance stance-${output.macro.stance}`}>{MARKET_STANCES[output.macro.stance]} · {EVOLUTION[output.macro.evolution]}</span></div>
          <p className="inference-summary">{output.macro.summary}</p><p>{output.macro.historicalComparison}</p>
          <div className="inference-evidence"><div><h4>支持依据</h4>{output.macro.supporting.map((p, i) => <div key={i}><p>{p.text}</p>{refs(p.citations)}</div>)}</div><div><h4>反对证据 / 分歧</h4>{output.macro.opposing.length ? output.macro.opposing.map((p, i) => <div key={i}><p>{p.text}</p>{refs(p.citations)}</div>) : <p>本次材料未形成独立反对证据，不代表不存在风险。</p>}</div></div>
          <div className="inference-decision"><h4>{DECISIONS[output.decision]}</h4><p>{output.rationale}</p></div>
          <div className="inference-horizons">{Object.entries(DAILY_HORIZONS).map(([key, label]) => <section key={key}><h4>{label}</h4>{output.actions.filter(a => a.horizon === key).map((a, i) => <article key={i} className="inference-action"><strong>{ACTIONS[a.action]} · {a.assetId === "portfolio" ? "组合" : STUDY_INSTRUMENTS.find(m => m.id === a.assetId)?.name ?? a.assetId.replace(/^position:/, "")}</strong><small>{INSTRUMENTS[a.instrument]} · {DIRECTIONS[a.direction]} · 预期 {a.expectedHoldingSessions} 个交易日</small><p>{a.thesis}</p><dl><dt>持有与复核</dt><dd>{a.holdingPeriod}</dd><dt>触发条件</dt><dd>{a.trigger}</dd><dt>失效条件</dt><dd>{a.invalidation}</dd><dt>组合影响</dt><dd>{a.positionImpact}</dd><dt>风险</dt><dd>{a.risk}</dd></dl>{refs(a.citations)}</article>)}</section>)}</div>
          <div className="inference-review"><h4>后续复核安排</h4><p><strong>第 5 个交易日前后：</strong>{output.reviewPlan.firstReview}</p><p><strong>第 10 个交易日前后：</strong>{output.reviewPlan.secondReview}</p><p><strong>中线：</strong>{output.reviewPlan.mediumTerm}</p><p><strong>长线：</strong>{output.reviewPlan.longTerm}</p></div>
          <p className="chart-note">观察事项：新增 {run!.observationChanges.created.length} 条，更新 {run!.observationChanges.updated.length} 条{run!.observationChanges.skipped.length ? `；${run!.observationChanges.skipped.length} 条因期间被修改而保留原状态` : ""}。可在下方检查或人工修订。</p>
          <details><summary>数据缺口与使用边界</summary>{[...output.limitations, ...run!.input.warnings].map((w, i) => <p key={i}>{w}</p>)}</details>
        </section>}
        {run && <details className="inference-input"><summary>查看本次输入与版本依据</summary><p>日报读取截止 {stamp(run.input.reportAsOf)} · 数据整理 {stamp(run.input.assembledAt)} · {run.model}{run.connection?.selected ? ` · 出口：${ROUTES[run.connection.selected]}` : ""}</p><div className="study-actions">{run.input.reports.map(r => <button className="text-button" key={r.id} onClick={() => setSource(r)}>{r.date} · v{r.revision}</button>)}</div><div className="daily-table-scroll"><table><thead><tr><th>关联市场</th><th>最新日 K</th><th>数据说明</th></tr></thead><tbody>{run.input.markets.map(m => <tr key={m.instrument.id}><td>{m.instrument.name}</td><td>{m.through ?? "缺失"}</td><td>{m.warnings.join("；") || "使用已完成日K"}</td></tr>)}</tbody></table></div><p>持仓：{run.input.positions.included ? `${run.input.positions.rows.length} 行快照；不等同完整组合Delta` : "本次未提供"}</p>{run.input.positions.rows.map((p, i) => <p key={i}>{p.accountLabel} · {p.symbol} · {p.directionLabel} · 数量 {p.quantity} · 报表 {p.asOf}</p>)}</details>}
        {source && <article className="inference-source"><div className="content-heading"><h4>引用日报 · {source.date} · v{source.revision}</h4><button className="text-button" onClick={() => setSource(null)}>关闭引用原文</button></div><span className={`daily-stance stance-${source.stance}`}>{MARKET_STANCES[source.stance]}</span><p className="daily-body">{source.body}</p></article>}
        <DailyObservations key={selected.id} reportId={selected.id} items={state.observations} onChanged={refresh} />
      </>}
    </>}
  </div>;
}
