import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BrokerSnapshotSchema, applyBrokerExpirations, worthlessExpirationTrade, expirationReviewFill, tradingCaseMetrics, accountPerformance, type StatementImport, type TradingCase } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";
import { availableReviewFills } from "../../apps/server/src/trading-review.js";

const at = "2026-09-05T12:00:00.000Z", symbol = "RR260904C00002000";
const opening = { id: "opening", transactionId: "opening", source: "statement" as const, instrumentKey: "rr-position", symbol, side: "buy" as const, quantity: "2", price: "0.13", multiplier: "100", feeCost: "3.02", currency: "USD", occurredAt: "2026-08-26T14:32:00.000Z", timePrecision: "instant" as const,
  provenance: { fileName: "synthetic.pdf", fileSha256: "a".repeat(64), page: 1, row: 1, broker: "大象", action: "open" as const, settlementDate: "2026-08-27", grossAmount: "26", netCash: "-29.02", feeBreakdown: { commission: "3.02" }, originalTime: "2026-08-26T14:32:00.000Z", originalTimezone: "UTC" } };
const account = BrokerSnapshotSchema.parse({ broker: "elephant", accountId: "synthetic", environment: "statement", asOf: "2026-09-03", syncedAt: at, currency: "USD", equity: "100", cash: "98", unrealizedPnl: "-27.02", sessionRealizedPnl: null,
  positions: [{ id: symbol, symbol, quantity: "2", currency: "USD", multiplier: "100", costBasis: "29.02", marketValue: "2", unrealizedPnl: "-27.02", assetType: "OPT" }],
  trades: [{ id: opening.id, externalId: opening.id, symbol, side: "buy", quantity: "2", price: "0.13", grossAmount: "26", multiplier: "100", fees: "3.02", currency: "USD", feeCurrency: "USD", tradedAt: opening.occurredAt, timePrecision: "instant", positionEffect: "open", assetType: "OPT" }], notes: [] });
const statement: StatementImport = { id: "statement", fileName: "synthetic.pdf", sha256: "a".repeat(64), broker: "大象", importedAt: at, fills: [opening], grossTotal: "26", netCash: "-29.02", feesTotal: "3.02", notes: [] };
const entry: TradingCase = { id: "case", title: "RR", strategy: "long call", horizon: "swing", instrumentType: "option", fillIds: [opening.id], historyComplete: true, fills: [opening], createdAt: at, updatedAt: at, plans: [], evidence: [], events: [], assessments: [], linkHistory: [] };

describe("user-confirmed worthless option expiration", () => {
  it("realizes the entire premium and opening fee without changing the original bank report", () => {
    const close = worthlessExpirationTrade(account, opening, "expired", at, "RR期权到期已作废");
    const snapshot = { ...account, trades: [...account.trades, close] }, effective = applyBrokerExpirations(snapshot);
    expect(effective.positions).toHaveLength(0); expect(account.positions).toHaveLength(1);
    expect(effective).toMatchObject({ asOf: "2026-09-03", equity: "100", cash: "98", unrealizedPnl: "0" });
    expect(accountPerformance([effective], [statement], new Map(), at)).toMatchObject({ realizedNet: "-29.02", totalNet: "-29.02", fees: "3.02", unallocatedFees: "0", complete: true });
    expect(tradingCaseMetrics({ ...entry, fills: [opening, expirationReviewFill(close, opening, "elephant")] })).toMatchObject({ state: "closed", closedAt: "2026-09-04", netPnl: "-29.02" });
    const conflict = applyBrokerExpirations({ ...snapshot, asOf: "2026-09-05" });
    expect(conflict.positions).toHaveLength(1); expect(conflict.notes.join()).toContain("差异");
  });
  it("rejects premature expiration and unreconciled inventory", () => {
    expect(() => worthlessExpirationTrade(account, opening, "bad", "2026-09-04T12:00:00.000Z", "confirmation")).toThrow("到期日尚未结束");
    expect(() => worthlessExpirationTrade({ ...account, positions: [{ ...account.positions[0]!, quantity: "3" }] }, opening, "bad", at, "confirmation")).toThrow("不匹配");
  });
  it.each(["node-sqlite", "better-sqlite3"] as const)("persists atomically and survives repeated confirmation/report import with %s", async driver => {
    const dir = await mkdtemp(join(tmpdir(), "option-expiry-")), path = join(dir, "test.sqlite"), storage = createStorageDriver(driver, path);
    // Production runs the CLI in another process. Two separately linked SQLite
    // libraries must not share WAL handles within the same process.
    const record = async (apply: boolean) => JSON.parse((await promisify(execFile)(process.execPath, ["scripts/record-option-expiration.mjs", "--database", path, "--symbol", symbol, "--note", "用户确认到期作废", "--confirm-worthless", ...(apply ? ["--apply"] : [])])).stdout);
    await storage.open(); await storage.migrate();
    try {
      await storage.saveBrokerSnapshots([account]); await storage.importStatements([statement], [entry]);
      expect((await record(false)).mode).toBe("dry-run");
      expect((await storage.getTradingCases())[0]!.fills).toHaveLength(1);
      expect(await record(true)).toMatchObject({ mode: "applied", optionNetPnl: "-29.02", elephantRealizedNet: "-29.02", remainingPositions: 0 });
      expect((await record(true)).mode).toBe("already-recorded");
      const saved = (await storage.getTradingCases())[0]!;
      expect(saved.fills).toHaveLength(2); expect(saved.events).toHaveLength(1);
      expect(saved.fills[0]).toEqual(opening); expect(saved.fills[1]!.source).toBe("adjustment");
      await storage.saveBrokerSnapshots([account]); // Reimporting an older PDF must not reopen it.
      await storage.close(); await storage.open();
      expect((await storage.getBrokerSnapshots())[0]!.positions).toHaveLength(0);
      expect(await availableReviewFills(storage)).toHaveLength(2);
      expect((await storage.getStatementImports())[0]!.fills).toEqual([opening]);
    } finally { await storage.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
