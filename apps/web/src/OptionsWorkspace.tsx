import Decimal from "decimal.js";
import { memo, useEffect, useState } from "react";
import { tradierSymbol, type MarketQuote, type MarketQuotesResponse, type OptionChainResponse, type OptionExpirationsResponse } from "@invest/domain";
import { getJson } from "./api";
import { OptionComparison } from "./OptionComparison";
import { formatMoney, formatTimestamp } from "./format";

const money = (v: string | null | undefined) => formatMoney(v ?? null, 4);
const iv = (v: string | null | undefined) => v == null ? "—" : `${new Decimal(v).mul(100).toFixed(2)}%`;
const errorText = (e: unknown) => e instanceof Error ? e.message : "行情读取失败";
const PAGE_SIZE = 24;

export const OptionsWorkspace = memo(function OptionsWorkspace({ heldContracts = [] }: { heldContracts?: string[] }) {
  const [draft, setDraft] = useState("AAPL"), [symbol, setSymbol] = useState("AAPL");
  const [dates, setDates] = useState<OptionExpirationsResponse | null>(null), [expiration, setExpiration] = useState("");
  const [chain, setChain] = useState<OptionChainResponse | null>(null), [spot, setSpot] = useState<MarketQuotesResponse | null>(null);
  const [error, setError] = useState(""), [quoteError, setQuoteError] = useState(""), [loading, setLoading] = useState(false);
  const [right, setRight] = useState("all"), [tab, setTab] = useState("quotes"), [page, setPage] = useState(0);
  const [selected, setSelected] = useState<MarketQuote | null>(null), [contractInput, setContractInput] = useState("");
  const [directError, setDirectError] = useState(""), [directLoading, setDirectLoading] = useState(false);
  const [revision, setRevision] = useState(0), [dateRevision, setDateRevision] = useState(0);
  const refresh = () => { if (!dates) setDateRevision(n => n + 1); else setRevision(n => n + 1); };
  useEffect(() => { const timer = window.setInterval(() => { if (document.visibilityState === "visible") setRevision(n => n + 1); }, 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    let alive = true;
    setDates(null); setExpiration(""); setChain(null); setSelected(null); setError(""); setLoading(true);
    getJson<OptionExpirationsResponse>(`/api/options/expirations?symbol=${encodeURIComponent(symbol)}`).then(data => {
      if (!alive) return; setDates(data); setExpiration(data.expirations[0] ?? ""); setLoading(false);
    }).catch(e => { if (alive) { setError(errorText(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [symbol, dateRevision]);
  useEffect(() => {
    let alive = true;
    getJson<MarketQuotesResponse>(`/api/market/quotes?symbols=${encodeURIComponent(symbol)}`).then(data => { if (alive) { setSpot(data); setQuoteError(""); } }).catch(e => { if (alive) setQuoteError(errorText(e)); });
    return () => { alive = false; };
  }, [symbol, revision]);
  useEffect(() => {
    if (!expiration) return;
    let alive = true; setLoading(true); setError("");
    getJson<OptionChainResponse>(`/api/options?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}`).then(data => {
      if (!alive) return;
      setChain(data); setSelected(current => data.contracts.find(q => q.symbol === current?.symbol) ?? current); setLoading(false);
    }).catch(e => { if (alive) { setError(errorText(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [symbol, expiration, revision]);
  const currentChain = chain?.symbol === symbol && chain.expiration === expiration ? chain : null;
  const contracts = (currentChain?.contracts ?? []).filter(q => right === "all" || q.right === right);
  const totalPages = Math.max(1, Math.ceil(contracts.length / PAGE_SIZE)), currentPage = Math.min(page, totalPages - 1);
  const rows = contracts.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const underlying = spot?.quotes.find(q => q.symbol === symbol);
  const environment = dates?.environment ?? spot?.environment;
  const nearest = () => {
    if (!underlying?.last || !contracts.length) return;
    let index = 0;
    contracts.forEach((q, i) => { if (new Decimal(q.strike!).minus(underlying.last!).abs().lt(new Decimal(contracts[index].strike!).minus(underlying.last!).abs())) index = i; });
    setPage(Math.floor(index / PAGE_SIZE)); setSelected(contracts[index]);
  };
  return <section className="widget options-workspace">
    <header className="content-heading"><div><p className="eyebrow">TRADIER · US OPTIONS</p><h3>期权链与合约行情</h3><p className="muted">按到期日查看报价与风险指标，同一行权价的 Call / Put 日 K 线并排对照。</p></div><span className="quote-asset">{environment === "sandbox" ? "模拟环境 · 延迟约 15 分钟" : "Tradier · USD"}</span></header>
    <div className="options-controls"><form onSubmit={e => { e.preventDefault(); const next = tradierSymbol(draft); if (next) { setSymbol(next); setDraft(next); setPage(0); if (next === symbol) refresh(); } }}><label>标的代码<input aria-label="期权标的代码" value={draft} maxLength={20} onChange={e => setDraft(e.target.value)} placeholder="AAPL / GLD / USO" /></label><button className="primary-button" type="submit">查询期权</button></form><label>到期日<select aria-label="期权到期日" value={expiration} onChange={e => { setExpiration(e.target.value); setSelected(null); setPage(0); }} disabled={!dates?.expirations.length}><option value="" disabled>选择到期日</option>{dates?.expirations.map(date => <option key={date}>{date}</option>)}</select></label><button className="secondary-button" disabled={loading} onClick={refresh}>{loading ? "读取中…" : "刷新行情"}</button></div>
    <div className="option-underlying"><strong>{symbol}</strong><span>最近成交 <b>{money(underlying?.last)}</b> USD</span><span>买 / 卖 {money(underlying?.bid)} / {money(underlying?.ask)}</span><span>成交时间 {underlying?.tradeAt ? formatTimestamp(underlying.tradeAt) : "—"}</span></div>
    {heldContracts.length > 0 && <label className="held-options-select">自动关注的期权<select aria-label="自动关注的期权" defaultValue="" onChange={async e => { const code = e.target.value; if (!code) return; setDirectError(""); try { const data = await getJson<MarketQuotesResponse>(`/api/market/quotes?symbols=${encodeURIComponent(code)}`); const q = data.quotes.find(q => q.symbol === code); if (!q) throw new Error("该合约当前无报价；若已到期，请核对结算。"); setSelected(q); } catch (e) { setDirectError(errorText(e)); } }}><option value="">选择持仓合约</option>{heldContracts.map(code => <option key={code}>{code}</option>)}</select>{directError && <span className="inline-error">{directError}</span>}</label>}
    {quoteError && <p className="inline-error">标的报价：{quoteError}</p>}
    {error && <p className="inline-error" role="alert">{error}{currentChain ? " 正在显示上次成功读取的数据。" : ""}</p>}
    <p className="chart-note">{environment === "sandbox" ? "模拟行情延迟约 15 分钟，不提供 Greeks。" : "实盘行情约每 30 秒刷新；Greeks / IV 由 Tradier 转供 ORATS，约每小时更新。"} 休市或合约不活跃时保留最近成交；价格按每股报价，合约规模以返回值为准。</p>
    {currentChain && <><div className="filter-toolbar"><div className="segmented-control" aria-label="期权表格内容"><button aria-pressed={tab === "quotes"} onClick={() => setTab("quotes")}>报价与成交</button><button aria-pressed={tab === "greeks"} onClick={() => setTab("greeks")}>Greeks / IV</button></div><label>方向<select aria-label="期权方向" value={right} onChange={e => { setRight(e.target.value); setPage(0); }}><option value="all">全部 Call / Put</option><option value="call">看涨 Call</option><option value="put">看跌 Put</option></select></label><button className="secondary-button" onClick={nearest} disabled={!underlying?.last || !contracts.length}>定位平值附近</button><span className="muted">{contracts.length} 个合约 · 表格可横向滚动 · 读取 {formatTimestamp(currentChain.receivedAt)}</span></div>
      {contracts.length ? <><div className="position-table-wrap"><table className="position-table option-chain-table"><thead><tr><th>合约 / 方向</th><th>行权价</th>{tab === "quotes" ? <><th>买价</th><th>卖价</th><th>最近成交</th><th>成交量</th><th>未平仓量</th><th>每张规模</th><th>成交时间</th></> : <><th>IV（中间）</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th><th>Rho</th><th>指标更新时间</th></>}</tr></thead><tbody>{rows.map(q => <tr key={q.symbol} className={selected?.symbol === q.symbol ? "option-selected" : ""}><td><button className="text-button option-contract-button" onClick={() => setSelected(q)}>{q.symbol}</button><span className={`option-right option-right--${q.right}`}>{q.right === "call" ? "看涨 CALL" : "看跌 PUT"}</span></td><td>{money(q.strike)}</td>{tab === "quotes" ? <><td>{money(q.bid)}</td><td>{money(q.ask)}</td><td>{money(q.last)}</td><td>{q.volume ?? "—"}</td><td>{q.openInterest ?? "—"}</td><td>{q.contractSize ?? "—"}</td><td>{q.tradeAt ? formatTimestamp(q.tradeAt) : "无成交时间"}</td></> : <><td>{iv(q.greeks?.midIv)}</td><td>{money(q.greeks?.delta)}</td><td>{money(q.greeks?.gamma)}</td><td>{money(q.greeks?.theta)}</td><td>{money(q.greeks?.vega)}</td><td>{money(q.greeks?.rho)}</td><td>{q.greeks?.updatedAt ?? "—"}<span>供应商时间（未标时区）</span></td></>}</tr>)}</tbody></table></div><div className="options-pagination"><button className="secondary-button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页合约</button><span>{currentPage + 1} / {totalPages}</span><button className="secondary-button" disabled={currentPage + 1 >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页合约</button></div></> : <p className="empty-state">Tradier 未返回这个到期日的期权合约。</p>}</>}
    {!error && !loading && dates && !dates.expirations.length && <p className="empty-state">Tradier 未返回 {symbol} 的有效到期日，该标的可能没有可交易期权。</p>}
    <details className="option-direct-lookup"><summary>按 OCC 合约代码查询</summary><form onSubmit={async e => { e.preventDefault(); setDirectError(""); setDirectLoading(true); try { const data = await getJson<MarketQuotesResponse>(`/api/market/quotes?symbols=${encodeURIComponent(tradierSymbol(contractInput))}`); const q = data.quotes.find(q => q.type === "option"); if (!q) throw new Error("Tradier 未返回该期权报价；请检查 OCC 代码，已到期合约可能不可用。"); setSelected(q); } catch (e) { setDirectError(errorText(e)); } finally { setDirectLoading(false); } }}><input aria-label="OCC 合约代码" value={contractInput} onChange={e => setContractInput(e.target.value)} maxLength={35} placeholder="例如 AAPL261218C00250000" /><button className="secondary-button" disabled={directLoading}>{directLoading ? "读取中…" : "查询合约"}</button></form>{directError && <p className="inline-error" role="alert">{directError}</p>}</details>
    {<OptionComparison selected={selected} contracts={currentChain?.contracts ?? []} spot={underlying?.last} />}
  </section>;
});
