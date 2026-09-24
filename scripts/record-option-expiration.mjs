// Records a user-confirmed worthless expiration as a settlement event.
// The original statement and broker report prices/NAV remain untouched.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { BrokerSnapshotSchema, worthlessExpirationTrade, expirationReviewFill, tradingCaseMetrics, applyBrokerExpirations, accountPerformance } from '../packages/domain/dist/index.js';

export function recordExpiration(database, symbol, note, apply = false, recordedAt = new Date().toISOString()) {
  const db = new DatabaseSync(database); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  try {
    const accounts = db.prepare("SELECT snapshot_json FROM broker_snapshots WHERE broker='elephant'").all().map(r => BrokerSnapshotSchema.parse(JSON.parse(r.snapshot_json)));
    const matching = accounts.filter(a => a.positions.some(p => p.symbol === symbol) || a.trades.some(t => t.symbol === symbol && t.expirationConfirmation));
    if (matching.length !== 1) throw Error('Expected exactly one matching Elephant account');
    const account = matching[0];
    const statements = db.prepare('SELECT entry_json FROM trading_statement_imports').all().map(r => JSON.parse(r.entry_json)).filter(s => s.broker === '大象');
    const unique = new Map(statements.flatMap(s => s.fills.map(f => [f.id, f])));
    const openings = [...unique.values()].filter(f => f.symbol === symbol && f.provenance?.action === 'open');
    if (openings.length !== 1) throw Error('Expected one verified opening execution');
    const opening = openings[0];
    const entries = db.prepare('SELECT entry_json FROM trading_review_cases').all().map(r => JSON.parse(r.entry_json));
    const cases = entries.filter(c => c.fills.some(f => f.id === opening.id));
    if (cases.length !== 1) throw Error('Opening review case must already exist');
    const entry = cases[0];
    const id = 'expiration:' + createHash('sha256').update(JSON.stringify([account.broker, account.accountId, symbol, 'worthless'])).digest('hex');
    const existing = account.trades.find(t => t.id === id);
    const trade = existing ?? worthlessExpirationTrade(account, opening, id, recordedAt, note);
    if (!trade.expirationConfirmation || trade.price !== '0' || trade.fees !== '0') throw Error('Existing event conflicts with confirmation');
    const wasLinked = entry.fills.some(f => f.id === id);
    if (!existing) account.trades.push(trade);
    if (!wasLinked) {
      entry.fills.push(expirationReviewFill(trade, opening, 'elephant')); entry.fillIds = entry.fills.map(f => f.id);
      entry.linkHistory.push({ recordedAt, fillIds: [id], historyComplete: entry.historyComplete });
      entry.events.push({ id: id + ':confirmation', recordedAt, occurredAt: null, logicStatus: 'unknown', observation: `用户确认：${note}；到期日 ${trade.tradedAt}，仅日期。`, action: '到期作废，结算价值 0；开仓权利金及已付费用转入已实现亏损，未记录额外到期费用。', evidenceIds: [] });
      entry.updatedAt = recordedAt;
    }
    const metric = tradingCaseMetrics(entry);
    if (metric.state !== 'closed' || metric.netPnl === null) throw Error('Expiration must reconcile the complete case to zero remaining quantity');
    const effective = applyBrokerExpirations(account);
    if (effective.positions.some(p => p.symbol === symbol)) throw Error('Confirmed event does not reconcile the bank inventory');
    const value = accountPerformance([effective], statements, new Map(), recordedAt);
    const result = { mode: existing && wasLinked ? 'already-recorded' : apply ? 'applied' : 'dry-run', symbol, expiredOn: trade.tradedAt, quantity: trade.quantity, currency: trade.currency, optionNetPnl: metric.netPnl, elephantRealizedNet: value.realizedNet, remainingPositions: effective.positions.length, originalStatementFills: unique.size };
    if (apply && !(existing && wasLinked)) {
      db.prepare('UPDATE broker_snapshots SET snapshot_json=? WHERE broker=? AND account_id=? AND environment=?').run(JSON.stringify(account), account.broker, account.accountId, account.environment);
      const owner = db.prepare('SELECT case_id FROM trading_review_fills WHERE fill_id=?').get(id);
      if (owner && owner.case_id !== entry.id) throw Error('Settlement is already linked to a different case');
      db.prepare('INSERT OR IGNORE INTO trading_review_fills (fill_id,case_id) VALUES (?,?)').run(id,entry.id);
      db.prepare('UPDATE trading_review_cases SET entry_json=?,updated_at=? WHERE id=?').run(JSON.stringify(entry),entry.updatedAt,entry.id);
    }
    db.exec(apply ? 'COMMIT' : 'ROLLBACK'); return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--database') || !args.includes('--symbol') || !args.includes('--note') || !args.includes('--confirm-worthless')) throw Error('Required: --database db.sqlite --symbol OCC --note user-confirmation --confirm-worthless [--apply]');
  console.log(JSON.stringify(recordExpiration(value('--database'),value('--symbol'),value('--note'),args.includes('--apply'))));
}
