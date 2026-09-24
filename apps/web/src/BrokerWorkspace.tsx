import { brokerLabel, directionLabel, quantityDirection, executionAction, brokerPositionEffect } from "@invest/domain";
import { memo, useCallback, useEffect, useState } from "react";
import { getJson, writeJson } from "./api";
import { formatMoney, formatTimestamp } from "./format";
import { startResearch } from "./ResearchWorkspace";
import { startTradingReview } from "./TradingReviewWorkspace";
import { BrokerAnalytics } from "./BrokerAnalytics";
import { tradierSymbol } from "@invest/domain";
import { TradierPositionPrice, useTradierQuotes } from "./useTradierQuotes";
import type { BrokerConnectionStatus, BrokerSnapshot } from "./types";

const MODE_LABEL: Record<string, string> = { live: "实盘账户", sandbox: "模拟环境", paper: "Paper 模拟", statement: "报表快照" };
const modeLabel = (mode: string) => MODE_LABEL[mode] ?? mode;

export const BrokerWorkspace = memo(function BrokerWorkspace() {
  const [connections, setConnections] = useState<BrokerConnectionStatus[]>([]);
  const [accounts, setAccounts] = useState<BrokerSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const refresh = useCallback(async () => {
    try { const data = await getJson<{ connections: BrokerConnectionStatus[]; accounts: BrokerSnapshot[] }>("/api/brokers"); setConnections(data.connections); setAccounts(data.accounts); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const update = () => void refresh(); void refresh(); window.addEventListener("invest:broker-data-updated", update); return () => window.removeEventListener("invest:broker-data-updated", update); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, connections.some(c => c.sync?.state === "running") ? 2000 : 15000);
    return () => window.clearInterval(timer);
  }, [connections, refresh]);
  const key = (account: BrokerSnapshot) => `${account.broker}:${account.accountId}:${account.environment}`;
  const active = accounts.find(account => key(account) === selected) ?? accounts[0];
  return <section className="widget broker-workspace">
    <BrokerAnalytics accounts={accounts} />
    <div className="workspace-intro"><div><p className="eyebrow">CONNECTED ACCOUNTS</p><h3>连接与同步</h3><p>Tradier 每 15 分钟、IBKR 每小时自动同步，Tradier 另在每个交易日常规收盘前 1 分钟再读取一次以捕获当日多腿订单；完成后更新总览、账户表现与交易配对。</p></div><span className="quote-asset">只读同步</span></div>
    {error ? <div className="inline-error" role="alert">{error}<button className="text-button" onClick={() => void refresh()}>重试读取</button></div> : null}
    {notice ? <p className="password-success" role="status">{notice}</p> : null}
    <div className="broker-connections">{connections.map(connection => {
      const syncing = busy === connection.id || connection.sync?.state === "running";
      const state = !connection.configured ? "missing" : syncing ? "running" : connection.sync?.state ?? "never";
      const badge = { missing: "尚未配置", never: "已配置 · 尚未同步", running: "正在同步", success: "最近同步成功", error: "最近同步失败" }[state];
      return <article key={connection.id}>
      <header><h3>{connection.name}</h3><span role="status" className={`status-badge status--${state === "success" ? "live" : ["missing", "error"].includes(state) ? "unavailable" : "delayed"}`}>{badge}</span></header>
      <p>{connection.description ?? "只读同步券商账户的持仓与成交。"}</p>
      <div className="broker-mode">{modeLabel(connection.mode)}{connection.cadenceMinutes ? ` · 每 ${connection.cadenceMinutes} 分钟自动同步` : ""}</div>
      {connection.authorization ? connection.authorization.needsReauthorization
        ? <p className="inline-error broker-sync-error" role="alert">{connection.authorization.message ?? "OAuth 刷新令牌已过期或即将过期，同步会失败。"}<br /><a href="#/settings">前往账号设置重新授权 →</a></p>
        : <p className="broker-sync-summary">{connection.authorization.message ?? `OAuth 刷新令牌${connection.authorization.daysLeft !== null ? `剩余 ${connection.authorization.daysLeft} 天` : "有效期未知"}${connection.authorization.expiresAt ? `，${formatTimestamp(connection.authorization.expiresAt)} 到期` : ""}${connection.authorization.issuedAt ? `（签发于 ${formatTimestamp(connection.authorization.issuedAt)}）` : ""}`}</p> : null}
      {connection.closeSync && <p className="broker-sync-summary">收盘前 {connection.closeSync.leadMinutes} 分钟同步：{connection.closeSync.nextSyncAt ? `下次 ${formatTimestamp(connection.closeSync.nextSyncAt)}（${connection.closeSync.basis === "calendar" ? "按 Tradier 交易日历" : "日历未读取，按工作日 16:00 ET"}）` : "暂无计划"}{connection.closeSync.lastSyncedDate ? ` · 最近执行 ${connection.closeSync.lastSyncedDate}` : ""}</p>}
      {connection.sync?.lastSuccessAt && <p className="broker-sync-summary">上次成功：{formatTimestamp(connection.sync.lastSuccessAt)}<br />已保存 {connection.sync.accounts} 个账户 · {connection.sync.positions} 项持仓 · {connection.sync.trades} 笔成交{connection.sync.positions === 0 && connection.sync.trades === 0 ? "（券商返回空持仓、空成交）" : ""}</p>}
      {state === "error" && connection.sync?.message && <p className="inline-error broker-sync-error" role="alert">{connection.sync.message}<br />失败时间：{connection.sync.completedAt ? formatTimestamp(connection.sync.completedAt) : "待核实"}{connection.sync.lastSuccessAt ? "；上次成功数据已保留。" : ""}</p>}
      {!connection.configured ? <details className="connection-setup"><summary>查看接入步骤</summary><ol><li>{connection.description ?? "按官方说明生成只读 API 凭证。"}</li>{connection.missing.length ? <li>需要填写：{connection.missing.join("、")}。</li> : null}{connection.id === "ibkr" ? <><li>在 IBKR 门户启用 Flex Web Service，生成 Token 和 XML 格式 Query ID。</li><li>查询包含 Open Positions（SUMMARY）和 Trades（EXECUTION），勾选代码、币种、数量、价格、成本、盈亏、tradeID 和日期字段。</li></> : null}{connection.id === "schwab" ? <li>保存 App Key / Secret 与回调地址后，在账号设置页完成 OAuth 授权；刷新令牌 7 天有效，到期需重新授权。</li> : null}<li>在「账号设置」页填写凭证并测试连接；也可继续通过服务器环境变量配置。</li><li>回到本页点击同步并检查实际记录。</li></ol><div className="connection-links"><a href="#/settings">前往账号设置配置凭证 →</a>{connection.docsUrl ? <a href={connection.docsUrl} target="_blank" rel="noreferrer">官方接入说明 ↗</a> : null}</div></details> : null}
      {connection.id === "ibkr" && connection.configured && <details className="connection-setup"><summary>XML 格式与字段设置</summary><ol><li>IBKR 门户 → Performance & Reports → Flex Queries → 编辑当前 Activity Flex Query。</li><li>Delivery Configuration 的 Format 设为 XML。</li><li>Open Positions：Summary 层级，勾选 Conid、Symbol、Currency、Position、Cost Basis Money、Position Value、Unrealized P/L。</li><li>Trades：Execution 层级，勾选 Trade ID、Symbol、Currency、Buy/Sell、Quantity、Trade Price、IB Commission、Date/Time、Asset Class。</li><li>保存每个栏目，再保存整个查询。同一 Query ID 修改字段后，直接重新同步；新建查询才需要更新服务器的 Query ID。</li></ol><a href="https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm" target="_blank" rel="noreferrer">IBKR 官方配置说明 ↗</a></details>}
      <button className="primary-button" disabled={!connection.configured || !!busy || syncing} onClick={async () => {
        setBusy(connection.id); setError(""); setNotice("");
        try { const result = await writeJson<{ accounts: BrokerSnapshot[]; connection?: BrokerConnectionStatus }>(`/api/brokers/${connection.id}/sync`, "POST"); setAccounts(current => [...current.filter(account => account.broker !== connection.id), ...result.accounts]); setConnections(current => current.map(c => c.id === connection.id ? result.connection ?? c : c)); setNotice(`${connection.name} 同步完成，已保存 ${result.accounts.length} 个账户。`); }
        catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { setBusy(""); await refresh(); }
      }}>{syncing ? "正在读取券商记录…" : "同步持仓和成交"}</button>
    </article>})}</div>
    {loading ? <p className="empty-state">正在读取账户…</p> : !accounts.length ? <div className="workspace-empty"><span aria-hidden="true">⇄</span><h3>等待首次同步</h3><p>配置券商凭证后，账户持仓与成交会保存在这里。手工交易可在「持仓」页录入。</p></div> : <>
      <div className="filter-toolbar"><label>查看账户<select aria-label="查看券商账户" value={active ? key(active) : ""} onChange={event => setSelected(event.target.value)}>{accounts.map(account => <option key={key(account)} value={key(account)}>{brokerLabel(account.broker)} · {account.accountId} · {account.environment}</option>)}</select></label></div>
      {active ? <AccountDetails key={key(active)} account={active} /> : null}
    </>}
  </section>;
});

function AccountDetails({ account }: { account: BrokerSnapshot }) {
  const market = useTradierQuotes([account]);
  const [query, setQuery] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [page, setPage] = useState(1);
  const day = (value: string) => /^\d{8}/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value.slice(0, 10);
  const trades = account.trades.filter(trade => trade.symbol.toLowerCase().includes(query.toLowerCase()) && (!start || day(trade.tradedAt) >= start) && (!end || day(trade.tradedAt) <= end));
  const pages = Math.max(1, Math.ceil(trades.length / 30));
  const currentPage = Math.min(page, pages);
  return <div className="account-details">
    <div className="account-asof"><strong>{brokerLabel(account.broker)} · {account.accountId}</strong><span>同步于 {formatTimestamp(account.syncedAt)}</span><span>数据截至 {account.asOf}</span></div>
    {account.environment === "statement" ? <p className="currency-explanation">券商报表快照 · 以下金额截至报告日期，按各持仓币种展示。</p> : <div className="overview-metrics broker-metrics">
      <div><span>账户权益 · {account.currency}</span><strong className="numeric">{formatMoney(account.equity)}</strong><p>券商账户余额口径</p></div>
      <div><span>当前持仓盈亏 · {account.currency}</span><strong className="numeric">{formatMoney(account.unrealizedPnl)}</strong><p>未平仓头寸 · 券商口径</p></div>
      <div><span>累计已实现净盈亏 · USD</span><strong className="numeric">{formatMoney(account.computedRealizedNet ?? null)}</strong><p>全部已同步成交 · 当日券商口径 {formatMoney(account.sessionRealizedPnl)} {account.currency}</p></div>
    </div>}
    {market.error && <p className="inline-error">Tradier 报价：{market.error}</p>}<p className="chart-note">股票与期权报价来自 Tradier，约每 30 秒刷新{market.environment === "sandbox" ? "，模拟环境延迟约 15 分钟" : ""}；休市时保留最近成交。账户金额与盈亏仍按券商报告统计。</p>
    <h3>持仓明细 <span className="muted">{account.positions.length} 项</span></h3>
    {account.positions.length ? <div className="position-table-wrap"><table className="position-table"><thead><tr><th>标的</th><th>数量</th><th>币种</th><th>成本</th><th>Tradier 成交价 · USD</th><th>报告市值</th><th>未实现盈亏</th></tr></thead><tbody>{account.positions.map(position => <tr key={position.id}><td><strong>{position.symbol}</strong></td><td>{position.quantity}<span>{directionLabel(position.symbol, quantityDirection(position.quantity))}</span></td><td>{position.currency}</td><td>{formatMoney(position.costBasis)}</td><td><TradierPositionPrice quote={position.currency === "USD" ? market.quotes.get(tradierSymbol(position.symbol)) : undefined} /></td><td>{formatMoney(position.marketValue)}</td><td>{formatMoney(position.unrealizedPnl)}</td></tr>)}</tbody></table></div> : <p className="empty-state">该快照没有持仓记录。</p>}
    <div className="content-heading"><h3>成交记录</h3><span>{trades.length} 笔</span></div>
    <div className="filter-toolbar"><input aria-label="搜索券商成交" placeholder="搜索标的代码…" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /><label>起始日期<input aria-label="成交起始日期" type="date" value={start} onChange={event => { setStart(event.target.value); setPage(1); }} /></label><label>结束日期<input aria-label="成交结束日期" type="date" min={start} value={end} onChange={event => { setEnd(event.target.value); setPage(1); }} /></label></div>
    {trades.length ? <div className="position-table-wrap"><table className="position-table"><thead><tr><th>券商日期 / 时间</th><th>标的</th><th>方向</th><th>数量</th><th>成交价</th><th>佣金 / 结单总费用</th><th>币种</th><th>复盘</th></tr></thead><tbody>{trades.slice((currentPage - 1) * 30, currentPage * 30).map(trade => <tr key={trade.id}><td>{trade.tradedAt}<span>{trade.timePrecision === "day" ? "仅日期" : trade.timePrecision === "instant" ? "UTC · 已核对结单时区" : "券商报表时区"}</span></td><td><strong>{trade.symbol}</strong><span>{trade.assetType}</span></td><td>{trade.expirationConfirmation ? "到期作废" : trade.side === "buy" ? "买入" : "卖出"}<span>{trade.expirationConfirmation ? "确认结算" : executionAction(trade.side, brokerPositionEffect(account, trade))}</span>{trade.expirationConfirmation && <span>用户确认 · 结算价值 0</span>}</td><td>{trade.quantity}</td><td>{trade.price ?? "—"}</td><td>{trade.statementFees ?? trade.totalFees ?? trade.fees ?? "—"}{trade.statementFees != null && <span>结单完整费用 · API 佣金 {trade.fees ?? "—"}</span>}</td><td>{trade.currency}</td><td><button className="text-button" onClick={() => startResearch({ transactionId: trade.id })}>记录判断</button><button className="text-button" onClick={() => startTradingReview({ transactionId: trade.id })}>交易复盘</button></td></tr>)}</tbody></table></div> : <p className="empty-state">没有符合条件的成交记录。</p>}
    {pages > 1 ? <div className="pagination"><button className="secondary-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage} / {pages}</span><button className="secondary-button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div> : null}
    <details className="broker-notes"><summary>同步范围与金额口径</summary>{account.notes.map(note => <p key={note}>{note}</p>)}</details>
  </div>;
}
