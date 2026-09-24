// Synthetic broker snapshots in an isolated UI; no provider calls or database writes.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const url = 'http://127.0.0.1:5175';
const account = (broker, accountId, equity, positions) => ({ broker, accountId, environment: broker === 'ibkr' ? 'statement' : 'live', currency: 'USD', equity, cash: '100', unrealizedPnl: null, sessionRealizedPnl: null, positions, trades: [], notes: [], syncedAt: '2026-09-05T10:00:00Z', asOf: '2026-09-04' });
const position = (id, symbol, assetType, quantity, marketValue) => ({ id, symbol, assetType, quantity, marketValue, currency: 'USD', costBasis: '100', unrealizedPnl: '20', averageCost: '10', markPrice: '12', multiplier: '1' });
const accounts = [account('ibkr', 'TEST-IB', '1000', [position('a', 'TEST-A', 'STK', '10', '120'), position('b', 'TEST-OPTION', 'OPT', '-1', '-200')]), account('tradier', 'TEST-TR', '500', [position('c', 'TEST-C', 'STK', '10', '150')])];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
const report = { errors: [], widths: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.route('**/api/brokers', r => r.fulfill({ json: { accounts, connections: [] } }));
  await page.goto(url + '/#/positions');
  await page.locator('.all-broker-positions tbody tr').first().waitFor();
  assert.equal(await page.locator('.all-broker-positions tbody tr').count(), 3);
  assert.equal(await page.locator('.manual-ledger-fold').getAttribute('open'), null);
  assert.equal(await page.locator('.transaction-form').isVisible(), false);
  await page.getByLabel('持仓券商', { exact: true }).selectOption('tradier');
  assert.equal(await page.locator('.all-broker-positions tbody tr').count(), 1);
  await page.getByLabel('持仓券商', { exact: true }).selectOption('all');
  await page.getByLabel('持仓资产类型', { exact: true }).selectOption('期权');
  assert.equal(await page.locator('.all-broker-positions tbody tr').count(), 1);
  assert.match(await page.locator('.all-broker-positions tbody').innerText(), /TEST-OPTION/);
  await page.getByLabel('持仓资产类型', { exact: true }).selectOption('all');
  for (const width of [1440, 768, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width); report.widths.push({ section: 'positions', width }); }
  await page.getByRole('tab', { name: '券商', exact: true }).click();
  await page.locator('.portfolio-chart svg').first().waitFor();
  assert.equal(await page.locator('.portfolio-chart svg').count(), 3);
  assert.match(await page.locator('.portfolio-chart').first().innerText(), /66.7%/);
  assert.match(await page.locator('.portfolio-chart').first().innerText(), /33.3%/);
  assert.equal(await page.locator('.broker-financial-card').count(), 2);
  for (const width of [1440, 768, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width); report.widths.push({ section: 'brokers', width }); }
  accounts[0].equity = null;
  await page.reload(); await page.getByText(/净资产或本位币缺失，暂不计算全账户占比/).waitFor();
  assert.equal(await page.locator('.portfolio-chart').first().locator('svg').count(), 0);
  const review = await (await page.request.get(url + '/api/trading-review')).json();
  review.fills = ['ibkr', 'tradier'].map((source, i) => ({ id: 'test-' + source, transactionId: 'test-' + source, source, environment: source === 'ibkr' ? 'statement' : 'live', instrumentKey: source, symbol: 'SYNTHETIC', side: 'sell', quantity: '1', price: '12', feeCost: '1', multiplier: '1', currency: 'USD', occurredAt: source === 'ibkr' ? '20260904;093000' : '2026-09-04', timePrecision: source === 'ibkr' ? 'broker-local' : 'day', realizedPnl: i === 0 ? '10' : null, caseId: null }));
  await page.route('**/api/trading-review', route => route.fulfill({ json: review }));
  await page.getByRole('tab', { name: /^交易复盘/ }).click();
  await page.getByRole('tab', { name: '周末复盘', exact: true }).click();
  await page.getByLabel('周报开始日期', { exact: true }).fill('2026-08-31');
  await page.getByLabel('周报结束日期', { exact: true }).fill('2026-09-06');
  await page.getByRole('tab', { name: '券商原始成交', exact: true }).click();
  await page.locator('.broker-trade-timeline svg').waitFor();
  assert.equal(await page.locator('.broker-trade-timeline tbody tr').count(), 2);
  assert.match(await page.locator('.broker-trade-timeline').innerText(), /10.00 USD/);
  assert.match(await page.locator('.broker-trade-timeline').innerText(), /接口未提供完整盈亏字段/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 320);
  assert.deepEqual(report.errors, []); console.log(JSON.stringify(report));
} finally { await browser.close(); }
