import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const base=process.env.INVEST_UI_TEST_URL ?? 'http://127.0.0.1:5175';
if(new URL(base).hostname!=='127.0.0.1')throw Error('Use disposable loopback preview');
const dir='/tmp/invest-account-performance-browser';await mkdir(dir,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--no-proxy-server']});
const report={errors:[],layouts:[]};
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark'});page.on('pageerror',e=>report.errors.push(e.message));
 const current={currency:'USD',capturedAt:'2026-09-05T12:00:00Z',totalNet:'-12.5',realizedNet:'20',unrealizedNet:'-30',fees:'5',unallocatedFees:'2.5',equity:'3000',complete:false,missing:['RR：结单仍列示已到期期权，需核对到期或行权结果'],fills:30,duplicateFills:6,from:'2026-06-03',basis:'current',valuedPositions:2,positions:3,accounts:[{broker:'elephant',asOf:'2026-09-03'},{broker:'ibkr',asOf:'20260904'}]};
 await page.route('**/api/performance',r=>r.fulfill({json:{current,history:[{...current,basis:'old',capturedAt:'2026-09-04T12:00:00Z',totalNet:'999'},{...current,capturedAt:'2026-09-05T11:00:00Z',totalNet:'-15',unrealizedNet:'-32.5'}]}}));
 const accounts=['ibkr','tradier','elephant'].map(broker=>({broker,accountId:'test-'+broker,environment:broker==='tradier'?'live':'statement',asOf:'2026-09-03',syncedAt:current.capturedAt,currency:'USD',equity:'1000',cash:'900',unrealizedPnl:'-2',sessionRealizedPnl:null,positions:broker==='elephant'?[{id:'NOK',symbol:'NOK',assetType:'STK',multiplier:'1',quantity:'13',currency:'USD',costBasis:'223.55',averageCost:'17.19615385',marketValue:'127.01',markPrice:'9.77',unrealizedPnl:'-96.54'}]:[],trades:[],notes:broker==='elephant'?['大象期末持仓来自最新提供结单','成本已包含开仓费用']:[]}));
 await page.route('**/api/brokers',r=>r.fulfill({json:{accounts,connections:[]}}));
 await page.route('**/api/market/quotes?*',r=>r.fulfill({json:{source:'Tradier',environment:'live',currency:'USD',receivedAt:current.capturedAt,quotes:[{symbol:'NOK',type:'stock',last:'9.8',bid:'9.7',ask:'9.9',tradeAt:current.capturedAt}],missing:[]}}));
 await page.goto(base);await page.locator('.performance-metrics').waitFor();
 assert.match(await page.locator('.performance-metrics').innerText(),/-12.50/);assert.match(await page.locator('.performance-metrics').innerText(),/-5.00/);
 assert.match(await page.locator('.performance-scope').innerText(),/2.50 USD/);
 assert.match(await page.locator('.account-performance .chart-toolbar').innerText(),/2 个采样点/);
 await page.getByRole('button',{name:'未实现净盈亏',exact:true}).click();assert.match(await page.locator('.account-performance .chart-readout').innerText(),/-30.00/);
 await page.locator('.performance-missing summary').click();await page.getByText('RR：结单仍列示已到期期权，需核对到期或行权结果',{exact:true}).waitFor();
 for(const theme of ['dark','light'])for(const width of [1440,1024,768,390]){
   await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height:1000});
   const scroll=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(scroll<=width+1);report.layouts.push({theme,width,scroll});
   await page.screenshot({path:`${dir}/overview-${theme}-${width}.png`,fullPage:true});
 }
 await page.getByRole('tab',{name:'券商',exact:true}).click();await page.locator('.broker-financial-card').first().waitFor();
 assert.equal(await page.locator('.broker-financial-card').count(),3);
 const select=page.getByLabel('查看券商账户');const value=await select.locator('option').filter({hasText:'大象'}).getAttribute('value');await select.selectOption(value);
 await page.locator('.account-details tbody tr').first().waitFor();
 assert.match(await page.locator('.account-details').innerText(),/大象/);assert.match(await page.locator('.account-details').innerText(),/Tradier 成交价/);
 await page.getByRole('tab',{name:'持仓',exact:true}).click();await page.locator('.all-broker-positions tbody tr').first().waitFor();
 assert.equal(await page.locator('.manual-ledger-fold').getAttribute('open'),null);
 assert.match(await page.locator('.all-broker-positions').innerText(),/大象/);
 assert.deepEqual(report.errors,[]);report.passed=true;await writeFile(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close()}
