import { useCallback, useEffect, useRef, useState } from "react";
import { STUDY_INSTRUMENTS, pairedStudy, type GeoEvent, type StudySeries } from "@invest/domain";
import { getJson, writeJson } from "./api";
import { parseRoute, replaceRoute, useRoute } from "./route";
import type { NewsItem } from "./types";
import type { StudyBoard, StudyData } from "./research-model";
import { StudyCandles, StudyLines, MonthlyStudy, changeText, STUDY_COLORS } from "./ResearchCharts";
import { SectorObservation } from "./SectorObservation";
import { GeoObservation } from "./GeoObservation";
import { MarketDaily } from "./MarketDaily";
import { DailyInference } from "./DailyInference";

const TABS = { market: "市场联动", daily: "市场日报", inference: "日报推理", monthly: "十年月度", sectors: "行业观察", events: "地缘事件", journal: "判断日志" } as const;
type Tab = keyof typeof TABS;
const isTab = (value: string | undefined): value is Tab => !!value && value in TABS;
const routedTab = (): Tab | null => { const route = parseRoute(); return route.section === "research" && isTab(route.rest[0]) ? route.rest[0] : null; };
const initialTab = (): Tab => { const routed = routedTab(); if (routed) return routed; try { return sessionStorage.getItem("invest:research-link") ? "journal" : "market"; } catch { return "market"; } };
const EMPTY: StudyBoard = { events: [], notes: [], companies: [] };
export function ResearchHub({ news, journal }: { news: NewsItem[]; journal: React.ReactNode }) {
  const [tab, setTab] = useState<Tab>(initialTab), [journalVisited, setJournalVisited] = useState(tab === "journal");
  const [dailyVisited, setDailyVisited] = useState(tab === "daily");
  const [inferenceVisited, setInferenceVisited] = useState(tab === "inference"), [inferenceFocus, setInferenceFocus] = useState<{ reportId: string; nonce: number } | null>(null);
  // Sub-view lives in the hash (#/research/<tab>) so reload and links restore it; tab changes replace the entry.
  const route = useRoute(), linkedTab = route.section === "research" && isTab(route.rest[0]) ? route.rest[0] : null;
  const select = useCallback((next: Tab) => { setTab(next); if (next === "daily") setDailyVisited(true); if (next === "inference") setInferenceVisited(true); if (next === "journal") setJournalVisited(true); }, []);
  useEffect(() => { if (linkedTab) select(linkedTab); }, [linkedTab, select]);
  useEffect(() => { const current = parseRoute(); if (current.section === "research") replaceRoute("research", tab, ...(current.rest[0] === tab ? current.rest.slice(1) : [])); }, [tab]);
  const [board, setBoard] = useState<StudyBoard>(EMPTY), [boardError, setBoardError] = useState(""), [loading, setLoading] = useState(true);
  const [data, setData] = useState<Record<string, StudySeries>>({}), [errors, setErrors] = useState<Record<string, string>>({}), [busy, setBusy] = useState<string[]>([]);
  const pending = useRef(new Map<string, Promise<void>>());
  const [asset, setAsset] = useState("sp500"), [compare, setCompare] = useState("gold-futures");
  const [comparisonCursor, setComparisonCursor] = useState<number | null>(null);
  const [from, setFrom] = useState(`${new Date().getUTCFullYear() - 1}-01-01`), [through, setThrough] = useState(new Date().toISOString().slice(0, 10));
  const [draftDate, setDraftDate] = useState<{ date: string; nonce: number } | null>(null), [focusId, setFocusId] = useState<string | null>(null);
  const reload = useCallback(async () => { try { setBoard(await getJson<StudyBoard>("/api/research/board")); setBoardError(""); } catch (e) { setBoardError(e instanceof Error ? e.message : "研究记录读取失败"); throw e; } finally { setLoading(false); } }, []);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  const load = useCallback((id: string, refresh = false) => {
    const previous = pending.current.get(id); if (previous) return previous;
    setBusy(b => [...b, id]); setErrors(e => ({ ...e, [id]: "" }));
    const operation = (refresh ? writeJson<{ series: StudySeries }>("/api/research/market/refresh", "POST", { id }) : getJson<{ series: StudySeries }>(`/api/research/market/series?id=${encodeURIComponent(id)}`))
      .then(result => { setData(d => ({ ...d, [id]: result.series })); })
      .catch(e => { setErrors(current => ({ ...current, [id]: e instanceof Error && e.message ? e.message : "历史读取失败" })); })
      .finally(() => { pending.current.delete(id); setBusy(b => b.filter(v => v !== id)); });
    pending.current.set(id, operation); return operation;
  }, []);
  const study: StudyData = { data, errors, busy, load };
  const instrument = STUDY_INSTRUMENTS.find(i => i.id === asset)!;
  const reference = instrument.kind === "rate" ? STUDY_INSTRUMENTS[0]! : instrument;
  const comparison = instrument.kind === "rate" ? instrument : STUDY_INSTRUMENTS.find(i => i.id === (compare === asset ? asset === "sp500" ? "gold-futures" : "sp500" : compare))!;
  const paired = pairedStudy(data[reference.id]?.bars ?? [], data[comparison.id]?.bars ?? [], from, through, comparison.kind === "rate");
  const loadSelected = async (refresh = false) => { await Promise.all([...new Set(tab === "monthly" ? [asset] : [reference.id, comparison.id])].map(id => load(id, refresh))); };
  const mark = (date: string) => { setDraftDate({ date, nonce: Date.now() }); select("events"); };
  const focus = (event: GeoEvent) => { setFocusId(event.id); select("events"); };
  const navigate = (next: Tab) => { select(next); if (next === "monthly" && instrument.kind !== "index") setAsset("sp500"); };
  const dailyMarket = (date: string, id: string) => {
    setAsset(id); setCompare(id === "gold-futures" ? "sp500" : "gold-futures");
    setFrom(new Date(Date.parse(date) - 30 * 86400000).toISOString().slice(0, 10));
    setThrough([new Date(Date.parse(date) + 30 * 86400000).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)].sort()[0]!);
    select("market");
  };
  const validRange = !!from && !!through && from <= through;
  return <section className="research-hub widget"><div className="workspace-intro"><div><p className="eyebrow">RESEARCH & REVIEW</p><h3>从市场变化，到可验证的判断</h3><p>先观察长期走势，再整理行业、事件与公司叙事，最后验证自己的判断。</p></div><span className="study-cadence">日度复盘 · 历史按需加载</span></div>
    <div className="study-nav" aria-label="研究视图">{Object.entries(TABS).map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => navigate(id as Tab)}>{label}{id === "events" && board.events.length ? <small>{board.events.length}</small> : null}</button>)}</div>
    {boardError && <p className="inline-error" role="alert">{boardError} <button className="text-button" onClick={() => void reload().catch(() => undefined)}>重新读取研究记录</button></p>}
    {(tab === "market" || tab === "monthly") && <div className="study-panel"><div className="study-controls"><label>{tab === "monthly" ? "比较指数" : "主图资产"}<select aria-label="研究主图资产" value={asset} onChange={e => setAsset(e.target.value)}>{STUDY_INSTRUMENTS.filter(i => tab !== "monthly" || i.kind === "index").map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>{tab === "market" && instrument.kind !== "rate" && <label>对照资产<select aria-label="研究对照资产" value={comparison.id} onChange={e => setCompare(e.target.value)}>{STUDY_INSTRUMENTS.filter(i => i.id !== asset).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>}{tab === "market" && <><label>开始日期<input type="date" aria-label="研究开始日期" value={from} onChange={e => setFrom(e.target.value)} /></label><label>结束日期<input type="date" aria-label="研究结束日期" value={through} onChange={e => setThrough(e.target.value)} /></label></>}<button className="primary-button" disabled={!!busy.length} onClick={() => void loadSelected()}>{busy.includes(asset) || busy.includes(reference.id) || busy.includes(comparison.id) ? "读取历史…" : "加载历史"}</button><button className="text-button" disabled={!!busy.length} onClick={() => void loadSelected(true)}>刷新来源</button></div>
      {tab === "market" && <div className="study-range-presets"><span>观察范围</span>{[1, 3, 5, 10].map(n => <button className="text-button" key={n} onClick={() => { setFrom(`${new Date().getUTCFullYear() - n}-01-01`); setThrough(new Date().toISOString().slice(0, 10)); }}>近 {n} 年</button>)}<span>价格、收益率与 ETF 身份分别标注</span></div>}
      {[...new Set([asset, ...(tab === "market" ? [reference.id, comparison.id] : [])])].filter(id => errors[id]).map(id => <p className="inline-error" role="alert" key={id}>{STUDY_INSTRUMENTS.find(i => i.id === id)!.name}：{errors[id]}</p>)}
      {tab === "monthly" ? <MonthlyStudy series={data[asset]} /> : !validRange ? <p className="inline-error" role="alert">请选择有效的开始和结束日期，开始日期不能晚于结束日期。</p> : <><StudyCandles key={asset} instrument={instrument} series={data[asset]} from={from} through={through} events={board.events} onMark={mark} onEvent={focus} />
        <div className="study-comparison"><div className="content-heading"><div><h4>{reference.name} × {comparison.name}</h4><p className="muted">共同观测日起点对齐 · {paired.points[0]?.date ?? "—"} 至 {paired.points.at(-1)?.date ?? "—"}</p></div><div className="study-correlation"><span>变化相关系数</span><strong>{paired.correlation === null ? "—" : paired.correlation.toFixed(2)}</strong><small>{paired.samples} 个相邻共同观测 · 至少 30 个</small></div></div>
        <StudyLines label="跨资产价格变化" cursor={comparisonCursor} onCursor={setComparisonCursor} unit="%" lines={[{ id: reference.id, name: reference.name, color: STUDY_COLORS[0]!, points: paired.points.map(p => ({ x: Date.parse(p.date), y: p.a })) }, ...(comparison.kind !== "rate" ? [{ id: comparison.id, name: comparison.name, color: STUDY_COLORS[1]!, points: paired.points.map(p => ({ x: Date.parse(p.date), y: p.b })) }] : [])]} />
        {comparison.kind === "rate" && <><h4>{comparison.name} · 变动 bp</h4><StudyLines label="利率变动" cursor={comparisonCursor} onCursor={setComparisonCursor} unit=" bp" lines={[{ id: comparison.id, name: comparison.name, color: STUDY_COLORS[1]!, points: paired.points.map(p => ({ x: Date.parse(p.date), y: p.b })) }]} /></>}
        {paired.points.length > 0 && <p className="muted">区间价格变化：{reference.name} {changeText(paired.points.at(-1)!.a)}；{comparison.name} {changeText(paired.points.at(-1)!.b, comparison.kind === "rate" ? " bp" : "%")}。</p>}
        <p className="chart-note">共同日期对齐，不填充休市或缺失价格。相关系数比较相邻共同观测的价格涨跌（利率用 bp 变化），用于观察同向或反向变化，不能据此推断因果。期货包含换月影响，价格变化不等于投资总回报。</p>
        {comparison.id !== asset && data[comparison.id] && <details className="study-comparison-detail"><summary>查看 {comparison.name} 的原始走势与来源</summary><StudyCandles key={comparison.id} instrument={comparison} series={data[comparison.id]} from={from} through={through} events={board.events} onEvent={focus} /></details>}
        </div></>}
    </div>}
    <div hidden={tab !== "sectors"}>{loading ? <p className="empty-state">读取行业研究结构…</p> : <SectorObservation board={board} study={study} news={news} reload={reload} />}</div>
    <div hidden={tab !== "events"}>{loading ? <p className="empty-state">读取事件时间轴…</p> : <GeoObservation active={tab === "events"} board={board} study={study} reload={reload} draftDate={draftDate} initialAsset={asset} focusId={focusId} />}</div>
    {dailyVisited && <div hidden={tab !== "daily"}><MarketDaily onMarket={dailyMarket} onInfer={report => { setInferenceFocus({ reportId: report.id, nonce: Date.now() }); select("inference"); }} /></div>}
    {inferenceVisited && <div hidden={tab !== "inference"}><DailyInference active={tab === "inference"} focus={inferenceFocus} onMarket={dailyMarket} /></div>}
    {journalVisited && <div hidden={tab !== "journal"}>{journal}</div>}
  </section>;
}
