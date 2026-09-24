import { brokerLabel, directionLabel, quantityDirection } from "@invest/domain";
import { memo, useCallback, useEffect, useState } from "react";
import { assetKind, brokerPositionTotals, tradierSymbol, type BrokerSnapshot } from "@invest/domain";
import { TradierPositionPrice, useTradierQuotes } from "./useTradierQuotes";
import { getJson } from "./api";
import { formatMoney, formatTimestamp } from "./format";

export const AllBrokerPositions = memo(function AllBrokerPositions() {
  const [accounts, setAccounts] = useState<BrokerSnapshot[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [broker, setBroker] = useState("all");
  const [asset, setAsset] = useState("all");
  const [query, setQuery] = useState("");
  const [environment, setEnvironment] = useState("real");
  const refresh = useCallback(async () => { try { const data = await getJson<{ accounts: BrokerSnapshot[] }>("/api/brokers"); setAccounts(data.accounts); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "持仓读取失败"); } finally { setLoaded(true); } }, []);
  useEffect(() => { const update = () => void refresh(); window.addEventListener("invest:broker-data-updated", update); void refresh(); const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15000); return () => { window.removeEventListener("invest:broker-data-updated", update); window.clearInterval(timer); }; }, [refresh]);
  const selected = accounts.filter(a => (environment === "real" ? a.environment !== "sandbox" : a.environment === "sandbox") && (broker === "all" || a.broker === broker));
  const market = useTradierQuotes(selected);
  const rows = selected.flatMap(account => account.positions.map(position => ({ account, position }))).filter(({ position }) => (asset === "all" || assetKind(position.assetType) === asset) && position.symbol.toLowerCase().includes(query.toLowerCase()));
  const totals = brokerPositionTotals(selected.map(a => ({ ...a, positions: rows.filter(r => r.account === a).map(r => r.position) })));
  return <section className="widget all-broker-positions"><div className="content-heading"><div><p className="eyebrow">ALL BROKER POSITIONS</p><h3>全部券商持仓</h3><p className="muted">{selected.length} 个账户 · {rows.length} 项持仓，按账户保留成本、市值与报表日期。</p></div><a className="secondary-button" href="#/brokers">查看资金与同步 →</a></div>
    {error && <p className="inline-error" role="alert">{error}<button className="text-button" onClick={() => void refresh()}>重试</button></p>}
    <div className="filter-toolbar"><input aria-label="搜索全部券商持仓" placeholder="搜索标的…" value={query} onChange={e => setQuery(e.target.value)} /><label>券商<select aria-label="持仓券商" value={broker} onChange={e => setBroker(e.target.value)}><option value="all">全部券商</option>{[...new Set(accounts.map(a => a.broker))].map(b => <option key={b} value={b}>{brokerLabel(b)}</option>)}</select></label><label>类型<select aria-label="持仓资产类型" value={asset} onChange={e => setAsset(e.target.value)}><option value="all">全部类型</option>{["股票 / ETF", "期权", "其他"].map(k => <option key={k}>{k}</option>)}</select></label><label>环境<select aria-label="持仓账户环境" value={environment} onChange={e => setEnvironment(e.target.value)}><option value="real">实盘 / 报表</option><option value="sandbox">模拟</option></select></label></div>
    <div className="holdings-total-grid">{totals.map(t => <article key={t.currency}><span>{t.currency} · {t.count} 项</span><dl><div><dt>持仓成本</dt><dd>{formatMoney(t.cost)}</dd></div><div><dt>持仓净市值</dt><dd>{formatMoney(t.marketValue)}</dd></div><div><dt>未实现盈亏</dt><dd>{formatMoney(t.unrealizedPnl)}</dd></div></dl></article>)}</div>
    {rows.length ? <div className="position-table-wrap"><table className="position-table"><thead><tr><th>标的 / 类型</th><th>券商 / 账户</th><th>数量</th><th>成本均价</th><th>成本金额</th><th>报告价格</th><th>Tradier 成交价 · USD</th><th>净市值</th><th>未实现盈亏</th><th>币种 / 数据截至</th></tr></thead><tbody>{rows.map(({ account, position: p }) => <tr key={`${account.broker}:${account.accountId}:${account.environment}:${p.id}`}><td><strong>{p.symbol}</strong><span>{assetKind(p.assetType)}</span></td><td>{brokerLabel(account.broker)}<span>{account.accountId}</span></td><td>{p.quantity}<span>{directionLabel(p.symbol, quantityDirection(p.quantity))}</span></td><td>{formatMoney(p.averageCost ?? null, 4)}</td><td>{formatMoney(p.costBasis)}</td><td>{formatMoney(p.markPrice ?? null, 4)}</td><td><TradierPositionPrice quote={p.currency === "USD" ? market.quotes.get(tradierSymbol(p.symbol)) : undefined} /></td><td>{formatMoney(p.marketValue)}</td><td>{formatMoney(p.unrealizedPnl)}</td><td>{p.currency}<span>{account.asOf}</span></td></tr>)}</tbody></table></div> : <p className="empty-state">{!loaded ? "正在读取券商持仓…" : "当前筛选下没有持仓。"}</p>}
    {market.error && <p className="inline-error">Tradier 报价：{market.error}。已有报价保留原成交时间。</p>}<p className="chart-note">Tradier 提供股票、ETF 和期权报价，约每 30 秒刷新{market.environment === "sandbox" ? "（模拟环境延迟约 15 分钟）" : ""}；成本、市值及盈亏仍为券商报告口径。休市时显示最近成交，报价不覆盖报告价格。</p>
    <div className="holdings-sources">{selected.map(a => <p key={`${a.broker}:${a.accountId}:${a.environment}`}><strong>{brokerLabel(a.broker)} · {a.accountId}</strong>：{a.positions.length} 项持仓 · 截至 {a.asOf} · 同步 {formatTimestamp(a.syncedAt)}</p>)}</div><p className="chart-note">IBKR、大象为报表快照，Tradier 为最近同步结果。不同币种分别统计；空值显示为「—」。大象持仓使用结单期末持仓表，按结单截止日展示。</p>
  </section>;
});
