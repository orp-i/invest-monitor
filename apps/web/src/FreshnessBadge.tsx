import { LiveAge } from "./useNow";
import {
  effectiveStatus,
  freshnessLabel,
  formatTimestamp,
  formatMarketTimestamp,
  statusIcon,
  statusLabel,
} from "./format";
import type { ConnectionState, Freshness } from "./types";

interface FreshnessBadgeProps {
  freshness: Freshness;
  connectionState: ConnectionState;
  sourceId?: string;
  sourceHealthStatus?: string;
  nowMs: number;
  compact?: boolean;
}

export function FreshnessBadge({
  freshness,
  connectionState,
  sourceId,
  sourceHealthStatus,
  nowMs,
  compact = false,
}: FreshnessBadgeProps) {
  const status = effectiveStatus(freshness, connectionState, sourceHealthStatus, nowMs);
  const disconnected = connectionState !== "connected" && status !== "unavailable";
  return (
    <div className={`freshness-stack ${compact ? "freshness-stack--compact" : ""}`}>
      <span className={`status-badge status--${status}`} data-status={status} role="status">
        <span aria-hidden="true">{statusIcon(status)}</span>
        <span>{freshnessLabel(freshness, status)}</span>
      </span>
      {freshness.tradeSession && <span className="trade-session" title="按实际成交时间与纽约交易日历判断；当前市场时段不会改变旧报价的成交时段。">成交：{{ pre: "盘前", regular: "盘中", post: "盘后", overnight: "夜盘时段 · 来源覆盖未确认", unknown: "时段未确认" }[freshness.tradeSession]}{freshness.tradeSessionDate ? ` · ${freshness.tradeSessionDate} ET` : ""}</span>}
      <span className="freshness-meta">
        <span><LiveAge freshness={freshness} /></span>
      </span>
      <details className="freshness-details">
        <summary aria-label="数据时间与来源详情">数据详情</summary>
        <div>
          {sourceId ? <span>来源：{sourceId}</span> : null}
          {freshness.marketState && <span>当前 Tradier 市场状态：{{ open: "盘中", closed: "休市", premarket: "盘前", postmarket: "盘后", unknown: "未知" }[freshness.marketState]}</span>}
          {freshness.tradeSession && <span>成交时段依据：{freshness.sessionBasis === "calendar" ? "纽约成交时间与 Tradier 交易日历（含提前收盘）" : "缺少可确认的时段信息"}；显示日期为纽约自然日，夜盘清算归属日待交易场所确认。</span>}
          <span>行情时间：{freshness.status === "unavailable" ? "暂无" : freshness.tradeReferenceAt ? formatMarketTimestamp(freshness.capturedAt) : formatTimestamp(freshness.capturedAt)}</span>
          <span>接收时间：{formatTimestamp(freshness.receivedAt)}</span>
          {freshness.tradeReferenceAt && <><span>最近成交：{formatMarketTimestamp(freshness.tradeReferenceAt)}</span><span>相对最近成交滞后：{freshness.dataLagMs ?? 0} 毫秒</span></>}
          <span>过期阈值：{freshness.staleAfterSeconds} 秒</span>
        </div>
      </details>
      {freshness.skewSuspected ? (
        <span className="skew-warning" role="note">
          <span aria-hidden="true">⚠</span>
          来源时钟可能偏移，时效按本地接收时间计算。
        </span>
      ) : null}
      {sourceHealthStatus && sourceHealthStatus !== "healthy" ? (
        <span className="health-warning" role="note">
          <span aria-hidden="true">!</span>
          数据源异常（{sourceHealthStatus}），报价已降级。
        </span>
      ) : null}
      {disconnected ? (
        <span className="connection-warning" role="note">
          <span aria-hidden="true">⟳</span>
          实时连接中断，当前为历史报价。
        </span>
      ) : null}
    </div>
  );
}
