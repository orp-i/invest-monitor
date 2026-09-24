import { useCallback, useEffect, useState } from "react";
import { DAILY_HORIZONS, OBSERVATION_STATES, type DailyObservation } from "@invest/domain";
import { getJson, writeJson } from "./api";

const API = "/api/research/daily-inference/observations";
const errorText = (e: unknown) => e instanceof Error ? e.message : "观察状态更新失败";
export const dailyChanged = () => window.dispatchEvent(new Event("invest:daily-observations"));
export function DailyObservations({ reportId, items, onChanged }: { reportId: string; items?: DailyObservation[]; onChanged?: () => void }) {
  const [rows, setRows] = useState<DailyObservation[]>(items ?? []), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false), [text, setText] = useState(""), [horizon, setHorizon] = useState<DailyObservation["horizon"]>("short");
  const [editing, setEditing] = useState<DailyObservation | null>(null), [status, setStatus] = useState<DailyObservation["status"]>("watching"), [reason, setReason] = useState("");
  const [history, setHistory] = useState<DailyObservation[] | null>(null), [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    if (items) return;
    try { setRows((await getJson<{ observations: DailyObservation[] }>(`${API}?reportId=${encodeURIComponent(reportId)}`)).observations); setError(""); }
    catch (e) { setError(errorText(e)); }
  }, [reportId, items]);
  useEffect(() => { if (items) setRows(items); else void load(); }, [items, load]);
  useEffect(() => { const changed = () => { void load(); }; window.addEventListener("invest:daily-observations", changed); return () => window.removeEventListener("invest:daily-observations", changed); }, [load]);
  const changed = () => { dailyChanged(); onChanged?.(); };
  const create = async () => {
    setBusy(true); setError("");
    try { await writeJson(API, "POST", { reportId, text, horizon }); setText(""); setCreating(false); setNotice("观察事项已加入，状态为待验证。"); changed(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!editing) return; setBusy(true); setError("");
    try { await writeJson(`${API}/${editing.id}`, "PATCH", { expectedRevision: editing.revision, status, evidence: reason }); setEditing(null); setNotice("状态与修改依据已保存，历史记录保留。"); changed(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const showHistory = async (item: DailyObservation) => {
    setError("");
    try { setHistory((await getJson<{ history: DailyObservation[] }>(`${API}/${item.id}/history`)).history); }
    catch (e) { setError(errorText(e)); }
  };
  return <section className="daily-tracking">
    <div className="content-heading"><div><h4>待验证 / 后续观察状态</h4><p className="muted">持续跟踪趋势证据。模型更新与人工修改均保留依据和历史。</p></div><button className="text-button" disabled={busy} onClick={() => setCreating(v => !v)}>新增观察事项</button></div>
    {error && <p role="alert" className="inline-error">{error} <button className="text-button" onClick={() => { void load(); onChanged?.(); }}>重新读取观察</button></p>}
    {notice && <p role="status" className="daily-notice">{notice}</p>}
    {creating && <form className="research-form" onSubmit={e => { e.preventDefault(); void create(); }}>
      <label className="daily-wide">观察内容<textarea aria-label="新增观察内容" required maxLength={2000} value={text} onChange={e => setText(e.target.value)} placeholder="例如：油价与收益率压力是否继续向科技股传导？" /></label>
      <label>观察周期<select aria-label="新增观察周期" value={horizon} onChange={e => setHorizon(e.target.value as DailyObservation["horizon"])}>{Object.entries(DAILY_HORIZONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <div className="study-actions"><button type="submit" className="primary-button" disabled={busy || !text.trim()}>保存观察事项</button><button type="button" className="text-button" onClick={() => setCreating(false)}>取消新增</button></div>
    </form>}
    {!rows.length && <p className="empty-state">尚无状态记录。可新增观察事项，或在日报推理完成后自动建立。</p>}
    <div className="observation-list">{rows.map(item => <article className="observation-card" key={item.id}>
      <div className="study-actions"><span className={`observation-status observation-${item.status}`}>{OBSERVATION_STATES[item.status]}</span><small>{item.reportDate} · {DAILY_HORIZONS[item.horizon]}</small></div>
      <p className="observation-text">{item.text}</p><p>{item.evidence || "等待后续证据"}</p>
      <small className="muted">{item.lastRunId ? "模型判断" : "人工记录"} · {new Date(item.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} · v{item.revision}</small>
      <div className="study-actions"><button className="text-button" disabled={busy} onClick={() => { setEditing(item); setStatus(item.status); setReason(""); }}>更新状态</button><button className="text-button" onClick={() => void showHistory(item)}>状态历史</button></div>
      {editing?.id === item.id && <form className="research-form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label>观察状态<select aria-label="观察状态" value={status} onChange={e => setStatus(e.target.value as DailyObservation["status"])}>{Object.entries(OBSERVATION_STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="daily-wide">更新依据<textarea aria-label="更新依据" required maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <div className="study-actions"><button className="primary-button" disabled={busy || !reason.trim()}>保存状态</button><button type="button" className="text-button" onClick={() => setEditing(null)}>取消修改</button></div>
      </form>}
    </article>)}</div>
    {history && <div className="observation-history"><div className="content-heading"><h4>观察状态历史</h4><button className="text-button" onClick={() => setHistory(null)}>关闭状态历史</button></div><p>{history[0]?.text}</p>{history.map(item => <article key={item.revision}><strong>v{item.revision} · {OBSERVATION_STATES[item.status]}</strong><small> · {item.lastRunId ? "模型判断" : "人工记录"} · {item.updatedAt}</small><p>{item.evidence || "待验证"}</p><small className="observation-citations">{item.citations.join(" · ")}</small></article>)}</div>}
  </section>;
}
