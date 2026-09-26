import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { baseStrategyLabel, brokerReportDay, tradierSymbol, clusterReviewGroups, caseUnreviewed, type ReviewFill, type TradingCase, type StrategyCluster } from "@invest/domain";
import type { StorageDriver } from "@invest/storage";
import { availableReviewFills } from "./trading-review.js";

/** Pair within an account/instrument. Day-only opposite fills stay in a single
 * quantity-balanced group: their intraday order is deliberately not invented. */
export function pairedReviewFills(fills: ReviewFill[]): ReviewFill[][] {
  const groups = new Map<string, ReviewFill[]>();
  for (const f of fills.filter(f => f.source !== "manual" && f.environment !== "sandbox")) {
    const key = JSON.stringify([f.instrumentKey, f.currency]);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const result: ReviewFill[][] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (brokerReportDay(a.occurredAt) ?? "").localeCompare(brokerReportDay(b.occurredAt) ?? "") || a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    let batch: ReviewFill[] = [], balance = new Decimal(0), valid = true;
    for (let i = 0; i < group.length;) {
      const first = group[i]!, day = brokerReportDay(first.occurredAt);
      const sameDay = group.filter(f => brokerReportDay(f.occurredAt) === day);
      const ambiguous = sameDay.some(f => f.timePrecision === "day");
      const unit = ambiguous ? sameDay : [first];
      i += unit.length;
      if (!day || unit.some(f => !new Decimal(f.quantity).gt(0))) { valid = false; break; }
      if (!ambiguous) {
        const change = new Decimal(first.quantity).mul(first.side === "buy" ? 1 : -1);
        const effect = first.positionEffect ?? first.provenance?.action;
        if (effect === "close" && (balance.isZero() || balance.isPositive() === change.isPositive() || balance.abs().lt(change.abs()))) valid = false;
        if (effect === "open" && !balance.isZero() && balance.isPositive() !== change.isPositive()) valid = false;
        if (!balance.isZero() && balance.isPositive() !== change.isPositive() && change.abs().gt(balance.abs())) valid = false;
      } else if (balance.isZero() && unit.every(f => (f.positionEffect ?? f.provenance?.action) === "close")) valid = false;
      batch.push(...unit);
      balance = unit.reduce((n, f) => n.plus(new Decimal(f.quantity).mul(f.side === "buy" ? 1 : -1)), balance);
      if (balance.isZero()) { if (valid && batch.some(f => f.side !== batch[0]!.side)) result.push(batch); batch = []; valid = true; }
    }
    // Keep open groups only when their initial entry is explicitly identified.
    if (valid && batch.length && (batch[0]!.positionEffect ?? batch[0]!.provenance?.action) === "open") result.push(batch);
  }
  return result;
}
const queues = new WeakMap<StorageDriver, Promise<void>>();
export const AUTO_STRATEGY = "自动开平仓配对（意图待复盘）";
const autoCaseId = (fills: ReviewFill[]) => "auto-case-" + createHash("sha256").update(JSON.stringify(fills.map(f => f.id).sort())).digest("hex");
const clusterTitle = (cluster: StrategyCluster, first: ReviewFill) => `${first.sourceLabel ?? first.source.toUpperCase()} · ${cluster.underlying} · ${cluster.structure.recognized ? baseStrategyLabel(cluster.structure.label) : `${cluster.groups.length} 腿组合`} · ${brokerReportDay(first.occurredAt)}`;

/** Creates and extends automatic cases from pairing cycles; multi-leg clusters with order, same-second or
 * broker-flagged same-day structure evidence become one case, and earlier unreviewed auto cases are merged once such evidence appears. */
export function syncAutomaticTradingCases(storage: StorageDriver): Promise<void> {
  const run = (queues.get(storage) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const [fills, cases] = await Promise.all([availableReviewFills(storage), storage.getTradingCases()]);
    const owners = new Map(cases.flatMap(c => c.fills.map(f => [f.id, c.id] as const)));
    const byId = new Map(cases.map(c => [c.id, c]));
    const appendTo = async (owner: TradingCase, unowned: ReviewFill[], now: string, basis?: string) => {
      await storage.updateTradingCase(owner.id, current => {
        for (const f of unowned) if (!current.fillIds.includes(f.id)) current.fills.push(f);
        current.fillIds = current.fills.map(f => f.id); current.updatedAt = now;
        if (basis) current.pairingBasis = basis;
        current.linkHistory.push({ recordedAt: now, fillIds: unowned.map(f => f.id), historyComplete: current.historyComplete });
        return current;
      });
      for (const f of unowned) owners.set(f.id, owner.id);
    };
    const createCase = async (group: ReviewFill[], title: string, now: string, basis?: string) => {
      const id = autoCaseId(group);
      const entry: TradingCase = { id, title, strategy: AUTO_STRATEGY, horizon: "unspecified", instrumentType: group.some(f => /\d{6}[CP]\d{8}$/.test(tradierSymbol(f.symbol))) ? "option" : "stock",
        fillIds: group.map(f => f.id), historyComplete: true, fills: group, createdAt: now, updatedAt: now, plans: [], evidence: [], events: [], assessments: [],
        linkHistory: [{ recordedAt: now, fillIds: group.map(f => f.id), historyComplete: true }], ...(basis ? { pairingBasis: basis } : {}) };
      await storage.createTradingCase(entry); cases.push(entry); byId.set(id, entry);
      for (const f of group) owners.set(f.id, id);
    };
    const perGroup = async (group: ReviewFill[]) => {
      const ownerIds = new Set(group.flatMap(f => owners.has(f.id) ? [owners.get(f.id)!] : []));
      const unowned = group.filter(f => !owners.has(f.id));
      if (!unowned.length || ownerIds.size > 1 || group.length > 200) return;
      const now = new Date().toISOString();
      if (ownerIds.size === 1) {
        const owner = byId.get([...ownerIds][0]!)!;
        // Append only to a case whose existing fills are all part of this cycle.
        // Existing multi-leg strategies and user grouping remain intact.
        if (!owner.fills.every(f => group.some(g => g.id === f.id))) return;
        await appendTo(owner, unowned, now);
        return;
      }
      const first = group[0]!, symbol = tradierSymbol(first.symbol);
      await createCase(group, `${first.sourceLabel ?? first.source.toUpperCase()} · ${symbol} · ${brokerReportDay(first.occurredAt)}`, now);
    };
    for (const cluster of clusterReviewGroups(pairedReviewFills(fills))) {
      if (cluster.groups.length === 1 || !cluster.autoMerge) { for (const group of cluster.groups) await perGroup(group); continue; }
      const clusterFills = cluster.groups.flat();
      if (clusterFills.length > 200) { for (const group of cluster.groups) await perGroup(group); continue; }
      const now = new Date().toISOString();
      const first = [...clusterFills].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0]!;
      const involved = [...new Set(clusterFills.flatMap(f => owners.has(f.id) ? [owners.get(f.id)!] : []))].map(id => byId.get(id)!);
      const unowned = clusterFills.filter(f => !owners.has(f.id));
      if (!involved.length) { await createCase(clusterFills, clusterTitle(cluster, first), now, cluster.basis); continue; }
      // Only unreviewed automatic cases that lie entirely inside the cluster may be merged without user consent.
      const mergeable = involved.every(c => caseUnreviewed(c) && c.strategy === AUTO_STRATEGY && c.fills.every(f => clusterFills.some(g => g.id === f.id)));
      if (!mergeable) { for (const group of cluster.groups) await perGroup(group); continue; }
      const [target, ...sources] = [...involved].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (sources.length) {
        const merged = await storage.mergeTradingCases(target!.id, sources.map(s => s.id), (t, srcs) => {
          const moved: string[] = [];
          for (const source of srcs) for (const fill of source.fills) if (!t.fills.some(f => f.id === fill.id)) { t.fills.push(fill); moved.push(fill.id); }
          t.fillIds = t.fills.map(f => f.id); t.historyComplete = t.historyComplete && srcs.every(s => s.historyComplete);
          t.title = clusterTitle(cluster, first); t.pairingBasis = `自动合并：${cluster.basis}`; t.updatedAt = now;
          t.linkHistory.push({ recordedAt: now, fillIds: moved, historyComplete: t.historyComplete, mergedFrom: srcs.map(s => ({ id: s.id, title: s.title, fillIds: s.fillIds })) });
          return t;
        });
        if (!merged) continue;
        for (const source of sources) { byId.delete(source.id); const index = cases.findIndex(c => c.id === source.id); if (index >= 0) cases.splice(index, 1); }
        byId.set(merged.id, merged); cases[cases.findIndex(c => c.id === merged.id)] = merged;
        for (const f of merged.fills) owners.set(f.id, merged.id);
      }
      if (unowned.length) await appendTo(byId.get(target!.id)!, unowned, now, `自动合并：${cluster.basis}`);
    }
  });
  queues.set(storage, run); return run;
}
