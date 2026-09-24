import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageDriver } from "@invest/storage";
import { tradingCaseMetrics, weeklyReviewMetrics, effectivePlanTiming, catalystExample, reviewContent,
  PersonalReviewRuleSchema, type TradingCase, type ReviewFill, type StatementImport } from "@invest/domain";
import { tradingReviewRequest } from "../../apps/server/src/trading-review.js";
import { syncAutomaticTradingCases } from "../../apps/server/src/auto-trading-review.js";
import { handleRequest } from "../../apps/server/src/app.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const fill = (id: string, side: "buy" | "sell", price: string, at = "2026-09-02T14:30:00.000Z", leg = "leg-a"): ReviewFill => ({ id, transactionId: id, source: "manual", instrumentKey: leg, symbol: "TEST", side, quantity: "1", price, feeCost: "1", multiplier: "1", currency: "USD", occurredAt: at, timePrecision: "instant" });
const makeCase = (fills: ReviewFill[], id = "case-1"): TradingCase => ({ id, title: id, strategy: "test-strategy", horizon: "swing", instrumentType: "stock", fillIds: fills.map(f => f.id), historyComplete: true, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z", fills, plans: [], evidence: [], events: [], assessments: [], linkHistory: [] });
const range = { weekStart: "2026-08-31", weekEnd: "2026-09-06", timezone: "America/New_York" };
const plan = { previousPlanId: null, changeReason: "initial", thesis: "Evidence at entry", invalidation: "Thesis invalid", exitConditions: "Close after catalyst", plannedRiskAmount: "10", riskCurrency: "USD", deadlineAt: null, overnightPlan: "", addConditions: "", riskMethodIds: [], evidenceIds: [], rule: null };

describe("strategy review financial boundaries", () => {
  it("counts a closed multi-leg strategy once and keeps partial exits out of wins", () => {
    const entry = makeCase([fill("a", "buy", "100"), fill("b", "sell", "80", undefined, "leg-b"), fill("c", "sell", "120", "2026-09-03T14:30:00.000Z"), fill("d", "buy", "85", "2026-09-03T14:30:00.000Z", "leg-b")]);
    expect(tradingCaseMetrics(entry)).toMatchObject({ state: "closed", netPnl: "11", rMultiple: null });
    const partial = makeCase(entry.fills.slice(0, 3), "partial");
    expect(tradingCaseMetrics(partial)).toMatchObject({ state: "open", netPnl: null });
    const weekly = weeklyReviewMetrics([entry, partial], range);
    expect(weekly.groups[0]).toMatchObject({ completed: 1, wins: 1, winRate: "100", payoffRatio: null, meanNetPnl: "11" });
    expect(weekly.openCaseIds).toEqual(["partial"]);
  });
  it("includes flat samples, separates currencies, and computes expectancy from completed net P&L", () => {
    const win = makeCase([fill("a", "buy", "100"), fill("b", "sell", "112")], "win");
    const loss = makeCase([fill("c", "buy", "100"), fill("d", "sell", "92")], "loss");
    const flat = makeCase([fill("e", "buy", "100"), fill("f", "sell", "102")], "flat");
    const eur = makeCase(win.fills.map(f => ({ ...f, currency: "EUR" })), "eur");
    const m = weeklyReviewMetrics([win, loss, flat, eur], range);
    expect(m.groups).toHaveLength(2);
    expect(m.groups[0]).toMatchObject({ completed: 3, wins: 1, losses: 1, flat: 1, payoffRatio: "1", meanNetPnl: "0" });
    expect(Number(m.groups[0]!.winRate)).toBeCloseTo(100/3);
  });
  it("does not manufacture R from revised, zero, missing, backfilled or incompatible risk", () => {
    const entry = makeCase([fill("a", "buy", "100"), fill("b", "sell", "122")]);
    entry.plans.push({ ...plan, id: "p1", recordedAt: "2026-09-01T10:00:00.000Z", recordingTiming: "before_entry" });
    expect(tradingCaseMetrics(entry).rMultiple).toBe("2");
    entry.plans.push({ ...entry.plans[0]!, id: "p2", plannedRiskAmount: "5" });
    expect(tradingCaseMetrics(entry).rMultiple).toBe("2");
    entry.plans[0]!.recordedAt = "2026-09-03T10:00:00.000Z";
    expect(tradingCaseMetrics(entry).rMultiple).toBeNull();
    expect(effectivePlanTiming(entry.plans[0]!, entry.fills)).toBe("backfilled");
    entry.plans[0]!.recordedAt = "2026-09-01T10:00:00.000Z"; entry.plans[0]!.plannedRiskAmount = null;
    expect(tradingCaseMetrics(entry).rMultiple).toBeNull();
    expect(PersonalReviewRuleSchema.safeParse({ exampleId: null, enabled: true, scope: "", trigger: "", basis: "", action: "", priority: "normal" }).success).toBe(false);
  });
  it("requires full amounts and history, handles date-only and timezone boundaries without invented marks", () => {
    const entry = makeCase([fill("a", "buy", "100", "2026-08-20T23:00:00.000Z"), fill("b", "sell", "110", "2026-09-01T02:00:00.000Z")]);
    expect(weeklyReviewMetrics([entry], { weekStart: "2026-08-31", weekEnd: "2026-08-31", timezone: "America/New_York" }).groups).toHaveLength(1);
    entry.fills[0]!.multiplier = null;
    expect(tradingCaseMetrics(entry)).toMatchObject({ state: "closed", netPnl: null });
    expect(weeklyReviewMetrics([entry], range).groups).toHaveLength(0);
    entry.historyComplete = false;
    expect(tradingCaseMetrics(entry).state).toBe("incomplete");
    entry.historyComplete = true; entry.fills[0]!.multiplier = "1";
    entry.fills.forEach(f => { f.timePrecision = "broker-local"; f.occurredAt = "20260901;093000"; });
    expect(weeklyReviewMetrics([entry], range).groups).toHaveLength(0);
  });
  it("50/25/25 preserves initial quantities, distinguishes cash from profit and refuses fractional contracts", () => {
    expect(catalystExample("10", "2", "100", true)).toMatchObject({ quantities: ["5", "2.5", "2.5"], validUnits: false, firstCash: "2000", firstRealized: "1000", cumulativeCash: "3500", cumulativeRealized: "2000", tailCost: "500", tailZeroFinalPnl: "1500" });
    expect(catalystExample("12", "2", "100", true).validUnits).toBe(true);
    expect(() => catalystExample("-1", "2", "1", false)).toThrow();
  });
});

describe("review storage and API", () => {
  it.each(["node-sqlite", "better-sqlite3"] as const)("keeps immutable plans, atomic ownership and idempotent imports with %s", async kind => {
    const dir = await mkdtemp(join(tmpdir(), "invest-review-")); dirs.push(dir);
    const storage = createStorageDriver(kind, join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      const entry = makeCase([fill("a", "buy", "100"), fill("b", "sell", "112")]);
      await storage.createTradingCase(entry);
      const call = (action: string, body: unknown) => tradingReviewRequest("POST", `/api/trading-review/cases/${entry.id}/${action}`, body, storage);
      const p1 = await call("plans", plan); expect(p1.status).toBe(200);
      const savedPlan = (await storage.getTradingCases())[0]!.plans[0]!;
      expect(savedPlan.recordingTiming).toBe("backfilled");
      expect((await call("plans", plan)).status).toBe(409);
      const next = { ...plan, previousPlanId: savedPlan.id, changeReason: "New evidence" };
      const concurrent = await Promise.all([call("plans", next), call("plans", next)]);
      expect(concurrent.map(r => r.status).sort()).toEqual([200, 409]);
      expect((await storage.getTradingCases())[0]!.plans[0]).toEqual(savedPlan);
      expect((await call("plans", { ...next, recordedAt: "2020-01-01" })).status).toBe(400);
      expect((await call("evidence", { title: "bad", facts: "bad", interpretation: "", sourceUrl: "javascript:alert(1)", availableAt: null, newsId: null, researchId: null })).status).toBe(400);
      expect((await call("events", { occurredAt: null, logicStatus: "valid", observation: "test", action: "test", evidenceIds: ["missing"] })).status).toBe(409);
      const exportResult = await tradingReviewRequest("GET", `/api/trading-review/cases/${entry.id}/export`, undefined, storage);
      expect(JSON.stringify(exportResult.body)).not.toContain('"transactionId"');
      await expect(storage.createTradingCase(makeCase([entry.fills[0]!], "other"))).rejects.toThrow("同一成交");
      expect(await storage.getTradingCases()).toHaveLength(1);
      const importedCase = makeCase([fill("import-a", "buy", "10")], "import-case");
      const statement: StatementImport = { id: "file-sha", fileName: "sample.pdf", sha256: "file-sha", broker: "test", importedAt: "2026-09-05", fills: importedCase.fills, grossTotal: "10", netCash: "-11", feesTotal: "1", notes: [] };
      expect(await storage.importStatements([statement], [importedCase])).toEqual({ files: 1, cases: 1 });
      expect(await storage.importStatements([statement], [importedCase])).toEqual({ files: 0, cases: 0 });
      await storage.migrate(); expect(await storage.getStatementImports()).toHaveLength(1);
      expect(await storage.getTradingCases()).toHaveLength(2);
      await expect(storage.importStatements([{ ...statement, id: "file-conflict" }], [makeCase([entry.fills[0]!], "conflict")])).rejects.toThrow();
      expect(await storage.getStatementImports()).toHaveLength(1);
      const weekInput = { ...range, goodCaseId: null, mistakeCaseId: null, riskyWinCaseId: null, findings: "本周宏观变化", marketImpact: "市场影响", opportunities: "条件判断", macroStudy: "来源证据", upcomingEvents: "", reading: "", englishTerms: "", recovery: "", keyEvents: [{ title: "下周事件", scheduledAt: "2026-09-08T12:30:00Z", timezone: "UTC", impact: "观察利率", sourceUrl: "https://www.federalreserve.gov/" }] };
      expect((await tradingReviewRequest("POST", "/api/trading-review/weekly", weekInput, storage)).status).toBe(201);
      const savedWeek = (await storage.getWeeklyReviews())[0]!;
      expect(savedWeek).toMatchObject({ marketImpact: "市场影响", opportunities: "条件判断", keyEvents: weekInput.keyEvents, brokerFills: [] });
      expect(savedWeek.caseSnapshots).toHaveLength(2);
      await storage.createTradingCase(makeCase([fill("later-fill", "buy", "3")], "later-case"));
      await storage.migrate();
      expect((await storage.getWeeklyReviews())[0]!.caseSnapshots).toHaveLength(2);
    } finally { await storage.close(); }
  });
  it("edits case profiles with history and merges unreviewed cases atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "invest-review-")); dirs.push(dir);
    const storage = createStorageDriver("node-sqlite", join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      const target = makeCase([fill("a", "buy", "100"), fill("b", "sell", "112")], "target");
      const legB = makeCase([fill("c", "sell", "50", undefined, "leg-b"), fill("d", "buy", "40", "2026-09-03T14:30:00.000Z", "leg-b")], "auto-case-leg-b");
      const reviewed = makeCase([fill("e", "buy", "1")], "reviewed");
      for (const entry of [target, legB, reviewed]) await storage.createTradingCase(entry);
      const call = (id: string, action: string, body: unknown) => tradingReviewRequest("POST", `/api/trading-review/cases/${id}/${action}`, body, storage);
      expect((await call("reviewed", "assessments", { curveIds: [], psychologyIds: [], planQuality: "unknown", executionQuality: "unknown", findings: "结论", nextBehavior: "改进", evidenceIds: [] })).status).toBe(200);
      const profile = await call("target", "profile", { title: "黄金 ETF 波段", strategy: "催化剂", horizon: "position", instrumentType: "stock" });
      expect(profile.status).toBe(200);
      expect((profile.body as { entry: TradingCase }).entry).toMatchObject({ title: "黄金 ETF 波段", strategy: "催化剂", horizon: "position", profileHistory: [{ title: "target", strategy: "test-strategy", horizon: "swing", instrumentType: "stock" }] });
      expect((await call("target", "profile", { title: "黄金 ETF 波段", strategy: "催化剂", horizon: "position", instrumentType: "stock" })).status).toBe(200);
      expect((await storage.getTradingCases()).find(c => c.id === "target")!.profileHistory).toHaveLength(1);
      expect((await call("target", "profile", { title: "", strategy: "x", horizon: "swing", instrumentType: "stock" })).status).toBe(400);
      expect((await call("target", "profile", { title: "x", strategy: "x", horizon: "swing", instrumentType: "stock", fillIds: [] })).status).toBe(400);
      for (const sourceCaseIds of [["reviewed"], ["target"], ["missing"], ["auto-case-leg-b", "reviewed"]]) expect((await call("target", "merge", { sourceCaseIds })).status).toBe(409);
      expect((await storage.getTradingCases()).map(c => c.id).sort()).toEqual(["auto-case-leg-b", "reviewed", "target"]);
      const merged = await call("target", "merge", { sourceCaseIds: ["auto-case-leg-b"] });
      expect(merged.status).toBe(200);
      const entry = (merged.body as { entry: TradingCase }).entry;
      expect([...entry.fillIds].sort()).toEqual(["a", "b", "c", "d"]);
      expect(entry.linkHistory.at(-1)).toMatchObject({ fillIds: ["c", "d"], historyComplete: true, mergedFrom: [{ id: "auto-case-leg-b", title: "auto-case-leg-b", fillIds: ["c", "d"] }] });
      expect(tradingCaseMetrics(entry).state).toBe("closed");
      expect((await storage.getTradingCases()).map(c => c.id).sort()).toEqual(["reviewed", "target"]);
      await expect(storage.createTradingCase(makeCase([fill("c", "sell", "1")], "again"))).rejects.toThrow("同一成交");
      await syncAutomaticTradingCases(storage);
      expect((await storage.getTradingCases()).map(c => c.id).sort()).toEqual(["reviewed", "target"]);
      expect((await storage.getTradingCases()).find(c => c.id === "reviewed")!.assessments).toHaveLength(1);
    } finally { await storage.close(); }
  });
  it("requires authentication and CSRF on all review writes", async () => {
    const request = (method: string, headers: Record<string, string>) => Object.assign(Readable.from([]), { method, url: "/api/trading-review/cases", headers });
    let status = 0;
    const response = { set statusCode(v: number) { status = v; }, setHeader() {}, end() {} };
    await handleRequest(request("GET", {}) as never, response as never, { authMode: "token", authToken: "secret", sessions: { isValid: () => false } } as never);
    expect(status).toBe(401);
    await handleRequest(request("POST", {}) as never, response as never, { authMode: "off", authToken: null } as never);
    expect(status).toBe(403);
  });
});

// The illustrated learning package is private; public clones do not ship apps/web/public/trading-review.
it.skipIf(!existsSync("apps/web/public/trading-review/curves"))("imports all original learning cards and keeps each illustration byte-for-byte", async () => {
  expect(reviewContent.curves).toHaveLength(10); expect(reviewContent.psychology).toHaveLength(19); expect(reviewContent.riskMethods).toHaveLength(7);
  expect(reviewContent.ruleExamples).toHaveLength(8); expect(reviewContent.ruleExamples.every(r => !r.enabledByDefault)).toBe(true);
  expect(reviewContent.curves[6]!.authorView).not.toContain("缺正文");
  expect(reviewContent.curves.map(c => c.order)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  for (const curve of reviewContent.curves) {
    const file = await readFile(join(process.cwd(), "apps/web/public/trading-review/curves", curve.image.path.split("/").at(-1)!));
    expect(createHash("sha256").update(file).digest("hex")).toBe(curve.image.sha256);
  }
});
