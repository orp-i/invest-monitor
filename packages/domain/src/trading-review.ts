import { z } from "zod";
import { Decimal } from "decimal.js";
import { reviewContent } from "./review-content.js";

const Money = Decimal.clone({ precision: 40 });
const text = z.string().trim().max(10000);
const required = text.min(1, "请补齐必填内容");
const id = z.string().min(1).max(300);
const ids = z.array(id).max(200).refine(v => new Set(v).size === v.length, "不能重复关联同一记录");
const decimal = z.string().max(80).regex(/^-?\d+(?:\.\d+)?$/, "请输入十进制数值");
const positive = decimal.refine(v => new Money(v).gt(0), "数值必须大于 0");
const instant = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, "日期无效");
const currency = z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/);
const safeUrl = text.refine(v => { try { return !v || ["https:", "http:"].includes(new URL(v).protocol); } catch { return false; } }, "来源链接必须为 http 或 https");
const contentIds = (values: readonly { id: string }[]) => ids.refine(v => v.every(k => values.some(item => item.id === k)), "知识卡引用无效");

export const TradingCaseInputSchema = z.object({
  title: required.max(200), strategy: required.max(200),
  horizon: z.enum(["intraday", "swing", "position", "unspecified"]),
  instrumentType: z.enum(["stock", "option", "crypto", "mixed", "other"]),
  fillIds: ids.default([]), historyComplete: z.boolean().default(false),
}).strict();
export type TradingCaseInput = z.infer<typeof TradingCaseInputSchema>;
/** Editable descriptive fields; every change appends the previous values to profileHistory. */
export const TradingCaseProfileSchema = TradingCaseInputSchema.pick({ title: true, strategy: true, horizon: true, instrumentType: true }).strict();
export type TradingCaseProfile = z.infer<typeof TradingCaseProfileSchema>;
export const TradingCaseMergeSchema = z.object({ sourceCaseIds: z.array(id).min(1).max(20).refine(v => new Set(v).size === v.length, "不能重复选择同一档案") }).strict();

export const PersonalReviewRuleSchema = z.object({
  exampleId: z.string().nullable().refine(v => v === null || reviewContent.ruleExamples.some(r => r.id === v), "规则来源无效"),
  enabled: z.boolean().default(false), scope: text, trigger: text, basis: text, action: text,
  priority: z.enum(["hard", "normal"]),
}).strict().refine(v => !v.enabled || [v.scope, v.trigger, v.basis, v.action].every(Boolean), "采用个人规则前，请补齐适用范围、触发条件、比例基准和动作");
export const TradingPlanInputSchema = z.object({
  previousPlanId: id.nullable(), changeReason: required,
  thesis: required, invalidation: required, exitConditions: required,
  plannedRiskAmount: positive.nullable(), riskCurrency: currency,
  deadlineAt: instant.nullable(), overnightPlan: text, addConditions: text,
  riskMethodIds: contentIds(reviewContent.riskMethods), evidenceIds: ids,
  rule: PersonalReviewRuleSchema.nullable(),
}).strict();
export type TradingPlanInput = z.infer<typeof TradingPlanInputSchema>;
export interface TradingPlan extends TradingPlanInput { id: string; recordedAt: string; recordingTiming: "before_entry" | "backfilled" | "unknown" }
export function effectivePlanTiming(plan: TradingPlan, fills: ReviewFill[]): TradingPlan["recordingTiming"] | "pending" {
  if (!fills.length) return "pending";
  if (fills.some(f => f.timePrecision !== "instant")) return "unknown";
  return fills.every(f => Date.parse(f.occurredAt) > Date.parse(plan.recordedAt)) ? "before_entry" : "backfilled";
}

export const TradingEvidenceInputSchema = z.object({
  title: required.max(300), facts: required, interpretation: text, sourceUrl: safeUrl,
  availableAt: instant.nullable(), newsId: id.nullable(), researchId: id.nullable(),
}).strict();
export type TradingEvidenceInput = z.infer<typeof TradingEvidenceInputSchema>;
export interface TradingEvidence extends TradingEvidenceInput { id: string; recordedAt: string; sourceSnapshot: { title: string; url: string; text: string }[] }
export const TradingEventInputSchema = z.object({
  occurredAt: instant.nullable(), logicStatus: z.enum(["valid", "weakened", "invalid", "unknown"]),
  observation: required, action: required, evidenceIds: ids,
}).strict();
export type TradingEventInput = z.infer<typeof TradingEventInputSchema>;
export interface TradingEvent extends TradingEventInput { id: string; recordedAt: string }
export const TradingAssessmentInputSchema = z.object({
  curveIds: contentIds(reviewContent.curves), psychologyIds: contentIds(reviewContent.psychology),
  planQuality: z.enum(["sound", "incomplete", "unknown"]),
  executionQuality: z.enum(["followed", "deviated", "unknown"]),
  findings: required, nextBehavior: required, evidenceIds: ids,
}).strict();
export type TradingAssessmentInput = z.infer<typeof TradingAssessmentInputSchema>;
export interface TradingAssessment extends TradingAssessmentInput { id: string; recordedAt: string; stage: "provisional" | "retrospective"; basisFillIds: string[]; basisPlanId: string | null }
export interface ReviewFill {
  id: string; transactionId: string; source: "manual" | "tradier" | "ibkr" | "schwab" | "alpaca" | "statement" | "adjustment";
  instrumentKey: string; symbol: string; side: "buy" | "sell"; quantity: string;
  price: string | null; feeCost: string | null; multiplier: string | null; currency: string;
  occurredAt: string; timePrecision: "instant" | "day" | "broker-local";
  sourceLabel?: string;
  netCash?: string | null;
  transactionAliases?: string[];
  positionEffect?: "open" | "close" | null;
  feeCurrency?: string | null;
  realizedPnl?: string | null;
  environment?: "live" | "sandbox" | "statement";
  expirationConfirmation?: { kind: "worthless"; recordedAt: string; note: string; openingFillId: string };
  /** Broker evidence: closed-lot pairing id and multi-leg order group, when the sync could attach them. */
  lotId?: string | null;
  orderGroupId?: string | null;
  /** Same broker account/environment (or manual account, or statement broker); clusters never cross it. */
  accountKey?: string;
  provenance?: { fileName: string; fileSha256: string; page: number; row: number; broker: string; action: "open" | "close"; settlementDate: string; grossAmount: string; netCash: string; feeBreakdown: Record<string, string>; originalTime: string; originalTimezone: string | null };
}
/** Explicit trading lessons the user keeps while trading, in three categories; edits keep the previous version. */
export const LESSON_CATEGORIES = { option: "期权", stock: "股票", hedge: "对冲设置" } as const;
export type LessonCategory = keyof typeof LESSON_CATEGORIES;
export const TradingLessonInputSchema = z.object({
  category: z.enum(["option", "stock", "hedge"]),
  title: required.max(200),
  body: required,
  trigger: text.default(""), action: text.default(""),
  caseIds: ids.default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  status: z.enum(["active", "retired"]).default("active"),
}).strict();
export type TradingLessonInput = z.infer<typeof TradingLessonInputSchema>;
export const TradingLessonUpdateSchema = TradingLessonInputSchema.extend({ expectedRevision: z.number().int().positive() }).strict();
export interface TradingLesson extends TradingLessonInput { id: string; createdAt: string; updatedAt: string; revision: number; history: (TradingLessonInput & { recordedAt: string })[] }
export interface StatementImport {
  id: string; fileName: string; sha256: string; broker: string; importedAt: string;
  fills: ReviewFill[]; grossTotal: string; netCash: string; feesTotal: string; notes: string[];
}
export interface TradingCase extends TradingCaseInput {
  pairingBasis?: string;
  id: string; createdAt: string; updatedAt: string; fills: ReviewFill[];
  plans: TradingPlan[]; evidence: TradingEvidence[]; events: TradingEvent[]; assessments: TradingAssessment[];
  linkHistory: { recordedAt: string; fillIds: string[]; historyComplete: boolean; mergedFrom?: { id: string; title: string; fillIds: string[] }[] }[];
  profileHistory?: (TradingCaseProfile & { recordedAt: string })[];
}
export interface CaseMetrics {
  state: "draft" | "open" | "closed" | "incomplete";
  openedAt: string | null; closedAt: string | null; currency: string | null;
  netPnl: string | null; rMultiple: string | null; missing: string[];
}

/** A strategy is one case, regardless of the number of legs or partial exits. */
export function tradingCaseMetrics(entry: TradingCase): CaseMetrics {
  const fills = entry.fills;
  const sorted = [...fills].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const result: CaseMetrics = { state: fills.length ? "incomplete" : "draft", openedAt: sorted[0]?.occurredAt ?? null, closedAt: null, currency: null, netPnl: null, rMultiple: null, missing: [] };
  if (!fills.length) { result.missing.push("尚未关联成交"); return result; }
  const currencies = new Set(fills.map(f => f.currency));
  if (currencies.size === 1) result.currency = fills[0]!.currency;
  else result.missing.push("包含多币种，未提供汇率，不能合计策略盈亏");
  if (!entry.historyComplete) result.missing.push("尚未确认已关联该策略从首次建仓开始的完整成交");
  const balances = new Map<string, InstanceType<typeof Money>>();
  let net = new Money(0), valid = true;
  for (const fill of fills) {
    balances.set(fill.instrumentKey, (balances.get(fill.instrumentKey) ?? new Money(0)).plus(new Money(fill.quantity).mul(fill.side === "buy" ? 1 : -1)));
    if (fill.netCash != null) { net = net.plus(fill.netCash); continue; }
    if (fill.price === null || fill.feeCost === null || fill.multiplier === null) { valid = false; continue; }
    net = net.plus(new Money(fill.provenance?.grossAmount ?? new Money(fill.quantity).mul(fill.price).mul(fill.multiplier)).mul(fill.side === "sell" ? 1 : -1)).minus(fill.feeCost);
  }
  if (!valid) result.missing.push("部分成交缺少价格、费用或合约乘数，盈亏等待核实");
  const flat = [...balances.values()].every(v => v.isZero());
  if (!flat) {
    result.state = entry.historyComplete ? "open" : "incomplete";
    result.missing.push("尚有未平仓数量，整笔策略不计入胜负");
  } else if (entry.historyComplete) {
    result.state = "closed"; result.closedAt = sorted.at(-1)!.occurredAt;
    if (valid && result.currency) result.netPnl = net.toFixed();
  }
  // The first plan fixes the denominator. Subsequent versions cannot manufacture R.
  const first = entry.plans[0];
  const entryTime = sorted[0]!.timePrecision === "instant" ? Date.parse(sorted[0]!.occurredAt) : NaN;
  if (first?.plannedRiskAmount && new Money(first.plannedRiskAmount).gt(0) && first.riskCurrency === result.currency && first.recordingTiming === "before_entry" && Date.parse(first.recordedAt) < entryTime && result.netPnl !== null) {
    result.rMultiple = new Money(result.netPnl).div(first.plannedRiskAmount).toFixed();
  } else result.missing.push("R 待补：需首次入场前记录的固定风险金额、同币种及精确成交时间");
  return result;
}

export const WeeklyReviewInputSchema = z.object({
  weekStart: day, weekEnd: day,
  timezone: z.string().max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "时区无效"),
  goodCaseId: id.nullable(), mistakeCaseId: id.nullable(), riskyWinCaseId: id.nullable(),
  findings: required, nextTrigger: text.default(""), nextAction: text.default(""), nextCheck: text.default(""),
  macroStudy: text, upcomingEvents: text, reading: text, englishTerms: text, recovery: text,
  marketImpact: text.default(""), opportunities: text.default(""),
  keyEvents: z.array(z.object({ title: required.max(200), scheduledAt: instant.nullable(), timezone: z.string().max(100), impact: text, sourceUrl: safeUrl }).strict()).max(30).default([]),
}).strict().refine(v => v.weekEnd >= v.weekStart && Date.parse(v.weekEnd) - Date.parse(v.weekStart) <= 6 * 86400000, "周报日期范围应为 1–7 天");
export type WeeklyReviewInput = z.infer<typeof WeeklyReviewInputSchema>;
export interface ReviewMetricsGroup {
  currency: string; strategy: string; horizon: string; instrumentType: string;
  completed: number; wins: number; losses: number; flat: number;
  netPnl: string; winRate: string; meanWin: string | null; meanLossAbs: string | null;
  payoffRatio: string | null; meanNetPnl: string; meanR: string | null; rSamples: number;
}
export interface WeeklyReviewMetrics {
  groups: ReviewMetricsGroup[]; closedCaseIds: string[]; openCaseIds: string[]; missing: string[];
  cashFlows: { currency: string; netCash: string | null; fills: number; missingFills: number }[];
}
export interface WeeklyReview extends WeeklyReviewInput { id: string; recordedAt: string; metrics: WeeklyReviewMetrics; caseSnapshots: TradingCase[]; brokerFills?: ReviewFill[] }
export function localReviewDay(value: string, precision: ReviewFill["timePrecision"], timezone: string): string | null {
  if (precision === "broker-local") return null;
  if (precision === "day") return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function weeklyReviewMetrics(cases: TradingCase[], range: Pick<WeeklyReviewInput, "weekStart" | "weekEnd" | "timezone">): WeeklyReviewMetrics {
  const result: WeeklyReviewMetrics = { groups: [], closedCaseIds: [], openCaseIds: [], cashFlows: [], missing: ["本报告仅统计已建立复盘档案的策略；一笔组合计一笔，部分退出不计胜负。", "最大回撤、最大浮盈浮亏及回吐率待补：缺少连续估值与出入金序列。", "本周现金净流入不等于本周已实现盈亏；跨周与部分退出的已实现盈亏未在此分摊。"] };
  const buckets = new Map<string, { entry: TradingCase; metric: CaseMetrics }[]>();
  const cash = new Map<string, { total: InstanceType<typeof Money>; fills: number; missing: number }>();
  const inRange = (day: string | null) => day !== null && day >= range.weekStart && day <= range.weekEnd;
  for (const entry of cases) {
    const metric = tradingCaseMetrics(entry);
    const sorted = [...entry.fills].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const first = sorted[0], last = sorted.at(-1);
    const start = first ? localReviewDay(first.occurredAt, first.timePrecision, range.timezone) : null;
    const end = metric.closedAt && last ? localReviewDay(last.occurredAt, last.timePrecision, range.timezone) : null;
    if (start && start <= range.weekEnd && (!end || end > range.weekEnd)) result.openCaseIds.push(entry.id);
    if (metric.state === "closed" && inRange(end)) {
      result.closedCaseIds.push(entry.id);
      if (metric.netPnl !== null && metric.currency) {
        const key = JSON.stringify([metric.currency, entry.strategy, entry.horizon, entry.instrumentType]);
        buckets.set(key, [...(buckets.get(key) ?? []), { entry, metric }]);
      } else result.missing.push(`${entry.title}：已退出但盈亏数据不足，未计入胜率样本`);
    }
    if (entry.fills.some(f => f.timePrecision === "broker-local")) result.missing.push(`${entry.title}：券商报表缺少可验证时区，相关成交未分配到周报日期`);
    for (const fill of entry.fills) {
      if (!inRange(localReviewDay(fill.occurredAt, fill.timePrecision, range.timezone))) continue;
      if (fill.timePrecision === "day") result.missing.push("仅日期成交沿用券商日期，无法转换到所选时区。");
      const bucket = cash.get(fill.currency) ?? { total: new Money(0), fills: 0, missing: 0 }; cash.set(fill.currency, bucket); bucket.fills++;
      if (fill.netCash != null) { bucket.total = bucket.total.plus(fill.netCash); continue; }
    if (fill.price === null || fill.feeCost === null || fill.multiplier === null) bucket.missing++;
      else bucket.total = bucket.total.plus(new Money(fill.provenance?.grossAmount ?? new Money(fill.quantity).mul(fill.price).mul(fill.multiplier)).mul(fill.side === "sell" ? 1 : -1)).minus(fill.feeCost);
    }
  }
  for (const rows of buckets.values()) {
    const values = rows.map(r => new Money(r.metric.netPnl!));
    const wins = values.filter(v => v.gt(0)), losses = values.filter(v => v.lt(0));
    const sum = (a: InstanceType<typeof Money>[]) => a.reduce((total, v) => total.plus(v), new Money(0));
    const mean = (a: InstanceType<typeof Money>[]) => a.length ? sum(a).div(a.length) : null;
    const meanWin = mean(wins), meanLoss = mean(losses)?.abs() ?? null;
    const rs = rows.filter(r => r.metric.rMultiple !== null).map(r => new Money(r.metric.rMultiple!));
    result.groups.push({ currency: rows[0]!.metric.currency!, strategy: rows[0]!.entry.strategy, horizon: rows[0]!.entry.horizon, instrumentType: rows[0]!.entry.instrumentType,
      completed: rows.length, wins: wins.length, losses: losses.length, flat: rows.length - wins.length - losses.length,
      netPnl: sum(values).toFixed(), winRate: new Money(wins.length).div(rows.length).mul(100).toFixed(),
      meanWin: meanWin?.toFixed() ?? null, meanLossAbs: meanLoss?.toFixed() ?? null,
      payoffRatio: meanWin && meanLoss ? meanWin.div(meanLoss).toFixed() : null,
      meanNetPnl: mean(values)!.toFixed(), meanR: mean(rs)?.toFixed() ?? null, rSamples: rs.length });
  }
  result.cashFlows = [...cash].map(([currency, b]) => ({ currency, netCash: b.missing ? null : b.total.toFixed(), fills: b.fills, missingFills: b.missing }));
  result.missing = [...new Set(result.missing)];
  return result;
}

/** Teaching calculator only: fixed initial debit, no fees or fills are inferred. */
export function catalystExample(quantity: string, debit: string, multiplier: string, wholeUnits: boolean) {
  [quantity, debit, multiplier].forEach(v => positive.parse(v));
  const q = new Money(quantity), p = new Money(debit), m = new Money(multiplier), cost = q.mul(p).mul(m);
  const quantities = [q.mul("0.5"), q.mul("0.25"), q.mul("0.25")];
  return { cost: cost.toFixed(), quantities: quantities.map(v => v.toFixed()),
    validUnits: !wholeUnits || quantities.every(v => v.isInteger()),
    firstPrice: p.mul(2).toFixed(), secondPrice: p.mul(3).toFixed(),
    firstCash: cost.toFixed(), firstRealized: cost.mul("0.5").toFixed(),
    cumulativeCash: cost.mul("1.75").toFixed(), cumulativeRealized: cost.toFixed(),
    tailCost: cost.mul("0.25").toFixed(), tailZeroFinalPnl: cost.mul("0.75").toFixed() };
}
