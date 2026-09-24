import { z } from "zod";
import { DecimalString } from "./schemas.js";

export const ResearchTopicSchema = z.enum(["treasuries", "gold", "oil", "rates", "inflation", "growth", "trade"]);
export const ResearchOutcomeSchema = z.enum(["pending", "confirmed", "invalidated", "mixed"]);
const safeUrl = z.string().max(2000).refine(value => {
  if (!value) return true;
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
}, "来源链接必须是 http 或 https 地址");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, "日期无效");

export const ResearchWriteSchema = z.object({
  title: z.string().trim().min(1).max(200),
  topic: ResearchTopicSchema,
  facts: z.string().trim().min(1).max(10000),
  thesis: z.string().trim().min(1).max(10000),
  invalidation: z.string().trim().min(1).max(5000),
  sourceUrl: safeUrl.default(""),
  observedOn: day,
  reviewOn: day,
  newsIds: z.array(z.string().min(1).max(200)).max(20).default([]),
  transactionIds: z.array(z.string().min(1).max(300)).max(20).default([]),
}).strict().refine(value => value.reviewOn >= value.observedOn, { message: "验证日期不能早于观察日期", path: ["reviewOn"] });
export type ResearchWrite = z.infer<typeof ResearchWriteSchema>;
export const ResearchReviewSchema = z.object({
  outcome: ResearchOutcomeSchema,
  notes: z.string().trim().min(1).max(10000),
}).strict();
export type ResearchReview = z.infer<typeof ResearchReviewSchema>;
export interface ResearchEntry extends ResearchWrite {
  id: string;
  createdAt: string;
  evidence: { id: string; title: string; url: string }[];
  linkedTrades: { id: string; label: string }[];
  reviews: (ResearchReview & { reviewedAt: string })[];
}

const money = DecimalString.nullable();
export const BrokerTradeSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  quantity: DecimalString,
  price: money,
  fees: money,
  statementFees: money.optional(),
  statementFeeSource: z.string().optional(),
  statementFillId: z.string().optional(),
  netCash: money.optional(),
  totalFees: money.optional(),
  currency: z.string(),
  tradedAt: z.string(),
  timePrecision: z.enum(["day", "broker-local", "instant"]),
  assetType: z.string(),
  multiplier: money.optional(),
  feeCurrency: z.string().nullable().optional(),
  positionEffect: z.enum(["open", "close"]).nullable().optional(),
  realizedPnl: money.optional(),
  grossAmount: money.optional(),
  expirationConfirmation: z.object({
    kind: z.literal("worthless"), recordedAt: z.string().datetime(),
    note: z.string().min(1), openingFillId: z.string().min(1),
  }).optional(),
  // Evidence attached by the broker sync. It never changes price, quantity, fees or the report date:
  // "lot" comes from the broker's closed-lot accounting (dates only), "order" from an order observed
  // during its session (second-level time, leg grouping and explicit open/close side).
  effectSource: z.enum(["order", "lot", "statement"]).nullable().optional(),
  lotId: z.string().nullable().optional(),
  orderId: z.string().nullable().optional(),
  orderGroupId: z.string().nullable().optional(),
  executedAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type BrokerTrade = z.infer<typeof BrokerTradeSchema>;
/** A filled order (or one leg of a multi-leg order) seen while the broker still returned it; persisted so nightly trade history can be matched later. */
export const BrokerOrderObservationSchema = z.object({
  broker: z.enum(["tradier"]), environment: z.enum(["live", "sandbox"]), accountId: z.string().min(1),
  orderId: z.string().min(1), groupId: z.string().nullable(), status: z.string().min(1),
  symbol: z.string().min(1), side: z.enum(["buy", "sell"]), positionEffect: z.enum(["open", "close"]).nullable(),
  quantity: DecimalString, price: money, executedAt: z.string().nullable(), createdAt: z.string().nullable(),
  firstSeenAt: z.string(), lastSeenAt: z.string(),
});
export type BrokerOrderObservation = z.infer<typeof BrokerOrderObservationSchema>;
export const BrokerPositionSchema = z.object({
  id: z.string(), symbol: z.string(), quantity: DecimalString, currency: z.string(),
  costBasis: money, marketValue: money, unrealizedPnl: money,
  assetType: z.string().optional(), multiplier: money.optional(),
  markPrice: money.optional(), averageCost: money.optional(),
});
export type BrokerPosition = z.infer<typeof BrokerPositionSchema>;
export const BrokerSnapshotSchema = z.object({
  broker: z.enum(["tradier", "ibkr", "elephant", "schwab", "alpaca"]),
  accountId: z.string().min(1),
  environment: z.enum(["live", "sandbox", "statement"]),
  syncedAt: z.string(),
  asOf: z.string(),
  currency: z.string().nullable(),
  equity: money,
  unrealizedPnl: money,
  sessionRealizedPnl: money,
  cash: money.optional(),
  reportFrom: z.string().nullable().optional(),
  allocation: z.array(z.object({ assetType: z.string(), value: DecimalString })).optional(),
  positions: z.array(BrokerPositionSchema),
  trades: z.array(BrokerTradeSchema),
  notes: z.array(z.string()),
  sourceStatement: z.object({ fileName: z.string(), sha256: z.string(), page: z.number().int().positive(), reportDate: z.string() }).optional(),
  computedRealizedNet: money.optional(),
  performance: z.object({
    realizedNet: DecimalString, unrealizedNet: DecimalString, totalNet: DecimalString, fees: DecimalString,
    unallocatedFees: DecimalString, from: z.string().nullable(), complete: z.boolean(), missing: z.array(z.string()),
    positions: z.number(), valuedPositions: z.number(),
  }).optional(),
});
export type BrokerSnapshot = z.infer<typeof BrokerSnapshotSchema>;
export interface BrokerSyncAttempt {
  broker: "tradier" | "ibkr" | "schwab" | "alpaca";
  mode: string;
  state: "success" | "error";
  startedAt: string;
  completedAt: string;
  message: string | null;
}
export interface BrokerSyncStatus {
  state: "never" | "running" | "success" | "error";
  startedAt: string | null;
  completedAt: string | null;
  lastSuccessAt: string | null;
  message: string | null;
  accounts: number;
  positions: number;
  trades: number;
}
export interface BrokerConnectionStatus {
  id: "tradier" | "ibkr" | "schwab" | "alpaca";
  name: string;
  configured: boolean;
  missing: string[];
  mode: string;
  /** Read-only sync cadence and provider notes from the broker registry. */
  cadenceMinutes?: number;
  description?: string;
  docsUrl?: string;
  /** OAuth brokers: refresh-token lifetime, so the page can ask for re-authorization before it expires. */
  authorization?: { kind: "oauth"; issuedAt: string | null; expiresAt: string | null; daysLeft: number | null; needsReauthorization: boolean; message: string | null };
  sync?: BrokerSyncStatus;
  /** Extra Tradier read one minute before the regular close, so the session's multi-leg orders are captured. */
  closeSync?: { nextSyncAt: string | null; basis: "calendar" | "weekday-default" | null; lastSyncedDate: string | null; leadMinutes: number };
}
