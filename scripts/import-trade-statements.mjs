// Validates a parsed, reconciled PDF bundle. Writes only with --apply.
// node scripts/import-trade-statements.mjs --input bundle.json --database db.sqlite [--apply]
import { createHash } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { tradingCaseMetrics } from '../packages/domain/dist/index.js';

const hash = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const money = z.string().max(80).regex(/^-?\d+(?:\.\d+)?$/);
const positive = money.refine(v => new Decimal(v).gt(0));
const provenance = z.object({ fileName: z.string(), fileSha256: z.string().regex(/^[a-f0-9]{64}$/), page: z.number().int().positive(), row: z.number().int().positive(), broker: z.enum(['大象', 'Tradier']), action: z.enum(['open', 'close']), settlementDate: z.string().date(), grossAmount: positive, netCash: money, feeBreakdown: z.record(z.string(), money), originalTime: z.string(), originalTimezone: z.string().nullable() }).strict();
const fillSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), transactionId: z.string(), source: z.literal('statement'), sourceLabel: z.string(), instrumentKey: z.string(), symbol: z.string(), side: z.enum(['buy', 'sell']), quantity: positive, price: positive, feeCost: money, multiplier: z.enum(['1', '100']), currency: z.literal('USD'), occurredAt: z.string(), timePrecision: z.enum(['instant', 'day']), provenance }).strict();
const bundleSchema = z.object({ version: z.literal(1), statements: z.array(z.object({ id: z.string(), fileName: z.string(), sha256: z.string(), broker: z.enum(['大象', 'Tradier']), fills: z.array(fillSchema), grossTotal: money, netCash: money, feesTotal: money, notes: z.array(z.string()) }).strict()).min(1) }).strict();
const sum = values => values.reduce((n, v) => n.plus(v), new Decimal(0));

export function prepareStatementImport(raw, recordedAt = new Date().toISOString()) {
  const bundle = bundleSchema.parse(raw);
  const unique = new Map();
  for (const statement of bundle.statements) {
    if (statement.id !== statement.sha256) throw Error('文件标识与指纹不符');
    for (const f of statement.fills) {
      if (f.provenance.fileSha256 !== statement.sha256 || f.provenance.fileName !== statement.fileName) throw Error('成交来源引用不符');
      if (!Number.isFinite(Date.parse(f.occurredAt)) || (f.timePrecision === 'instant' && !/Z$|[+-]\d\d:\d\d$/.test(f.occurredAt)) || (f.timePrecision === 'day' && !/^\d{4}-\d\d-\d\d$/.test(f.occurredAt))) throw Error('成交时间无效');
      if (Date.parse(f.occurredAt) > Date.parse(recordedAt)) throw Error('实际成交不可在未来');
      const gross = new Decimal(f.quantity).mul(f.price).mul(f.multiplier);
      const reportedGross = new Decimal(f.provenance.grossAmount);
      if (!gross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).eq(reportedGross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)) || !reportedGross.mul(f.side === 'sell' ? 1 : -1).minus(f.feeCost).eq(f.provenance.netCash) || !sum(Object.values(f.provenance.feeBreakdown)).eq(f.feeCost)) throw Error('成交金额或费用不平');
      const prior = unique.get(f.id);
      if (prior && ['instrumentKey', 'symbol', 'side', 'quantity', 'price', 'feeCost', 'multiplier', 'occurredAt'].some(k => prior[k] !== f[k])) throw Error('重复成交存在字段冲突');
      unique.set(f.id, f);
    }
    if (!sum(statement.fills.map(f => f.provenance.grossAmount)).eq(statement.grossTotal) || !sum(statement.fills.map(f => f.provenance.netCash)).eq(statement.netCash) || !sum(statement.fills.map(f => f.feeCost)).eq(statement.feesTotal)) throw Error('文件总额不平');
  }
  const groups = new Map();
  for (const f of unique.values()) groups.set(f.instrumentKey, [...(groups.get(f.instrumentKey) ?? []), f]);
  // Only merge explicitly simultaneous opposite option legs from the same broker.
  // Day-only confirmations cannot prove simultaneity, so no such inference is made.
  const parent = new Map([...groups.keys()].map(k => [k, k]));
  const root = key => { while (parent.get(key) !== key) key = parent.get(key); return key; };
  const firsts = [...groups].map(([key, fills]) => ({ key, first: [...fills].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.provenance.row - b.provenance.row)[0] }));
  for (const a of firsts) for (const b of firsts) {
    if (a.key >= b.key) continue;
    const x = a.first, y = b.first;
    const ox = /^([A-Z]+)(\d{6})[CP]\d{8}$/.exec(x.symbol), oy = /^([A-Z]+)(\d{6})[CP]\d{8}$/.exec(y.symbol);
    if (ox && oy && ox[1] === oy[1] && ox[2] === oy[2] && x.provenance.broker === y.provenance.broker && x.provenance.fileSha256 === y.provenance.fileSha256 && x.timePrecision === 'instant' && y.timePrecision === 'instant' && x.occurredAt === y.occurredAt && x.side !== y.side && x.quantity === y.quantity && x.provenance.action === 'open' && y.provenance.action === 'open') parent.set(root(b.key), root(a.key));
  }
  const merged = new Map();
  for (const [key, fills] of groups) merged.set(root(key), [...(merged.get(root(key)) ?? []), ...fills]);
  const cases = [];
  for (const fills of merged.values()) {
    fills.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.provenance.row - b.provenance.row || a.id.localeCompare(b.id));
    const instruments = new Set(fills.map(f => f.instrumentKey));
    const balances = new Map(); let complete = true;
    for (const fill of fills) {
      const position = balances.get(fill.instrumentKey) ?? new Decimal(0), change = new Decimal(fill.quantity).mul(fill.side === 'buy' ? 1 : -1);
      if (fill.provenance.action === 'close' && (position.isZero() || position.isPositive() === change.isPositive() || position.abs().lt(change.abs()))) complete = false;
      if (fill.provenance.action === 'open' && !position.isZero() && position.isPositive() !== change.isPositive()) complete = false;
      balances.set(fill.instrumentKey, position.plus(change));
    }
    const first = fills[0], option = /^([A-Z]+)(\d{6})[CP]\d{8}$/.exec(first.symbol);
    const readable = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(first.symbol);
    const symbolLabel = instruments.size > 1 ? `${option?.[1] ?? first.symbol} ${option?.[2] ?? ''} 双腿` : readable ? `${readable[1]} ${readable[3]}/${readable[4]} ${new Decimal(readable[6]).div(1000).toFixed()}${readable[5]}` : first.symbol;
    const id = 'statement-case-' + hash(...fills.map(f => f.id).sort());
    const notes = ['历史成交由结单导入，入场理由、计划风险与心理评价尚未记录，不推定为事前计划。', instruments.size > 1 ? '按同券商、同到期标的、同一时刻及等量反向开仓归为一笔双腿交易；策略意图待本人复盘。' : '按同一合约或证券归组；策略意图待本人复盘。', '完整性根据结单开仓、平仓标记及逐腿数量核对；未退出数量继续标为持仓中。'];
    const entry = { id, title: `${first.provenance.broker} · ${symbolLabel}`, strategy: option ? instruments.size > 1 ? '期权双腿（意图待复盘）' : '期权单腿（意图待复盘）' : '股票（意图待复盘）', horizon: 'unspecified', instrumentType: option ? 'option' : 'stock', fillIds: fills.map(f => f.id), historyComplete: complete, createdAt: recordedAt, updatedAt: recordedAt, fills, plans: [], events: [], assessments: [], linkHistory: [{ recordedAt, fillIds: fills.map(f => f.id), historyComplete: complete }], evidence: [{ id: 'import-evidence-' + hash(id), title: '结单成交与归组依据', facts: `关联 ${fills.length} 笔成交，${instruments.size} 个合约 / 证券。来源：${[...new Set(fills.map(f => f.provenance.fileName))].join('、')}。所有金额与原结单逐项核对。`, interpretation: notes.join('\n'), sourceUrl: '', availableAt: null, newsId: null, researchId: null, recordedAt, sourceSnapshot: [] }] };
    cases.push(entry);
  }
  const statements = bundle.statements.map(s => ({ ...s, importedAt: recordedAt }));
  return { statements, cases };
}

export function summarizeImport(prepared) {
  const metrics = prepared.cases.map(tradingCaseMetrics);
  const closed = metrics.filter(m => m.state === 'closed' && m.netPnl !== null);
  return { files: prepared.statements.length, uniqueFills: new Set(prepared.statements.flatMap(s => s.fills.map(f => f.id))).size, cases: metrics.length, closed: closed.length, open: metrics.filter(m => m.state === 'open').length, incomplete: metrics.filter(m => m.state === 'incomplete').length, closedNetPnl: sum(closed.map(m => m.netPnl)).toFixed(), currency: 'USD', missingPriorRisk: metrics.filter(m => m.rMultiple === null).length };
}

// Keep existing case IDs and all user records. New closing fills extend their
// original case; conflicting ownership aborts the entire batch.
export function planStatementImport(prepared, statements, cases) {
  const previousFiles = new Map(statements.map(s => [s.id, s]));
  const owners = new Map(cases.flatMap(c => c.fills.map(f => [f.id, c])));
  for (const s of prepared.statements) {
    const prior = previousFiles.get(s.id);
    if (prior && (prior.sha256 !== s.sha256 || JSON.stringify(prior.fills) !== JSON.stringify(s.fills))) throw Error('已导入结单内容冲突');
  }
  const inserts = [], updates = [];
  for (const proposed of prepared.cases) {
    const added = proposed.fills.filter(f => !owners.has(f.id));
    if (!added.length) continue;
    const owned = [...new Set(proposed.fills.flatMap(f => owners.has(f.id) ? [owners.get(f.id)] : []))];
    // Incremental bundles must include the earlier statements, so overlapping
    // instruments cannot be silently split into another incomplete case.
    const overlapping = cases.filter(c => c.fills.some(f => proposed.fills.some(p => p.instrumentKey === f.instrumentKey)));
    if (owned.length > 1 || overlapping.some(c => !owned.includes(c))) throw Error('成交归组与已有档案冲突，请包含历史结单并核对归属');
    if (!owned.length) { inserts.push(proposed); continue; }
    const current = owned[0];
    if (added.some(f => !current.fills.some(old => old.instrumentKey === f.instrumentKey))) throw Error('新增合约不能自动并入已有用户分组');
    const next = structuredClone(current);
    next.fills.push(...added); next.fillIds = next.fills.map(f => f.id);
    next.historyComplete = current.historyComplete && proposed.historyComplete;
    next.updatedAt = proposed.updatedAt;
    next.linkHistory.push({ recordedAt: proposed.updatedAt, fillIds: added.map(f => f.id), historyComplete: next.historyComplete });
    updates.push(next);
  }
  return { statements: prepared.statements.filter(s => !previousFiles.has(s.id)), cases: inserts, updates };
}

function databasePlan(database, prepared) {
  const statements = database.prepare('SELECT entry_json FROM trading_statement_imports').all().map(r => JSON.parse(r.entry_json));
  const cases = database.prepare('SELECT entry_json FROM trading_review_cases').all().map(r => JSON.parse(r.entry_json));
  return planStatementImport(prepared, statements, cases);
}

export function applyStatementImport(database, prepared) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const plan = databasePlan(database, prepared);
    for (const s of plan.statements) database.prepare('INSERT INTO trading_statement_imports (id, imported_at, entry_json) VALUES (?, ?, ?)').run(s.id, s.importedAt, JSON.stringify(s));
    for (const c of [...plan.cases, ...plan.updates]) {
      if (plan.updates.includes(c)) database.prepare('UPDATE trading_review_cases SET updated_at = ?, entry_json = ? WHERE id = ?').run(c.updatedAt, JSON.stringify(c), c.id);
      else database.prepare('INSERT INTO trading_review_cases (id, updated_at, entry_json) VALUES (?, ?, ?)').run(c.id, c.updatedAt, JSON.stringify(c));
      for (const f of c.fills) {
        const prior = database.prepare('SELECT case_id FROM trading_review_fills WHERE fill_id = ?').get(f.id);
        if (prior && prior.case_id !== c.id) throw Error('成交已属于其他档案');
        database.prepare('INSERT OR IGNORE INTO trading_review_fills (fill_id, case_id) VALUES (?, ?)').run(f.id, c.id);
      }
    }
    database.exec('COMMIT');
    return { files: plan.statements.length, cases: plan.cases.length, updatedCases: plan.updates.length };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

async function main() {
  const args = process.argv.slice(2), inputPath = args[args.indexOf('--input') + 1], databasePath = args[args.indexOf('--database') + 1];
  if (!args.includes('--input')) throw Error('Specify --input bundle.json');
  const prepared = prepareStatementImport(JSON.parse(await readFile(inputPath, 'utf8')));
  if (!args.includes('--database')) {
    if (args.includes('--apply')) throw Error('Specify --database explicitly before --apply');
    console.log(JSON.stringify({ mode: 'dry-run', ...summarizeImport(prepared) })); return;
  }
  if (!existsSync(databasePath)) throw Error('Existing database required');
  const database = new DatabaseSync(databasePath, { readOnly: !args.includes('--apply') });
  database.exec('PRAGMA busy_timeout = 5000');
  try {
    const plan = databasePlan(database, prepared);
    const delta = { files: plan.statements.length, cases: plan.cases.length, updatedCases: plan.updates.length };
    if (!args.includes('--apply')) { console.log(JSON.stringify({ mode: 'dry-run', delta, ...summarizeImport(prepared) })); return; }
    if (!delta.files && !delta.cases && !delta.updatedCases) { console.log(JSON.stringify({ mode: 'applied', inserted: delta })); return; }
    const backupPath = args.includes('--backup') ? args[args.indexOf('--backup') + 1] : `${databasePath}.before-statements-${Date.now()}.sqlite`;
    if (existsSync(backupPath)) throw Error('Backup already exists');
    // Pin a WAL read snapshot so normal collector writes cannot repeatedly
    // restart a multi-gigabyte backup. No write lock is held during the copy.
    database.exec('BEGIN');
    try {
      database.prepare('SELECT COUNT(*) FROM trading_statement_imports').get();
      await backup(database, backupPath, { rate: 8192 });
    } finally { database.exec('ROLLBACK'); }
    await chmod(backupPath, 0o600);
    const result = applyStatementImport(database, prepared);
    console.log(JSON.stringify({ mode: 'applied', backup: backupPath, inserted: result, ...summarizeImport(prepared) }));
  } finally { database.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Statement import failed. No partial batch was committed; inspect the source bundle and validation.'); process.exitCode = 1; });
