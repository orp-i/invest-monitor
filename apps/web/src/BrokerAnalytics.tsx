import { brokerLabel } from "@invest/domain";
import { useState } from "react";
import { Decimal } from "decimal.js";
import { assetKind, brokerFeeTotals, brokerPositionTotals, exactTotal, type BrokerSnapshot } from "@invest/domain";
import { DonutChart } from "./PortfolioCharts";
import { formatMoney, formatTimestamp } from "./format";

const accountName = (a: BrokerSnapshot) => `${brokerLabel(a.broker)} · ${a.accountId}`;
export function BrokerAnalytics({ accounts }: { accounts: BrokerSnapshot[] }) {
  const [environment, setEnvironment] = useState("real");
  const [selectedCurrency, setCurrency] = useState("USD");
  const selected = accounts.filter(a => environment === "sandbox" ? a.environment === "sandbox" : a.environment !== "sandbox");
  const currencies = [...new Set(selected.flatMap(a => [a.currency, ...a.positions.map(p => p.currency)]).filter((c): c is string => !!c))].sort();
  const currency = currencies.includes(selectedCurrency) ? selectedCurrency : currencies[0] ?? "USD";
  const capital = selected.filter(a => a.currency === currency);
  const missingCapital = selected.filter(a => a.equity === null || a.currency === null);
  const exposure = selected.flatMap(a => a.positions.filter(p => p.currency === currency));
  const kinds = [...new Set(exposure.map(p => assetKind(p.assetType)))];
  const pnl = selected.map(a => ({ account: a, value: currency === "USD" && a.performance ? a.performance.totalNet : a.currency === currency && a.unrealizedPnl !== null ? a.unrealizedPnl : exactTotal(a.positions.filter(p => p.currency === currency).map(p => p.unrealizedPnl)), included: a.currency === currency || a.positions.some(p => p.currency === currency) })).filter(p => p.included);
  return <div className="broker-analytics"><div className="content-heading"><div><p className="eyebrow">BROKER ALLOCATION</p><h3>资金分布与账户表现</h3></div><div className="filter-toolbar"><label>账户环境<select aria-label="统计账户环境" value={environment} onChange={e => setEnvironment(e.target.value)}><option value="real">实盘 / 券商结单</option><option value="sandbox">模拟账户</option></select></label><label>统计币种<select aria-label="券商统计币种" value={currency} onChange={e => setCurrency(e.target.value)}>{(currencies.length ? currencies : ["USD"]).map(c => <option key={c}>{c}</option>)}</select></label></div></div>
    <div className="portfolio-chart-grid">
      <DonutChart title="券商资金占比" currency={currency} items={capital.map(a => ({ id: accountName(a), label: accountName(a), value: a.equity ?? "0" }))} missing={missingCapital.length ? `${missingCapital.map(a => brokerLabel(a.broker)).join('、')} 净资产或本位币缺失，暂不计算全账户占比` : capital.some(a => new Decimal(a.equity!).lt(0)) ? "包含负净资产，请查看下方账户明细" : undefined} note="按券商报告的账户净资产计算，包含现金；不同币种、模拟账户分别统计。快照日期见下方。" />
      <DonutChart title="持仓类型分布" currency={currency} items={kinds.map(kind => ({ id: kind, label: kind, value: exactTotal(exposure.filter(p => assetKind(p.assetType) === kind).map(p => p.marketValue === null ? null : new Decimal(p.marketValue).abs().toFixed())) ?? "0" }))} missing={exposure.some(p => p.marketValue === null) ? "部分持仓市值缺失，暂不计算仓位比例" : undefined} note="按持仓市值绝对值计算股票 / ETF、期权和其他资产的敞口占比；不含现金，不代表最大风险或 Delta 敞口。" />
      <DonutChart title={currency === "USD" ? "累计净盈亏分布" : "报告浮动盈亏分布"} currency={currency} centerLabel="盈亏绝对值" items={pnl.map(p => ({ id: accountName(p.account), label: accountName(p.account), value: new Decimal(p.value ?? "0").abs().toFixed(), signedValue: p.value ?? "0" }))} missing={pnl.some(p => p.value === null) ? "部分券商盈亏缺失，暂不计算占比" : undefined} note="扇区按盈亏绝对值计算贡献，图例保留正负号；USD 与总览采用相同净盈亏口径；缺失项见账户明细。" />
    </div>
    <div className="broker-financial-cards">{selected.map(account => <BrokerFinancialCard key={`${account.broker}:${account.accountId}:${account.environment}`} account={account} />)}</div>
    {!selected.length && <p className="empty-state">尚无该环境的账户快照，请在下方同步。</p>}
  </div>;
}
function BrokerFinancialCard({ account }: { account: BrokerSnapshot }) {
  const fees = brokerFeeTotals(account);
  const positions = brokerPositionTotals([account]);
  const dates = account.trades.map(t => t.tradedAt).sort();

  return <article className="broker-financial-card"><header><h3>{accountName(account)}</h3><span className="tr-pill">{account.environment === "statement" ? account.broker === "elephant" ? "银行结单" : "Flex 报表" : account.environment === "sandbox" ? "模拟" : "实盘"}</span></header><p className="muted">数据截至 {account.asOf} · 同步 {formatTimestamp(account.syncedAt)}</p><dl className="financial-metrics"><div><dt>账户净资产</dt><dd>{formatMoney(account.equity)} {account.currency}</dd></div><div><dt>现金余额</dt><dd>{formatMoney(account.cash ?? null)} {account.currency}</dd></div><div><dt>报告浮动盈亏</dt><dd>{account.unrealizedPnl !== null ? `${formatMoney(account.unrealizedPnl)} ${account.currency}` : positions.length ? positions.map(p => `${formatMoney(p.unrealizedPnl)} ${p.currency}`).join(' / ') : '0 · 空持仓'}</dd></div><div><dt>累计已实现净盈亏 · USD</dt><dd>{formatMoney(account.computedRealizedNet ?? null)} USD</dd></div><div><dt>未实现净盈亏 · USD</dt><dd>{formatMoney(account.performance?.unrealizedNet ?? null)} USD</dd></div><div><dt>{account.performance?.complete ? "累计总净盈亏" : "已知部分总净盈亏"} · USD</dt><dd>{formatMoney(account.performance?.totalNet ?? null)} USD</dd></div><div><dt>已同步成交已知手续费</dt><dd>{fees.map(f => <span key={f.currency}>{formatMoney(f.total)} {f.currency}{f.missing > 0 && <small>已知 {formatMoney(f.known)}，{f.missing} 笔费用缺失</small>}</span>)}{!fees.length && "0 · 无已同步成交"}</dd></div><div><dt>持仓 / 成交</dt><dd>{account.positions.length} 项 / {account.trades.length} 笔</dd></div></dl>
    {account.sessionRealizedPnl !== null && <p className="chart-note">当日已平仓盈亏（券商口径）：{formatMoney(account.sessionRealizedPnl)} {account.currency}</p>}
    {account.performance && !account.performance.complete && <details><summary>核算待补充（{account.performance.missing.length}）</summary>{account.performance.missing.map(m => <p key={m} className="chart-note">{m}</p>)}</details>}
    {account.equity === null && account.broker === "ibkr" && <p className="inline-error">资金分布待补：Flex 查询添加 Net Asset Value (NAV) Summary in Base（全部字段），以及 Account Information → Base Currency，再同步。</p>}
    {account.allocation && account.allocation.length > 0 && <details><summary>现金与资产明细 · {account.currency}</summary><dl className="financial-metrics">{account.allocation.map(a => <div key={a.assetType}><dt>{a.assetType}</dt><dd>{formatMoney(a.value)}</dd></div>)}</dl></details>}
    <p className="chart-note">手续费范围：{dates.length ? `${dates[0]} — ${dates.at(-1)}` : "暂无成交"}，仅已保存记录，不代表开户以来全部费用。已匹配的正式结单含佣金、交易费及附加费，优先用于费用统计；API 佣金原值保留。累计已实现覆盖全部已保存成交及确认结算，不代表开户以来完整历史。结算现金已含费用，不再重复扣除。</p>
  </article>;
}
