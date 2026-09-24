import { lazy, memo, Suspense, useCallback, useEffect, useState } from "react";
import { navigateRoute } from "./route";
import { getJson, writeJson } from "./api";
import { formatTimestamp } from "./format";
const ResearchHub = lazy(() => import("./ResearchHub").then(module => ({ default: module.ResearchHub })));
import type { BrokerSnapshot, InstrumentMeta, NewsItem, ResearchEntry, ResearchReview, ResearchWrite, TransactionRecord } from "./types";

export const TOPICS = { treasuries: "美债", gold: "黄金", oil: "原油", rates: "利率政策", inflation: "通胀", growth: "经济增长", trade: "交易复盘" } as const;
const OUTCOMES = { pending: "待验证", confirmed: "符合预期", invalidated: "判断失效", mixed: "部分符合" } as const;
const TOPIC_HINTS = {
  treasuries: "记录 2 年 / 10 年收益率、期限利差，以及变化的原因。",
  gold: "记录金价、实际利率与美元变化，区分事实和你的推断。",
  oil: "记录 WTI / Brent、库存、供需变化与事件影响。",
  rates: "记录已公布的利率决议，并另行写下对下一次会议的预期。",
  inflation: "记录 CPI / PCE 的公布值、前值与预期差。",
  growth: "记录就业、消费、PMI 等证据，以及对增长的判断。",
  trade: "记录入场依据、执行偏差，以及什么结果会推翻原判断。",
};
const freshDraft = (): ResearchWrite => ({ title: "", topic: "treasuries", facts: "", thesis: "", invalidation: "", sourceUrl: "", observedOn: new Date().toISOString().slice(0, 10), reviewOn: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), newsIds: [], transactionIds: [] });

export function startResearch(link: { newsId?: string; transactionId?: string }) {
  try { sessionStorage.setItem("invest:research-link", JSON.stringify(link)); } catch { /* The form remains usable without storage. */ }
  navigateRoute("research", "journal");
}

// Memoized: quote ticks replace the snapshot object but keep these props, so the research hub (forms, charts) is not re-rendered.
export const ResearchWorkspace = memo(function ResearchWorkspace({ news, transactions, instruments }: { news: NewsItem[]; transactions: TransactionRecord[]; instruments: Record<string, InstrumentMeta> }) {
  return <Suspense fallback={<p className="empty-state">正在打开研究工作区…</p>}><ResearchHub news={news} journal={<ResearchJournal news={news} transactions={transactions} instruments={instruments} />} /></Suspense>;
});

function ResearchJournal({ news, transactions, instruments }: { news: NewsItem[]; transactions: TransactionRecord[]; instruments: Record<string, InstrumentMeta> }) {
  const [entries, setEntries] = useState<ResearchEntry[]>([]);
  const [brokerAccounts, setBrokerAccounts] = useState<BrokerSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ResearchWrite>(freshDraft);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [topic, setTopic] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [query, setQuery] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [research, brokers] = await Promise.all([getJson<{ entries: ResearchEntry[] }>("/api/research"), getJson<{ accounts: BrokerSnapshot[] }>("/api/brokers")]);
      setEntries(research.entries); setBrokerAccounts(brokers.accounts); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("invest:research-link");
      if (!raw) return;
      const link = JSON.parse(raw) as { newsId?: string; transactionId?: string };
      const item = news.find(item => item.id === link.newsId);
      setDraft(current => ({ ...current, topic: link.transactionId ? "trade" : current.topic, title: item?.title.slice(0, 200) ?? "", sourceUrl: item?.url ?? "", newsIds: item ? [item.id] : [], transactionIds: link.transactionId ? [link.transactionId] : [] }));
      setOpen(true);
      sessionStorage.removeItem("invest:research-link");
    } catch { /* Ignore malformed local navigation state. */ }
  }, [news]);
  const tradeOptions = [
    ...transactions.map(trade => ({ id: trade.id, label: `手工 · ${instruments[trade.instrumentId]?.symbol ?? trade.instrumentId} · ${trade.type} · ${trade.quantity} · ${formatTimestamp(new Date(trade.tradeAtMs).toISOString())}` })),
    ...brokerAccounts.flatMap(account => account.trades.map(trade => ({ id: trade.id, label: `${account.broker} · ${trade.symbol} · ${trade.side} · ${trade.quantity} · ${trade.tradedAt}` }))),
  ];
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError(null); setNotice("");
    try {
      const { entry } = await writeJson<{ entry: ResearchEntry }>("/api/research", "POST", draft);
      setEntries(current => [entry, ...current]); setDraft(freshDraft()); setOpen(false); setTopic("all"); setOutcome("all"); setQuery(""); setNotice("判断已保存，后续可追加验证记录。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  const lastOutcome = (entry: ResearchEntry) => entry.reviews.at(-1)?.outcome ?? "pending";
  const today = new Date().toISOString().slice(0, 10);
  const due = entries.filter(entry => lastOutcome(entry) === "pending" && entry.reviewOn <= today).length;
  const filtered = entries.filter(entry => (topic === "all" || entry.topic === topic) && (outcome === "all" || (outcome === "due" ? entry.reviewOn <= today && lastOutcome(entry) === "pending" : lastOutcome(entry) === outcome)) && `${entry.title} ${entry.facts} ${entry.thesis}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="widget research-workspace">
    <div className="workspace-intro"><div><p className="eyebrow">RESEARCH JOURNAL</p><h3>让判断留下证据</h3><p>观察事实 → 写下判断与证伪条件 → 关联交易 → 到期验证</p></div><button className="primary-button" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? "收起记录表" : "＋ 记录新判断"}</button></div>
    <div className="research-topic-grid">{(["treasuries", "gold", "oil", "rates"] as const).map(key => <button key={key} aria-pressed={topic === key} onClick={() => setTopic(value => value === key ? "all" : key)}><strong>{TOPICS[key]}</strong><span>{entries.filter(entry => entry.topic === key).length} 条观察</span><p>{TOPIC_HINTS[key]}</p></button>)}</div>
    <div className="research-summary"><span>{entries.length} 条判断</span><span>{entries.filter(entry => lastOutcome(entry) !== "pending").length} 条已有验证</span><button className="text-button" onClick={() => setOutcome("due")}>{due} 条到期待验证 →</button></div>
    {notice ? <p className="password-success" role="status">{notice}</p> : null}
    {error ? <div className="inline-error" role="alert">{error}<button className="text-button" onClick={() => void refresh()}>重试读取</button></div> : null}
    {open ? <form className="research-form" onSubmit={save}>
      <label className="form-wide">判断标题<input required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="这次要观察和验证什么？" /></label>
      <label>主题<select value={draft.topic} onChange={event => setDraft({ ...draft, topic: event.target.value as ResearchWrite["topic"] })}>{Object.entries(TOPICS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>原始来源链接（可选）<input type="url" maxLength={2000} value={draft.sourceUrl} onChange={event => setDraft({ ...draft, sourceUrl: event.target.value })} placeholder="https://" /></label>
      <label>观察日期<input type="date" required value={draft.observedOn} onChange={event => setDraft({ ...draft, observedOn: event.target.value })} /></label>
      <label>计划验证日期<input type="date" required min={draft.observedOn} value={draft.reviewOn} onChange={event => setDraft({ ...draft, reviewOn: event.target.value })} /></label>
      <label className="form-wide">已知事实<textarea required maxLength={10000} value={draft.facts} onChange={event => setDraft({ ...draft, facts: event.target.value })} placeholder={TOPIC_HINTS[draft.topic]} /></label>
      <label>我的判断<textarea required maxLength={10000} value={draft.thesis} onChange={event => setDraft({ ...draft, thesis: event.target.value })} placeholder="预期方向、期限，以及影响哪些资产或交易。" /></label>
      <label>证伪条件<textarea required maxLength={5000} value={draft.invalidation} onChange={event => setDraft({ ...draft, invalidation: event.target.value })} placeholder="出现什么事实时，应承认原判断不成立？" /></label>
      <label>关联新闻（可多选）<select multiple size={4} value={draft.newsIds} onChange={event => setDraft({ ...draft, newsIds: Array.from(event.target.selectedOptions, option => option.value) })}>{news.map(item => <option value={item.id} key={item.id}>{item.title.slice(0, 90)}</option>)}</select></label>
      <label>关联交易（可多选）<select multiple size={4} value={draft.transactionIds} onChange={event => setDraft({ ...draft, transactionIds: Array.from(event.target.selectedOptions, option => option.value) })}>{tradeOptions.map(trade => <option key={trade.id} value={trade.id}>{trade.label}</option>)}</select></label>
      <p className="form-wide muted">桌面端按住 Ctrl / Command 可多选。原始判断保存后保留不变，验证结论会作为新记录追加。</p>
      <button className="primary-button form-wide" disabled={saving} type="submit">{saving ? "保存中…" : "保存判断"}</button>
    </form> : null}
    <div className="filter-toolbar"><input aria-label="搜索判断" placeholder="搜索判断、事实…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="筛选研究主题" value={topic} onChange={event => setTopic(event.target.value)}><option value="all">全部主题</option>{Object.entries(TOPICS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="筛选验证状态" value={outcome} onChange={event => setOutcome(event.target.value)}><option value="all">全部状态</option><option value="due">到期待验证</option>{Object.entries(OUTCOMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
    {loading ? <p className="empty-state">正在读取判断日志…</p> : !filtered.length ? <div className="workspace-empty"><span aria-hidden="true">✎</span><h3>{entries.length ? "没有匹配的判断" : "第一条判断，从一个事实开始"}</h3><p>记录美债、黄金、原油或利率变化，也可以从情报页或一笔交易发起复盘。</p></div> : <div className="journal-list">{filtered.map(entry => <ResearchCard key={entry.id} entry={entry} onUpdated={next => setEntries(current => current.map(row => row.id === next.id ? next : row))} />)}</div>}
  </section>;
}

function ResearchCard({ entry, onUpdated }: { entry: ResearchEntry; onUpdated: (entry: ResearchEntry) => void }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<ResearchReview["outcome"]>("pending");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const latest = entry.reviews.at(-1)?.outcome ?? "pending";
  return <article className="journal-card">
    <div className="news-meta"><span className="quote-asset">{TOPICS[entry.topic]}</span><span className={`review-outcome review-outcome--${latest}`}>{OUTCOMES[latest]}</span><span>观察 {entry.observedOn}</span><span>计划验证 {entry.reviewOn}</span></div>
    <h3>{entry.title}</h3><div className="journal-evidence"><div><h4>已知事实</h4><p>{entry.facts}</p></div><div><h4>原始判断</h4><p>{entry.thesis}</p></div><div><h4>证伪条件</h4><p>{entry.invalidation}</p></div></div>
    {entry.sourceUrl ? <a className="source-link" href={entry.sourceUrl} target="_blank" rel="noreferrer">查看原始来源 ↗</a> : null}
    {entry.evidence.length || entry.linkedTrades.length ? <details className="journal-links"><summary>关联证据 · {entry.evidence.length} 条新闻 / {entry.linkedTrades.length} 笔交易</summary>{entry.evidence.map(item => <a href={item.url} target="_blank" rel="noreferrer" key={item.id}>{item.title}</a>)}{entry.linkedTrades.map(trade => <p key={trade.id}>{trade.label}</p>)}</details> : null}
    {entry.reviews.length ? <div className="review-timeline">{entry.reviews.map((review, i) => <div key={i}><strong>{OUTCOMES[review.outcome]}</strong><time>{formatTimestamp(review.reviewedAt)}</time><p>{review.notes}</p></div>)}</div> : null}
    <div className="journal-card-footer"><span>记录于 {formatTimestamp(entry.createdAt)}</span><button className="secondary-button" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? "收起" : "追加验证"}</button></div>
    {open ? <form className="review-form" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError("");
      try { const result = await writeJson<{ entry: ResearchEntry }>(`/api/research/${encodeURIComponent(entry.id)}/reviews`, "POST", { outcome, notes }); onUpdated(result.entry); setNotes(""); setOpen(false); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setBusy(false); }
    }}><label>验证结论<select value={outcome} onChange={event => setOutcome(event.target.value as ResearchReview["outcome"])}>{Object.entries(OUTCOMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>实际结果与依据<textarea required maxLength={10000} value={notes} onChange={event => setNotes(event.target.value)} placeholder="发生了什么？哪些证据支持或推翻了判断？下次会怎样调整？" /></label>{error ? <p className="inline-error" role="alert">{error}</p> : null}<button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存验证"}</button></form> : null}
  </article>;
}
