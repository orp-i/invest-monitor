import Decimal from "decimal.js";
import type { ConnectionState, Freshness, FreshnessStatus } from "./types";

export function formatDecimal(value: string | null | undefined, scale: number): string {
  if (value === null || value === undefined || value === "") return "—";
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  if (scale === 0) {
    const roundedInteger = fraction.length > 0 && fraction[0] !== undefined && fraction[0] >= "5"
      ? incrementDigits(integer)
      : integer;
    return `${negative ? "-" : ""}${roundedInteger}`;
  }
  let digits = (fraction + "0".repeat(scale)).slice(0, scale);
  if (fraction.length > scale && (fraction[scale] ?? "0") >= "5") {
    const rounded = incrementDigits(integer + digits);
    const splitAt = rounded.length - scale;
    const roundedInteger = rounded.slice(0, splitAt) || "0";
    digits = rounded.slice(splitAt).padStart(scale, "0");
    return `${negative ? "-" : ""}${roundedInteger}.${digits}`;
  }
  return `${negative ? "-" : ""}${integer}.${digits}`;
}

function incrementDigits(value: string): string {
  const chars = value.split("");
  let index = chars.length - 1;
  while (index >= 0 && chars[index] === "9") {
    chars[index] = "0";
    index -= 1;
  }
  if (index < 0) return `1${chars.join("")}`;
  chars[index] = String.fromCharCode(chars[index].charCodeAt(0) + 1);
  return chars.join("");
}

export function formatAge(freshness: Freshness, nowMs: number): string {
  if (freshness.status === "unavailable") return "尚无数据";
  const base = freshness.freshnessBasis === "receivedAt" ? freshness.receivedAt : freshness.capturedAt;
  const ageMs = Math.max(0, nowMs - Date.parse(base));
  if (!Number.isFinite(ageMs)) return "时间未知";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(timestamp);
}

export function formatEpoch(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatTimestamp(new Date(value).toISOString());
}

export function formatRate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return `${new Decimal(value).mul(100).toFixed(2)}%`;
  } catch {
    return value;
  }
}

export function formatMilliseconds(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value} ms`;
}

export function effectiveStatus(
  freshness: Freshness,
  connectionState: ConnectionState,
  sourceHealthStatus?: string,
  nowMs = Date.now(),
): FreshnessStatus {
  if (freshness.status === "unavailable") return "unavailable";
  if (sourceHealthStatus && sourceHealthStatus !== "healthy") return "stale";
  if (connectionState !== "connected") return "stale";
  const base = Date.parse(freshness.tradeReferenceAt || freshness.freshnessBasis === "receivedAt" ? freshness.receivedAt : freshness.capturedAt);
  if (!Number.isFinite(base) || nowMs - base > freshness.staleAfterSeconds * 1000) return "stale";
  return freshness.status;
}

export function formatMoney(value: string | null | undefined, scale = 2): string {
  const formatted = formatDecimal(value, scale);
  const [integer, fraction] = formatted.split(".");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction === undefined ? "" : `.${fraction}`);
}

export function statusLabel(status: FreshnessStatus): string {
  return {
    live: "实时 · LIVE",
    delayed: "延迟 · DELAYED",
    stale: "陈旧 · STALE",
    unavailable: "不可用 · UNAVAILABLE",
  }[status];
}

export function freshnessLabel(freshness: Freshness, status: FreshnessStatus): string {
  if (status === "live" && freshness.tradeReferenceAt && freshness.dataLagMs === 0) return freshness.marketState === "closed" ? "休市 · 最近成交" : "最近成交 · 已同步";
  return statusLabel(status);
}

export function statusIcon(status: FreshnessStatus): string {
  return { live: "●", delayed: "◒", stale: "▲", unavailable: "×" }[status];
}

export function formatMarketTimestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return `${new Intl.DateTimeFormat("zh-CN", {timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(value))} ET`;
}
