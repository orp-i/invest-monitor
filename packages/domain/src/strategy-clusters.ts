import { Decimal } from "decimal.js";
import { baseStrategyLabel, identifyStrategy, optionIdentity } from "./trade-direction.js";
import { tradierSymbol } from "./market-data.js";
import { brokerReportDay, reviewExecutionDetails } from "./review-analytics.js";
import type { ReviewFill, TradingCase } from "./trading-review.js";

// Step 2 of automatic matching: group per-contract pairing cycles into one strategy when the broker
// evidence says they belong together. Evidence strength decides what happens:
//   order     – fills share a multi-leg order id              → merge automatically
//   instant   – legs opened (and closed) at the same second    → merge automatically only when the
//               structure is recognized (vertical, straddle, butterfly, condor…)
//   structure – same account, underlying, report day(s), every fill carries a broker open/close flag
//               (closed lots / observed orders) and the legs form a recognized structure → merge automatically;
//               several same-day round trips stay in one case because their pairing across legs is unknown
//   day       – same account, underlying and report day only   → never merged, offered as a suggestion
// Day-precision fills are never ordered or grouped by guesswork; cross-account fills never mix.
export type ClusterEvidence = "order" | "instant" | "structure" | "day";
export interface StrategyCluster {
  groups: ReviewFill[][];
  evidence: ClusterEvidence | null;
  underlying: string;
  accountKey: string;
  structure: { label: string; recognized: boolean; referenceUrl: string | null };
  autoMerge: boolean;
  basis: string;
}
const RANK: Record<ClusterEvidence, number> = { order: 4, instant: 3, structure: 2, day: 1 };
const explicitEffect = (f: ReviewFill) => f.positionEffect ?? f.provenance?.action ?? null;
/** Two same-expiry contracts of one type at different strikes with matching quantities look like a vertical even
 * before open/close flags arrive. Only a hint for the suggestion text; direction stays unverified. */
export function sameDayShapeHint(fills: readonly ReviewFill[]): string | null {
  const ids = fills.map(f => optionIdentity(f.symbol));
  const first = ids[0];
  if (!first || ids.some(i => !i || i.underlying !== first.underlying || i.expiry !== first.expiry)) return null;
  const legs = new Map<string, { type: "C" | "P"; strike: string; bought: Decimal; sold: Decimal }>();
  fills.forEach((f, i) => {
    const id = ids[i]!, leg = legs.get(f.symbol) ?? { type: id.type, strike: id.strike, bought: new Decimal(0), sold: new Decimal(0) };
    if (f.side === "buy") leg.bought = leg.bought.plus(f.quantity); else leg.sold = leg.sold.plus(f.quantity);
    legs.set(f.symbol, leg);
  });
  if (legs.size !== 2) return null;
  const [a, b] = [...legs.values()] as [NonNullable<ReturnType<typeof legs.get>>, NonNullable<ReturnType<typeof legs.get>>];
  if (a.type !== b.type || a.strike === b.strike) return null;
  const closed = a.bought.eq(a.sold) && b.bought.eq(b.sold) && a.bought.eq(b.bought) && a.bought.gt(0);
  const open = (a.sold.isZero() && b.bought.isZero() && a.bought.eq(b.sold) && a.bought.gt(0)) || (a.bought.isZero() && b.sold.isZero() && a.sold.eq(b.bought) && a.sold.gt(0));
  return closed || open ? `形态符合${a.type === "P" ? "认沽" : "认购"}价差（多空方向待核实，缺少开平标记）` : null;
}
const weaker = (a: ClusterEvidence | null, b: ClusterEvidence): ClusterEvidence => a === null ? b : RANK[a] <= RANK[b] ? a : b;
export const fillUnderlying = (fill: ReviewFill): string => optionIdentity(fill.symbol)?.underlying ?? tradierSymbol(fill.symbol);
export const fillAccountKey = (fill: ReviewFill): string => fill.accountKey ?? fill.instrumentKey;

interface GroupFacts {
  index: number; account: string; currency: string; underlying: string; orders: Set<string>;
  openAt: string | null; closeAt: string | null | undefined; openDay: string | null; closeDay: string | null | undefined; instant: boolean; symbol: string;
}
function facts(group: ReviewFill[], index: number): GroupFacts {
  const explicit = group.some(f => f.positionEffect);
  const sorted = [...group].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const opens = explicit ? group.filter(f => f.positionEffect === "open") : [sorted[0]!];
  const closes = explicit ? group.filter(f => f.positionEffect === "close") : sorted.slice(1);
  const single = (rows: ReviewFill[]) => rows.length && rows.every(f => f.timePrecision === "instant" && f.occurredAt === rows[0]!.occurredAt) ? rows[0]!.occurredAt : null;
  const day = (rows: ReviewFill[]) => rows.length && rows.every(f => brokerReportDay(f.occurredAt) === brokerReportDay(rows[0]!.occurredAt)) ? brokerReportDay(rows[0]!.occurredAt) : null;
  return {
    index, account: fillAccountKey(group[0]!), currency: group[0]!.currency, underlying: fillUnderlying(group[0]!), symbol: group[0]!.symbol,
    orders: new Set(group.flatMap(f => f.orderGroupId ? [f.orderGroupId] : [])),
    openAt: single(opens), closeAt: closes.length ? single(closes) : undefined, openDay: day(opens), closeDay: closes.length ? day(closes) : undefined,
    instant: group.every(f => f.timePrecision === "instant"),
  };
}

export function clusterReviewGroups(groups: ReviewFill[][]): StrategyCluster[] {
  const nodes = groups.filter(g => g.length).map(facts);
  const parent = nodes.map((_, i) => i), evidence: (ClusterEvidence | null)[] = nodes.map(() => null);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]!));
  const union = (a: number, b: number, kind: ClusterEvidence) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) { evidence[ra] = weaker(evidence[ra]!, kind); return; }
    parent[rb] = ra; evidence[ra] = weaker(weaker(evidence[ra]!, kind), evidence[rb] ?? kind);
  };
  const compatible = (a: GroupFacts, b: GroupFacts) => a.account === b.account && a.currency === b.currency && a.underlying === b.underlying && a.symbol !== b.symbol;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]!, b = nodes[j]!;
    if (a.account !== b.account || a.currency !== b.currency) continue;
    if ([...a.orders].some(id => b.orders.has(id))) { union(i, j, "order"); continue; }
    if (!compatible(a, b)) continue;
    if (a.instant && b.instant && a.openAt && a.openAt === b.openAt && ((a.closeAt === undefined && b.closeAt === undefined) || (!!a.closeAt && a.closeAt === b.closeAt))) { union(i, j, "instant"); continue; }
    if (a.openDay && a.openDay === b.openDay && ((a.closeDay === undefined && b.closeDay === undefined) || (!!a.closeDay && a.closeDay === b.closeDay))) union(i, j, "day");
  }
  const members = new Map<number, number[]>();
  nodes.forEach((_, i) => { const root = find(i); members.set(root, [...(members.get(root) ?? []), i]); });
  return [...members.entries()].map(([root, indexes]) => {
    const clusterGroups = indexes.map(i => groups[nodes[i]!.index]!);
    let kind = clusterGroups.length > 1 ? evidence[root] : null;
    const fills = clusterGroups.flat();
    const details = reviewExecutionDetails({ fills, historyComplete: false } as TradingCase);
    const strategy = details.strategy;
    const structure = { label: strategy.label, recognized: strategy.referenceUrl !== null, referenceUrl: strategy.referenceUrl };
    const first = nodes[indexes[0]!]!;
    // Day-aligned legs whose every fill carries a broker open/close flag and whose shape is recognized are
    // strong enough to merge; their same-day round trips are not split because cross-leg pairing is unknown.
    const flagged = fills.every(f => explicitEffect(f) !== null);
    if (kind === "day" && flagged && structure.recognized) kind = "structure";
    const autoMerge = kind === "order" || kind === "structure" || (kind === "instant" && structure.recognized);
    const lotCounts = new Set(details.legs.map(l => l.lots));
    const rounds = lotCounts.size === 1 ? [...lotCounts][0]! : 0;
    const hint = kind === "day" ? sameDayShapeHint(fills) : null;
    const basis = kind === null ? "" : kind === "order"
      ? `同一多腿订单的 ${clusterGroups.length} 腿（订单 ${[...new Set(fills.flatMap(f => f.orderGroupId ? [f.orderGroupId] : []))].join("、")}）；${structure.recognized ? `开仓结构识别为“${structure.label}”` : "结构未识别，按券商订单归为一笔策略"}。`
      : kind === "instant"
        ? `${clusterGroups.length} 腿于 ${first.openAt ?? "同一时刻"} 同秒开仓${first.closeAt ? "、同秒平仓" : ""}；${structure.recognized ? `识别为“${structure.label}”，自动合并` : "结构未识别，仅建议合并"}。`
        : kind === "structure"
          ? `同账户、同标的的 ${clusterGroups.length} 腿在 ${first.openDay ?? "同一日"} 同日开仓${first.closeDay ? "、同日平仓" : ""}，开平标记来自券商（已平仓批次 / 当日订单），结构识别为“${baseStrategyLabel(structure.label)}”，自动合并${rounds > 1 ? `；各腿 ${rounds} 个批次，缺少秒级时间未拆分为独立轮次` : ""}。`
          : `同账户、同标的的 ${clusterGroups.length} 个周期在 ${first.openDay ?? "同一日"} 同日开仓${first.closeDay ? "、同日退出" : ""}，但缺少秒级时间与订单号，不自动合并，需人工确认。${hint ? `${hint}；券商开平标记（Tradier 已平仓批次通常 T+1 到达）补齐后可自动识别合并。` : ""}`;
    return { groups: clusterGroups, evidence: kind, underlying: first.underlying, accountKey: first.account, structure, autoMerge, basis };
  });
}

export interface MergeSuggestion { targetCaseId: string; sourceCaseIds: string[]; evidence: ClusterEvidence; structure: string; basis: string; underlying: string }
export const caseUnreviewed = (c: TradingCase) => !c.plans.length && !c.evidence.length && !c.events.length && !c.assessments.length;

/** Existing cases whose fills fall into one evidence cluster but are still split; sources must be unreviewed so a merge loses nothing. */
export function mergeSuggestions(cases: TradingCase[], groups: ReviewFill[][]): MergeSuggestion[] {
  const owners = new Map(cases.flatMap(c => c.fills.map(f => [f.id, c] as const)));
  const suggestions: MergeSuggestion[] = [];
  for (const cluster of clusterReviewGroups(groups)) {
    if (!cluster.evidence) continue;
    const fills = cluster.groups.flat();
    const involved = [...new Set(fills.flatMap(f => owners.has(f.id) ? [owners.get(f.id)!] : []))];
    if (involved.length < 2) continue;
    const inside = (c: TradingCase) => c.fills.every(f => fills.some(g => g.id === f.id));
    const reviewed = involved.filter(c => !caseUnreviewed(c));
    if (reviewed.length > 1) continue;
    const target = reviewed[0] ?? [...involved].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]!;
    const sources = involved.filter(c => c.id !== target.id && caseUnreviewed(c) && inside(c));
    if (!sources.length) continue;
    suggestions.push({ targetCaseId: target.id, sourceCaseIds: sources.map(c => c.id), evidence: cluster.evidence, structure: cluster.structure.label, basis: cluster.basis, underlying: cluster.underlying });
  }
  return suggestions;
}
