import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createTransaction, getJson } from "./api";
import { FreshnessBadge } from "./FreshnessBadge";
import { PriceChart } from "./PriceChart";
import { useChartData } from "./useChartData";
import { IntradayChart } from "./IntradayChart";
import type { ChartCandle } from "@invest/domain";
import { uniqueNews } from "./dashboard";
import { ResearchWorkspace, startResearch, TOPICS } from "./ResearchWorkspace";
import { TradingReviewWorkspace, startTradingReview } from "./TradingReviewWorkspace";
import { BrokerWorkspace } from "./BrokerWorkspace";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { OptionsWorkspace } from "./OptionsWorkspace";
import { TransactionLedger } from "./TransactionLedger";
import {
  effectiveStatus,
  formatDecimal,
  formatMoney,
  formatEpoch,
  formatMilliseconds,
  formatRate,
  formatTimestamp,
} from "./format";
import type {
  Candle,
  ConnectionState,
  InstrumentMeta,
  NewsItem,
  PnlSummary,
  PanelDescriptor,
  PositionView,
  QuoteEnvelope,
  QuoteValue,
  SourceEgressStatus,
  SourceHealth,
  SectionDescriptor,
  StoredQuoteRow,
  TransactionRecord,
  TransactionType,
  WidgetDescriptor,
  WidgetKind,
} from "./types";

interface WidgetScope {
  panel: PanelDescriptor;
  instrument: InstrumentMeta | undefined;
  quotes: QuoteEnvelope[];
  health: SourceHealth[];
  egress: SourceEgressStatus[];
  history?: StoredQuoteRow[];
  candles?: Candle[];
  news: NewsItem[];
  sections: SectionDescriptor[];
  positions: PositionView[];
  transactions: TransactionRecord[];
  pnlSummary: PnlSummary;
  instruments: Record<string, InstrumentMeta>;
  onChanged: () => Promise<void>;
}

interface WidgetProps {
  widget: WidgetDescriptor;
  scope: WidgetScope;
  connectionState: ConnectionState;
  nowMs: number;
}

type WidgetRenderer = (props: WidgetProps) => ReactNode;

export function WidgetRenderer(props: WidgetProps): ReactNode {
  const missing = props.widget.requiredCapabilities.filter(
    (capability) => !props.scope.panel.availableCapabilities.includes(capability),
  );
  if (missing.length > 0) {
    if (typeof props.widget.options.unavailableReason === "string") return <UnavailableWidget widget={props.widget} reason={props.widget.options.unavailableReason} />;
    return <UnavailableWidget widget={props.widget} reason={`当前数据源尚未提供所需能力（${missing.map(cap => ({ quote: "行情报价", candle: "历史 K 线", optionChain: "期权链", greeks: "期权风险指标", news: "新闻" })[cap] ?? cap).join("、")}）。请在系统配置中检查数据源是否启用、访问凭证是否有效。`} />;
  }
  const renderer = WIDGET_REGISTRY[props.widget.kind];
  const Component = renderer;
  return Component ? <Component {...props} /> : <section className="widget widget--unavailable"><h3>{props.widget.title}</h3><p>当前页面版本无法显示这个组件，请先保存已填写的内容，再重新加载页面。</p><button className="secondary-button" onClick={() => window.location.reload()}>重新加载页面</button></section>;
}

const WIDGET_REGISTRY: Partial<Record<WidgetKind, WidgetRenderer>> = {
  "quote-card": QuoteCardWidget,
  "health-badge": HealthBadgeWidget,
  sparkline: SparklineWidget,
  candlestick: CandlestickWidget,
  "option-chain": OptionChainWidget,
  "greeks-grid": OptionChainWidget,
  "news-feed": NewsFeedWidget,
  "position-table": PositionTableWidget,
  "pnl-summary": PnlSummaryWidget,
  "transaction-form": TransactionFormWidget,
  "pnl-card": UnsupportedDataWidget,
  "research-journal": ({ scope }) => <ResearchWorkspace news={scope.news} transactions={scope.transactions} instruments={scope.instruments} />,
  "trading-review": ({ scope }) => <TradingReviewWorkspace news={scope.news} />,
  "broker-accounts": () => <BrokerWorkspace />,
  "account-settings": () => <SettingsWorkspace />,
  "transaction-history": ({ scope }) => <TransactionLedger transactions={scope.transactions} instruments={scope.instruments} onChanged={scope.onChanged} />,
};

// Stable prop identity lets the memoized workspaces skip re-renders caused by quote ticks elsewhere.
function OptionChainWidget({ scope }: WidgetProps): ReactNode {
  const held = useMemo(() => Object.values(scope.instruments).filter(i => i.assetClass === "option").map(i => i.symbol), [scope.instruments]);
  return <OptionsWorkspace heldContracts={held} />;
}

function UnavailableWidget({ widget, reason }: { widget: WidgetDescriptor; reason: string }): ReactNode {
  return (
    <section className="widget widget--unavailable">
      <header className="widget-header">
        <div>
          <p className="eyebrow">功能状态</p>
          <h3>{widget.title}</h3>
        </div>
        <span className="status-badge status--unavailable"><span aria-hidden="true">×</span> UNAVAILABLE</span>
      </header>
      <p>{reason}</p>
    </section>
  );
}

function UnsupportedDataWidget({ widget }: WidgetProps): ReactNode {
  return <UnavailableWidget widget={widget} reason="此功能尚未接入数据源。接入相应服务并验证权限后才能使用。" />;
}

function PositionTableWidget({ widget, scope, connectionState, nowMs }: WidgetProps): ReactNode {
  const positions = scope.positions;
  return (
    <section className="widget widget--positions">
      <header className="widget-header">
        <div>
          <p className="eyebrow">手工账户 · 移动加权平均成本</p>
          <h3>{widget.title}</h3>
        </div>
        <span className="health-legend">成本与报价币种分别保留</span>
      </header>
      {positions.length === 0 ? (
        <p className="empty-state">尚无交易；录入第一笔买入或卖出后会生成持仓。</p>
      ) : (
        <div className="position-table-wrap">
          <table className="position-table">
            <thead>
              <tr>
                <th>标的</th><th>数量</th><th>均价 / 成本</th><th>标记价格</th><th>市值</th><th>已实现</th><th>未实现</th><th>报价状态</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const positionStatus = effectiveStatus(position.freshness, connectionState, undefined, nowMs);
                const instrument = scope.instruments[position.instrumentId];
                const markCurrency = position.markQuoteAsset ?? "—";
                return (
                  <tr key={position.id}>
                    <td><strong>{instrument?.symbol ?? position.instrumentId}</strong><span>{instrument?.displayName ?? position.instrumentId}</span></td>
                    <td className="numeric">{position.quantity}</td>
                    <td className="numeric">
                      <strong>{formatDecimal(position.averageCost, instrument?.precision.priceScale ?? 2)} {position.quoteAsset}</strong>
                      <span>成本 {formatDecimal(position.costBasis, 2)} {position.quoteAsset}</span>
                    </td>
                    <td className="numeric">
                      <strong>{formatDecimal(position.markPrice, instrument?.precision.priceScale ?? 2)}</strong>
                      <span>{position.markPrice === null ? "报价不可用" : `按 ${markCurrency} 计价`}</span>
                    </td>
                    <td className="numeric">{formatDecimal(position.marketValue, 2)}{position.marketValue === null ? "" : ` ${markCurrency}`}</td>
                    <td className="numeric">{formatDecimal(position.realizedPnl, 2)} {position.quoteAsset}</td>
                    <td className="numeric position-unrealized">
                      {formatDecimal(position.unrealizedPnl, 2)}{position.unrealizedPnl === null ? "" : ` ${markCurrency}`}
                    </td>
                    <td>
                      <span className={`status-badge status--${positionStatus}`}>{positionStatus}</span>
                      {position.freshness.status === "stale" ? <span className="position-stale">陈旧 · {formatTimestamp(position.freshness.capturedAt)}</span> : null}
                      {position.quoteAsset !== position.markQuoteAsset && position.markQuoteAsset !== null ? (
                        <span className="currency-mismatch">成本 {position.quoteAsset} / 报价 {position.markQuoteAsset}，未做 FX</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PnlSummaryWidget({ widget, scope }: WidgetProps): ReactNode {
  const summary = scope.pnlSummary;
  return (
    <section className="widget widget--pnl-summary">
      <header className="widget-header">
        <div>
          <p className="eyebrow">不隐式换汇 · 分币种核算</p>
          <h3>{widget.title}</h3>
        </div>
        <span className="health-legend">{summary.positionsCount} 个持仓</span>
      </header>
      {summary.positionsCount === 0 && summary.costSubtotals.length === 0 ? (
        <p className="empty-state">尚无可汇总的交易。</p>
      ) : (
        <div className="pnl-summary-grid">
          {summary.costSubtotals.map((subtotal) => (
            <article key={`cost:${subtotal.currency}`}>
              <h4>成本 / 收益 · {subtotal.currency}</h4>
              <dl>
                <div><dt>成本</dt><dd className="numeric">{formatDecimal(subtotal.costBasis, 2)} {subtotal.currency}</dd></div>
                <div><dt>已实现</dt><dd className="numeric">{formatDecimal(subtotal.realizedPnl, 2)} {subtotal.currency}</dd></div>
                <div><dt>税前股息</dt><dd className="numeric">{formatDecimal(subtotal.grossDividend, 2)} {subtotal.currency}</dd></div>
                <div><dt>预扣税</dt><dd className="numeric">{formatDecimal(subtotal.withholdingTax, 2)} {subtotal.currency}</dd></div>
                <div><dt>税后现金收益</dt><dd className="numeric">{formatDecimal(subtotal.netIncome, 2)} {subtotal.currency}</dd></div>
              </dl>
            </article>
          ))}
          {summary.valuationSubtotals.map((subtotal) => (
            <article key={`value:${subtotal.currency}`}>
              <h4>按 {subtotal.currency} 计价</h4>
              <dl>
                <div><dt>市值</dt><dd className="numeric">{formatDecimal(subtotal.marketValue, 2)} {subtotal.marketValue === null ? "" : subtotal.currency}</dd></div>
                <div><dt>未实现盈亏</dt><dd className="numeric">{formatDecimal(subtotal.unrealizedPnl, 2)} {subtotal.unrealizedPnl === null ? "" : subtotal.currency}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}
      {summary.explanation ? <p className="currency-explanation">{summary.explanation}</p> : null}
    </section>
  );
}

function TransactionFormWidget({ widget, scope }: WidgetProps): ReactNode {
  const instruments = Object.values(scope.instruments).sort((left, right) => left.displayName.localeCompare(right.displayName));
  const [instrumentId, setInstrumentId] = useState(() => instruments[0]?.id ?? "");
  const [type, setType] = useState<TransactionType>("buy");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [fees, setFees] = useState("0");
  const [currency, setCurrency] = useState(() => instruments[0]?.quoteAsset ?? "USD");
  const [tradeAt, setTradeAt] = useState(localDateTimeValue);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (instrumentId || instruments.length === 0) return;
    setInstrumentId(instruments[0]?.id ?? "");
    setCurrency(instruments[0]?.quoteAsset ?? "USD");
  }, [instrumentId, instruments]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !instrumentId) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await createTransaction({
        instrumentId,
        type,
        quantity,
        price: type === "buy" || type === "sell" ? price : null,
        fees,
        currency: currency.trim().toUpperCase(),
        tradeAtMs: new Date(tradeAt).getTime(),
      });
      setQuantity("");
      setPrice("");
      setFees("0");
      await scope.onChanged();
    } catch (reason: unknown) {
      setFormError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="widget widget--transaction-form">
      <header className="widget-header">
        <div><p className="eyebrow">手工账户</p><h3>{widget.title}</h3></div>
      </header>
      <form className="transaction-form" onSubmit={submit}>
        <label>标的<select aria-label="标的" value={instrumentId} onChange={(event) => {
          const next = event.target.value;
          setInstrumentId(next);
          setCurrency(scope.instruments[next]?.quoteAsset ?? currency);
        }}>{instruments.map((instrument) => <option key={instrument.id} value={instrument.id}>{instrument.symbol} · {instrument.displayName}</option>)}</select></label>
        <label>方向<select aria-label="方向" value={type} onChange={(event) => {
          const next = event.target.value as TransactionType;
          setType(next);
          if (next === "dividend" || next === "withholding_tax") setPrice("");
        }}>
          <option value="buy">买入</option><option value="sell">卖出</option><option value="dividend">税前股息</option><option value="withholding_tax">预扣税（负现金流）</option>
        </select></label>
        <label>{type === "dividend" || type === "withholding_tax" ? "现金金额" : "数量"}<input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder={type === "withholding_tax" ? "例如 -30" : "例如 1.25"} required /></label>
        <label>价格<input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="例如 100" disabled={type === "dividend" || type === "withholding_tax"} required={type === "buy" || type === "sell"} /></label>
        <label>手续费<input inputMode="decimal" value={fees} onChange={(event) => setFees(event.target.value)} required /></label>
        <label>币种<input value={currency} onChange={(event) => setCurrency(event.target.value)} pattern="[A-Za-z0-9]{2,10}" required /></label>
        <label>成交时间<input type="datetime-local" value={tradeAt} onChange={(event) => setTradeAt(event.target.value)} required /></label>
        <button type="submit" disabled={submitting || !instrumentId}>{submitting ? "保存中…" : "保存交易"}</button>
      </form>
      <p className="transaction-note">卖出手续费只进入已实现盈亏；税前股息与预扣税必须各录一行。</p>
      {formError ? <p className="auth-error" role="alert">{formError}</p> : null}

    </section>
  );
}

function localDateTimeValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function transactionTypeLabel(type: TransactionRecord["type"]): string {
  return { buy: "买入", sell: "卖出", dividend: "税前股息", withholding_tax: "预扣税" }[type] ?? type;
}

function NewsFeedWidget({ widget, scope }: WidgetProps): ReactNode {
  const [query, setQuery] = useState("");
  const [sectionId, setSectionId] = useState("all");
  const [importance, setImportance] = useState("all");
  const [macroTopic, setMacroTopic] = useState("all");
  const [page, setPage] = useState(1);
  const sections = scope.sections.filter(section => section.showPositionSummary);
  const instrumentIds = new Set(sections.find(section => section.id === sectionId)?.panels.map(panel => panel.instrumentId));
  const news = uniqueNews(mapped<NewsItem[]>(scope, widget, "news") ?? scope.news).filter(item =>
    (sectionId === "all" || (sectionId === "unlinked" ? item.instrumentIds.length === 0 : item.instrumentIds.some(id => instrumentIds.has(id))))
    && (macroTopic === "all" || item.tags.includes(`macro:${macroTopic}`))
    && (importance === "all" || item.importance === importance)
    && `${item.title} ${item.summary ?? ""} ${item.sourceId}`.toLowerCase().includes(query.toLowerCase()));
  const pages = Math.max(1, Math.ceil(news.length / 12));
  const currentPage = Math.min(page, pages);
  return <section className="widget widget--news">
    <div className="workspace-intro"><div><p className="eyebrow">MARKET INTELLIGENCE</p><h3>新闻与市场线索</h3><p>阅读原始来源，将值得验证的线索记入判断日志。</p></div><span className="quote-asset">{news.length} 条</span></div>
    <div className="macro-news-filters" aria-label="宏观新闻主题">{["all", "treasuries", "gold", "oil", "rates", "inflation", "growth"].map(key => <button key={key} type="button" aria-pressed={macroTopic === key} onClick={() => { setMacroTopic(key); setPage(1); }}>{key === "all" ? "全部新闻" : TOPICS[key as keyof typeof TOPICS]}</button>)}</div>
    <div className="filter-toolbar"><input aria-label="搜索新闻" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="搜索新闻、来源…" /><select aria-label="按板块筛选新闻" value={sectionId} onChange={event => { setSectionId(event.target.value); setPage(1); }}><option value="all">全部板块</option>{sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}<option value="unlinked">未关联标的</option></select><select aria-label="按重要性筛选新闻" value={importance} onChange={event => { setImportance(event.target.value); setPage(1); }}><option value="all">全部重要性</option><option value="critical">关键</option><option value="high">重要</option><option value="medium">一般</option><option value="low">参考</option></select></div>
    {!news.length ? <div className="workspace-empty"><h3>没有匹配的新闻</h3><p>调整筛选条件，或等待下一次采集。</p></div> : <div className="news-list">{news.slice((currentPage - 1) * 12, currentPage * 12).map(item => <article className="news-item" key={item.id}>
      <div className="news-meta"><span className={`importance importance--${item.importance}`}>{({ critical: "关键", high: "重要", medium: "一般", low: "参考" })[item.importance]}</span><span>{item.sourceId}</span><time dateTime={item.publishedAt ?? item.fetchedAt}>{formatTimestamp(item.publishedAt ?? item.fetchedAt)}</time></div>
      <h4><a href={item.url} target="_blank" rel="noreferrer">{item.title} ↗</a></h4>
      {item.summary ? <details className="news-summary"><summary>查看摘要</summary><p>{item.summary}</p></details> : null}
      <div className="news-item-footer"><div className="news-tags">{item.instrumentIds.map(id => <span key={id}>{scope.instruments[id]?.symbol ?? id}</span>)}<span>{item.enrichment.providerId ? `AI · ${item.enrichment.model ?? item.enrichment.providerId}` : "规则标注"}</span></div><button className="text-button" onClick={() => startResearch({ newsId: item.id })}>记录判断 →</button><button className="text-button" onClick={() => startTradingReview({ newsId: item.id })}>关联交易复盘 →</button></div>
    </article>)}</div>}
    {pages > 1 ? <div className="pagination"><button className="secondary-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage} / {pages}</span><button className="secondary-button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div> : null}
  </section>;
}

function QuoteCardWidget({ widget, scope, connectionState, nowMs }: WidgetProps): ReactNode {
  const rows = mapped<QuoteEnvelope[]>(scope, widget, "quotes") ?? [];
  const instrument = scope.instrument;
  const orderedRows = [...rows].sort((left, right) => left.priority - right.priority || left.sourceId.localeCompare(right.sourceId));
  return (
    <section className="widget widget--quote-card">
      <header className="widget-header">
        <div>
          <p className="eyebrow">多源报价</p>
          <h3>来源对比</h3>
        </div>
        <div className="instrument-heading">
          <strong>{instrument?.symbol ?? scope.panel.instrumentId}</strong>
          <span>{instrument?.displayName ?? scope.panel.title}</span>
        </div>
      </header>
      {typeof widget.options.sourceNote === "string" ? <p className="currency-explanation">{widget.options.sourceNote}</p> : null}
      <div className="quote-comparison" role="table" aria-label={`${scope.panel.title} source comparison`}>
        {orderedRows.length === 0 ? (
          <div className="empty-state">尚未配置可用的报价来源。</div>
        ) : orderedRows.map((row) => (
          <QuoteRow
            key={`${row.instrumentId}:${row.sourceId}`}
            row={row}
            widget={widget}
            priceScale={instrument?.precision.priceScale ?? 2}
            connectionState={connectionState}
            nowMs={nowMs}
          />
        ))}
      </div>
      <p className="comparison-note">
        报价保留来源币种，USD 与 USDT 分开展示。
      </p>
    </section>
  );
}

function QuoteRow({
  row,
  widget,
  priceScale,
  connectionState,
  nowMs,
}: {
  row: QuoteEnvelope;
  widget: WidgetDescriptor;
  priceScale: number;
  connectionState: ConnectionState;
  nowMs: number;
}): ReactNode {
  const quote = mapped<QuoteValue | null>(row, widget, "quote") ?? null;
  const freshness = mapped<typeof row.freshness>(row, widget, "freshness") ?? row.freshness;
  const sourceHealth = mapped<SourceHealth | null>(row, widget, "sourceHealth") ?? row.sourceHealth;
  const status = effectiveStatus(freshness, connectionState, sourceHealth?.status, nowMs);
  const quoteAsset = mapped<string>(row, widget, "quoteAsset") ?? row.quoteAsset;
  const convertedTo = quote?.convertedTo ?? null;
  return (
    <div className={`quote-row quote-row--${status}`} role="row">
      <div className="quote-source" role="cell">
        <div className="source-line">
          <strong>{row.sourceId}</strong>
          <span className={`quote-asset quote-asset--${quoteAsset.toLowerCase()}`}>{quoteAsset}</span>
        </div>
        <details className="source-details"><summary>来源详情</summary><span>代码 {row.providerSymbol} · 优先级 {row.priority} · 出口 {row.egressProfile}</span></details>
      </div>
      <div className="quote-price" role="cell">
        {status === "unavailable" || quote?.price === null || quote?.price === undefined ? (
          <span className="unavailable-price">暂无可用报价</span>
        ) : (
          <>
            <span className="price-value numeric">{formatMoney(quote.price, priceScale)}</span>
            <span className="price-unit">{quoteAsset}</span>
            {status === "stale" ? <span className="stale-price-label">历史报价</span> : null}
          </>
        )}
        {convertedTo ? (
          <span className="conversion-note">
            convertedTo {convertedTo.currency} @ {convertedTo.rate} · fx {convertedTo.fxSourceId}
          </span>
        ) : null}
        {quote?.quality === "indicative" ? <span className="quality-note">参考报价</span> : null}
      </div>
      <div className="quote-freshness" role="cell">
        <FreshnessBadge
          freshness={freshness}
          connectionState={connectionState}
          sourceId={row.sourceId}
          sourceHealthStatus={sourceHealth?.status}
          nowMs={nowMs}
          compact
        />
      </div>
    </div>
  );
}

function HealthBadgeWidget({ scope }: WidgetProps): ReactNode {
  const [onlyIssues, setOnlyIssues] = useState(false);
  const rows = scope.health.filter(row => !onlyIssues || row.status !== "healthy" || row.clockSkewStatus === "suspected");
  return <section className="widget widget--health">
    <div className="workspace-intro"><div><p className="eyebrow">SYSTEM HEALTH</p><h3>数据源运行情况</h3><p>按来源与数据能力查看成功率、时延和实际出口。</p></div><label className="check-label"><input type="checkbox" checked={onlyIssues} onChange={event => setOnlyIssues(event.target.checked)} />仅看异常</label></div>
    <div className="position-table-wrap"><table className="position-table health-table"><thead><tr><th>数据源</th><th>状态</th><th>成功率</th><th>时延 p50 / p95</th><th>时钟偏移</th><th>实际出口</th><th>最近成功</th></tr></thead><tbody>{rows.map(row => {
      const egress = scope.egress.find(entry => entry.sourceId === row.sourceId);
      return <tr key={`${row.sourceId}:${row.capability}`}><td><strong>{row.sourceId}</strong><span>{row.capability}</span></td><td><span className={`health-state health-state--${row.status}`}>{row.status === "healthy" ? "正常" : row.status === "degraded" ? "降级" : row.status}</span></td><td>{formatRate(row.successRate)}</td><td>{formatMilliseconds(row.p50LatencyMs)} / {formatMilliseconds(row.p95LatencyMs)}</td><td className={row.clockSkewStatus === "suspected" ? "metric-warning" : ""}>{formatMilliseconds(row.clockSkewMedianMs)}<span>{row.clockSkewStatus === "suspected" ? "疑似偏移" : row.clockSkewStatus === "normal" ? "正常" : "待观测"}</span></td><td>{egress?.latestActualEgress ?? row.egressProfileUsed ?? "—"}<span>主出口 {egress?.configuredPrimaryEgress ?? "—"} · 回退 {egress?.fallbackCount1h ?? 0} 次 / 小时</span></td><td>{formatEpoch(row.lastSuccessAtMs)}<details><summary>诊断详情</summary><p>熔断器：{row.circuitState} · 观测：{formatEpoch(row.observedAtMs)}</p>{row.lastErrorJson ? <p className="error-detail">{row.lastErrorJson}</p> : <p>暂无错误</p>}</details></td></tr>;
    })}</tbody></table></div>
    {!rows.length ? <p className="empty-state">{onlyIssues ? "当前没有异常观测。" : "等待数据源首次观测。"}</p> : null}
  </section>;
}

function SparklineWidget({ widget, scope, connectionState, nowMs }: WidgetProps): ReactNode {
  if (typeof widget.options.intradaySymbol === "string") return <section className="widget widget--chart"><header className="widget-header"><div><p className="eyebrow">INTRADAY</p><h3>分时图</h3><p className="chart-source-label">Tradier · USD · 5 分钟</p></div></header><IntradayChart key={widget.options.intradaySymbol} symbol={widget.options.intradaySymbol} tradeAt={scope.quotes.find(q => q.sourceId === widget.options.sourceId)?.quote?.capturedAt} priceScale={scope.instrument?.precision.priceScale ?? 2} /></section>;
  return <SampleHistoryWidget widget={widget} scope={scope} connectionState={connectionState} nowMs={nowMs} />;
}

function SampleHistoryWidget({ widget, scope, connectionState, nowMs }: WidgetProps): ReactNode {
  const result = useEndpoint<{ history: StoredQuoteRow[] }>(widget.dataEndpoint);
  const sourceId = String(widget.options.sourceId ?? "");
  const quote = scope.quotes.find(row => row.sourceId === sourceId);
  const expectedAsset = quote?.quoteAsset ?? String(widget.options.quoteAsset ?? "");
  const history = (result.data?.history ?? []).filter(row => row.sourceId === sourceId && row.instrumentId === scope.panel.instrumentId && row.price !== null && (!expectedAsset || row.quoteAsset === expectedAsset));
  const points = history.map(row => ({ time: row.capturedAtMs, price: row.price! }));
  if (quote?.quote?.price != null && quote.freshness.status !== "unavailable") {
    const time = Date.parse(quote.quote.capturedAt);
    if (!points.some(point => point.time === time)) points.push({ time, price: quote.quote.price });
  }
  const asset = quote?.quoteAsset ?? history[0]?.quoteAsset ?? String(widget.options.quoteAsset ?? "");
  return <section className="widget widget--chart">
    <header className="widget-header"><div><p className="eyebrow">QUOTE SAMPLES</p><h3>分时采样</h3><p className="chart-source-label">{sourceId} · {asset} · 已采集报价，可能存在缺口</p></div>
      {quote ? <FreshnessBadge freshness={quote.freshness} connectionState={connectionState} sourceId={sourceId} sourceHealthStatus={quote.sourceHealth?.status} nowMs={nowMs} compact /> : null}
    </header>
    {result.data || points.length ? <PriceChart points={points} quoteAsset={asset} priceScale={scope.instrument?.precision.priceScale ?? 2} /> : !result.error ? <p className="empty-state">正在加载历史行情…</p> : null}
    {result.error ? <p className="chart-error" role="alert">历史行情读取失败，30 秒后重试。{result.data ? " 当前保留上次数据。" : ""}</p> : null}
  </section>;
}

function CandlestickWidget({ widget, scope, connectionState, nowMs }: WidgetProps): ReactNode {
  const result = useChartData<{ candles: ChartCandle[]; warnings?: string[] }>(widget.dataEndpoint);
  const sourceId = String(widget.options.sourceId ?? "");
  const sourceRows = (result.data?.candles ?? []).filter(row => row.sourceId === sourceId && row.instrumentId === scope.panel.instrumentId).slice().sort((a, b) => Date.parse(a.openTime) - Date.parse(b.openTime));
  const rows = sourceRows.filter(row => row.quoteAsset === sourceRows.at(-1)?.quoteAsset);
  const latest = rows[rows.length - 1];
  const health = scope.health.find(row => row.sourceId === sourceId && row.capability === "candle");
  return <section className="widget widget--chart widget--candlestick">
    <header className="widget-header"><div><p className="eyebrow">CANDLESTICK</p><h3>K 线</h3><p className="chart-source-label">{sourceId} · {latest?.quoteAsset ?? "—"} · {String(widget.options.timeframe ?? "")}</p></div>
      {latest ? latest.timeframe === "1d" ? <span className="quote-asset" title={`接收时间 ${formatTimestamp(latest.freshness.receivedAt)}`}>日 K · {latest.openTime.slice(0, 10)}</span> : <FreshnessBadge freshness={latest.freshness} connectionState={connectionState} sourceId={sourceId} sourceHealthStatus={health?.status} nowMs={nowMs} compact /> : null}
    </header>
    {typeof widget.options.sourceNote === "string" ? <p className="currency-explanation">{widget.options.sourceNote}</p> : null}
    {!!result.data?.warnings?.length && <details className="chart-data-warning"><summary>{result.data.warnings.length} 项历史数据提示 · 异常日期已跳过，均线按有效 K 线计算</summary>{result.data.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
    {result.data ? <PriceChart key={`${scope.panel.instrumentId}:${sourceId}`} points={rows.map(row => ({ time: Date.parse(row.openTime), price: row.close, open: row.open, high: row.high, low: row.low, ma: row.ma }))} quoteAsset={latest?.quoteAsset ?? ""} priceScale={scope.instrument?.precision.priceScale ?? 2} timeframe={String(widget.options.timeframe ?? "")} candles /> : !result.error ? <p className="empty-state">正在加载 K 线…</p> : null}
    {result.error ? <p className="chart-error" role="alert">K 线读取失败，30 秒后重试。</p> : null}
  </section>;
}

function useEndpoint<T>(endpoint: string): { data: T | null; error: Error | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    setData(null);
    setError(null);
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const next = await getJson<T>(endpoint, controller.signal);
        if (!controller.signal.aborted) { setData(next); setError(null); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason : new Error(String(reason)));
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [endpoint]);
  return { data, error };
}

function mapped<T>(value: unknown, widget: WidgetDescriptor, key: string): T | undefined {
  const path = widget.fieldMap[key];
  if (!path) return undefined;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as T | undefined;
}
