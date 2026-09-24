import { formatMoney, formatTimestamp, statusIcon, statusLabel, freshnessLabel } from "./format";
import { LiveAge } from "./useNow";
import { aggregateStatus, panelStatus, primaryQuote, uniqueNews } from "./dashboard";
import { AccountPerformance } from "./AccountPerformance";
import { RiskExposure } from "./RiskExposure";
import type { ConnectionState, PanelDescriptor, SectionDescriptor, Snapshot } from "./types";

interface MarketProps {
  snapshot: Snapshot;
  connectionState: ConnectionState;
  nowMs: number;
}

export function MarketSelector({ panels, selectedId, onSelect, ...props }: MarketProps & {
  panels: PanelDescriptor[]; selectedId: string; onSelect: (id: string) => void;
}) {
  return <div className="market-selector" aria-label="选择标的">
    {panels.map(panel => <button type="button" className="market-tile" key={panel.instrumentId}
      aria-pressed={selectedId === panel.instrumentId} onClick={() => onSelect(panel.instrumentId)}>
      <MarketQuote panel={panel} silent={panel.instrumentId !== selectedId && props.snapshot.instruments[panel.instrumentId]?.assetClass !== "equity"} {...props} />
    </button>)}
  </div>;
}

function MarketQuote({ panel, snapshot, connectionState, nowMs, silent = false }: MarketProps & { panel: PanelDescriptor; silent?: boolean }) {
  const instrument = snapshot.instruments[panel.instrumentId];
  const status = panelStatus(panel, snapshot, connectionState, nowMs);
  const quote = status !== "unavailable" ? primaryQuote(panel, snapshot) : undefined;
  return <>
    <span className="market-tile-heading"><strong>{instrument?.symbol ?? panel.title}</strong><span className={`market-status text--${status}`} title={statusLabel(status)}>{statusIcon(status)} {silent ? "静默" : quote?.freshness.tradeReferenceAt ? freshnessLabel(quote.freshness, status) : status === "unavailable" ? "未启用" : status === "live" ? "实时" : status === "delayed" ? "延迟" : "陈旧"}</span></span>
    <span className="market-tile-name">{instrument?.displayName ?? panel.title}</span>
    <span className="market-tile-price numeric">{quote ? formatMoney(quote.quote?.price, instrument?.precision.priceScale ?? 2) : "—"}<small>{quote?.quoteAsset}</small></span>
    <span className="market-tile-source">{quote ? <>{quote.sourceId} · <LiveAge freshness={quote.freshness} /></> : "等待可用数据源"}</span>
  </>;
}

export function Overview({ snapshot, connectionState, nowMs, onNavigate }: MarketProps & { onNavigate: (id: string) => void }) {
  const sections = snapshot.view.sections.filter(section => section.showPositionSummary || section.id === "options").map(section => section.id === "options" ? { ...section, panels: snapshot.view.panels.filter(p => p.assetClass === "option" && snapshot.instruments[p.instrumentId]) } : section).sort((a, b) => a.order - b.order);
  const sources = [...new Set(snapshot.health.map(row => row.sourceId))];
  const healthySources = sources.filter(id => snapshot.health.filter(row => row.sourceId === id).every(row => row.status === "healthy"));
  const news = uniqueNews(snapshot.news);
  const headlines = news.filter(item => item.importance === "high" || item.importance === "critical").slice(0, 3);
  const visibleHeadlines = headlines.length ? headlines : news.slice(0, 3);
  return <div className="overview">
    <AccountPerformance />
    <RiskExposure />
    <div className="review-entry-grid"><button onClick={() => onNavigate("positions")}><strong>持仓结构 →</strong><span>查看全部券商持仓、成本与估值</span></button><button onClick={() => onNavigate("trading-review")}><strong>交易复盘 →</strong><span>核对成交、费用与执行改进</span></button><button onClick={() => onNavigate("research")}><strong>宏观研究与判断 →</strong><span>指数联动、十年月度、行业与事件</span></button></div>
    <div className="content-heading"><div><p className="eyebrow">MARKET WATCH</p><h3>市场一览</h3></div><span>原币报价 · 各来源独立展示</span></div>
    <div className="overview-sections">
      {sections.map(section => <SectionCard key={section.id} section={section} snapshot={snapshot} connectionState={connectionState} nowMs={nowMs} onNavigate={onNavigate} />)}
    </div>
    <div className="overview-bottom">
      <section className="overview-news">
        <div className="content-heading"><div><p className="eyebrow">INTELLIGENCE</p><h3>{headlines.length ? "重点情报" : "最新情报"}</h3></div><button className="text-button" onClick={() => onNavigate("intel")}>查看全部 →</button></div>
        {visibleHeadlines.length ? visibleHeadlines.map(item => <article key={item.id}>
          <div className="news-meta"><span className={`importance importance--${item.importance}`}>{({ critical: "关键", high: "重要", medium: "一般", low: "参考" })[item.importance]}</span><span>{item.sourceId}</span><time>{formatTimestamp(item.publishedAt ?? item.fetchedAt)}</time></div>
          <a href={item.url} target="_blank" rel="noreferrer">{item.title}<span aria-hidden="true"> ↗</span></a>
        </article>) : <p className="empty-state">尚无情报，采集后会自动更新。</p>}
      </section>
      <section className="overview-health">
        <div className="content-heading"><div><p className="eyebrow">DATA STATUS</p><h3>数据状态</h3></div><button className="text-button" onClick={() => onNavigate("system")}>详情 →</button></div>
        <div className="source-chips">{sources.map(id => <span key={id}><i className={healthySources.includes(id) ? "dot dot--live" : "dot dot--stale"} />{id}<small>{healthySources.includes(id) ? "正常" : "异常"}</small></span>)}</div>
        {!sources.length ? <p className="empty-state">等待数据源首次观测。</p> : null}
        <p className="overview-note">{connectionState === "connected" ? "实时推送已连接，报价时效按来源单独判断。" : "实时推送暂未连接，已有报价按陈旧数据展示。"}</p>
      </section>
    </div>
  </div>;
}

function SectionCard({ section, snapshot, connectionState, nowMs, onNavigate }: MarketProps & { section: SectionDescriptor; onNavigate: (id: string) => void }) {
  if (section.id === "options" && !section.panels.length) return <button className="overview-section-card" onClick={() => onNavigate("options")}><span className="overview-card-heading"><strong>期权</strong><span className="market-status">Tradier</span></span><span className="overview-card-count">到期日 · 期权链 · Greeks</span><span className="overview-card-link">查看期权行情 ↗</span></button>;
  const status = aggregateStatus(section.panels.map(panel => panelStatus(panel, snapshot, connectionState, nowMs)));
  return <button className="overview-section-card" onClick={() => onNavigate(section.id)}>
    <span className="overview-card-heading"><strong>{section.title}</strong><span className={`market-status text--${status}`}>{statusIcon(status)} {status === "unavailable" ? "未启用" : status === "live" ? "实时" : status === "delayed" ? "含延迟" : "需关注"}</span></span>
    <span className="overview-card-count">{section.panels.length} 个标的</span>
    <span className="overview-card-quotes">{section.panels.slice(0, 4).map(panel => {
      const row = panelStatus(panel, snapshot, connectionState, nowMs) === "unavailable" ? undefined : primaryQuote(panel, snapshot);
      return <span key={panel.instrumentId}><span>{snapshot.instruments[panel.instrumentId]?.symbol ?? panel.title}</span><strong className="numeric">{row ? formatMoney(row.quote?.price, snapshot.instruments[panel.instrumentId]?.precision.priceScale ?? 2) : "—"}<small>{row?.quoteAsset}</small></strong></span>;
    })}</span>
    <span className="overview-card-link">{status === "unavailable" ? "查看启用状态" : "查看行情详情"}<span aria-hidden="true">↗</span></span>
  </button>;
}
