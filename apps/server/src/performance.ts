import { createHash } from "node:crypto";
import { accountPerformance, tradierSymbol, performanceSchedule, type PerformanceSample, type BrokerApiId, type BrokerConnectionStatus, type PerformanceScheduleOptions, type PerformanceSlotKind } from "@invest/domain";
import type { AppConfig } from "@invest/config";
import type { StorageDriver } from "@invest/storage";

export async function performanceMarks(storage: StorageDriver, config: AppConfig) {
  const quotes = await storage.getLatestQuotes();
  const tradier = new Set(config.sources.filter(s => s.enabled && s.adapter === "tradier-stocks" && s.capabilities.includes("quote")).map(s => s.id));
  const marks = new Map<string, string>();
  for (const quote of quotes.filter(q => tradier.has(q.sourceId)).sort((a, b) => a.capturedAtMs - b.capturedAtMs)) {
    const instrument = config.instruments.find(i => i.id === quote.instrumentId);
    const binding = instrument?.sourceBindings.find(b => b.sourceId === quote.sourceId && b.quoteAsset === "USD");
    if (binding && quote.quoteAsset === "USD" && quote.price !== null) marks.set(tradierSymbol(binding.providerSymbol), quote.price);
  }
  return marks;
}
export async function currentPerformance(storage: StorageDriver, config: AppConfig) {
  const [accounts, statements, marks] = await Promise.all([storage.getBrokerSnapshots(), storage.getStatementImports(), performanceMarks(storage, config)]);
  const value = accountPerformance(accounts, statements, marks, new Date().toISOString());
  return { ...value, basis: createHash("sha256").update(value.basis).digest("hex") };
}
export async function recordPerformance(storage: StorageDriver, config: AppConfig, scheduledFor: string): Promise<void> {
  const value = await currentPerformance(storage, config);
  if (!value.accounts.length) return;
  const sample: PerformanceSample = { capturedAt: value.capturedAt, scheduledFor, totalNet: value.totalNet, unrealizedNet: value.unrealizedNet, realizedNet: value.realizedNet, fees: value.fees, complete: value.complete, basis: value.basis };
  await storage.savePerformanceSample(sample);
}

export function createPerformanceRecorder(deps: {
  storage: Pick<StorageDriver, "getPerformanceHistory">;
  /** Called before recording; "half-day" slots refresh every configured broker, "session" slots only the live one. */
  refreshBrokers?: (kind: PerformanceSlotKind) => Promise<void>;
  record: (scheduledFor: string) => Promise<void>;
  onRecorded: () => void;
  now?: () => number;
  sessionSchedule?: PerformanceScheduleOptions["sessionSchedule"];
}) {
  const now = deps.now ?? Date.now;
  let task: Promise<void> | null = null, completedSlot: string | null = null, closed = false;
  return {
    runDue(): Promise<void> {
      if (closed) return Promise.resolve();
      if (task) return task;
      const schedule = performanceSchedule(now(), undefined, { sessionSchedule: deps.sessionSchedule }), slot = schedule.latestSlotAt;
      if (slot === completedSlot) return Promise.resolve();
      task = (async () => {
        const last = (await deps.storage.getPerformanceHistory(1)).at(-1);
        // Legacy samples also suppress duplicate recording in their half-day.
        if (!last || Date.parse(last.scheduledFor ?? last.capturedAt) < Date.parse(slot)) {
          if (deps.refreshBrokers) await deps.refreshBrokers(schedule.latestSlotKind);
          await deps.record(slot);
          deps.onRecorded();
        }
        completedSlot = slot;
      })().finally(() => { task = null; });
      return task;
    },
    async close() { closed = true; await task?.catch(() => {}); },
  };
}

export async function refreshPerformanceBrokers(connections: readonly BrokerConnectionStatus[], refresh: (broker: BrokerApiId) => Promise<void>): Promise<void> {
  const failed: string[] = [];
  // Each sync updates shared config/held-instrument metadata. Finish one before
  // starting the other, but still attempt both when one provider fails.
  for (const connection of connections.filter(c => c.configured)) {
    try { await refresh(connection.id); } catch { failed.push(connection.name); }
  }
  if (failed.length) throw new Error(`日 K 等待券商同步成功：${failed.join("、")}`);
}
