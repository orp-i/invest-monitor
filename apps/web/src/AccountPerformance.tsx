import { memo, useEffect, useState } from "react";
import Decimal from "decimal.js";
import { brokerLabel, dailyPerformanceCandles, performanceSchedule, type AccountPerformance as Performance, type PerformanceSample, type PerformanceDailyCandle, type PerformanceSchedule } from "@invest/domain";
import { getJson } from "./api";
import { formatMoney, formatTimestamp } from "./format";
import { PriceChart } from "./PriceChart";

export const AccountPerformance = memo(function AccountPerformance() {
  const [data, setData] = useState<{ current: Performance; history: PerformanceSample[]; daily?: PerformanceDailyCandle[]; schedule?: PerformanceSchedule } | null>(null), [error, setError] = useState("");
  const [series, setSeries] = useState<"totalNet" | "unrealizedNet">("totalNet");
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => { let alive = true, pending = false;
    const refresh = async () => { if (pending) return; pending = true; try { const result = await getJson<NonNullable<typeof data>>("/api/performance?history=0"); if (alive) { setData(result); setError(""); } } catch (e) { if (alive) setError(e instanceof Error ? e.message : "盈亏读取失败"); } finally { pending = false; } };
    const onUpdate = () => void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("invest:broker-data-updated", onUpdate);
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => { alive = false; window.removeEventListener("invest:broker-data-updated", onUpdate); document.removeEventListener("visibilitychange", onVisible); };
  }, [refreshTick]);
  const current = data?.current;
  // Live card updates do not add observations to the twice-daily history.
  const schedule = data?.schedule ?? performanceSchedule();
  const daily = data?.daily ?? dailyPerformanceCandles(data?.history ?? [], schedule.candleTimeZone ?? schedule.timeZone);
  const last = daily.at(-1);
  const change = daily.reduce((n, d) => n + d.samples, 0) > 1 && last ? new Decimal(last.totalNet.close).minus(daily[0]!.totalNet.open).toFixed() : null;
  const basisChanges = daily.filter(d => d.basisChanged).map(d => d.day);
  const timeZoneLabel = schedule.timeZone === "Asia/Shanghai" ? "北京时间" : schedule.timeZone;
  const scheduledTime = (at: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: schedule.timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
  return <section className="account-performance widget"><header className="content-heading"><div><p className="eyebrow">PORTFOLIO REVIEW · USD</p><h3>整体投资与盈亏</h3><p className="muted">券商与已导入结单 · 统一以美元统计 · 手续费已计入净盈亏</p></div><div className="study-actions"><button className="text-button" onClick={() => setRefreshTick(n => n + 1)}>更新估值</button><a className="secondary-button" href="#/brokers">查看券商明细 →</a></div></header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!current ? <p className="empty-state">正在核对持仓、成交与手续费…</p> : !current.accounts.length ? <p className="empty-state">同步券商持仓后显示账户盈亏。</p> : <><div className="overview-metrics performance-metrics">
      <div className="performance-total"><span>{current.complete ? "当前总净盈亏" : "已知部分净盈亏"} · USD</span><strong className={`numeric ${new Decimal(current.totalNet).gte(0) ? "study-positive" : "study-negative"}`}>{formatMoney(current.totalNet)}</strong><p>{current.complete ? "已计入未实现盈亏及全部已记录手续费" : `已知部分 · ${current.valuedPositions} / ${current.positions} 项持仓可核算`}</p></div>
      <div><span>已实现净盈亏 · USD</span><strong className="numeric">{formatMoney(current.realizedNet)}</strong><p>已导入成交范围 · 已扣对应手续费</p></div>
      <div><span>未实现净盈亏 · USD</span><strong className="numeric">{formatMoney(current.unrealizedNet)}</strong><p>最新报价与券商报告 · 已计入可核实费用</p></div>
      <div><span>已知手续费支出 · USD</span><strong className="numeric">{formatMoney(new Decimal(current.fees).negated().toFixed())}</strong><p>已记录费用 · 缺失分项见待核对事项</p></div>
    </div><div className="performance-review-band"><div><span>整体净资产 · 券商报告口径</span><strong className="numeric">{formatMoney(current.equity)} <small>USD</small></strong><p>各账户报告日期可能不同；净资产包含本金。</p></div><div><span>持仓核算覆盖</span><strong>{current.valuedPositions} / {current.positions} <small>项</small></strong><p>{current.accounts.length} 个账户 · {current.complete ? "当前口径可完整核算" : `${current.missing.length} 项待核对`}</p></div><div><span>记录起点以来净盈亏变化</span><strong className="numeric">{change === null ? "等待后续记录" : formatMoney(change)} <small>{change === null ? "" : "USD"}</small></strong><p>按全部已保存记录的首末值比较，含核算范围调整。</p></div></div>
    <div className="content-heading"><div><h4>盈亏变化 · 日 K</h4><p className="muted">美股常规时段每 {schedule.session?.everyMinutes ?? 30} 分钟、收盘前 {schedule.session?.preCloseMinutes ?? 1} 分钟各记录一次（先读取 Tradier）；{timeZoneLabel} 12:00 和 00:00 另同步 Tradier、IBKR 后记录。日 K 按纽约交易日聚合，收盘前的记录即当日收盘值。同步失败时保留上次记录并自动重试。日 K 覆盖全部已保存记录，显示历史总变化；新增结单或补齐成本改变核算范围的交易日在下方单独标注。</p></div><div className="segmented-control" aria-label="账户盈亏曲线"><button aria-pressed={series === "totalNet"} onClick={() => setSeries("totalNet")}>总净盈亏</button><button aria-pressed={series === "unrealizedNet"} onClick={() => setSeries("unrealizedNet")}>未实现净盈亏</button></div></div>
    <p className="chart-note performance-schedule">{last ? `最近记录：${scheduledTime(last.lastCapturedAt)}` : "尚无定时记录"} · 下次更新：{scheduledTime(schedule.nextUpdateAt)}（{timeZoneLabel}）</p>
    {daily.length ? <PriceChart points={daily.map(p => ({ time: p.time, price: p[series].close, open: p[series].open, high: p[series].high, low: p[series].low }))} quoteAsset="USD" priceScale={2} candles timeframe="1d" showMovingAverages={false} caption="日 K 按纽约交易日排列 · 拖动、悬浮或方向键查看历史" /> : <p className="empty-state">等待下一次定时记录后显示日 K。</p>}
    <p className="chart-note">开/收为当天首末记录（收盘前 1 分钟的记录为收盘值），高/低为已记录样本中的最高/最低值，不代表全天极值。单次记录时四值相同，缺失日期留空；定时任务之外的更新估值和券商同步只更新当前金额，不增加日 K 采样。</p>
    {daily.length > 0 && <p className="chart-note">共 {daily.length} 个交易日的记录；{basisChanges.length ? `其中 ${basisChanges.length} 天核算范围有变化（新增成交/结单或成本修订）：${basisChanges.slice(-6).join("、")}${basisChanges.length > 6 ? " 等" : ""}，当天的开收差包含范围调整。` : "核算范围未变化。"}</p>}
    <p className="chart-note">统计 {current.from ?? "—"} 起的 {current.fills} 笔成交；已排除 {current.duplicateFills} 笔 API / 结单重复记录。总净盈亏 = 已实现净盈亏 + 未实现净盈亏 − 尚未分配的手续费 {formatMoney(current.unallocatedFees)} USD。</p>
    <p className="chart-note">持仓截至：{current.accounts.map(a => `${brokerLabel(a.broker)} ${a.asOf}`).join(" · ")}。休市时采用 Tradier 最近成交价；统计更新于 {formatTimestamp(current.capturedAt)}。</p>
    {!current.complete && <details className="performance-missing"><summary>待核对事项（{current.missing.length}）</summary><ul>{current.missing.map(m => <li key={m}>{m}</li>)}</ul></details>}</>}
  </section>;
});
