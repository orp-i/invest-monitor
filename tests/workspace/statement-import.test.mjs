import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { prepareStatementImport, summarizeImport, planStatementImport, applyStatementImport } from '../../scripts/import-trade-statements.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const fileSha = sha('synthetic-statement');
const row = (id, symbol, side, action, price, net, time, index) => ({
  id: sha(id), transactionId: 'statement:' + sha(id), source: 'statement', sourceLabel: '大象 · 结单',
  instrumentKey: sha(symbol), symbol, side, quantity: '1', price, feeCost: '1', multiplier: '100', currency: 'USD',
  occurredAt: time, timePrecision: 'instant',
  provenance: { fileName: 'synthetic.pdf', fileSha256: fileSha, page: 2, row: index, broker: '大象', action, settlementDate: '2026-09-04', grossAmount: String(Number(price) * 100), netCash: net, feeBreakdown: { commission: '1' }, originalTime: time, originalTimezone: 'Asia/Hong_Kong' },
});
function fixture() {
  const fills = [row('a', 'TEST260918P00100000', 'buy', 'open', '2', '-201', '2026-09-02T14:30:00.000Z', 1),
    row('b', 'TEST260918P00095000', 'sell', 'open', '1', '99', '2026-09-02T14:30:00.000Z', 2),
    row('c', 'TEST260918P00100000', 'sell', 'close', '3', '299', '2026-09-03T14:30:00.000Z', 3),
    row('d', 'TEST260918P00095000', 'buy', 'close', '1.5', '-151', '2026-09-03T14:30:00.000Z', 4)];
  return { version: 1, statements: [{ id: fileSha, fileName: 'synthetic.pdf', sha256: fileSha, broker: '大象', fills, grossTotal: '750', netCash: '46', feesTotal: '4', notes: [] }] };
}
describe('reconciled statement imports', () => {
  it('groups simultaneous opposite legs as one strategy without inventing prior plans', () => {
    const prepared = prepareStatementImport(fixture());
    expect(summarizeImport(prepared)).toMatchObject({ files: 1, uniqueFills: 4, cases: 1, closed: 1, closedNetPnl: '46', missingPriorRisk: 1 });
    expect(prepared.cases[0].plans).toEqual([]); expect(prepared.cases[0].assessments).toEqual([]);
    expect(prepareStatementImport(fixture()).cases[0].id).toBe(prepared.cases[0].id);
  });
  it('deduplicates overlap between statement files and refuses mismatched totals', () => {
    const input = fixture(), copy = structuredClone(input.statements[0]), otherSha = sha('overlap');
    copy.id = otherSha; copy.sha256 = otherSha; copy.fileName = 'overlap.pdf';
    copy.fills.forEach(f => { f.provenance.fileSha256 = otherSha; f.provenance.fileName = copy.fileName; });
    input.statements.push(copy);
    expect(summarizeImport(prepareStatementImport(input))).toMatchObject({ files: 2, uniqueFills: 4, cases: 1 });
    input.statements[0].feesTotal = '0'; expect(() => prepareStatementImport(input)).toThrow('文件总额不平');
  });
  it('rejects wrong multipliers, future dates and duplicate fill conflicts', () => {
    const input = fixture(); input.statements[0].fills[0].multiplier = '1';
    expect(() => prepareStatementImport(input)).toThrow('成交金额或费用不平');
    const future = fixture(); future.statements[0].fills[0].occurredAt = '2099-01-01T00:00:00.000Z';
    expect(() => prepareStatementImport(future)).toThrow('实际成交不可在未来');
    const duplicate = fixture(); duplicate.statements[0].fills[1].id = duplicate.statements[0].fills[0].id;
    expect(() => prepareStatementImport(duplicate)).toThrow('重复成交存在字段冲突');
  });
  it('accepts a no-trade statement only with zero execution totals', () => {
    const input = fixture(); Object.assign(input.statements[0], { fills: [], grossTotal: '0', netCash: '0', feesTotal: '0' });
    expect(summarizeImport(prepareStatementImport(input))).toMatchObject({ files: 1, uniqueFills: 0, cases: 0 });
    input.statements[0].netCash = '1'; expect(() => prepareStatementImport(input)).toThrow('文件总额不平');
  });
  it('appends later exits to the existing multi-leg case, preserving its identity and review records', () => {
    const all = prepareStatementImport(fixture());
    const earlier = structuredClone(all.cases[0]);
    earlier.id = 'existing-user-case'; earlier.fills = earlier.fills.slice(0, 2); earlier.fillIds = earlier.fills.map(f => f.id);
    earlier.title = 'User title'; earlier.assessments = [{ id: 'retained-review' }]; earlier.evidence = [{ id: 'retained-evidence' }];
    const plan = planStatementImport(all, [], [earlier]);
    expect(plan.cases).toHaveLength(0); expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ id: earlier.id, title: earlier.title, assessments: earlier.assessments, evidence: earlier.evidence, createdAt: earlier.createdAt });
    expect(plan.updates[0].fills.slice(0, 2)).toEqual(earlier.fills);
    expect(plan.updates[0].linkHistory.at(-1).fillIds).toEqual(all.cases[0].fillIds.slice(2));
    expect(planStatementImport(all, all.statements, plan.updates)).toEqual({ statements: [], cases: [], updates: [] });
    const split = structuredClone(earlier); split.id = 'other-owner'; split.fills = [all.cases[0].fills[2]];
    expect(() => planStatementImport(all, [], [earlier, split])).toThrow('成交归组');
    const prior = structuredClone(all.statements); prior[0].fills[0].feeCost = '2';
    expect(() => planStatementImport(all, prior, [])).toThrow('内容冲突');
  });
  it('writes an atomic incremental batch, is idempotent and rolls back conflicting fill ownership', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE trading_review_cases(id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, entry_json TEXT NOT NULL);
        CREATE TABLE trading_statement_imports(id TEXT PRIMARY KEY, imported_at TEXT NOT NULL, entry_json TEXT NOT NULL);
        CREATE TABLE trading_review_fills(fill_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES trading_review_cases(id));`);
      const all = prepareStatementImport(fixture());
      expect(applyStatementImport(db, all)).toEqual({ files: 1, cases: 1, updatedCases: 0 });
      expect(applyStatementImport(db, all)).toEqual({ files: 0, cases: 0, updatedCases: 0 });
      db.prepare('DELETE FROM trading_statement_imports').run();
      const existing = structuredClone(all.cases[0]); existing.fills = existing.fills.slice(0, 2); existing.fillIds = existing.fills.map(f => f.id);
      db.prepare('UPDATE trading_review_cases SET entry_json = ?').run(JSON.stringify(existing));
      db.prepare('DELETE FROM trading_review_fills WHERE fill_id IN (?, ?)').run(...all.cases[0].fillIds.slice(2));
      expect(applyStatementImport(db, all)).toEqual({ files: 1, cases: 0, updatedCases: 1 });
      const conflict = structuredClone(all); conflict.statements[0].id = 'new-file'; conflict.cases[0].fills.push({ ...conflict.cases[0].fills[0], id: 'new-fill' });
      db.prepare('INSERT INTO trading_review_cases VALUES (?, ?, ?)').run('other', '', JSON.stringify({ id: 'other', fills: [] }));
      db.prepare('INSERT INTO trading_review_fills VALUES (?, ?)').run('new-fill', 'other');
      const before = db.prepare('SELECT entry_json FROM trading_review_cases WHERE id = ?').get(existing.id);
      expect(() => applyStatementImport(db, conflict)).toThrow('成交已属于');
      expect(db.prepare('SELECT id FROM trading_statement_imports WHERE id = ?').get('new-file')).toBeUndefined();
      expect(db.prepare('SELECT entry_json FROM trading_review_cases WHERE id = ?').get(existing.id)).toEqual(before);
    } finally { db.close(); }
  });
});
