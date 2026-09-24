// UI regression checks with broker responses intercepted; no broker network calls.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const url = process.env.INVEST_UI_TEST_URL ?? 'http://127.0.0.1:5175';
if (new URL(url).hostname !== '127.0.0.1') throw Error('Isolated loopback server required');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
const report = { errors: [], checks: [] };
const savedAt = '2026-09-05T09:00:00Z';
let sync = { state: 'never', startedAt: null, completedAt: null, lastSuccessAt: null, message: null, accounts: 0, positions: 0, trades: 0 };
const account = { broker: 'ibkr', environment: 'statement', accountId: 'TEST-ONLY', syncedAt: savedAt, asOf: '20260904', currency: null, equity: null, unrealizedPnl: null, sessionRealizedPnl: null, positions: [], trades: [], notes: [] };
const connection = () => ({ id: 'ibkr', name: 'IBKR', mode: 'Flex XML', configured: true, missing: [], sync });
let fail = false, release;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/api/brokers', route => route.fulfill({ json: { connections: [connection()], accounts: sync.lastSuccessAt ? [account] : [] } }));
  await page.route('**/api/brokers/ibkr/sync', async route => {
    sync = { ...sync, state: 'running' };
    await new Promise(resolve => { release = resolve; });
    sync = { ...sync, state: fail ? 'error' : 'success', completedAt: savedAt, lastSuccessAt: savedAt, accounts: 1, message: fail ? 'IBKR 报告缺少字段：Open Positions → Conid；Trades → Trade ID' : null };
    await route.fulfill({ status: fail ? 502 : 200, json: fail ? { message: sync.message } : { accounts: [account], connection: connection() } });
  });
  await page.goto(url + '/#/brokers');
  const card = page.locator('.broker-connections article').filter({ hasText: 'IBKR' });
  await card.getByText('已配置 · 尚未同步', { exact: true }).waitFor();
  await card.getByRole('button', { name: '同步持仓和成交' }).click();
  await card.getByText('正在同步', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.broker-connections button.primary-button')?.disabled);
  while (!release) await new Promise(resolve => setTimeout(resolve, 20));
  release(); release = null;
  await card.getByText('最近同步成功', { exact: true }).waitFor();
  assert.match(await card.innerText(), /1 个账户 · 0 项持仓 · 0 笔成交/);
  await page.reload(); await card.getByText('最近同步成功', { exact: true }).waitFor();
  report.checks.push('empty success survives reload');
  fail = true;
  await card.getByRole('button', { name: '同步持仓和成交' }).click();
  while (!release) await new Promise(resolve => setTimeout(resolve, 20));
  release(); release = null;
  await card.getByText('最近同步失败', { exact: true }).waitFor();
  assert.match(await card.locator('.broker-sync-error').innerText(), /Conid.*Trade ID/);
  await page.reload(); await card.getByText('最近同步失败', { exact: true }).waitFor();
  assert.match(await card.innerText(), /上次成功数据已保留/);
  report.checks.push('failure survives reload and retains previous snapshot');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width);
  }
  report.checks.push('broker cards fit desktop and mobile');
  await page.getByRole('tab', { name: /^交易复盘/ }).click();
  await page.locator('.tr-header').waitFor();
  assert.equal(await page.locator('.widget--unavailable').count(), 0);
  await page.getByRole('button', { name: '＋ 新建交易档案' }).click();
  await page.getByLabel('档案标题', { exact: true }).fill('未保存的草稿');
  await page.route('**/assets/test-current.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/index.html?version-check=*', route => route.fulfill({ contentType: 'text/html', body: '<script type="module" src="/assets/test-next.js"></script>' }));
  await page.evaluate(() => { const script = document.createElement('script'); script.type = 'module'; script.src = '/assets/test-current.js'; document.head.append(script); window.dispatchEvent(new Event('focus')); });
  await page.getByText('网页有新版本', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('档案标题', { exact: true }).inputValue(), '未保存的草稿');
  assert.equal(await page.getByRole('button', { name: '重新加载页面', exact: true }).count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 320);
  report.checks.push('review component loads; update notice preserves unsaved draft');
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
