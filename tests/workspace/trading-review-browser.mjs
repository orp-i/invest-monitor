// Only writes to the disposable loopback review server, never production.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const url = process.env.INVEST_UI_TEST_URL ?? 'http://127.0.0.1:5175';
if (new URL(url).hostname !== '127.0.0.1') throw Error('Isolated loopback server required');
const dir = process.env.INVEST_UI_ARTIFACTS ?? '/tmp/invest-trading-review-browser'; await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(), headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
const report = { errors: [], widths: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', e => report.errors.push(e.message));
  const suffix = Date.now().toString();
  for (const [type, price, time] of [['buy', '100', Date.now()-3600000], ['sell', '112', Date.now()-1800000]]) {
    const r = await page.request.post(url + '/api/transactions', { headers: { 'X-Requested-With': 'XMLHttpRequest' }, data: { accountId: 'manual', instrumentId: 'aapl-usd', type, quantity: '2', price, fees: '1', currency: 'USD', tradeAtMs: time } });
    assert.equal(r.status(), 201, await r.text());
  }
  await page.goto(url); await page.locator('.overview-sections').waitFor();
  await page.getByRole('tab', { name: /^交易复盘/ }).click(); await page.locator('.tr-header').waitFor();
  await page.getByRole('button', { name: '＋ 新建交易档案' }).click();
  await page.getByLabel('档案标题', { exact: true }).fill('浏览器复盘验证 ' + suffix);
  await page.getByLabel('策略名称', { exact: true }).fill('浏览器测试策略');
  await page.getByLabel('搜索可关联成交', { exact: true }).fill('AAPL');
  for (const check of await page.locator('.tr-fill-options input[type=checkbox]').all()) await check.check();
  await page.getByLabel('我已关联这笔策略从首次建仓至今的全部成交（组合各腿均包含）').check();
  await page.getByRole('button', { name: '建立档案', exact: true }).click();
  await page.locator('.tr-detail-heading h3').filter({ hasText: suffix }).waitFor();
  assert.match(await page.locator('.tr-case-detail .tr-stats').first().innerText(), /22\.00 USD/);
  assert.equal(await page.getByRole('tab', { name: '交易计划', exact: true }).count(), 0);
  assert.match(await page.locator('.execution-summary').innerText(), /100.0000/);
  assert.match(await page.locator('.execution-summary').innerText(), /112.0000/);
  await page.getByRole('tab', { name: '成交明细', exact: true }).click();
  assert.equal(await page.locator('.execution-rows tbody tr').count(), 2);
  await page.getByRole('tab', { name: '新闻与判断', exact: true }).click();
  await page.getByLabel('证据标题', { exact: true }).fill('浏览器测试证据');
  await page.getByLabel('已经核实的事实', { exact: true }).fill('仅用于测试的数据');
  await page.getByRole('button', { name: '保存证据', exact: true }).click();
  await page.locator('.tr-history').filter({ hasText: '证据 · 浏览器测试证据' }).waitFor();
  await page.getByRole('tab', { name: '图文学习', exact: true }).click();
  await page.locator('.original-image').first().waitFor();
  assert.equal(await page.locator('.original-image').count(), 10);
  await page.locator('.original-heading').filter({ hasText: '07 · 叙事/催化剂确认收益曲线' }).getByRole('button').click();
  await page.getByRole('tab', { name: '逐笔复盘', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: contentTitle(), exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByLabel('复盘结论', { exact: true }).fill('测试发现：价格与手续费核对一致。');
  await page.getByLabel('下次改进', { exact: true }).fill('交易完成后核对费用。');
  await page.getByRole('button', { name: '保存逐笔复盘', exact: true }).click();
  await page.locator('.tr-history').filter({ hasText: '事后复盘' }).waitFor();
  await page.getByRole('tab', { name: '周末复盘', exact: true }).click();
  await page.locator('.weekly-trade-chart svg').waitFor();
  await page.getByLabel('本周主要宏观变化', { exact: true }).fill('测试周报：本周利率预期变化。');
  await page.getByLabel('对市场的影响', { exact: true }).fill('测试影响：美债、黄金、原油分开核对。');
  await page.getByLabel('下周潜在交易机会', { exact: true }).fill('测试判断：等待关键数据后验证方向。');
  await page.getByRole('button', { name: '＋ 添加关键事件', exact: true }).click();
  await page.getByLabel('事件 1 名称', { exact: true }).fill('测试事件');
  await page.getByLabel('事件 1 时间', { exact: true }).fill('2026-09-08T12:30');
  await page.getByLabel('事件 1 影响', { exact: true }).fill('观察利率预期');
  await page.getByLabel('事件 1 来源', { exact: true }).fill('https://www.federalreserve.gov/');
  await page.getByRole('button', { name: '保存本次周报快照', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="查看历史周报"]')?.options.length > 1);
  await page.getByLabel('查看历史周报', { exact: true }).selectOption({ index: 1 });
  assert.match(await page.locator('.tr-weekly').innerText(), /测试周报/);
  assert.match(await page.locator('.macro-event-timeline').innerText(), /测试事件/);
  await page.getByRole('tab', { name: '止盈算例', exact: true }).click();
  await page.getByLabel('初始数量 Q', { exact: true }).fill('10'); await page.getByLabel('初始单位借方成本 P', { exact: true }).fill('2');
  await page.getByLabel('数量必须是整数合约 / 组合单位', { exact: true }).check();
  await page.getByRole('alert').filter({ hasText: '不可成交的小数合约' }).waitFor();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const tab of ['交易档案', '周末复盘', '图文学习', '止盈算例']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const sw = await page.evaluate(() => document.documentElement.scrollWidth); assert.ok(sw <= width, `${tab} overflows ${width}: ${sw}`);
      report.widths.push({ width, tab, scrollWidth: sw });
      if (width === 1440 || width === 390) await page.screenshot({ path: `${dir}/${width}-${tab}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' }); await page.getByRole('tab', { name: '图文学习', exact: true }).click();
  await page.screenshot({ path: `${dir}/390-learning-light.png`, fullPage: true });
  await page.locator('.original-image img').evaluateAll(imgs => imgs.forEach(i => { i.loading = 'eager'; }));
  await page.waitForFunction(() => [...document.querySelectorAll('.original-image img')].every(i => i.complete && i.naturalWidth > 0));
  const images = await page.locator('.original-image img').evaluateAll(imgs => imgs.map(i => ({ ok: i.complete && i.naturalWidth > 0, ratio: i.width / i.height, natural: i.naturalWidth / i.naturalHeight })));
  assert.ok(images.every(i => i.ok && Math.abs(i.ratio - i.natural) < 0.03));
  await page.reload(); await page.locator('.tr-header').waitFor();
  const api = await (await page.request.get(url + '/api/trading-review')).json();
  const saved = api.cases.find(c => c.title.endsWith(suffix)); assert.equal(saved.plans.length, 0); assert.equal(saved.assessments.length, 1);
  report.savedCase = true; report.images = images.length; assert.deepEqual(report.errors, []);
  await writeFile(`${dir}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }
function contentTitle() { return '叙事/催化剂确认收益曲线'; }
