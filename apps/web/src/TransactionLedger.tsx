import { useState } from "react";
import { deleteTransaction } from "./api";
import { formatMoney, formatTimestamp } from "./format";
import { startResearch } from "./ResearchWorkspace";
import { startTradingReview } from "./TradingReviewWorkspace";
import type { InstrumentMeta, TransactionRecord } from "./types";

export function TransactionLedger({ transactions, instruments, onChanged }: { transactions: TransactionRecord[]; instruments: Record<string, InstrumentMeta>; onChanged: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labels = { buy: "买入", sell: "卖出", dividend: "税前股息", withholding_tax: "预扣税" };
  const rows = transactions.filter(row => (type === "all" || row.type === type) && `${instruments[row.instrumentId]?.symbol ?? row.instrumentId} ${instruments[row.instrumentId]?.displayName ?? ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.tradeAtMs - a.tradeAtMs);
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const currentPage = Math.min(page, pages);
  return <section className="widget widget--ledger">
    <div className="content-heading"><div><p className="eyebrow">TRADE JOURNAL</p><h3>手工交易账本</h3></div><span>{rows.length} 笔交易</span></div>
    <div className="filter-toolbar"><input aria-label="搜索手工交易" placeholder="搜索标的…" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} /><select aria-label="筛选交易类型" value={type} onChange={event => { setType(event.target.value); setPage(1); }}><option value="all">全部类型</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {!rows.length ? <p className="empty-state">尚无匹配的交易。在上方录入交易后，可在这里发起复盘。</p> : <div className="position-table-wrap"><table className="position-table"><thead><tr><th>成交时间</th><th>标的</th><th>类型</th><th>数量 / 现金额</th><th>价格</th><th>手续费</th><th>币种</th><th>操作</th></tr></thead><tbody>{rows.slice((currentPage - 1) * 20, currentPage * 20).map(row => <tr key={row.id}><td>{formatTimestamp(new Date(row.tradeAtMs).toISOString())}</td><td><strong>{instruments[row.instrumentId]?.symbol ?? row.instrumentId}</strong></td><td>{labels[row.type]}</td><td>{row.quantity}</td><td>{formatMoney(row.price, instruments[row.instrumentId]?.precision.priceScale ?? 2)}</td><td>{row.fees}</td><td>{row.currency}</td><td><div className="ledger-actions"><button className="text-button" onClick={() => startResearch({ transactionId: row.id })}>记录判断</button><button className="text-button" onClick={() => startTradingReview({ transactionId: row.id })}>交易复盘</button>{removing !== row.id ? <button className="text-button muted" onClick={() => setRemoving(row.id)}>删除</button> : <><button className="text-button" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await deleteTransaction(row.id); await onChanged(); setRemoving(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }}>确认删除并重算</button><button className="text-button" disabled={busy} onClick={() => setRemoving("")}>取消</button></>}</div></td></tr>)}</tbody></table></div>}
    {pages > 1 ? <div className="pagination"><button className="secondary-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage} / {pages}</span><button className="secondary-button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div> : null}
  </section>;
}
