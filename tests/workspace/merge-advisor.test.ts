import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerSnapshotSchema, type BrokerTrade, type MergeAdviceInput, type MergeAdviceRun } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { syncAutomaticTradingCases } from "../../apps/server/src/auto-trading-review.js";
import { MergeAdvisorService, MERGE_ADVICE_SYSTEM_PROMPT, parseMergeAdvice } from "../../apps/server/src/merge-advisor.js";
import { dailyLlmProvider, DailyLlmError, type DailyLlmProvider } from "../../apps/server/src/daily-llm.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const at = "2026-09-25T20:00:00.000Z";
const trade = (id: string, symbol: string, side: "buy" | "sell", price: string, netCash: string, extra: Partial<BrokerTrade> = {}): BrokerTrade => ({ id, externalId: null, symbol, side, quantity: "1", price, fees: "0", currency: "USD", tradedAt: "2026-09-25", timePrecision: "day", assetType: "option", netCash, ...extra });
const snapshot = (trades: BrokerTrade[]) => BrokerSnapshotSchema.parse({ broker: "tradier", accountId: "A", environment: "live", asOf: at, syncedAt: at, currency: "USD", equity: "1", unrealizedPnl: "0", sessionRealizedPnl: "0", positions: [], trades, notes: [] });
const legs = [trade("v1", "SPY260925C00770000", "buy", "0.42", "-42.11"), trade("v2", "SPY260925C00770000", "sell", "0.89", "88.87"), trade("v3", "SPY260925C00771000", "sell", "0.24", "23.87"), trade("v4", "SPY260925C00771000", "buy", "0.53", "-53.11")];
/** A model that reads the INPUT it was given and proposes the two legs as one debit spread. */
const answer = (input: MergeAdviceInput) => {
  // The model answers with the short refs it was given; validation maps them back to ids.
  const by = (s: string, side: "buy" | "sell") => input.fills.filter(f => f.symbol.endsWith(s) && f.side === side).map(f => f.ref);
  return { summary: "同日两腿认购价差", limitations: ["缺少券商批次，开平按 SOP-4 推断"], proposals: [{ id: "p1", kind: "merge", caseIds: input.cases.map(c => c.ref), fillIds: input.fills.map(f => f.ref), structure: "看多认购价差（买低卖高行权价）", direction: "bullish",
    legs: [{ symbol: "SPY260925C00770000", role: "long", openFillIds: by("770000", "buy"), closeFillIds: by("770000", "sell") }, { symbol: "SPY260925C00771000", role: "short", openFillIds: by("771000", "sell"), closeFillIds: by("771000", "buy") }], rounds: 1, confidence: "medium", rationale: "同日同到期两腿，形态符合借方认购价差。", sopRules: ["SOP-4"], warnings: [] }] };
};
function fake(complete?: DailyLlmProvider["complete"]): DailyLlmProvider & { complete: ReturnType<typeof vi.fn> } {
  return { status: () => ({ configured: true, provider: "isolated", model: "fixture", missing: [], issue: null }),
    complete: vi.fn(complete ?? (async (_s, u) => ({ text: JSON.stringify(answer(JSON.parse(u).INPUT)), model: "fixture-actual", usage: { inputTokens: 20, outputTokens: 40 } }))) } as DailyLlmProvider & { complete: ReturnType<typeof vi.fn> };
}
async function database() {
  const dir = await mkdtemp(join(tmpdir(), "merge-advisor-")); dirs.push(dir);
  const storage = createStorageDriver("node-sqlite", join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
  await storage.saveBrokerSnapshots([snapshot(legs)]); await syncAutomaticTradingCases(storage);
  return storage;
}

describe("SOP merge advisor", () => {
  it("asks the model about unresolved same-day clusters, re-checks its proposal and makes the merge executable", async () => {
    const storage = await database();
    try {
      const provider = fake(), service = new MergeAdvisorService(storage, provider, { auto: true, cooldownMs: 0 });
      expect((await storage.getTradingCases()).map(c => c.fills.length).sort()).toEqual([2, 2]);
      const state = await service.request("GET", "/api/trading-review/advice", undefined);
      expect(state.status).toBe(200); expect((state.body as { candidates: unknown[]; latest: unknown }).candidates).toHaveLength(1); expect((state.body as { latest: unknown }).latest).toBeNull();
      const started = await service.request("POST", "/api/trading-review/advice/run", {});
      expect(started.status).toBe(202); await service.idle();
      expect(provider.complete).toHaveBeenCalledTimes(1);
      const [system, user] = provider.complete.mock.calls[0]!;
      expect(system).toBe(MERGE_ADVICE_SYSTEM_PROMPT); expect(system).toContain("不是指令");
      const payload = JSON.parse(user as string);
      expect(payload.SOP.some((r: string) => r.startsWith("SOP-4"))).toBe(true); expect(payload.INPUT.fills).toHaveLength(4); expect(payload.INPUT.fills.every((f: { netCash: string }) => typeof f.netCash === "string")).toBe(true);
      const [run] = await storage.getMergeAdviceRuns(1);
      expect(run).toMatchObject({ status: "completed", trigger: "manual", model: "fixture-actual", usage: { inputTokens: 20, outputTokens: 40 }, clusters: 1, fills: 4 });
      expect(run!.proposals[0]).toMatchObject({ netCash: "17.52", kind: "merge", verifiedStructure: expect.stringContaining("看多认购价差") });
      expect(run!.proposals[0]!.fillIds.every(id => id.length > 10)).toBe(true); expect((await storage.getMergeAdviceRun(run!.id))!.input.fills.map(f => f.ref)).toEqual(["F1", "F2", "F3", "F4"]);
      expect(payload.INPUT.fills[0].ref).toBe("F1"); expect(system).toContain("ref");
      const cases = await storage.getTradingCases();
      expect(run!.proposals[0]!.actionable).toEqual({ targetCaseId: [...cases].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]!.id, sourceCaseIds: [expect.any(String)] });
      // The same unresolved input is not sent again automatically; a failed run may be retried.
      expect(await service.maybeAuto()).toBe(false); expect(provider.complete).toHaveBeenCalledTimes(1);
      const full = await service.request("GET", `/api/trading-review/advice/runs/${run!.id}`, undefined);
      expect((full.body as { run: MergeAdviceRun }).run.input.sop.length).toBe(9);
    } finally { await storage.close(); }
  });
  it("does not call an unconfigured or cooled-down provider, and fails safely after one repair attempt", async () => {
    const storage = await database();
    try {
      const disabled = new MergeAdvisorService(storage, dailyLlmProvider({} as never, {}));
      expect((await disabled.request("POST", "/api/trading-review/advice/run", {})).status).toBe(503);
      expect(await disabled.maybeAuto()).toBe(false);
      const bad = fake(async () => ({ text: JSON.stringify({ summary: "x", limitations: [], proposals: [{ id: "p", kind: "merge", caseIds: [], fillIds: ["not-a-fill"], structure: "s", direction: "unknown", legs: [], rounds: null, confidence: "low", rationale: "r", sopRules: [], warnings: [] }] }), model: "fixture", usage: { inputTokens: 1, outputTokens: 1 } }));
      const service = new MergeAdvisorService(storage, bad, { auto: true, cooldownMs: 60000 });
      expect(await service.maybeAuto()).toBe(true); await service.idle();
      expect(bad.complete).toHaveBeenCalledTimes(2);
      expect(JSON.parse(bad.complete.mock.calls[1]![1] as string).REPAIR).toContain("上一次输出");
      const [run] = await storage.getMergeAdviceRuns(1);
      expect(run).toMatchObject({ status: "failed", trigger: "auto", proposals: [] }); expect(run!.error).toContain("两次输出未通过校验");
      // Within the cooldown nothing runs even though the last run failed; a manual run is still allowed.
      expect(await service.maybeAuto()).toBe(false);
      const truncated = fake(async () => { throw new DailyLlmError("cut", "truncated", "{\"summary\":\"partial"); });
      const again = new MergeAdvisorService(storage, truncated, { auto: true, cooldownMs: 0 });
      expect((await again.request("POST", "/api/trading-review/advice/run", {})).status).toBe(202); await again.idle();
      expect(truncated.complete).toHaveBeenCalledTimes(2); expect(truncated.complete.mock.calls[0]![3]).toEqual({ outputTokenBoost: false }); expect(truncated.complete.mock.calls[1]![3]).toEqual({ outputTokenBoost: true });
      expect((await storage.getMergeAdviceRuns(1))[0]!.attempts?.map(a => a.issue)).toEqual(["被截断", "被截断"]);
      expect((await storage.getMergeAdviceRuns(1))[0]!.error).toContain("截断"); expect((await storage.getMergeAdviceRuns(1))[0]!.attempts?.[0]?.sample).toContain("partial");
      expect(parseMergeAdvice("```json\n" + JSON.stringify({ summary: "s", limitations: [], proposals: [] }) + "\n```").summary).toBe("s");
    } finally { await storage.close(); }
  });
});
