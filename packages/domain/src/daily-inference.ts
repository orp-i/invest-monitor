import { z } from "zod";
import type { MarketDailyReport, MarketDailySummary } from "./market-daily.js";
import type { StudyBar, StudyInstrument } from "./research-market.js";

export const DAILY_HORIZONS = { short: "短线 · 期权", medium: "中线 · 价差与股票", long: "长线 · 股票" } as const;
export const DAILY_REASONING_VERSION = "daily-trend-v3-compact-output";
export const DAILY_TREND_GUIDANCE = "日报记录长周期宏观趋势观点；1–2周是最短操作周期。短线主要期权，中线主要Put/Call Spread与股票，长线主要股票。第5/10交易日用于复核，持有期限按趋势、催化与风险条件判断。点位和幅度作为情景参考，不以精确命中或单日涨跌判定观点对错。";
export const OBSERVATION_STATES = { pending: "待验证", watching: "继续观察", supported: "出现支持", contradicted: "出现反证", mixed: "证据分化", invalidated: "条件失效", closed: "结束跟踪" } as const;
const horizon = z.enum(["short", "medium", "long"]);
const status = z.enum(["pending", "watching", "supported", "contradicted", "mixed", "invalidated", "closed"]);
const text = z.string().trim().min(1).max(2000);
const citations = z.array(z.string().min(1).max(180)).min(1).max(12);
const evidence = z.object({ text, citations }).strict();
export const DailyInferenceOptionsSchema = z.object({
  reportId: z.string().min(1).max(100), expectedRevision: z.number().int().positive(),
  historyDays: z.number().int().min(7).max(180).default(60),
  includePositions: z.boolean().default(true), refreshMarkets: z.boolean().default(true),
  question: z.string().trim().max(2000).default(""),
}).strict();
export type DailyInferenceOptions = z.infer<typeof DailyInferenceOptionsSchema>;
export const DailyInferenceStartSchema = DailyInferenceOptionsSchema.extend({ requestId: z.string().uuid() });
export const DailyInferenceOutputSchema = z.object({
  macro: z.object({
    stance: z.enum(["risk-on", "risk-off", "neutral", "mixed", "unset"]),
    summary: text,
    evolution: z.enum(["strengthening", "weakening", "unchanged", "reversal", "unclear"]),
    historicalComparison: text,
    supporting: z.array(evidence).min(1).max(8), opposing: z.array(evidence).max(8),
  }).strict(),
  decision: z.enum(["observe", "manage-existing", "conditional-opportunity"]),
  rationale: text,
  actions: z.array(z.object({
    horizon, assetId: z.string().min(1).max(100),
    instrument: z.enum(["option", "put-spread", "call-spread", "stock", "portfolio"]),
    action: z.enum(["watch", "hold", "increase", "reduce", "hedge", "exit"]),
    direction: z.enum(["bullish", "bearish", "neutral", "mixed"]),
    expectedHoldingSessions: z.number().int().min(5).max(2520), holdingPeriod: text, thesis: text, trigger: text, invalidation: text, risk: text, positionImpact: text, citations,
  }).strict()).min(1).max(9),
  reviewPlan: z.object({ firstReview: text, secondReview: text, mediumTerm: text, longTerm: text }).strict(),
  newObservations: z.array(z.object({ text, horizon, status: z.enum(["pending", "watching"]), evidence: text, citations }).strict()).max(8),
  observationUpdates: z.array(z.object({ id: z.string().uuid(), status: status.exclude(["closed"]), evidence: text, citations }).strict()).max(60),
  limitations: z.array(text).min(1).max(12),
}).strict();
export type DailyInferenceOutput = z.infer<typeof DailyInferenceOutputSchema>;
export interface DailyObservation {
  id: string; reportId: string; reportDate: string; text: string; horizon: keyof typeof DAILY_HORIZONS;
  status: keyof typeof OBSERVATION_STATES; evidence: string; citations: string[];
  origin: "user" | "llm"; lastRunId: string | null; revision: number; createdAt: string; updatedAt: string;
}
export const DailyObservationEditSchema = z.object({ expectedRevision: z.number().int().positive(), status, evidence: text }).strict();
export const DailyObservationCreateSchema = z.object({ reportId: z.string().min(1).max(100), text, horizon, evidence: z.string().trim().max(2000).default("") }).strict();
export interface InferenceMarket {
  instrument: StudyInstrument; citation: string; fetchedAt: string | null; through: string | null;
  bars: StudyBar[]; warnings: string[];
}
export interface InferencePosition {
  broker: string; accountLabel: string; environment: string; asOf: string; syncedAt: string; symbol: string; quantity: string; currency: string;
  assetType: string; multiplier: string | null; marketValue: string | null; unrealizedPnl: string | null;
  contractDirection: string; marketDirection: string; directionLabel: string; underlying: string;
}
export interface DailyInferenceInput {
  schemaVersion: 1; promptVersion: string; reportAsOf: string; assembledAt: string;
  reportDate: string; anchorCitation: string; historyFrom: string;
  reports: (MarketDailyReport & { citation: string })[];
  markets: InferenceMarket[];
  positions: { included: boolean; citation: string; capturedAt: string; rows: InferencePosition[] };
  observations: DailyObservation[]; question: string; warnings: string[];
}
export interface DailyLlmRouteProbe {
  profile: "direct" | "vpn" | "corp"; attempts: number; successes: number; medianMs: number | null;
  modelAvailable: boolean | null; httpStatus: number | null; issue: string | null;
}
export interface DailyLlmConnection {
  mode: "auto" | "direct" | "vpn" | "corp"; selected: "direct" | "vpn" | "corp" | null;
  recommended: "direct" | "vpn" | "corp" | null; checkedAt: string | null; expiresAt: string | null;
  probes: DailyLlmRouteProbe[]; note: string;
}
export interface DailyLlmStatus { configured: boolean; provider: string; model: string; missing: string[]; issue: string | null; connection?: DailyLlmConnection }
export interface DailyInferenceRun {
  id: string; reportId: string; reportDate: string; reportRevision: number;
  status: "running" | "completed" | "failed"; createdAt: string; completedAt: string | null;
  options: DailyInferenceOptions; provider: string; model: string; promptVersion: string;
  input: DailyInferenceInput; output: DailyInferenceOutput | null; error: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  connection?: DailyLlmConnection;
  /** One entry per model request; a second entry means the first reply was truncated or malformed and one compact retry was made. */
  attempts?: { startedAt: string; issue: string | null }[];
  observationChanges: { updated: string[]; created: string[]; skipped: string[] };
}
export type DailyInferenceRunSummary = Omit<DailyInferenceRun, "input" | "output"> & { macro: DailyInferenceOutput["macro"] | null; decision: DailyInferenceOutput["decision"] | null };
export interface DailyInferenceState {
  provider: DailyLlmStatus; reports: MarketDailySummary[]; selected: MarketDailyReport | null;
  history: MarketDailySummary[]; historyFrom: string | null; observations: DailyObservation[];
  runs: DailyInferenceRunSummary[]; warnings: string[];
}
export function inferenceRunSummary(run: DailyInferenceRun): DailyInferenceRunSummary {
  const { input: _input, output, ...summary } = run;
  return { ...summary, macro: output?.macro ?? null, decision: output?.decision ?? null };
}
