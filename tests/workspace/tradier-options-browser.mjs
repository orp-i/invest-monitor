import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const base=process.env.INVEST_UI_TEST_URL ?? 'http://127.0.0.1:5175';
if(new URL(base).hostname!=='127.0.0.1') throw Error('Use disposable loopback preview');
const dir='/tmp/invest-tradier-options-browser'; await mkdir(dir,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox','--no-proxy-server']});
const report={errors:[],layouts:[]};
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>report.errors.push(e.message));
 const meta={source:'Tradier',environment:'live',currency:'USD',receivedAt:new Date().toISOString()};
 const rows=Array.from({length:70},(_,i)=>{const strike=200+Math.floor(i/2)*5;const right=i%2?'put':'call';return {symbol:`AAPL301220${right==='call'?'C':'P'}${String(strike*1000).padStart(8,'0')}`,description:`Test option ${strike}`,type:'option',last:'2.12',bid:'0',ask:'2.15',tradeAt:'2026-09-04T19:00:00Z',bidAt:'2026-09-04T19:10:00Z',askAt:'2026-09-04T19:10:00Z',volume:'120',openInterest:'300',strike:String(strike),right,expiration:'2030-12-20',underlying:'AAPL',contractSize:'10',greeks:{delta:'0.42',gamma:'0',theta:'-0.04',vega:null,rho:null,midIv:'0.35',updatedAt:'2026-09-04 15:00:00'}}});
 let failChain=false;
 await page.route('**/api/options/expirations?*',route=>route.fulfill({json:{...meta,symbol:'AAPL',expirations:['2030-12-20','2031-01-17']}}));
 await page.route('**/api/options?*',route=>{const exp=new URL(route.request().url()).searchParams.get('expiration');return route.fulfill(failChain?{status:502,json:{message:'模拟 Tradier 暂时不可用'}}:{json:{...meta,symbol:'AAPL',expiration:exp,contracts:exp==='2030-12-20'?rows:[]}})});
 await page.route('**/api/market/quotes?*',route=>{const symbols=new URL(route.request().url()).searchParams.get('symbols');return route.fulfill({json:{...meta,quotes:symbols==='AAPL'?[{symbol:'AAPL',type:'stock',last:'260',bid:'259',ask:'261',tradeAt:'2026-09-04T19:00:00Z'}]:rows.filter(r=>r.symbol===symbols),missing:[]}})});
 await page.route('**/api/market/history?*',route=>route.fulfill({json:{...meta,notice:'Tradier 日 K 线 · 仅含完整日期',candles:[{openTime:'2026-09-01T00:00:00Z',open:'1',high:'2',low:'.5',close:'1.5'},{openTime:'2026-09-02T00:00:00Z',open:'1.5',high:'3',low:'1.2',close:'2.5'}]}}));
 await page.goto(base+'/#/options');await page.locator('.option-chain-table tbody tr').first().waitFor();
 assert.equal(await page.locator('.option-chain-table tbody tr').count(),24);
 await page.getByRole('button',{name:'定位平值附近'}).click();
 await page.locator('.option-detail .candle').first().waitFor();
 assert.match(await page.locator('.option-detail').innerText(),/AAPL301220C00260000/);
 assert.match(await page.locator('.option-detail').innerText(),/每张合约规模\s+10/);
 await page.getByRole('button',{name:'Greeks / IV',exact:true}).click();
 assert.match(await page.locator('.option-chain-table tbody').innerText(),/35.00%/);
 await page.getByLabel('期权方向').selectOption('put');
 assert.ok((await page.locator('.option-chain-table tbody').innerText()).includes('看跌 PUT'));
 assert.ok(!(await page.locator('.option-chain-table tbody').innerText()).includes('看涨 CALL'));
 for(const width of [1440,1024,768,390]){
   await page.setViewportSize({width,height:1000});
   const dimensions=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
   assert.ok(dimensions.scroll<=width+1,JSON.stringify(dimensions));report.layouts.push(dimensions);
   await page.screenshot({path:`${dir}/options-${width}.png`,fullPage:true});
 }
 await page.getByLabel('期权到期日').selectOption('2031-01-17');
 await page.getByText('Tradier 未返回这个到期日的期权合约。',{exact:true}).waitFor();
 assert.equal(await page.locator('.option-detail').count(),0);
 failChain=true; await page.getByRole('button',{name:'刷新行情',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'模拟 Tradier 暂时不可用'}).waitFor();
 assert.equal(report.errors.length,0); report.passed=true;
 await writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close()}
