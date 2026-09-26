import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TradingLesson } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { tradingReviewRequest } from "../../apps/server/src/trading-review.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const lesson = { category: "option", title: "0DTE 认购价差不追开盘前 30 分钟", body: "9/25 两轮 770/771 在开盘波动中追价，第一轮 -20。", trigger: "开盘后 30 分钟内、SPY 波动放大", action: "等待第一根 15 分钟 K 收盘后再开价差", caseIds: [] as string[], tags: ["SPY", "0DTE", "价差"], status: "active" };

describe.each(["node-sqlite", "better-sqlite3"] as const)("trading lessons / %s", driver => {
  it("records categorized lessons, keeps edit history with revision checks, links cases and rejects bad input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lessons-")); dirs.push(dir);
    const storage = createStorageDriver(driver, join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      const call = (method: string, path: string, body?: unknown) => tradingReviewRequest(method, path, body, storage);
      const created = await call("POST", "/api/trading-review/cases", { title: "SPY 0DTE 价差", strategy: "价差", horizon: "intraday", instrumentType: "option", fillIds: [], historyComplete: false });
      expect(created.status).toBe(201);
      const caseId = (created.body as { entry: { id: string } }).entry.id;
      // Invalid category, unknown case and a stranger field are refused before anything is written.
      expect((await call("POST", "/api/trading-review/lessons", { ...lesson, category: "crypto" })).status).toBe(400);
      expect((await call("POST", "/api/trading-review/lessons", { ...lesson, caseIds: ["missing"] })).status).toBe(409);
      expect((await call("POST", "/api/trading-review/lessons", { ...lesson, extra: 1 })).status).toBe(400);
      expect(await storage.getTradingLessons()).toEqual([]);
      const saved = await call("POST", "/api/trading-review/lessons", { ...lesson, caseIds: [caseId] });
      expect(saved.status).toBe(201);
      const first = (saved.body as { lesson: TradingLesson }).lesson;
      expect(first).toMatchObject({ category: "option", revision: 1, history: [], caseIds: [caseId], tags: ["SPY", "0DTE", "价差"], status: "active" });
      await call("POST", "/api/trading-review/lessons", { category: "hedge", title: "指数对冲张数按 Delta 名义算", body: "IWM 认沽价差对冲多头时先算净 Delta。", trigger: "", action: "", caseIds: [], tags: [], status: "active" });
      await call("POST", "/api/trading-review/lessons", { category: "stock", title: "股票只做趋势确认后的回撤", body: "…", trigger: "", action: "", caseIds: [], tags: [] });
      const listed = (await call("GET", "/api/trading-review/lessons")).body as { lessons: TradingLesson[] };
      expect(listed.lessons.map(l => l.category).sort()).toEqual(["hedge", "option", "stock"]);
      expect((((await call("GET", "/api/trading-review")).body) as { lessons: TradingLesson[] }).lessons).toHaveLength(3);
      // An edit keeps the previous version and bumps the revision; a stale revision is refused; unknown ids are 404.
      const edited = await call("POST", `/api/trading-review/lessons/${first.id}`, { ...lesson, caseIds: [caseId], body: "补充：第二轮等待后 +16。", expectedRevision: 1 });
      expect(edited.status).toBe(200);
      const second = (edited.body as { lesson: TradingLesson }).lesson;
      expect(second).toMatchObject({ revision: 2, body: "补充：第二轮等待后 +16。", createdAt: first.createdAt });
      expect(second.history).toHaveLength(1); expect(second.history[0]).toMatchObject({ body: lesson.body, recordedAt: first.updatedAt });
      expect((await call("POST", `/api/trading-review/lessons/${first.id}`, { ...lesson, expectedRevision: 1 })).status).toBe(409);
      expect((await storage.getTradingLessons()).find(l => l.id === first.id)!.revision).toBe(2);
      expect((await call("POST", "/api/trading-review/lessons/nope", { ...lesson, expectedRevision: 1 })).status).toBe(404);
      expect((await call("GET", `/api/trading-review/lessons/${first.id}`)).status).toBe(405);
      // Retiring keeps the record and its history instead of deleting it.
      const retired = await call("POST", `/api/trading-review/lessons/${first.id}`, { ...lesson, caseIds: [caseId], body: second.body, status: "retired", expectedRevision: 2 });
      expect((retired.body as { lesson: TradingLesson }).lesson).toMatchObject({ status: "retired", revision: 3 });
      expect((await storage.getTradingLessons()).filter(l => l.status === "active")).toHaveLength(2);
    } finally { await storage.close(); }
  });
});
