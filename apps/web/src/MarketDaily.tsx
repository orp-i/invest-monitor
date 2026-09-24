import { useEffect, useRef, useState } from "react";
import { DAILY_TREND_GUIDANCE, MARKET_STANCES, OBSERVATION_STATES, STUDY_INSTRUMENTS, marketReportToday, type DailyObservation, type MarketDailyContext, type MarketDailyReport, type MarketDailyRevision, type MarketDailySummary, type MarketDailyWrite } from "@invest/domain";
import { getJson, writeJson } from "./api";
import { DailyObservations } from "./DailyObservations";
import { clearLocalDraft, draftTime, readLocalDraft, useLocalDraft } from "./useLocalDraft";
import { replaceRoute, useRoute } from "./route";

const API = "/api/research/daily-reports";
const STATUS = { draft: "草稿", ready: "已保存", archived: "已归档" };
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const blank = (date: string): MarketDailyWrite => ({ date, title: date ? `${date} 市场日报` : "市场日报", summary: "", body: "", stance: "unset", drivers: "", watch: "", sourceUrl: "", assetIds: [], status: "draft" });
const inputOf = ({ id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input }: MarketDailyReport): MarketDailyWrite => input;
const timestamp = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const errorText = (error: unknown) => error instanceof Error ? error.message : "日报操作失败";
const NEW_DRAFT_KEY = "invest:daily-draft:new", draftKeyFor = (id: string | null) => id ? `invest:daily-draft:${id}` : NEW_DRAFT_KEY;

export function MarketDaily({ onMarket, onInfer }: { onMarket: (date: string, assetId: string) => void; onInfer?: (report: MarketDailyReport) => void }) {
  const today = marketReportToday();
  const [month, setMonth] = useState(today.slice(0, 7)), [reports, setReports] = useState<MarketDailySummary[]>([]);
  const [loading, setLoading] = useState(true), [reload, setReload] = useState(0), [filter, setFilter] = useState("active"), [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MarketDailyReport | null>(null), [draft, setDraft] = useState<MarketDailyWrite | null>(null), [dirty, setDirty] = useState(false);
  const [revisions, setRevisions] = useState<MarketDailyRevision[] | null>(null), [historical, setHistorical] = useState<MarketDailyReport | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [listError, setListError] = useState(""), [notice, setNotice] = useState("");
  const [contextFrom, setContextFrom] = useState(`${month}-01`), [contextTo, setContextTo] = useState(today);
  const [tracking, setTracking] = useState<DailyObservation[]>([]), [trackingError, setTrackingError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const load = () => { void getJson<{ observations: DailyObservation[] }>(`/api/research/daily-inference/observations?from=${month}-01&to=${monthEnd(month)}`, abort.signal)
      .then(result => { setTracking(result.observations); setTrackingError(""); }).catch(e => { if (!abort.signal.aborted) setTrackingError(errorText(e)); }); };
    load(); window.addEventListener("invest:daily-observations", load);
    return () => { abort.abort(); window.removeEventListener("invest:daily-observations", load); };
  }, [month]);
  const detailSequence = useRef(0), editor = useRef<HTMLFormElement>(null);
  // Unsaved edits are mirrored to this browser so a tab switch, reload or web update does not lose them.
  const draftKey = draft ? draftKeyFor(selected?.id ?? null) : null;
  useLocalDraft(draftKey, draft, dirty);
  const restore = (key: string, current: MarketDailyWrite | null, date?: string): boolean => {
    const local = readLocalDraft<MarketDailyWrite>(key);
    if (!local || (date && local.value.date !== date) || (current && JSON.stringify(local.value) === JSON.stringify(current))) { if (local) clearLocalDraft(key); return false; }
    setDraft(local.value); setDirty(true); setNotice(`已恢复 ${draftTime(local.savedAt)} 在本机未保存的修改；如需放弃，请点击“取消编辑”。`);
    return true;
  };
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setListError("");
    getJson<{ reports: MarketDailySummary[] }>(`${API}?from=${month}-01&to=${monthEnd(month)}&status=all`, controller.signal)
      .then(result => { setReports(result.reports); })
      .catch(e => { if (!controller.signal.aborted) setListError(errorText(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [month, reload]);
  useEffect(() => { setContextFrom(`${month}-01`); setContextTo([monthEnd(month), today].sort()[0]!); }, [month, today]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const discard = () => { if (!dirty) return true; if (!window.confirm("当前日报有未保存内容，确定放弃这些修改？")) return false; if (draftKey) clearLocalDraft(draftKey); return true; };
  const open = async (id: string, follow = false) => {
    if (!discard()) return;
    const sequence = ++detailSequence.current; setBusy(true); setError(""); setNotice("");
    try {
      const result = await getJson<{ report: MarketDailyReport }>(`${API}/${id}`);
      if (sequence !== detailSequence.current) return;
      setSelected(result.report); setDraft(null); setDirty(false); setRevisions(null); setHistorical(null);
      if (follow) setMonth(result.report.date.slice(0, 7));
      replaceRoute("research", "daily", result.report.id);
      restore(draftKeyFor(result.report.id), inputOf(result.report));
    } catch (e) { if (sequence === detailSequence.current) setError(errorText(e)); }
    finally { if (sequence === detailSequence.current) setBusy(false); }
  };
  const create = (date: string) => {
    const existing = reports.find(report => report.date === date);
    if (existing) { void open(existing.id); return; }
    if (!discard()) return;
    ++detailSequence.current; setSelected(null); setRevisions(null); setHistorical(null); setDraft(blank(date)); setDirty(false); setError(""); setNotice("");
    replaceRoute("research", "daily");
    restore(NEW_DRAFT_KEY, null, date || undefined);
    requestAnimationFrame(() => editor.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  // Deep link #/research/daily/<reportId> (from trading review, inference citations or a shared link) opens that report.
  const route = useRoute(), linkedId = route.section === "research" && route.rest[0] === "daily" ? route.rest[1] ?? null : null;
  const selectedId = selected?.id ?? null;
  useEffect(() => { if (linkedId && linkedId !== selectedId) void open(linkedId, true); }, [linkedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = <K extends keyof MarketDailyWrite>(key: K, value: MarketDailyWrite[K]) => { setDraft(current => current ? { ...current, ...(key === "date" && current.title === blank(current.date).title ? { title: value ? `${value} 市场日报` : "市场日报" } : {}), [key]: value } : current); setDirty(true); setNotice(""); };
  const save = async (status: MarketDailyWrite["status"], input = draft) => {
    if (!input || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const body = { ...input, status }, key = draftKeyFor(selected?.id ?? null);
      const result = selected ? await writeJson<{ report: MarketDailyReport }>(`${API}/${selected.id}`, "PATCH", { expectedRevision: selected.revision, report: body }) : await writeJson<{ report: MarketDailyReport }>(API, "POST", body);
      setSelected(result.report); setDraft(null); setDirty(false); setRevisions(null); setHistorical(null); clearLocalDraft(key);
      setMonth(result.report.date.slice(0, 7)); setReload(value => value + 1);
      setNotice(status === "ready" ? `日报已保存 · 版本 ${result.report.revision}，可供推理参考` : status === "archived" ? "日报已归档，历史版本仍可回看" : "草稿已保存，暂不进入推理参考");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const history = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try { setRevisions((await getJson<{ revisions: MarketDailyRevision[] }>(`${API}/${selected.id}/revisions`)).revisions); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const viewRevision = async (revision: number) => {
    if (!selected) return;
    setBusy(true); setError("");
    try { setHistorical((await getJson<{ report: MarketDailyReport }>(`${API}/${selected.id}?revision=${revision}`)).report); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const exportContext = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const { context } = await getJson<{ context: MarketDailyContext }>(`${API}/context?from=${contextFrom}&to=${contextTo}&limit=31`);
      if (!context.reports.length) { setNotice("所选日期没有可供参考的已保存日报，草稿和归档内容不会导出。"); return; }
      const url = URL.createObjectURL(new Blob([JSON.stringify(context, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `市场日报参考-${contextFrom}-${contextTo}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`已导出 ${context.reports.length} 篇日报及版本引用${context.hasMore ? "；范围内更多日报未包含，请缩小日期范围分批导出" : ""}。后续可将参考包交给推理模块。`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const moveMonth = (delta: number) => { const date = new Date(`${month}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + delta); setMonth(date.toISOString().slice(0, 7)); };
  const days = Number(monthEnd(month).slice(8)), offset = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const visible = reports.filter(report => (filter === "all" || (filter === "active" ? report.status !== "archived" : report.status === filter)) && `${report.title} ${report.summary} ${report.drivers} ${report.watch}`.toLowerCase().includes(query.trim().toLowerCase()));
  const display = historical ?? selected;
  return <div className="study-panel market-daily">
    <div className="content-heading"><div><p className="eyebrow">DAILY MARKET JOURNAL</p><h3>市场日报</h3><p className="muted">每天留下一份市场观察，沿时间表对照判断与变化。正文由你们填写。</p></div><div className="study-actions"><button className="text-button" disabled={busy} onClick={() => create("")}>补填历史日报</button><button className="primary-button" disabled={busy || loading || !!listError} onClick={() => { if (month !== today.slice(0, 7)) { setMonth(today.slice(0, 7)); setNotice("已回到本月，可点击今日日期填写或查看。"); } else create(today); }}>填写 / 查看今日</button></div></div>
    <div className="daily-overview">
      <div className="daily-calendar"><div className="study-controls"><button className="text-button" aria-label="日报上个月" disabled={month <= "1900-01"} onClick={() => moveMonth(-1)}>‹</button><label>日报月份<input type="month" min="1900-01" max={today.slice(0, 7)} value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value) && e.target.value >= "1900-01" && e.target.value <= today.slice(0, 7)) setMonth(e.target.value); }} /></label><button className="text-button" aria-label="日报下个月" disabled={month >= today.slice(0, 7)} onClick={() => moveMonth(1)}>›</button></div>
        <div className="daily-calendar-grid" aria-label={`${month} 日报日历`}>{["一", "二", "三", "四", "五", "六", "日"].map(day => <span className="daily-weekday" key={day}>{day}</span>)}{Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}{Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`, report = reports.find(item => item.date === date);
          return <button key={date} disabled={loading || busy || !!listError || date > today} className={`daily-day ${report ? `daily-${report.status}` : ""}`} aria-label={`${date} ${report ? STATUS[report.status] : "未填写"}`} aria-pressed={(draft?.date ?? selected?.date) === date} aria-current={date === today ? "date" : undefined} onClick={() => create(date)}><strong>{i + 1}</strong><small>{report ? STATUS[report.status] : "·"}</small></button>;
        })}</div><p className="chart-note">按日报所属日期归档，可选择美股交易日。空白日期表示未填写。保存时间按北京时间展示。</p>
      </div>
      <div className="daily-timeline"><div className="study-controls"><label>时间表状态<select aria-label="时间表状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">日报与草稿</option><option value="ready">已保存</option><option value="draft">草稿</option><option value="archived">已归档</option><option value="all">全部</option></select></label><label>搜索日报<input type="search" placeholder="摘要、驱动、待验证事项" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
        {listError ? <p role="alert" className="inline-error">{listError} <button className="text-button" onClick={() => setReload(value => value + 1)}>重试读取日报</button></p> : loading ? <p className="empty-state">读取日报时间表…</p> : !visible.length ? <p className="empty-state">{reports.length ? "当前筛选没有日报。" : "本月还没有日报。点击日历中的日期，粘贴你们的第一篇市场观察。"}</p> : <div className="daily-table-scroll"><table className="daily-table"><caption>{month} 市场变化时间表 · 最近日期在前</caption><thead><tr><th>日期 / 状态</th><th>市场判断</th><th>摘要与变化</th><th>待验证 / 后续观察</th></tr></thead><tbody>{visible.map(report => <tr key={report.id} data-selected={selected?.id === report.id}><td><button className="text-button" disabled={busy} onClick={() => void open(report.id)}>{report.date}</button><small>{STATUS[report.status]} · v{report.revision}</small></td><td><span className={`daily-stance stance-${report.stance}`}>{MARKET_STANCES[report.stance]}</span></td><td><strong>{report.title}</strong>{report.summary ? <p>{report.summary}</p> : report.excerpt ? <p className="daily-excerpt" title="未填写摘要，显示正文开头">{report.excerpt}</p> : <p>未填写摘要</p>}{report.drivers && <p className="muted">驱动：{report.drivers}</p>}</td><td>{report.watch || "未填写"}<div className="daily-tracking-summary">{Object.entries(OBSERVATION_STATES).map(([id, label]) => { const count = tracking.filter(o => o.reportId === report.id && o.status === id).length; return count ? <small key={id} className={`observation-status observation-${id}`}>{label} {count}</small> : null; })}</div></td></tr>)}</tbody></table></div>}
        <p className="chart-note">{DAILY_TREND_GUIDANCE}</p>
        {trackingError && <p className="inline-error">观察状态暂未读取：{trackingError}</p>}
      </div>
    </div>
    {error && <p role="alert" className="inline-error">{error}{selected && <button className="text-button" disabled={busy} onClick={() => void open(selected.id)}>重新读取当前日报</button>}</p>}
    {notice && <p role="status" className="daily-notice">{notice}</p>}
    {draft && <form ref={editor} className="research-form daily-editor" onSubmit={event => { event.preventDefault(); void save("ready"); }}>
      <div className="daily-wide"><h4>{selected ? "编辑市场日报" : "填写市场日报"}</h4><p className="muted">{dirty ? "有未保存的修改 · " : ""}选择日报所属日期，支持补填过去日期。正文可直接粘贴；摘要建议写清“今天相较此前发生了什么变化”。</p></div>
      <label>日报日期<input type="date" required max={today} value={draft.date} disabled={!!selected || busy} onChange={e => update("date", e.target.value)} /></label>
      <label>市场判断<select aria-label="市场判断" value={draft.stance} disabled={busy} onChange={e => update("stance", e.target.value as MarketDailyWrite["stance"])}>{Object.entries(MARKET_STANCES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="daily-wide">日报标题<input required maxLength={200} value={draft.title} disabled={busy} onChange={e => update("title", e.target.value)} /></label>
      <label className="daily-wide">一句摘要<textarea aria-label="一句摘要" rows={2} maxLength={1000} value={draft.summary} disabled={busy} placeholder="概括整体市场变化与分歧，便于时间表回看" onChange={e => update("summary", e.target.value)} /></label>
      <label className="daily-wide">日报正文<textarea aria-label="日报正文" rows={14} maxLength={50000} value={draft.body} disabled={busy} placeholder="粘贴或手工填写每日市场日报。可包含指数与利率、板块表现、重要事件，以及你们的判断依据。" onChange={e => update("body", e.target.value)} /></label>
      <label>主要驱动（选填）<textarea aria-label="主要驱动（选填）" maxLength={3000} value={draft.drivers} disabled={busy} placeholder="哪些事件或数据推动了变化？" onChange={e => update("drivers", e.target.value)} /></label>
      <label>待验证 / 后续观察（选填）<textarea aria-label="待验证 / 后续观察（选填）" maxLength={3000} value={draft.watch} disabled={busy} placeholder="短线、中线、长线分别等待什么证据？首次复核哪些趋势与失效条件？" onChange={e => update("watch", e.target.value)} /></label>
      <label className="daily-wide">来源链接（选填）<input type="url" maxLength={2000} value={draft.sourceUrl} disabled={busy} placeholder="https://…；更多来源可写在正文中" onChange={e => update("sourceUrl", e.target.value)} /></label>
      <fieldset className="daily-wide study-asset-checks" disabled={busy}><legend>关联市场（选填）</legend>{STUDY_INSTRUMENTS.map(asset => <label key={asset.id}><input type="checkbox" checked={draft.assetIds.includes(asset.id)} onChange={e => update("assetIds", e.target.checked ? [...draft.assetIds, asset.id] : draft.assetIds.filter(id => id !== asset.id))} />{asset.name}</label>)}</fieldset>
      <div className="daily-wide study-actions"><button className="primary-button" disabled={busy || !draft.body.trim()} type="submit">{busy ? "处理中…" : "保存日报"}</button><button className="text-button" disabled={busy} type="button" onClick={() => { if (editor.current?.reportValidity()) void save("draft"); }}>保存草稿</button><button className="text-button" type="button" disabled={busy} onClick={() => { if (discard()) { if (draftKey) clearLocalDraft(draftKey); setDraft(null); setDirty(false); } }}>取消编辑</button><span className="muted">保存日报后可供推理读取；草稿仅供继续编辑。</span></div>
    </form>}
    {!draft && display && <article className="daily-detail">
      <div className="content-heading"><div><p className="eyebrow">{display.date} · {STATUS[display.status]} · v{display.revision}{historical ? " · 历史版本（只读）" : ""}</p><h4>{display.title}</h4><p className="muted">保存于 {timestamp(display.updatedAt)}（北京时间）</p></div><div className="study-actions">{historical ? <button className="text-button" onClick={() => setHistorical(null)}>返回当前版本</button> : <><button className="primary-button" disabled={busy} onClick={() => { setDraft(inputOf(display)); setDirty(false); setError(""); }}>{display.status === "archived" ? "编辑并恢复" : "编辑日报"}</button><button className="text-button" disabled={busy} onClick={() => void history()}>历史版本</button>{display.status !== "archived" && <button className="text-button" disabled={busy} onClick={() => void save("archived", inputOf(display))}>归档</button>}</>}</div></div>
      <span className={`daily-stance stance-${display.stance}`}>{MARKET_STANCES[display.stance]}</span>{display.summary && <p className="daily-summary">{display.summary}</p>}
      {!historical && display.status === "ready" && onInfer && <button className="text-button" onClick={() => onInfer(display)}>结合历史日报推理</button>}
      <div className="daily-body">{display.body || "草稿尚未填写正文。"}</div>
      {(display.drivers || display.watch) && <div className="daily-observations"><div><h4>主要驱动</h4><p>{display.drivers || "未填写"}</p></div><div><h4>待验证 / 后续观察</h4><p>{display.watch || "未填写"}</p></div></div>}
      {display.sourceUrl && <p><a href={display.sourceUrl} target="_blank" rel="noreferrer">查看日报来源 ↗</a></p>}
      <div className="study-actions"><span className="muted">查看同期走势</span>{(display.assetIds.length ? display.assetIds : ["sp500"]).map(id => <button className="text-button" key={id} onClick={() => onMarket(display.date, id)}>{STUDY_INSTRUMENTS.find(asset => asset.id === id)?.name}</button>)}</div>
      {revisions && <div className="daily-revisions"><h4>历史版本</h4><p className="muted">最近 100 次保存，原始内容保留。点击版本查看当时记录。</p>{revisions.map(revision => <button className="text-button" key={revision.revision} disabled={busy} onClick={() => void viewRevision(revision.revision)}>v{revision.revision} · {STATUS[revision.status]} · {timestamp(revision.updatedAt)}</button>)}</div>}
      {!historical && display.status === "ready" && <DailyObservations key={display.id} reportId={display.id} />}
    </article>}
    <div className="daily-context"><h4>为后续推理准备参考</h4><p className="muted">选择日期范围，导出已保存日报及其版本引用。后续可据此分析市场变化、操作触发条件与判断失效条件。</p><div className="study-controls"><label>参考开始日期<input type="date" value={contextFrom} max={today} onChange={e => setContextFrom(e.target.value)} /></label><label>参考结束日期<input type="date" value={contextTo} max={today} onChange={e => setContextTo(e.target.value)} /></label><button className="text-button" disabled={busy || !contextFrom || !contextTo || contextFrom > contextTo} onClick={() => void exportContext()}>导出推理参考包</button></div><p className="chart-note">每次最多包含最近 31 篇。也可进入“日报推理”，结合历史资料生成操作参考并更新观察状态。</p></div>
  </div>;
}
