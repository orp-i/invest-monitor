import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { brokerFeeTotals, brokerPositionTotals, exactTotal, reviewExecutionDetails, weeklyTradeTimeline, WeeklyReviewInputSchema, type BrokerSnapshot, type TradingCase, type ReviewFill } from "@invest/domain";
import { parseIbkrStatement } from "../../apps/server/src/brokers.js";
const fill = (id: string, side: 'buy' | 'sell', quantity: string, price: string, day: string): ReviewFill => ({ id, transactionId: id, source: 'ibkr', sourceLabel: 'IBKR', instrumentKey: 'option-1', symbol: 'TEST OPTION', side, quantity, price, feeCost: '1', multiplier: '100', currency: 'USD', occurredAt: day + 'T14:00:00Z', timePrecision: 'instant' });
const entry = (fills: ReviewFill[]): TradingCase => ({ id: 'test', title: 'test', strategy: 'spread', horizon: 'swing', instrumentType: 'option', historyComplete: true, fillIds: fills.map(f => f.id), fills, plans: [], evidence: [], events: [], assessments: [], linkHistory: [], createdAt: '2026-08-31', updatedAt: '2026-09-05' });
const range = { weekStart: '2026-08-31', weekEnd: '2026-09-06', timezone: 'UTC' };
describe('precise execution and portfolio analytics', () => {
  it('uses quantity-weighted opening/closing prices and includes all fees for a short option', () => {
    const c = entry([fill('a', 'sell', '2', '3', '2026-08-31'), fill('b', 'sell', '1', '6', '2026-09-01'), fill('c', 'buy', '1', '1', '2026-09-02'), fill('d', 'buy', '2', '2.5', '2026-09-03')]);
    const d = reviewExecutionDetails(c);
    expect(d.legs[0]).toMatchObject({ openingPrice: '4', closingPrice: '2', openingQuantity: '3', closingQuantity: '3', fees: '4', netQuantity: '0', pnl: '596' });
    expect(d.actions).toEqual({ a: '卖出开仓（空头）', b: '卖出开仓（空头）', c: '买入平仓（空头回补）', d: '买入平仓（空头回补）' });
    c.fills.pop();
    expect(reviewExecutionDetails(c).legs[0]?.pnl).toBeNull();
  });
  it('does not invent an opening price from incomplete or ambiguous date-only history', () => {
    const c = entry([fill('a', 'buy', '1', '1', '2026-09-01'), fill('b', 'sell', '1', '2', '2026-09-01')]);
    c.fills.forEach(f => { f.timePrecision = 'day'; f.occurredAt = '2026-09-01'; });
    expect(reviewExecutionDetails(c).legs[0]).toMatchObject({ openingPrice: null, closingPrice: null, classificationKnown: false });
    c.fills[0]!.positionEffect = 'open'; c.fills[1]!.positionEffect = 'close';
    expect(reviewExecutionDetails(c).legs[0]).toMatchObject({ openingPrice: '1', closingPrice: '2', classificationKnown: true });
    c.historyComplete = false; c.fills.forEach(f => { f.positionEffect = null; });
    expect(reviewExecutionDetails(c).legs[0]?.openingPrice).toBeNull();
  });
  it('separates broker, currency and fill dates, recognizing profit only at complete exit', () => {
    const closed = entry([fill('a', 'buy', '1', '1', '2026-08-31'), fill('b', 'sell', '1', '2', '2026-09-03')]);
    const open = { ...entry([fill('c', 'buy', '2', '1', '2026-09-02'), fill('d', 'sell', '1', '5', '2026-09-03')]), id: 'partial' };
    const eur = { ...closed, id: 'eur', fills: closed.fills.map(f => ({ ...f, currency: 'EUR', sourceLabel: 'Tradier' })) };
    const result = weeklyTradeTimeline([closed, open, eur], range);
    expect(result.points.find(p => p.day === '2026-09-03' && p.broker === 'IBKR')).toMatchObject({ pnl: '98', cumulativePnl: '98', fills: 2, completed: 1 });
    expect(result.points.find(p => p.day === '2026-08-31' && p.broker === 'IBKR')).toMatchObject({ pnl: '0', fills: 1, completed: 0 });
    expect(result.points.find(p => p.day === '2026-09-03' && p.currency === 'EUR')?.pnl).toBe('98');
    closed.fills.forEach(f => { f.timePrecision = 'broker-local'; });
    expect(weeklyTradeTimeline([closed], range).points).toEqual([]);
  });
  it('keeps missing amounts and commission currencies distinct, including commission rebates', () => {
    expect(exactTotal(['9007199254740993.125', '0.001'])).toBe('9007199254740993.126');
    expect(exactTotal(['1', null])).toBeNull();
    const account = { broker: 'ibkr', trades: [{ fees: '-2', feeCurrency: 'USD' }, { fees: '0.5', feeCurrency: 'USD' }, { fees: '-3', feeCurrency: 'EUR' }, { fees: null, feeCurrency: 'EUR' }], positions: [{ currency: 'USD', costBasis: '10', marketValue: '11', unrealizedPnl: '1' }, { currency: 'EUR', costBasis: '10', marketValue: null, unrealizedPnl: null }] } as BrokerSnapshot;
    expect(brokerFeeTotals(account)).toEqual([{ currency: 'USD', total: '1.5', known: '1.5', missing: 0, trades: 2 }, { currency: 'EUR', total: null, known: '3', missing: 1, trades: 2 }]);
    expect(brokerPositionTotals([account])).toMatchObject([{ currency: 'USD', marketValue: '11' }, { currency: 'EUR', marketValue: null }]);
  });
  it('reads explicit NAV at the report cutoff and retains option multiplier and commission currency', () => {
    const xml = '<FlexQueryResponse><FlexStatements><FlexStatement accountId="TEST" fromDate="20260901" toDate="20260904"><AccountInformation currency="USD"/><EquitySummaryInBase><EquitySummaryByReportDateInBase reportDate="20260903" total="9999"/><EquitySummaryByReportDateInBase reportDate="20260904" model="" total="1000.123" cash="800" stock="100.123" options="100"/></EquitySummaryInBase><OpenPositions><OpenPosition conid="1" symbol="TEST OPTION" currency="USD" position="1" assetCategory="OPT" multiplier="10"/></OpenPositions><Trades><Trade tradeID="1" symbol="TEST OPTION" currency="USD" quantity="1" buySell="BUY" tradeDate="20260904" multiplier="10" ibCommission="-2" ibCommissionCurrency="EUR" openCloseIndicator="O" fifoPnlRealized="0"/></Trades></FlexStatement></FlexStatements></FlexQueryResponse>';
    const [a] = parseIbkrStatement(xml);
    expect(a).toMatchObject({ equity: '1000.123', cash: '800', currency: 'USD', reportFrom: '20260901' });
    expect(a?.trades[0]).toMatchObject({ multiplier: '10', feeCurrency: 'EUR', positionEffect: 'open', realizedPnl: '0' });
    expect(parseIbkrStatement(xml.replace('<AccountInformation currency="USD"/>', ''))[0]?.equity).toBeNull();
  });
  it('accepts a concise macro week and validates event links', () => {
    const input = { ...range, goodCaseId: null, mistakeCaseId: null, riskyWinCaseId: null, findings: '事实变化', marketImpact: '市场影响', opportunities: '条件判断', macroStudy: '', upcomingEvents: '', reading: '', englishTerms: '', recovery: '', keyEvents: [{ title: '测试事件', scheduledAt: '2026-09-08T12:30:00Z', timezone: 'UTC', impact: '观察利率预期', sourceUrl: 'https://www.federalreserve.gov/' }] };
    expect(WeeklyReviewInputSchema.parse(input).nextAction).toBe('');
    expect(WeeklyReviewInputSchema.safeParse({ ...input, keyEvents: [{ ...input.keyEvents[0], sourceUrl: 'javascript:alert(1)' }] }).success).toBe(false);
  });
  // The learning-material package is private and absent from public clones; skip instead of failing there.
  it.skipIf(!existsSync('docs/trading-review-content-v1/01-图文内容手册.md') || !existsSync('apps/web/public/trading-review/content-manual.md'))('publishes the complete supplied manual without rewriting its contents', async () => {
    expect(await readFile('apps/web/public/trading-review/content-manual.md', 'utf8')).toBe(await readFile('docs/trading-review-content-v1/01-图文内容手册.md', 'utf8'));
  });
});
