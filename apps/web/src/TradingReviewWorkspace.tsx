import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  reviewContent as content, tradingCaseMetrics, reviewExecutionDetails, catalystExample, optionIdentity, brokerReportDay, MARKET_STANCES, LESSON_CATEGORIES,
  type TradingCase, type TradingCaseInput, type TradingCaseProfile, type TradingEvidenceInput, type MarketDailySummary, type MergeSuggestion, type TradingLesson, type TradingLessonInput, type LessonCategory,
  type TradingEventInput, type TradingAssessmentInput, type ReviewFill, type WeeklyReview,
  type StatementImport, type MergeAdviceRunSummary, type DailyLlmStatus,
} from "@invest/domain";
import { getJson, writeJson } from "./api";
import { navigateRoute, parseRoute, replaceRoute, routeHash, useRoute } from "./route";
import { WeeklyReviewWorkspace } from "./WeeklyReviewWorkspace";
import { OriginalLearning } from "./OriginalLearning";
import { ExecutionSummary, ExecutionRows } from "./ExecutionDetails";
import { formatMoney, formatTimestamp } from "./format";
import type { NewsItem } from "./types";

type FillChoice = ReviewFill & { caseId: string | null };
interface ReviewData { statements: (Omit<StatementImport, "fills"> & { fillCount: number })[]; cases: TradingCase[]; fills: FillChoice[]; weekly: WeeklyReview[]; research: { id: string; title: string; topic: string }[]; suggestions?: MergeSuggestion[]; lessons?: TradingLesson[] }
const freshLesson = (category: LessonCategory = "option", caseIds: string[] = []): TradingLessonInput => ({ category, title: "", body: "", trigger: "", action: "", caseIds, tags: [], status: "active" });
const lessonInput = (l: TradingLesson): TradingLessonInput => ({ category: l.category, title: l.title, body: l.body, trigger: l.trigger, action: l.action, caseIds: l.caseIds, tags: l.tags, status: l.status });
const EVIDENCE = { order: "同一多腿订单", instant: "同秒开仓", structure: "同日结构（券商开平标记）", day: "同日同标的（需人工确认）" };
interface AdviceState { provider: DailyLlmStatus; auto: boolean; sop: { version: string; rules: string[] }; candidates: { key: string; underlying: string; reason: string; structure: string; hint: string | null; caseIds: string[]; fills: number }[]; warnings: string[]; latest: MergeAdviceRunSummary | null; runs: MergeAdviceRunSummary[] }
const DIRECTIONS = { bullish: "看多", bearish: "看空", neutral: "中性区间", volatility: "双向波动", mixed: "多空混合", unknown: "方向待核实" };
const KINDS = { merge: "建议合并", "keep-separate": "建议保持独立", "split-review": "建议人工拆分" };
const CONFIDENCE = { high: "高", medium: "中", low: "低" };
type Intent = { kind: "curve" | "psychology"; id: string } | null;
const HORIZONS = { intraday: "日内", swing: "波段", position: "中长线", unspecified: "待明确" };
const TYPES = { stock: "股票 / ETF", option: "期权", crypto: "加密资产", mixed: "多工具组合", other: "其他" };
const STATES = { draft: "待建仓", open: "持仓中", closed: "已退出", incomplete: "待核对成交" };
const LOGIC = { valid: "有效", weakened: "动摇", invalid: "失效", unknown: "未知" };
const freshCase = (): TradingCaseInput => ({ title: "", strategy: "", horizon: "swing", instrumentType: "stock", fillIds: [], historyComplete: false });
const freshAssessment = (): TradingAssessmentInput => ({ curveIds: [], psychologyIds: [], planQuality: "unknown", executionQuality: "unknown", findings: "", nextBehavior: "", evidenceIds: [] });
const iso = (value: FormDataEntryValue | null) => value ? new Date(String(value)).toISOString() : null;
const value = (data: FormData, key: string) => String(data.get(key) ?? "");
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const toggle = (items: string[], item: string) => items.includes(item) ? items.filter(v => v !== item) : [...items, item];
const TABS = ["cases", "lessons", "weekly", "learning", "calculator"];
const AUTO_STRATEGY = "自动开平仓配对（意图待复盘）";
const SORTS = { opened: "最近开仓", closed: "最近退出", review: "等待复盘优先", pnl: "净盈亏" };
const unreviewed = (c: TradingCase) => !c.plans.length && !c.evidence.length && !c.events.length && !c.assessments.length;
const underlyings = (c: TradingCase) => [...new Set(c.fills.map(f => optionIdentity(f.symbol)?.underlying ?? f.symbol))];
const shiftDay = (day: string, n: number) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
const awaitingReview = (c: TradingCase) => tradingCaseMetrics(c).state === "closed" && c.assessments.at(-1)?.stage !== "retrospective";
// Readable label for OCC option symbols such as SPY260914P00762000; stored titles are left unchanged.
const contractLabel = (symbol: string) => { const o = optionIdentity(symbol); return o ? `${o.underlying} · 20${o.expiry.slice(0, 2)}-${o.expiry.slice(2, 4)}-${o.expiry.slice(4)} 到期 · ${o.type === "C" ? "Call" : "Put"} ${o.strike}` : null; };
const caseContracts = (c: TradingCase) => [...new Set(c.fills.map(f => f.symbol))].map(contractLabel).filter((v): v is string => !!v);

function LessonsWorkspace({ lessons, cases, save, busy, focusCaseId, onOpenCase }: { lessons: TradingLesson[]; cases: TradingCase[]; save: Save; busy: boolean; focusCaseId?: string; onOpenCase: (id: string) => void }) {
  const [category, setCategory] = useState<"all" | LessonCategory>("all");
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<TradingLessonInput>(() => freshLesson("option", focusCaseId ? [focusCaseId] : []));
  const [tagText, setTagText] = useState("");
  // Arriving from a case detail ("记录这笔交易的经验") opens the form with that case linked.
  useEffect(() => { if (focusCaseId) { setEditing("new"); setDraft(d => ({ ...freshLesson(d.category, [focusCaseId]) })); setTagText(""); } }, [focusCaseId]);
  const shown = (l: TradingLesson) => showRetired || l.status === "active";
  const visible = lessons.filter(l => (category === "all" || l.category === category) && shown(l)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const caseTitle = (id: string) => cases.find(c => c.id === id)?.title ?? id;
  const startEdit = (l: TradingLesson) => { setEditing(l.id); setDraft(lessonInput(l)); setTagText(l.tags.join(", ")); };
  const parseTags = (text: string) => [...new Set(text.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean))].slice(0, 20);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...draft, tags: parseTags(tagText) };
    const ok = editing === "new" ? await save("/api/trading-review/lessons", body) : await save(`/api/trading-review/lessons/${editing}`, { ...body, expectedRevision: lessons.find(l => l.id === editing)?.revision ?? 1 });
    if (ok) { setEditing(null); setDraft(freshLesson(draft.category)); setTagText(""); }
  };
  const setStatus = (l: TradingLesson, status: TradingLessonInput["status"]) => save(`/api/trading-review/lessons/${l.id}`, { ...lessonInput(l), status, expectedRevision: l.revision });
  const count = (k?: LessonCategory) => lessons.filter(l => shown(l) && (!k || l.category === k)).length;
  return <div className="tr-lessons">
    <div className="tr-row tr-lessons-heading"><div><p className="eyebrow">TRADING LESSONS</p><h3>交易经验</h3><p className="muted">按期权、股票、对冲设置三类显式记录每次交易学到的东西：适用场景与下次动作。可关联交易档案；修改保留历史；不再适用的经验标记停用而不删除。</p></div><button className="primary-button" onClick={() => { setEditing("new"); setDraft(freshLesson(category === "all" ? "option" : category, focusCaseId ? [focusCaseId] : [])); setTagText(""); }}>＋ 记录经验</button></div>
    <div className="tr-tabs" role="tablist" aria-label="经验分类">{([["all", `全部 ${count()}`], ...Object.entries(LESSON_CATEGORIES).map(([k, v]) => [k, `${v} ${count(k as LessonCategory)}`])] as [string, string][]).map(([id, title]) => <button role="tab" key={id} aria-selected={category === id} onClick={() => setCategory(id as "all" | LessonCategory)}>{title}</button>)}<Check checked={showRetired} onChange={setShowRetired}>显示已停用</Check></div>
    {editing && <form className="tr-form tr-surface" onSubmit={submit}>
      <div className="tr-full tr-row"><h4>{editing === "new" ? "新经验" : "修改经验（保留此前版本）"}</h4><button type="button" className="text-button" onClick={() => setEditing(null)}>收起</button></div>
      <Field label="分类"><select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as LessonCategory })}>{Object.entries(LESSON_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="状态"><select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as TradingLessonInput["status"] })}><option value="active">有效</option><option value="retired">已停用</option></select></Field>
      <Field label="一句话标题" wide><input required maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="例如：0DTE 认购价差不在开盘前 30 分钟追价" /></Field>
      <Field label="经验内容（发生了什么、为什么）" wide><textarea required maxLength={10000} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} /></Field>
      <Field label="适用场景 / 触发条件" wide><textarea maxLength={10000} value={draft.trigger} onChange={e => setDraft({ ...draft, trigger: e.target.value })} placeholder="什么情况下这条经验成立" /></Field>
      <Field label="下次动作 / 避免事项" wide><textarea maxLength={10000} value={draft.action} onChange={e => setDraft({ ...draft, action: e.target.value })} placeholder="具体做什么或不做什么" /></Field>
      <Field label="标签（逗号分隔）"><input value={tagText} onChange={e => setTagText(e.target.value)} placeholder="例如：SPY, 0DTE, 价差" /></Field>
      <Field label="关联交易档案（可多选）" wide><select multiple value={draft.caseIds} onChange={e => setDraft({ ...draft, caseIds: [...e.target.selectedOptions].map(o => o.value) })} size={Math.min(6, Math.max(3, cases.length))}>{[...cases].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></Field>
      <div className="tr-full"><button className="primary-button" disabled={busy}>{editing === "new" ? "保存经验" : "保存修改"}</button></div>
    </form>}
    {visible.length ? <ul className="tr-lesson-list">{visible.map(l => <li key={l.id} className="tr-surface">
      <header><strong>{l.title}</strong><span className="tr-pill">{LESSON_CATEGORIES[l.category]}</span>{l.status === "retired" && <span className="tr-pill">已停用</span>}<time>更新于 {formatTimestamp(l.updatedAt)}{l.revision > 1 ? ` · 第 ${l.revision} 版` : ""}</time></header>
      <p className="tr-lesson-body">{l.body}</p>
      {l.trigger && <p><strong>适用场景：</strong>{l.trigger}</p>}{l.action && <p><strong>下次动作：</strong>{l.action}</p>}
      {(l.tags.length > 0 || l.caseIds.length > 0) && <p className="muted">{l.tags.map(t => `#${t}`).join(" ")}{l.caseIds.length ? <> · 关联：{l.caseIds.map(id => <button key={id} type="button" className="text-button" onClick={() => onOpenCase(id)}>{caseTitle(id)}</button>)}</> : null}</p>}
      <p className="tr-lesson-actions"><button type="button" className="text-button" disabled={busy} onClick={() => startEdit(l)}>修改</button>{l.status === "active" ? <button type="button" className="text-button" disabled={busy} onClick={() => void setStatus(l, "retired")}>标记停用</button> : <button type="button" className="text-button" disabled={busy} onClick={() => void setStatus(l, "active")}>恢复有效</button>}</p>
      {l.history.length > 0 && <details className="tr-data-notes"><summary>修改历史 · {l.history.length} 次</summary>{l.history.map(h => <p key={h.recordedAt}>{formatTimestamp(h.recordedAt)} 之前：{LESSON_CATEGORIES[h.category]} · {h.title} · {h.body}{h.trigger ? ` · 场景：${h.trigger}` : ""}{h.action ? ` · 动作：${h.action}` : ""}</p>)}</details>}
    </li>)}</ul> : <p className="empty-state">{lessons.length ? "该分类下还没有经验记录。" : "还没有经验记录。每次复盘后把可复用的结论记在这里，按期权、股票、对冲设置分类。"}</p>}
  </div>;
}

function MergeAdvicePanel({ advice, cases, busy, onRun, onMerge, onSelect }: { advice: AdviceState | null; cases: TradingCase[]; busy: boolean; onRun: () => void; onMerge: (target: string, sources: string[]) => void; onSelect: (id: string) => void }) {
  if (!advice) return null;
  const latest = advice.latest;
  const title = (id: string) => cases.find(c => c.id === id)?.title ?? id;
  const running = latest?.status === "running";
  return <details className="tr-notice tr-advice" open={!!latest && latest.status === "completed"}>
    <summary><strong>SOP 合并建议 · 模型</strong>{advice.provider.configured ? ` ${advice.provider.model}` : "（未配置）"} · 待判断分组 {advice.candidates.length} 个{latest ? ` · 最近分析 ${formatTimestamp(latest.createdAt)}${running ? "（进行中）" : latest.status === "failed" ? "（失败）" : ""}` : ""}</summary>
    <p className="muted">模型按 SOP 判断哪些成交属于同一策略、各腿开平角色与轮数；建议仅供人工确认，程序按净现金重新核算并核对结构，不改写成交。{advice.auto ? "券商同步后待判断分组有变化时自动分析一次。" : "自动分析已关闭。"} <button type="button" className="text-button" disabled={busy || running || !advice.provider.configured} onClick={onRun}>{running ? "分析中…" : "重新分析"}</button></p>
    {!advice.provider.configured && <p className="muted">请先在“设置 → 日报 LLM”填写 API 地址、Key 与模型{advice.provider.missing.length ? `（缺少 ${advice.provider.missing.join("、")}）` : ""}。</p>}
    {latest?.status === "failed" && <p className="inline-error" role="alert">{latest.error}</p>}
    {latest?.status === "failed" && latest.attempts?.some(a => a.sample) && <details className="tr-data-notes"><summary>模型输出片段（诊断用，不是结果）</summary>{latest.attempts.filter(a => a.sample).map(a => <p key={a.startedAt}>{formatTimestamp(a.startedAt)} · {a.issue}：<code>{a.sample}</code></p>)}</details>}
    {latest?.status === "completed" && latest.output && <>
      <p>{latest.output.summary}</p>
      {latest.proposals.length ? <ul className="tr-advice-list">{latest.proposals.map(p => <li key={p.id}>
        <strong>{p.structure}</strong>（{DIRECTIONS[p.direction]} · 置信度{CONFIDENCE[p.confidence]}） · {KINDS[p.kind]} · {p.fillIds.length} 笔成交{p.netCash !== null ? ` · 净现金合计 ${formatMoney(p.netCash)} USD` : ""}{p.rounds ? ` · ${p.rounds} 轮` : ""}
        <br />{p.rationale}
        <br /><span className="muted">{[...p.checks, ...p.warnings].join("；")}{p.sopRules.length ? ` · ${p.sopRules.join("、")}` : ""}</span>
        <br />{p.caseIds.map(id => <button key={id} type="button" className="text-button" onClick={() => onSelect(id)}>打开“{title(id)}”</button>)}
        {p.actionable && <button type="button" className="text-button" disabled={busy} onClick={() => onMerge(p.actionable!.targetCaseId, p.actionable!.sourceCaseIds)}>按建议合并到“{title(p.actionable.targetCaseId)}”</button>}
      </li>)}</ul> : <p className="muted">模型没有提出可执行的分组建议。</p>}
      {!!latest.output.limitations.length && <p className="muted">局限：{latest.output.limitations.join("；")}</p>}
      {latest.usage && <p className="muted">tokens：输入 {latest.usage.inputTokens ?? "—"} / 输出 {latest.usage.outputTokens ?? "—"}{latest.attempts && latest.attempts.length > 1 ? " · 含一次压缩重试" : ""}</p>}
    </>}
    {!!advice.candidates.length && <details className="tr-data-notes"><summary>待判断分组 {advice.candidates.length} 个</summary>{advice.candidates.map(c => <p key={c.key}>{c.underlying} · {c.reason}{c.hint ? ` · ${c.hint}` : ""} · {c.fills} 笔</p>)}</details>}
    {!!advice.warnings.length && <p className="muted">{advice.warnings.join("；")}</p>}
    <details className="tr-data-notes"><summary>SOP {advice.sop.version}</summary>{advice.sop.rules.map(r => <p key={r}>{r}</p>)}</details>
  </details>;
}

export function startTradingReview(link: { transactionId?: string; newsId?: string }) {
  try { sessionStorage.setItem("invest:trading-review-link", JSON.stringify(link)); } catch { /* Navigation is still available. */ }
  navigateRoute("trading-review", "cases");
}

export const TradingReviewWorkspace = memo(function TradingReviewWorkspace({ news }: { news: NewsItem[] }) {
  const [data, setData] = useState<ReviewData | null>(null);
  // Tab and selected case live in the hash (#/trading-review/cases/<id>) so reload, back and links restore them.
  const route = useRoute();
  const tab = route.section === "trading-review" && TABS.includes(route.rest[0] ?? "") ? route.rest[0]! : "cases";
  const selected = tab === "cases" ? route.rest[1] ?? "" : "";
  const lastSelected = useRef("");
  if (selected) lastSelected.current = selected;
  const setTab = useCallback((next: string) => replaceRoute("trading-review", next, next === "cases" ? parseRoute().rest[1] || lastSelected.current || undefined : undefined), []);
  const setSelected = useCallback((id: string) => replaceRoute("trading-review", "cases", id), []);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(freshCase);
  const [intent, setIntent] = useState<Intent>(null);
  const [newsId, setNewsId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<keyof typeof SORTS>("opened");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<AdviceState | null>(null);
  const loadAdvice = useCallback(async () => { try { setAdvice(await getJson<AdviceState>("/api/trading-review/advice")); } catch { /* The advice panel is optional; the journal still works. */ } }, []);
  const refresh = useCallback(async () => {
    try { setData(await getJson<ReviewData>("/api/trading-review")); setError(""); void loadAdvice(); }
    catch (e) { setError(e instanceof Error ? e.message : "读取失败"); }
  }, [loadAdvice]);
  // While the model is working, poll the run every few seconds; stop as soon as it completes or fails.
  useEffect(() => { if (advice?.latest?.status !== "running") return; const timer = setTimeout(() => void loadAdvice(), 4000); return () => clearTimeout(timer); }, [advice, loadAdvice]);
  useEffect(() => { const update = () => void refresh(); void refresh(); window.addEventListener("invest:broker-data-updated", update); return () => window.removeEventListener("invest:broker-data-updated", update); }, [refresh]);
  useEffect(() => {
    if (!data) return;
    try {
      const raw = sessionStorage.getItem("invest:trading-review-link"); if (!raw) return;
      const link = JSON.parse(raw) as { transactionId?: string; newsId?: string };
      if (link.transactionId) {
        const fill = data.fills.find(f => f.transactionId === link.transactionId || f.transactionAliases?.includes(link.transactionId!));
        if (fill?.caseId) setSelected(fill.caseId);
        else { setDraft({ ...freshCase(), title: fill ? `${fill.symbol} 交易复盘` : "", fillIds: fill ? [fill.id] : [] }); setCreating(true); }
      }
      if (link.newsId) { setNewsId(link.newsId); setNotice("已带入新闻。选择或新建交易档案后，将它保存为证据。"); }
      sessionStorage.removeItem("invest:trading-review-link");
    } catch { /* No persisted link required. */ }
  }, [data]);
  const save = async (path: string, body: unknown) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await writeJson(path, "POST", body); await refresh(); setNotice("已保存，原始记录保持留存。"); return true;
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); return false; }
    finally { setBusy(false); }
  };
  const useKnowledge = (next: Intent) => {
    setIntent(next); setTab("cases");
    if (!selected && data?.cases[0]) setSelected(data.cases[0].id);
    else if (!selected) setNotice("已选中知识卡。选择或新建一个交易档案后，即可用于逐笔复盘。");
  };
  if (!data) return <div className="trading-review"><p role="status">{error || "正在读取复盘档案…"}</p>{error && <button className="secondary-button" onClick={() => void refresh()}>重试</button>}</div>;
  const cases = data.cases.filter(c => (!query || `${c.title} ${c.strategy} ${c.fills.map(f => f.symbol).join(" ")} ${caseContracts(c).join(" ")}`.toLowerCase().includes(query.toLowerCase())) && (filter === "all" || (filter === "review-due" ? awaitingReview(c) : tradingCaseMetrics(c).state === filter)));
  const money = (m: ReturnType<typeof tradingCaseMetrics>) => m.netPnl === null ? Number.NEGATIVE_INFINITY : Number(m.netPnl);
  const sorted = cases.map(c => ({ c, m: tradingCaseMetrics(c) })).sort((a, b) => sort === "closed" ? (b.m.closedAt ?? "").localeCompare(a.m.closedAt ?? "") || (b.m.openedAt ?? "").localeCompare(a.m.openedAt ?? "")
    : sort === "pnl" ? money(b.m) - money(a.m) : sort === "review" ? Number(awaitingReview(b.c)) - Number(awaitingReview(a.c)) || (b.m.closedAt ?? b.m.openedAt ?? "").localeCompare(a.m.closedAt ?? a.m.openedAt ?? "")
    : (b.m.openedAt ?? b.c.createdAt).localeCompare(a.m.openedAt ?? a.c.createdAt)).map(x => x.c);
  const entry = data.cases.find(c => c.id === selected) ?? sorted[0] ?? data.cases[0];
  return <div className="trading-review">
    <header className="tr-header"><div><p className="eyebrow">TRADING JOURNAL</p><h2>交易档案与逐笔复盘</h2><p>同步后按同账户、同标的自动配对开平仓；仅有日期的成交按数量归组，日内顺序待核实。</p></div><button className="primary-button" onClick={() => { setCreating(true); setTab("cases"); setDraft(freshCase()); }}>＋ 新建交易档案</button></header>
    <div className="tr-stats"><Stat label="交易档案" value={String(data.cases.length)} /><Stat label="交易经验" value={String((data.lessons ?? []).filter(l => l.status === "active").length)} note="期权 / 股票 / 对冲设置" onClick={() => setTab("lessons")} /><Stat label="持仓中 / 待核对" value={String(data.cases.filter(c => ["open", "incomplete"].includes(tradingCaseMetrics(c).state)).length)} /><Stat label="等待复盘" value={String(data.cases.filter(awaitingReview).length)} note="点击筛选" onClick={() => { setFilter("review-due"); setQuery(""); setTab("cases"); }} /><Stat label="周报留存" value={String(data.weekly.length)} /></div>
    <div className="tr-tabs" role="tablist" aria-label="复盘工作区">{[["cases", "交易档案"], ["lessons", "交易经验"], ["weekly", "周末复盘"], ["learning", "图文学习"], ["calculator", "止盈算例"]].map(([id, title]) => <button role="tab" key={id} aria-selected={tab === id} onClick={() => setTab(id!)}>{title}</button>)}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="tr-notice" role="status">{notice}</p>}
    {tab === "cases" && <>
      <MergeAdvicePanel advice={advice} cases={data.cases} busy={busy} onSelect={setSelected}
        onRun={async () => { setBusy(true); setError(""); try { const reply = await writeJson<{ run: MergeAdviceRunSummary | null; message?: string }>("/api/trading-review/advice/run", "POST", {}); if (reply.message) setNotice(reply.message); await loadAdvice(); } catch (e) { setError(e instanceof Error ? e.message : "分析失败"); } finally { setBusy(false); } }}
        onMerge={async (target, sources) => { const targetCase = data.cases.find(c => c.id === target); if (window.confirm(`按模型建议将 ${sources.length} 个档案合并到“${targetCase?.title ?? target}”？被合并档案将移除，此操作不可撤销。`)) { if (await save(`/api/trading-review/cases/${target}/merge`, { sourceCaseIds: sources })) setSelected(target); } }} />
      {!!data.suggestions?.length && <div className="tr-notice tr-suggestions"><strong>有 {data.suggestions.length} 组档案可能属于同一策略：</strong>{data.suggestions.map(s => { const target = data.cases.find(c => c.id === s.targetCaseId); return <button key={s.targetCaseId} type="button" className="text-button" onClick={() => setSelected(s.targetCaseId)}>{s.underlying} · {EVIDENCE[s.evidence]} · {s.sourceCaseIds.length + 1} 个档案 → {target?.title ?? s.targetCaseId}</button>; })}<span className="muted">同一订单或同秒开仓且结构可识别的腿已自动合并；这里列出的需要你确认。</span></div>}
      {data.statements.length > 0 && <details className="tr-data-notes"><summary>已导入 {data.statements.length} 份结单 · {data.statements.reduce((n, s) => n + s.fillCount, 0)} 笔成交</summary>{data.statements.map(s => <p key={s.id}>{s.fileName} · {s.broker} · {s.fillCount} 笔 · 费用 {s.feesTotal} · 净现金 {s.netCash} USD<br />{s.notes.join("；")}</p>)}</details>}
      {creating && <form className="tr-form tr-surface" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError("");
        try { const result = await writeJson<{ entry: TradingCase }>("/api/trading-review/cases", "POST", draft); await refresh(); setSelected(result.entry.id); setCreating(false); setNotice("档案已建立，请核对成交并记录复盘。"); }
        catch (e) { setError(e instanceof Error ? e.message : "创建失败"); } finally { setBusy(false); }
      }}><div className="tr-full tr-row"><h3>建立一笔策略交易</h3><button type="button" className="text-button" onClick={() => setCreating(false)}>收起</button></div>
        <Field label="档案标题"><input required maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="例如：黄金 ETF 波段交易" /></Field>
        <Field label="策略名称"><input required maxLength={200} value={draft.strategy} onChange={e => setDraft({ ...draft, strategy: e.target.value })} placeholder="例如：催化剂 / 趋势跟随" /></Field>
        <Field label="持有周期"><select value={draft.horizon} onChange={e => setDraft({ ...draft, horizon: e.target.value as TradingCaseInput["horizon"] })}>{Object.entries(HORIZONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="工具类型"><select value={draft.instrumentType} onChange={e => setDraft({ ...draft, instrumentType: e.target.value as TradingCaseInput["instrumentType"] })}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <div className="tr-full"><FillPicker fills={data.fills.filter(f => !f.caseId)} selected={draft.fillIds} onChange={fillIds => setDraft({ ...draft, fillIds })} /><Check checked={draft.historyComplete} onChange={historyComplete => setDraft({ ...draft, historyComplete })}>我已关联这笔策略从首次建仓至今的全部成交（组合各腿均包含）</Check><p className="muted">尚未确认的成交可以稍后补充。同一笔成交仅归属一个档案，不会重复记账。</p></div>
        <div className="tr-full"><button className="primary-button" disabled={busy}>建立档案</button></div>
      </form>}
      <div className="tr-case-layout"><aside className="tr-case-list"><input aria-label="搜索复盘档案" placeholder="搜索标的、策略或标题" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="筛选复盘状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option><option value="review-due">等待复盘（已退出未复盘）</option>{Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="档案排序" value={sort} onChange={e => setSort(e.target.value as keyof typeof SORTS)}>{Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>排序：{v}</option>)}</select>
        {sorted.map(c => { const m = tradingCaseMetrics(c), contracts = caseContracts(c); return <button className="tr-case" key={c.id} aria-pressed={entry?.id === c.id} onClick={() => setSelected(c.id)}><span>{c.strategy} · {HORIZONS[c.horizon]}</span><strong>{c.title}</strong>{contracts.length > 0 && <small className="tr-contract">{contracts.join(" / ")}</small>}<div><span className="tr-pill">{STATES[m.state]}</span><b>{m.netPnl === null ? "盈亏待核实" : `${formatMoney(m.netPnl)} ${m.currency}`}</b></div><small>开仓结构：{reviewExecutionDetails(c).direction}</small><small>{c.fills.length} 笔成交 · {c.assessments.length} 次复盘</small></button>; })}
        {!cases.length && <p className="empty-state">还没有符合条件的档案。</p>}
      </aside><main className="tr-case-detail">{entry ? <CaseDetail key={entry.id} entry={entry} data={data} news={news} intent={intent} clearIntent={() => setIntent(null)} newsId={newsId} clearNews={() => setNewsId(null)} save={save} busy={busy} /> : <div className="tr-empty tr-surface"><span className="tr-empty-mark">↗</span><h3>从一笔真实交易开始</h3><p>选择一笔档案，或将手动成交、Tradier 和 IBKR 成交归入同一策略。核对每笔成交的价格、费用与结果。</p><ol><li>成交：开仓、平仓与费用</li><li>执行：当时的观察与实际动作</li><li>复盘：过程评价与下次改进</li></ol><button className="secondary-button" onClick={() => setTab("learning")}>先阅读十种收益路径 →</button></div>}</main></div>
    </>}
    {tab === "lessons" && <LessonsWorkspace lessons={data.lessons ?? []} cases={data.cases} save={save} busy={busy} focusCaseId={route.rest[1]} onOpenCase={setSelected} />}
    {tab === "weekly" && <WeeklyReviewWorkspace cases={data.cases} fills={data.fills} weekly={data.weekly} save={save} busy={busy} />}
    {tab === "learning" && <OriginalLearning onUse={useKnowledge} />}
    {tab === "calculator" && <CatalystCalculator />}
  </div>;
});

function Stat({ label, value, note, onClick }: { label: string; value: string; note?: string; onClick?: () => void }) {
  const body = <><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</>;
  return onClick ? <button type="button" onClick={onClick}>{body}</button> : <div>{body}</div>;
}
function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) { return <label className={wide ? "tr-full" : undefined}><span>{label}</span>{children}</label>; }
function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) { return <label className="tr-check"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span>{children}</span></label>; }
function TagPicker({ label, items, selected, onChange }: { label: string; items: readonly { id: string; title: string }[]; selected: string[]; onChange: (v: string[]) => void }) { return <fieldset className="tr-tag-picker"><legend>{label}</legend><div>{items.map(item => <button type="button" key={item.id} aria-pressed={selected.includes(item.id)} onClick={() => onChange(toggle(selected, item.id))}>{item.title}</button>)}</div></fieldset>; }
function EvidencePicker({ entry, selected, onChange }: { entry: TradingCase; selected: string[]; onChange: (v: string[]) => void }) { return <TagPicker label="引用证据（可多选）" items={entry.evidence} selected={selected} onChange={onChange} />; }
function FillPicker({ fills, selected, onChange }: { fills: FillChoice[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState("");
  const shown = fills.filter(f => `${f.symbol} ${f.sourceLabel ?? f.source} ${f.occurredAt}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="tr-fill-picker"><div className="tr-row"><strong>关联现有成交 · 已选 {selected.length} 笔</strong><input aria-label="搜索可关联成交" value={query} onChange={e => setQuery(e.target.value)} placeholder="标的、券商或日期" /></div><div className="tr-fill-options">{shown.slice(0, 100).map(f => <Check key={f.id} checked={selected.includes(f.id)} onChange={() => onChange(toggle(selected, f.id))}><b>{f.symbol}</b> · {f.expirationConfirmation ? "到期作废" : f.side === "buy" ? "买" : "卖"} {f.quantity} @ {f.price ?? "待补"} {f.currency}<small>{f.sourceLabel ?? f.source} · {f.occurredAt}</small></Check>)}{!shown.length && <p className="muted">没有可关联的成交。可先去「持仓」手动记账，或在「券商」同步。</p>}</div>{shown.length > 100 && <p className="muted">匹配 {shown.length} 笔，显示前 100 笔，请按标的或日期缩小范围。</p>}</div>;
}

type Save = (path: string, body: unknown) => Promise<boolean>;
function CaseDetail({ entry, data, news, intent, clearIntent, newsId, clearNews, save, busy }: { entry: TradingCase; data: ReviewData; news: NewsItem[]; intent: Intent; clearIntent: () => void; newsId: string | null; clearNews: () => void; save: Save; busy: boolean }) {
  const [tab, setTab] = useState("assessment");
  const [assessment, setAssessment] = useState(freshAssessment);
  const [fillIds, setFillIds] = useState<string[]>([]);
  const [complete, setComplete] = useState(entry.historyComplete);
  const [exportError, setExportError] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [profile, setProfile] = useState<TradingCaseProfile>({ title: entry.title, strategy: entry.strategy, horizon: entry.horizon, instrumentType: entry.instrumentType });
  const metrics = tradingCaseMetrics(entry);
  const execution = useMemo(() => reviewExecutionDetails(entry), [entry]);
  const missing = metrics.missing.filter(note => !note.startsWith("R 待补"));
  useEffect(() => {
    if (!intent) return;
    setTab("assessment"); setTagsOpen(true);
    setAssessment(a => ({ ...a, curveIds: intent.kind === "curve" ? [...new Set([...a.curveIds, intent.id])] : a.curveIds, psychologyIds: intent.kind === "psychology" ? [...new Set([...a.psychologyIds, intent.id])] : a.psychologyIds }));
    clearIntent();
  }, [intent, clearIntent]);
  useEffect(() => { if (newsId) setTab("evidence"); }, [newsId]);
  const submit = (action: string, body: unknown) => save(`/api/trading-review/cases/${entry.id}/${action}`, body);
  return <div className="tr-surface"><header className="tr-detail-heading"><div><p className="eyebrow">{entry.strategy} · {HORIZONS[entry.horizon]} · {TYPES[entry.instrumentType]}</p><h3>{entry.title}</h3>{caseContracts(entry).length > 0 && <p className="tr-contract">{caseContracts(entry).join(" / ")}</p>}<span className="tr-pill">{STATES[metrics.state]}</span></div><div className="tr-detail-actions"><button className="secondary-button" aria-expanded={editingProfile} onClick={() => setEditingProfile(v => !v)}>{editingProfile ? "收起资料" : "编辑档案资料"}</button><button className="secondary-button" onClick={async () => { try { download(`trading-review-${entry.id}.json`, await getJson(`/api/trading-review/cases/${entry.id}/export`)); setExportError(""); } catch (e) { setExportError(e instanceof Error ? e.message : "导出失败"); } }}>导出复盘资料</button></div></header>
    {exportError && <p role="alert" className="inline-error">{exportError}</p>}
    {(() => { const asTarget = data.suggestions?.find(s => s.targetCaseId === entry.id), asSource = data.suggestions?.find(s => s.sourceCaseIds.includes(entry.id)); const targetCase = asSource && data.cases.find(c => c.id === asSource.targetCaseId);
      return asTarget ? <p className="tr-notice"><strong>建议合并：</strong>{asTarget.basis} 可并入 {asTarget.sourceCaseIds.length} 个无复盘记录的档案：{asTarget.sourceCaseIds.map(id => data.cases.find(c => c.id === id)?.title ?? id).join("、")}。<button type="button" className="text-button" disabled={busy} onClick={async () => { if (window.confirm(`将 ${asTarget.sourceCaseIds.length} 个档案合并到“${entry.title}”？被合并档案将移除，此操作不可撤销。`)) await submit("merge", { sourceCaseIds: asTarget.sourceCaseIds }); }}>按建议合并</button></p>
        : asSource && targetCase ? <p className="tr-notice">此档案可能与“{targetCase.title}”属于同一策略（{EVIDENCE[asSource.evidence]}）。<button type="button" className="text-button" onClick={() => replaceRoute("trading-review", "cases", targetCase.id)}>打开目标档案</button></p> : null; })()}
    {entry.pairingBasis?.startsWith("自动合并") && <p className="muted">{entry.pairingBasis}</p>}
    {(() => { const linked = (data.lessons ?? []).filter(l => l.caseIds.includes(entry.id) && l.status === "active"); return <p className="tr-notice tr-case-lessons"><strong>交易经验：</strong>{linked.length ? linked.map(l => <span key={l.id}>{LESSON_CATEGORIES[l.category]} · {l.title}；</span>) : "这笔交易还没有记录经验。"}<button type="button" className="text-button" onClick={() => replaceRoute("trading-review", "lessons", entry.id)}>记录这笔交易的经验</button></p>; })()}
    {entry.strategy === AUTO_STRATEGY && !editingProfile && <p className="tr-notice">这是券商成交自动配对的档案。请补充真实的策略意图与持有周期，复盘结论才有依据。<button type="button" className="text-button" onClick={() => setEditingProfile(true)}>补充策略与周期</button></p>}
    {editingProfile && <form className="tr-form tr-surface tr-profile-form" onSubmit={async e => { e.preventDefault(); if (await submit("profile", profile)) setEditingProfile(false); }}>
      <div className="tr-full tr-row"><h4>档案资料</h4><span className="muted">修改会保留此前的值；成交、证据与复盘记录不受影响。</span></div>
      <Field label="档案标题"><input required maxLength={200} value={profile.title} onChange={e => setProfile({ ...profile, title: e.target.value })} /></Field>
      <Field label="策略意图"><input required maxLength={200} value={profile.strategy} onChange={e => setProfile({ ...profile, strategy: e.target.value })} placeholder="例如：财报前 Put Spread / 趋势跟随 / 事件驱动" /></Field>
      <Field label="持有周期"><select value={profile.horizon} onChange={e => setProfile({ ...profile, horizon: e.target.value as TradingCaseProfile["horizon"] })}>{Object.entries(HORIZONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="工具类型"><select value={profile.instrumentType} onChange={e => setProfile({ ...profile, instrumentType: e.target.value as TradingCaseProfile["instrumentType"] })}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <div className="tr-full"><button className="primary-button" disabled={busy}>保存档案资料</button> <button type="button" className="text-button" onClick={() => { setEditingProfile(false); setProfile({ title: entry.title, strategy: entry.strategy, horizon: entry.horizon, instrumentType: entry.instrumentType }); }}>取消</button></div>
      {!!entry.profileHistory?.length && <details className="tr-full tr-data-notes"><summary>资料修改历史 · {entry.profileHistory.length} 次</summary>{entry.profileHistory.map(h => <p key={h.recordedAt}>{formatTimestamp(h.recordedAt)} 之前：{h.title} · {h.strategy} · {HORIZONS[h.horizon]} · {TYPES[h.instrumentType]}</p>)}</details>}
    </form>}
    <div className="tr-stats tr-stats-three"><Stat label="整笔净盈亏" value={metrics.netPnl === null ? "待核实 / 未完整退出" : `${formatMoney(metrics.netPnl)} ${metrics.currency}`} /><Stat label="成交总手续费" value={execution.fees.map(f => `${formatMoney(f.total)} ${f.currency}`).join(" / ") || "暂无成交"} /><Stat label="逐笔复盘" value={`${entry.assessments.length} 次记录`} /></div>
    <ExecutionSummary entry={entry} />
    <DailyContext entry={entry} direction={execution.direction} />
    {missing.length > 0 && <details className="tr-data-notes"><summary>待核对信息 · {missing.length} 项</summary>{missing.map(note => <p key={note}>{note}</p>)}</details>}
    <div className="tr-tabs tr-detail-tabs" role="tablist" aria-label="交易档案内容">{[["assessment", "逐笔复盘"], ["fills", "成交明细"], ["evidence", "新闻与判断"]].map(([id, label]) => <button role="tab" key={id} aria-selected={tab === id} onClick={() => setTab(id!)}>{label}</button>)}</div>
    {tab === "assessment" && <><form className="tr-form concise-assessment" onSubmit={async e => { e.preventDefault(); if (await submit("assessments", assessment)) setAssessment(freshAssessment()); }}>
      <Field label="复盘结论" wide><textarea required rows={3} maxLength={1000} value={assessment.findings} onChange={e => setAssessment({ ...assessment, findings: e.target.value })} placeholder="关键判断、实际结果、主要原因，写清 1–3 句话" /></Field>
      <Field label="下次改进" wide><textarea required rows={2} maxLength={500} value={assessment.nextBehavior} onChange={e => setAssessment({ ...assessment, nextBehavior: e.target.value })} placeholder="只写一项：遇到什么情况，具体怎样做" /></Field>
      <details className="tr-full assessment-options" open={tagsOpen} onToggle={e => setTagsOpen(e.currentTarget.open)}><summary>路径、心理与证据（可选）</summary><TagPicker label="收益路径" items={content.curves} selected={assessment.curveIds} onChange={curveIds => setAssessment({ ...assessment, curveIds })} /><TagPicker label="当时的心理与行为" items={content.psychology} selected={assessment.psychologyIds} onChange={psychologyIds => setAssessment({ ...assessment, psychologyIds })} /><Field label="执行质量"><select value={assessment.executionQuality} onChange={e => setAssessment({ ...assessment, executionQuality: e.target.value as TradingAssessmentInput["executionQuality"] })}><option value="unknown">暂不评价</option><option value="followed">执行符合预期</option><option value="deviated">执行存在偏差</option></select></Field><EvidencePicker entry={entry} selected={assessment.evidenceIds} onChange={evidenceIds => setAssessment({ ...assessment, evidenceIds })} /></details>
      <div className="tr-full"><button className="primary-button" disabled={busy}>保存逐笔复盘</button><span className="muted"> {metrics.state === "closed" ? "事后复盘" : "暂定复盘，完整退出后可追加验证"}</span></div>
    </form><h4>复盘历史</h4>{[...entry.assessments].reverse().map(a => <article className="tr-history" key={a.id}><header><strong>{a.stage === "provisional" ? "暂定复盘" : "事后复盘"}</strong><time>{formatTimestamp(a.recordedAt)}</time></header><p className="tr-prose">{a.findings}</p><p className="tr-next">下次改进：{a.nextBehavior}</p><div className="tr-tags">{[...content.curves, ...content.psychology].filter(c => [...a.curveIds, ...a.psychologyIds].includes(c.id)).map(c => <span key={c.id}>{c.title}</span>)}</div><EvidenceReferences entry={entry} ids={a.evidenceIds} /></article>)}{!entry.assessments.length && <p className="muted">还没有复盘结论。</p>}</>}
    {tab === "fills" && <><ExecutionRows entry={entry} /><details className="tr-data-notes"><summary>补充成交与核对完整性</summary><form onSubmit={async e => { e.preventDefault(); if (await submit("fills", { fillIds: fillIds.length ? fillIds : entry.fillIds, historyComplete: complete })) setFillIds([]); }}><FillPicker fills={data.fills.filter(f => !f.caseId)} selected={fillIds} onChange={setFillIds} /><Check checked={complete} onChange={setComplete}>已包含该策略从首次建仓至今的完整成交</Check><button className="primary-button" disabled={busy || (!fillIds.length && !entry.fills.length)}>保存成交关联</button></form>{entry.linkHistory.map((l, i) => <p key={i}>{formatTimestamp(l.recordedAt)} · 选择 {l.fillIds.length} 笔 · {l.historyComplete ? "已确认完整" : "等待核对"}{l.mergedFrom?.length ? ` · 合并自：${l.mergedFrom.map(m => m.title).join("、")}` : ""}</p>)}</details><MergeCases entry={entry} data={data} submit={submit} busy={busy} /></>}
    {tab === "evidence" && <EvidenceAndEvents entry={entry} data={data} news={news} newsId={newsId} clearNews={clearNews} submit={submit} busy={busy} />}
  </div>;
}

function DailyContext({ entry, direction }: { entry: TradingCase; direction: string }) {
  const metrics = tradingCaseMetrics(entry);
  const opened = metrics.openedAt ? brokerReportDay(metrics.openedAt) : null, closed = metrics.closedAt ? brokerReportDay(metrics.closedAt) : null;
  const today = new Date().toISOString().slice(0, 10);
  const from = opened ? shiftDay(opened, -3) : null, to = opened ? [closed ?? shiftDay(opened, 5), today].sort()[0]! : null;
  const [rows, setRows] = useState<MarketDailySummary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!from || !to) { setRows([]); return; }
    const abort = new AbortController();
    getJson<{ reports: MarketDailySummary[] }>(`/api/research/daily-reports?from=${from}&to=${to}&status=ready`, abort.signal).then(r => { setRows(r.reports); setError(""); }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "日报读取失败"); });
    return () => abort.abort();
  }, [from, to]);
  if (!opened) return null;
  return <section className="tr-daily-context"><div className="tr-row"><h4>当时的市场日报</h4><small className="muted">开仓 {opened}{closed ? ` → 退出 ${closed}` : ""} 前后 · 开仓结构：{direction}</small></div>
    {error && <p className="inline-error">{error}</p>}
    {rows && !rows.length && <p className="muted">这段时间没有已保存的市场日报；可到“宏观研究 → 市场日报”补填。</p>}
    {!!rows?.length && <div className="tr-daily-rows">{rows.slice(0, 6).map(r => <a key={r.id} href={routeHash("research", "daily", r.id)}><strong>{r.date}</strong><span className={`daily-stance stance-${r.stance}`}>{MARKET_STANCES[r.stance]}</span><span className="tr-daily-text">{r.summary || r.excerpt || r.title}</span></a>)}</div>}
    <p className="chart-note">日报是长周期宏观观点，与这笔交易的方向是否一致由你判断，不自动评分；点击日期可打开原文。</p>
  </section>;
}
function MergeCases({ entry, data, submit, busy }: { entry: TradingCase; data: ReviewData; submit: (action: string, body: unknown) => Promise<boolean>; busy: boolean }) {
  const [picked, setPicked] = useState<string[]>(() => data.suggestions?.find(s => s.targetCaseId === entry.id)?.sourceCaseIds ?? []);
  const [query, setQuery] = useState("");
  const mine = underlyings(entry);
  const related = (c: TradingCase) => underlyings(c).some(u => mine.includes(u));
  const candidates = data.cases.filter(c => c.id !== entry.id && unreviewed(c)).sort((a, b) => Number(related(b)) - Number(related(a)) || (tradingCaseMetrics(b).openedAt ?? "").localeCompare(tradingCaseMetrics(a).openedAt ?? ""));
  const shown = candidates.filter(c => !query || `${c.title} ${caseContracts(c).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  if (!candidates.length) return null;
  return <details className="tr-data-notes tr-merge"><summary>合并其他档案到本档案 · {candidates.length} 个无复盘记录的档案可选</summary>
    <p className="muted">用于把自动拆开的价差各腿或分批成交并入同一策略：被合并档案会移除，其成交并入本档案并写入关联历史；已有复盘、证据或操作记录的档案不能被合并。同标的档案排在前面。</p>
    <div className="tr-row"><strong>已选 {picked.length} 个</strong><input aria-label="筛选可合并档案" value={query} onChange={e => setQuery(e.target.value)} placeholder="标的、到期日或标题" /></div>
    <div className="tr-fill-options">{shown.slice(0, 40).map(c => { const m = tradingCaseMetrics(c); return <Check key={c.id} checked={picked.includes(c.id)} onChange={() => setPicked(toggle(picked, c.id))}><b>{c.title}</b>{related(c) ? " · 同标的" : ""}<small>{caseContracts(c).join(" / ") || c.fills.map(f => f.symbol).join(" / ")} · {STATES[m.state]} · {c.fills.length} 笔成交{m.netPnl !== null ? ` · ${formatMoney(m.netPnl)} ${m.currency}` : ""}</small></Check>; })}</div>
    <button type="button" className="primary-button" disabled={busy || !picked.length} onClick={async () => { if (!window.confirm(`将 ${picked.length} 个档案合并到“${entry.title}”？被合并档案将移除，其成交归入本档案，此操作不可撤销。`)) return; if (await submit("merge", { sourceCaseIds: picked })) setPicked([]); }}>合并所选档案到本档案</button>
  </details>;
}
function EvidenceReferences({ entry, ids }: { entry: TradingCase; ids: string[] }) { return ids.length ? <p className="muted">引用证据：{ids.map(id => entry.evidence.find(e => e.id === id)?.title ?? "待核实").join("；")}</p> : null; }
function EvidenceAndEvents({ entry, data, news, newsId, clearNews, submit, busy }: { entry: TradingCase; data: ReviewData; news: NewsItem[]; newsId: string | null; clearNews: () => void; submit: (action: string, body: unknown) => Promise<boolean>; busy: boolean }) {
  const [selectedNews, setSelectedNews] = useState(newsId ?? "");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const linkedNews = news.find(n => n.id === selectedNews);
  useEffect(() => { if (newsId) { setSelectedNews(newsId); clearNews(); } }, [newsId, clearNews]);
  return <><details className="tr-form-section" open><summary>添加当时的证据</summary><form className="tr-form" key={selectedNews} onSubmit={async e => {
    e.preventDefault(); const form = e.currentTarget, fd = new FormData(form);
    const body: TradingEvidenceInput = { title: value(fd, "title"), facts: value(fd, "facts"), interpretation: value(fd, "interpretation"), sourceUrl: value(fd, "sourceUrl"), availableAt: iso(fd.get("availableAt")), newsId: selectedNews || null, researchId: value(fd, "researchId") || null };
    if (await submit("evidence", body)) { form.reset(); setSelectedNews(""); }
  }}>
    <Field label="关联新闻"><select value={selectedNews} onChange={e => setSelectedNews(e.target.value)}><option value="">自行记录来源</option>{news.map(n => <option value={n.id} key={n.id}>{n.title.slice(0, 100)}</option>)}</select></Field>
    <Field label="关联已有宏观判断"><select name="researchId"><option value="">不关联</option>{data.research.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select></Field>
    <Field label="证据标题"><input name="title" required maxLength={300} defaultValue={linkedNews?.title.slice(0, 300) ?? ""} /></Field>
    <Field label="来源链接"><input name="sourceUrl" type="url" defaultValue={linkedNews?.url ?? ""} /></Field>
    <Field label="已经核实的事实" wide><textarea name="facts" required placeholder="尽量记录具体公布值、公告内容或实际观察" /></Field>
    <Field label="我的解释与反证" wide><textarea name="interpretation" placeholder="事实可能通过什么机制影响美债、黄金、原油或利率判断？什么证据会反驳？" /></Field>
    <Field label={`信息可获得时间（${timezone()}，不知道可留空）`}><input type="datetime-local" name="availableAt" /></Field>
    <div className="tr-full"><button className="primary-button" disabled={busy}>保存证据</button></div>
  </form></details>
    <details className="tr-form-section"><summary>记录操作与逻辑变化</summary><form className="tr-form" onSubmit={async e => { e.preventDefault(); const form = e.currentTarget, fd = new FormData(form); const body: TradingEventInput = { occurredAt: iso(fd.get("occurredAt")), logicStatus: value(fd, "logicStatus") as TradingEventInput["logicStatus"], observation: value(fd, "observation"), action: value(fd, "action"), evidenceIds }; if (await submit("events", body)) { form.reset(); setEvidenceIds([]); } }}>
      <Field label={`实际发生时间（${timezone()}，可留空）`}><input type="datetime-local" name="occurredAt" /></Field>
      <Field label="当前逻辑状态"><select name="logicStatus" defaultValue="unknown">{Object.entries(LOGIC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="当时的观察与理由" wide><textarea name="observation" required /></Field><Field label="实际采取的动作" wide><textarea name="action" required placeholder="记录已做的决定，包括保持不动；成交请在关联成交中选择" /></Field>
      <div className="tr-full"><EvidencePicker entry={entry} selected={evidenceIds} onChange={setEvidenceIds} /></div><button className="primary-button" disabled={busy}>保存操作记录</button>
    </form></details>
    <h4>证据与操作时间线</h4>
    {[...entry.evidence.map(e => ({ at: e.recordedAt, id: e.id, node: <><header><strong>证据 · {e.title}</strong><time>记录于 {formatTimestamp(e.recordedAt)}</time></header><p className="muted">信息可获得时间：{e.availableAt ? formatTimestamp(e.availableAt) : "待核实"}</p><p className="tr-prose">{e.facts}</p>{e.interpretation && <p className="tr-prose">判断：{e.interpretation}</p>}{e.sourceUrl && <a href={e.sourceUrl} target="_blank" rel="noreferrer">查看来源 ↗</a>}{e.sourceSnapshot.map((s, i) => <details key={i}><summary>关联内容快照：{s.title}</summary><p className="tr-prose">{s.text}</p></details>)}</> })), ...entry.events.map(e => ({ at: e.recordedAt, id: e.id, node: <><header><strong>操作 · 逻辑{LOGIC[e.logicStatus]}</strong><time>记录于 {formatTimestamp(e.recordedAt)}</time></header><p className="muted">实际发生时间：{e.occurredAt ? formatTimestamp(e.occurredAt) : "待核实"}{e.occurredAt && e.occurredAt < e.recordedAt ? " · 事后补记" : ""}</p><p className="tr-prose">观察：{e.observation}</p><p className="tr-prose">动作：{e.action}</p><EvidenceReferences entry={entry} ids={e.evidenceIds} /></> }))].sort((a, b) => b.at.localeCompare(a.at)).map(row => <article className="tr-history" key={row.id}>{row.node}</article>)}
    {!entry.evidence.length && !entry.events.length && <p className="muted">还没有证据或操作记录。信息可获得、实际发生和记录时间会分别保留。</p>}
  </>;
}

function CatalystCalculator() {
  const [q, setQ] = useState(""), [p, setP] = useState(""), [m, setM] = useState("1"), [whole, setWhole] = useState(false);
  let result: ReturnType<typeof catalystExample> | null = null;
  try { if (q && p && m) result = catalystExample(q, p, m, whole); } catch { /* Incomplete numeric input. */ }
  return <div className="tr-surface"><p className="eyebrow">TEACHING EXAMPLE · 50 / 25 / 25</p><h3>分清回收现金与实现利润</h3><p className="muted">适用于固定初始成本、未加仓的买入或净借方头寸。仅为教学计算，未扣费用与滑点；不记录任何卖出或规则执行。</p><div className="tr-form"><Field label="初始数量 Q"><input inputMode="decimal" value={q} onChange={e => setQ(e.target.value)} /></Field><Field label="初始单位借方成本 P"><input inputMode="decimal" value={p} onChange={e => setP(e.target.value)} /></Field><Field label="经核实的合约乘数"><input inputMode="decimal" value={m} onChange={e => setM(e.target.value)} /></Field><Check checked={whole} onChange={setWhole}>数量必须是整数合约 / 组合单位</Check></div>
    {result ? <><div className="tr-workflow tr-calculator-stages"><div><span>01 · +100%</span><strong>单位价值 {formatMoney(result.firstPrice)}</strong><small>卖出初始 50%：{result.quantities[0]} 单位</small><p>毛回收 {formatMoney(result.firstCash)}<br />已实现利润 {formatMoney(result.firstRealized)}</p></div><div><span>02 · +200%</span><strong>单位价值 {formatMoney(result.secondPrice)}</strong><small>再卖初始 25%：{result.quantities[1]} 单位</small><p>累计毛回收 {formatMoney(result.cumulativeCash)}<br />累计已实现利润 {formatMoney(result.cumulativeRealized)}</p></div><div><span>03 · 尾仓</span><strong>保留 {result.quantities[2]} 单位</strong><small>尾仓原始成本 {formatMoney(result.tailCost)}</small><p>若尾仓归零，最终毛利润<br />{formatMoney(result.tailZeroFinalPnl)}</p></div></div>{!result.validUnits && <p className="inline-error" role="alert">该比例产生不可成交的小数合约。请自行选择合法的完整单位分配，本工具不会自动取整。</p>}</> : <p className="empty-state">输入正数数量与单位成本，查看各阶段的教学算例。</p>}
    <p className="tr-notice">50 / 25 / 25 与 90 / 10 是不同方案。信用结构不可直接套用；有限收益价差需核实目标是否可达。加仓、提前减仓或移仓后，原方案需重新评估。</p>
  </div>;
}
function download(name: string, data: unknown) { const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
