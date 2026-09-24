import { accountPerformance, withBrokerExecutionDetails, type BrokerApiId, type BrokerConnectionStatus, type BrokerSnapshot, type BrokerSyncAttempt } from "@invest/domain";
import type { StorageDriver } from "@invest/storage";
import type { AppConfig } from "@invest/config";
import { performanceMarks } from "./performance.js";
import { brokerConnections } from "./brokers.js";
import { closeSyncStatus } from "./session-close-sync.js";

export const brokerSyncs = new WeakMap<StorageDriver, Map<string, string>>();
const brokerSyncTasks = new WeakMap<StorageDriver, Map<string, Promise<void>>>();
// Daily recording must await a running manual/background sync, including its
// post-processing, rather than treating the busy flag as a completed refresh.
export function runBrokerSync(storage: StorageDriver, broker: BrokerApiId, work: (startedAt: string) => Promise<void>): Promise<void> {
  const tasks = brokerSyncTasks.get(storage) ?? new Map<string, Promise<void>>();
  brokerSyncTasks.set(storage, tasks);
  const running = tasks.get(broker);
  if (running) return running;
  const active = brokerSyncs.get(storage) ?? new Map<string, string>();
  brokerSyncs.set(storage, active);
  const startedAt = new Date().toISOString(); active.set(broker, startedAt);
  const task = Promise.resolve().then(() => work(startedAt)).finally(() => { tasks.delete(broker); active.delete(broker); });
  tasks.set(broker, task);
  return task;
}
export function describeBrokerSync(connection: BrokerConnectionStatus, accounts: BrokerSnapshot[], attempts: BrokerSyncAttempt[], runningAt?: string): BrokerConnectionStatus {
  const environment = connection.id === "ibkr" ? "statement" : connection.id === "schwab" ? "live" : connection.id === "alpaca" ? (connection.mode === "paper" ? "sandbox" : "live") : connection.mode;
  const matching = accounts.filter(a => a.broker === connection.id && a.environment === environment);
  const attempt = attempts.find(a => a.broker === connection.id && a.mode === connection.mode);
  const lastSuccessAt = attempt?.state === "success" ? attempt.completedAt : matching.map(a => a.syncedAt).sort().at(-1) ?? null;
  return { ...connection, sync: {
    state: runningAt ? "running" : attempt?.state ?? (lastSuccessAt ? "success" : "never"),
    startedAt: runningAt ?? attempt?.startedAt ?? null,
    completedAt: attempt?.completedAt ?? lastSuccessAt,
    lastSuccessAt, message: attempt?.message ?? null,
    accounts: matching.length, positions: matching.reduce((n, a) => n + a.positions.length, 0), trades: matching.reduce((n, a) => n + a.trades.length, 0),
  } };
}
export async function brokerWorkspaceData(storage: StorageDriver, config?: AppConfig, env: NodeJS.ProcessEnv = process.env) {
  const [accounts, attempts, statements] = await Promise.all([storage.getBrokerSnapshots(), storage.getBrokerSyncAttempts(), storage.getStatementImports()]);
  const marks = config ? await performanceMarks(storage, config) : new Map<string, string>();
  const detailed = withBrokerExecutionDetails(accounts, statements);
  const enriched = detailed.map(a => {
    const imports = statements.filter(s => a.broker === "elephant" ? s.broker === "大象" : a.broker === "tradier" && s.broker.toLowerCase() === "tradier" && accounts.filter(x => x.broker === "tradier" && x.environment !== "sandbox").length === 1);
    const performance = accountPerformance([{ ...a, environment: a.environment === "sandbox" ? "live" : a.environment }], a.environment === "sandbox" ? [] : imports, marks, new Date().toISOString());
    return { ...a, computedRealizedNet: performance.realizedNet, performance };
  });
  const closeSync = closeSyncStatus(storage);
  return { accounts: enriched, connections: brokerConnections(env).map(c => ({ ...describeBrokerSync(c, accounts, attempts, brokerSyncs.get(storage)?.get(c.id)), ...(c.id === "tradier" && closeSync ? { closeSync } : {}) })) };
}
