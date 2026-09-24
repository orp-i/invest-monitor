// Run against the disposable review API, never a production ledger.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node tests/workspace/browser-smoke.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const url = process.env.INVEST_UI_TEST_URL ?? 'http://127.0.0.1:5175';
if (new URL(url).hostname !== '127.0.0.1') throw new Error('Browser write tests require an isolated loopback server.');
const dir = process.env.INVEST_UI_ARTIFACTS ?? '/tmp/invest-ui-review';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
const errors = [];
const report = {};
const createdTrades = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.overview-sections').waitFor();
  assert.equal(await page.getByRole('tab').count(), 11);
  assert.equal(await page.locator('.overview-section-card').count(), 4);
  report.overviewHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.screenshot({ animations: 'disabled', path: `${dir}/after-overview-desktop.png`, fullPage: true });

  await page.getByRole('tab', { name: /^加密货币/ }).click();
  await page.locator('.price-chart').waitFor();
  assert.equal(await page.locator('.panel--market').count(), 1);
  await page.getByRole('button', { name: /ETH\/USD/ }).click();
  assert.match(await page.locator('.panel-header h2').innerText(), /Ethereum/);
  await page.getByRole('button', { name: /BTC\/USD/ }).click();
  await page.getByRole('button', { name: '走势 · binance-vision', exact: true }).click();
  await page.getByRole('button', { name: '最近 20', exact: true }).click();
  const chart = page.locator('.price-chart');
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .5);
  await page.locator('.chart-crosshair').waitFor();
  assert.equal(await page.locator('.chart-crosshair').count(), 1);
  await page.locator('.chart-wrap').focus();
  await page.keyboard.press('Home');
  const firstReadout = await page.locator('.chart-readout').innerText();
  await page.keyboard.press('End');
  assert.notEqual(await page.locator('.chart-readout').innerText(), firstReadout);
  await page.screenshot({ animations: 'disabled', path: `${dir}/after-market-desktop.png`, fullPage: true });
  await page.getByRole('button', { name: 'K 线 · binance-vision', exact: true }).click();
  await page.locator('.candle').first().waitFor();
  report.candles = await page.locator('.candle').count();

  await page.getByRole('tab', { name: /^期权/ }).click();
  assert.equal(await page.locator('.price-chart').count(), 0);
  await page.locator('.options-workspace').waitFor();
  await page.getByRole('alert').filter({ hasText: 'TRADIER_ACCESS_TOKEN' }).waitFor();
  await page.getByRole('tab', { name: /^情报$/ }).click();
  await page.locator('.news-item').first().waitFor();
  const firstTitle = await page.locator('.news-item h4').first().innerText();
  const nextNewsPage = page.getByRole('button', { name: '下一页', exact: true });
  if (await nextNewsPage.count()) {
    await nextNewsPage.click();
    assert.notEqual(await page.locator('.news-item h4').first().innerText(), firstTitle);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
  }
  await page.getByRole('textbox', { name: '搜索新闻' }).fill('no-matching-headline-xyz');
  assert.equal(await page.locator('.news-item').count(), 0);
  await page.getByRole('textbox', { name: '搜索新闻' }).fill('');
  await page.getByRole('button', { name: '记录判断 →' }).first().click();
  await page.locator('.research-form').waitFor();
  assert.equal((await page.locator('.research-form').getByLabel('关联新闻（可多选）').evaluate(select => Array.from(select.selectedOptions).length)), 1);
  assert.ok(firstTitle.includes(await page.getByRole('textbox', { name: '判断标题' }).inputValue()));
  const testTitle = `浏览器验收：利率观察 ${Date.now()}`;
  await page.getByRole('textbox', { name: '判断标题' }).fill(testTitle);
  await page.locator('.research-form select').first().selectOption('rates');
  await page.getByRole('textbox', { name: '已知事实' }).fill('测试记录：原始新闻是证据，未把预测写成已发生的事实。');
  await page.getByRole('textbox', { name: '我的判断' }).fill('测试判断：等待下次官方公布后核对。');
  await page.getByRole('textbox', { name: '证伪条件' }).fill('公布的数据与假设不符。');
  await page.getByRole('button', { name: '保存判断', exact: true }).click();
  const entry = page.locator('.journal-card').filter({ hasText: testTitle });
  await entry.waitFor();
  await entry.getByRole('button', { name: '追加验证' }).click();
  await entry.getByLabel('验证结论').selectOption('mixed');
  await entry.getByRole('textbox', { name: '实际结果与依据' }).fill('验证样本：保留原始判断，追加新证据。');
  await entry.getByRole('button', { name: '保存验证' }).click();
  await entry.locator('.review-timeline').waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.review-timeline').first().waitFor();
  assert.match(await page.locator('.journal-card').filter({ hasText: testTitle }).innerText(), /测试判断：等待下次官方公布后核对/);
  await page.screenshot({ animations: 'disabled', path: `${dir}/after-research-desktop.png`, fullPage: true });

  await page.getByRole('tab', { name: '持仓', exact: true }).click();
  assert.equal(await page.locator('.manual-ledger-fold').getAttribute('open'), null);
  await page.locator('.manual-ledger-fold > summary').click();
  const form = page.locator('.transaction-form');
  await form.getByLabel('标的', { exact: true }).selectOption('btc-usd');
  await form.getByLabel('数量', { exact: true }).fill('0.01');
  await form.getByLabel('价格', { exact: true }).fill('70000');
  await form.getByLabel('手续费', { exact: true }).fill('1');
  await form.getByLabel('币种', { exact: true }).fill('USD');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/transactions') && response.request().method() === 'POST');
  await form.getByRole('button', { name: '保存交易' }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const transaction = (await response.json()).transaction;
  createdTrades.push(transaction.id);
  await page.locator('.widget--ledger tbody tr').first().waitFor();
  const linkedRow = page.locator('.widget--ledger tbody tr').filter({ hasText: 'BTC/USD' }).first();
  await linkedRow.getByRole('button', { name: '记录判断', exact: true }).click();
  await page.locator('.research-form').waitFor();
  const selectedTrades = await page.locator('.research-form').getByLabel('关联交易（可多选）').evaluate(select => Array.from(select.selectedOptions, option => option.value));
  assert.equal(selectedTrades.length, 1);
  const allTrades = (await (await page.request.get(`${url}/api/transactions`)).json()).transactions;
  assert.equal(allTrades.find(t => t.id === selectedTrades[0])?.instrumentId, 'btc-usd');
  await page.getByRole('textbox', { name: '判断标题' }).fill(`交易关联验收 ${Date.now()}`);
  await page.getByRole('textbox', { name: '已知事实' }).fill('测试买入成交已记录。');
  await page.getByRole('textbox', { name: '我的判断' }).fill('检查交易链接与账户隔离。');
  await page.getByRole('textbox', { name: '证伪条件' }).fill('链接缺失或错误。');
  await page.getByRole('button', { name: '保存判断', exact: true }).click();
  await page.getByText('判断已保存，后续可追加验证记录。').waitFor();

  await page.getByRole('tab', { name: '券商', exact: true }).click();
  await page.locator('.broker-connections article').first().waitFor();
  assert.equal(await page.getByRole('button', { name: '同步持仓和成交' }).count(), 2);
  assert.equal(await page.getByRole('button', { name: '同步持仓和成交', disabled: true }).count(), 2);
  await page.screenshot({ animations: 'disabled', path: `${dir}/after-brokers-desktop.png`, fullPage: true });

  const widths = [1440, 768, 390, 320];
  report.layout = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const section of ['overview', 'crypto', 'positions', 'research', 'brokers', 'intel', 'system']) {
      await page.evaluate(section => { location.hash = `/${section}`; }, section);
      await page.locator(`#section-${section}`).waitFor();
      const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(geometry.scrollWidth <= width + 1, `horizontal page overflow at ${width}/${section}: ${geometry.scrollWidth}`);
      report.layout.push({ width, section, ...geometry });
    }
    if (width === 390) {
      await page.evaluate(() => { location.hash = '/overview'; });
      await page.locator('.overview-sections').waitFor();
      await page.screenshot({ animations: 'disabled', path: `${dir}/after-overview-mobile.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => { location.hash = '/overview'; });
  await page.locator('.overview-sections').waitFor();
  await page.screenshot({ animations: 'disabled', path: `${dir}/after-overview-light.png`, fullPage: true });
  await page.getByRole('tab', { name: '总览', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '持仓', exact: true }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
  report.browserErrors = errors;
  report.completed = ['overview', 'descriptor navigation', 'single instrument selection', 'chart range and pointer/keyboard readout', 'candles', 'unavailable capabilities', 'global news and search', 'news to research', 'immutable research and persisted reviews', 'manual transaction entry', 'transaction to research', 'unconfigured brokers', '28 responsive layouts', 'light theme', 'tab keyboard navigation'];
  for (const id of createdTrades) await page.request.delete(`${url}/api/transactions/${encodeURIComponent(id)}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  await writeFile(`${dir}/browser-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ animations: 'disabled', path: `${dir}/failure.png`, fullPage: true }); await writeFile(`${dir}/failure.txt`, await page.locator('body').innerText()); }
  throw error;
} finally { await browser.close(); }
