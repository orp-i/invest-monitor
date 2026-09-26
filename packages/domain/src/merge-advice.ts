import { z } from "zod";
import { Decimal } from "decimal.js";
import { identifyStrategy, optionIdentity, type MarketDirection, type StrategyLeg } from "./trade-direction.js";
import { brokerReportDay } from "./review-analytics.js";
import type { ClusterEvidence } from "./strategy-clusters.js";
import type { DailyLlmConnection } from "./daily-inference.js";

// LLM-assisted grouping advice: the model applies the SOP to unresolved same-day clusters and unrecognized
// multi-contract cases, and proposes how fills should be grouped. Everything it returns is re-checked here
// against the fills it was given; money is always recomputed from net cash, never taken from the model.
const text = (max: number) => z.string().trim().min(1).max(max);
const fillId = z.string().trim().min(1).max(300);
export const MergeAdviceOutputSchema = z.object({
  summary: text(800),
  proposals: z.array(z.object({
    id: z.string().trim().min(1).max(60),
    kind: z.enum(["merge", "keep-separate", "split-review"]),
    caseIds: z.array(z.string().trim().min(1).max(300)).max(20),
    fillIds: z.array(fillId).min(1).max(200),
    structure: text(120),
    direction: z.enum(["bullish", "bearish", "neutral", "volatility", "mixed", "unknown"]),
    legs: z.array(z.object({ symbol: z.string().trim().min(1).max(40), role: z.enum(["long", "short"]), openFillIds: z.array(fillId).max(100), closeFillIds: z.array(fillId).max(100) }).strict()).max(8),
    rounds: z.number().int().min(1).max(50).nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    rationale: text(800),
    sopRules: z.array(z.string().trim().max(40)).max(12),
    warnings: z.array(z.string().trim().max(300)).max(8),
  }).strict()).max(20),
  limitations: z.array(z.string().trim().max(300)).max(8),
}).strict();
export type MergeAdviceOutput = z.infer<typeof MergeAdviceOutputSchema>;
export type MergeAdviceProposal = MergeAdviceOutput["proposals"][number];

export interface MergeAdviceFill {
  /** Short handle for the model (F1, F2…); replies may use it or the full id, validation maps both back. */
  ref: string;
  id: string; symbol: string; contract: { underlying: string; expiry: string; type: "C" | "P"; strike: string } | null;
  side: "buy" | "sell"; quantity: string; price: string | null; netCash: string | null; feeCost: string | null; multiplier: string | null;
  day: string | null; timePrecision: "instant" | "day" | "broker-local"; occurredAt: string;
  positionEffect: "open" | "close" | null; lotId: string | null; orderGroupId: string | null;
  broker: string; caseId: string | null; caseTitle: string | null;
}
export interface MergeAdviceCluster { key: string; underlying: string; accountKey: string; evidence: ClusterEvidence | null; structure: string; hint: string | null; caseIds: string[]; fillIds: string[]; reason: string }
export interface MergeAdviceCase { ref: string; id: string; title: string; strategy: string; createdAt: string; userConfirmed: boolean; reviewed: boolean; structure: string; fillIds: string[] }
export interface MergeAdviceInput {
  schemaVersion: 1; sopVersion: string; assembledAt: string; sop: readonly string[];
  clusters: MergeAdviceCluster[]; cases: MergeAdviceCase[]; fills: MergeAdviceFill[]; warnings: string[];
}
export interface MergeAdviceProposalView extends MergeAdviceProposal {
  /** Sum of the proposal's fill net cash (fees included); null when any fill lacks it. Never the model's number. */
  netCash: string | null;
  /** Structure recomputed from the proposed leg roles with identifyStrategy; null when not a recognized structure. */
  verifiedStructure: string | null;
  checks: string[];
  /** Merge that the existing merge endpoint can execute: whole unreviewed cases only, one optional reviewed target. */
  actionable: { targetCaseId: string; sourceCaseIds: string[] } | null;
}
export interface MergeAdviceRun {
  id: string; createdAt: string; completedAt: string | null; status: "running" | "completed" | "failed"; trigger: "auto" | "manual";
  provider: string; model: string; sopVersion: string; promptVersion: string; inputHash: string;
  input: MergeAdviceInput; output: MergeAdviceOutput | null; proposals: MergeAdviceProposalView[]; error: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null; connection?: DailyLlmConnection;
  /** One entry per model request; `sample` keeps the start of a truncated or invalid reply for diagnosis (never used as a result). */
  attempts?: { startedAt: string; issue: string | null; sample?: string | null }[];
}
export type MergeAdviceRunSummary = Omit<MergeAdviceRun, "input"> & { clusters: number; fills: number };
export function mergeAdviceRunSummary(run: MergeAdviceRun): MergeAdviceRunSummary {
  const { input, ...rest } = run;
  return { ...rest, clusters: input.clusters.length, fills: input.fills.length };
}
/** Canonical text of what the model would be asked about; the server hashes it to avoid repeating a paid request. */
export function mergeAdviceFingerprint(input: MergeAdviceInput): string {
  const fills = [...input.fills].sort((a, b) => a.id.localeCompare(b.id)).map(f => [f.id, f.positionEffect, f.lotId, f.orderGroupId, f.caseId, f.timePrecision, f.occurredAt].join("|"));
  const clusters = [...input.clusters].map(c => `${c.key}:${[...c.fillIds].sort().join(",")}`).sort();
  return JSON.stringify({ sop: input.sopVersion, clusters, fills });
}
export class MergeAdviceValidationError extends Error { constructor(message: string, readonly detail: string) { super(message); } }
const sum = (values: (string | null)[]) => values.some(v => v === null) ? null : values.reduce((s, v) => s.plus(v!), new Decimal(0)).toFixed();
/** Re-checks a parsed reply against the input: unknown or duplicated fill ids make the reply invalid (one compact retry);
 * money, balance, structure and merge feasibility are recomputed from the fills. */
export function validateMergeAdvice(output: MergeAdviceOutput, input: MergeAdviceInput): MergeAdviceProposalView[] {
  const fills = new Map(input.fills.map(f => [f.id, f]));
  const cases = new Map(input.cases.map(c => [c.id, c]));
  // Short refs keep the model's output small; both refs and full ids are accepted and normalized to ids.
  const fillRef = new Map(input.fills.map(f => [f.ref, f.id]));
  const caseRef = new Map(input.cases.map(c => [c.ref, c.id]));
  const toFill = (v: string) => fillRef.get(v) ?? v, toCase = (v: string) => caseRef.get(v) ?? v;
  const views: MergeAdviceProposalView[] = [];
  for (const raw of output.proposals) {
    const proposal: MergeAdviceProposal = { ...raw, fillIds: raw.fillIds.map(toFill), caseIds: [...new Set(raw.caseIds.map(toCase))], legs: raw.legs.map(l => ({ ...l, openFillIds: l.openFillIds.map(toFill), closeFillIds: l.closeFillIds.map(toFill) })) };
    const ids = new Set(proposal.fillIds);
    if (ids.size !== proposal.fillIds.length) throw new MergeAdviceValidationError("模型输出重复引用成交", `proposal ${proposal.id} 重复成交 id`);
    const unknown = proposal.fillIds.filter(id => !fills.has(id));
    if (unknown.length) throw new MergeAdviceValidationError("模型引用了不存在的成交", `proposal ${proposal.id} 未知成交 ${unknown.slice(0, 3).join("、")}`);
    for (const leg of proposal.legs) for (const id of [...leg.openFillIds, ...leg.closeFillIds]) if (!ids.has(id)) throw new MergeAdviceValidationError("模型的腿引用了建议之外的成交", `proposal ${proposal.id} 腿 ${leg.symbol} 引用 ${id}`);
    const rows = proposal.fillIds.map(id => fills.get(id)!);
    const checks: string[] = [];
    const netCash = sum(rows.map(f => f.netCash));
    // Balance per contract from the fills themselves.
    const balance = new Map<string, Decimal>();
    for (const f of rows) balance.set(f.symbol, (balance.get(f.symbol) ?? new Decimal(0)).plus(new Decimal(f.quantity).mul(f.side === "buy" ? 1 : -1)));
    const open = [...balance].filter(([, q]) => !q.isZero());
    checks.push(open.length ? `尚有未平仓合约：${open.map(([s, q]) => `${s} ${q.toFixed()}`).join("、")}` : "各合约买卖数量已平衡（已平仓）");
    // Structure recomputed from the model's leg roles; a mismatch is reported, not silently accepted.
    let verifiedStructure: string | null = null;
    if (proposal.legs.length) {
      const legs: StrategyLeg[] = proposal.legs.map(leg => {
        const opens = leg.openFillIds.map(id => fills.get(id)!);
        const legFills = rows.filter(f => f.symbol === leg.symbol);
        const openingQuantity = (opens.length ? opens : legFills.filter(f => f.side === (leg.role === "long" ? "buy" : "sell"))).reduce((s, f) => s.plus(f.quantity), new Decimal(0)).toFixed();
        const days = new Set(opens.map(f => f.day));
        const multipliers = new Set(legFills.map(f => f.multiplier));
        return { symbol: leg.symbol, direction: leg.role, openingQuantity, multiplier: multipliers.size === 1 ? [...multipliers][0]! : null, openingAt: null,
          openingDay: days.size === 1 ? [...days][0]! : null, openingConfirmed: opens.length > 0, currency: "USD", broker: legFills[0]?.broker ?? "" };
      });
      const identified = identifyStrategy(legs, { sameDayEvidence: true });
      verifiedStructure = identified.referenceUrl ? identified.label : null;
      checks.push(verifiedStructure ? `程序核对结构：${verifiedStructure}` : `程序未能按腿角色核对出标准结构（${identified.label}）`);
      if (verifiedStructure && !proposal.structure.includes(verifiedStructure.split(" · ")[0]!.split("（")[0]!)) checks.push("模型结构名称与程序核对结果不同，以程序核对为准");
    }
    // Merge feasibility through the existing merge endpoint: whole cases only, sources unreviewed.
    let actionable: MergeAdviceProposalView["actionable"] = null;
    if (proposal.kind === "merge") {
      const owners = [...new Set(rows.map(f => f.caseId))];
      if (owners.some(o => o === null)) checks.push("含未归档案的成交，无法通过合并接口一键执行");
      else if (owners.length < 2) checks.push("涉及的成交已在同一档案");
      else {
        const involved = owners.map(id => cases.get(id!)).filter((c): c is MergeAdviceCase => !!c);
        const whole = involved.every(c => c.fillIds.every(id => ids.has(id)));
        const reviewed = involved.filter(c => c.reviewed);
        if (involved.length !== owners.length) checks.push("部分档案信息缺失，无法一键执行");
        else if (!whole) checks.push("建议只覆盖了某些档案的一部分成交，需手动调整");
        else if (reviewed.length > 1) checks.push("多个档案已有复盘记录，不能自动合并");
        else {
          const target = reviewed[0] ?? [...involved].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]!;
          actionable = { targetCaseId: target.id, sourceCaseIds: involved.filter(c => c.id !== target.id).map(c => c.id) };
        }
      }
    }
    views.push({ ...proposal, netCash, verifiedStructure, checks, actionable });
  }
  return views;
}
export const contractOf = (symbol: string): MergeAdviceFill["contract"] => { const o = optionIdentity(symbol); return o ? { underlying: o.underlying, expiry: o.expiry, type: o.type, strike: o.strike } : null; };
export const fillDay = (occurredAt: string): string | null => brokerReportDay(occurredAt);
export type { MarketDirection };
