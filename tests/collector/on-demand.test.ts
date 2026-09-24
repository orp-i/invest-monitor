import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry, binanceVisionAdapter } from "@invest/adapters";
import { CollectorScheduler } from "@invest/collector";
import { parseConfigText, type ConfigSnapshot } from "@invest/config";

async function setup(count=2, held:string[]=["test-0"], fetch = vi.fn(async () => ({ok:true as const,value:{status:200,headers:{},body:new TextEncoder().encode('{}'),receivedAt:new Date().toISOString(),serverDate:null,clockSkewMs:null,egressProfileUsed:"direct" as const,url:"https://example.invalid"}})), automaticStocks=false) {
  const loaded=parseConfigText(await readFile('config/portfolio.yaml','utf8'));if(!loaded.ok)throw Error('config');
  const base=loaded.config.instruments.find(i=>i.id==='btc-usd')!, binding=base.sourceBindings.find(b=>b.sourceId==='binance-vision')!;
  const registry=new AdapterRegistry();registry.register({...binanceVisionAdapter,fetch,parse:()=>({ok:true,value:{}}),normalize:()=>({ok:true,value:{kind:"candles",value:[]}})});
  const config={...loaded.config,sources:loaded.config.sources.filter(s=>s.id==='binance-vision').map(s=>({...s,rateLimit:{...s.rateLimit,requestsPerSecond:1000,burst:100}})),instruments:Array.from({length:count},(_,i)=>({...base,assetClass:automaticStocks ? "equity" as const : base.assetClass,id:`test-${i}`,sourceBindings:[{...binding,instrumentId:`test-${i}`,cadenceSeconds:1}]}))};
  const snapshot:ConfigSnapshot={config,generation:1,sha256:'test',loadedAt:new Date().toISOString()};
  const scheduler=new CollectorScheduler({appendRawEvent:async()=>1,recordSourceHealth:async()=>{}} as never,{} as never,registry,async()=>null,{onDemand:true,automaticStocks});
  scheduler.setBackgroundQuoteInstruments(held);await scheduler.start(snapshot);return {scheduler,fetch,snapshot};
}
afterEach(()=>vi.useRealTimers());
describe('on-demand collector',()=>{
  it('automatically starts all stock quote/history jobs beyond four slots and backfills a new watch item',async()=>{
    vi.useFakeTimers();let release!:()=>void;const gate=new Promise<void>(r=>{release=r});
    const fetch=vi.fn(async()=>{await gate;return {ok:true as const,value:{status:200,headers:{},body:new TextEncoder().encode('{}'),receivedAt:new Date().toISOString(),serverDate:null,clockSkewMs:null,egressProfileUsed:'direct' as const,url:'https://example.invalid'}}});
    const {scheduler,snapshot}=await setup(6,[],fetch,true);
    try {
      await vi.advanceTimersByTimeAsync(10);expect(fetch).toHaveBeenCalledTimes(12);expect(scheduler.status().pausedJobs).toBe(0);
      const first=snapshot.config.instruments[0], added={...first,id:'new-stock',sourceBindings:first.sourceBindings.map(b=>({...b,instrumentId:'new-stock'}))};
      await scheduler.applySnapshot({...snapshot,generation:2,config:{...snapshot.config,instruments:[...snapshot.config.instruments,added]}});
      await vi.advanceTimersByTimeAsync(10);expect(fetch).toHaveBeenCalledTimes(14);expect(scheduler.status().activeJobs).toBe(14);
    } finally {await scheduler.stop();release();await vi.advanceTimersByTimeAsync(10);}
  });
  it('keeps holdings quotes, activates only the selected details and expires/replaces per-tab leases',async()=>{
    vi.useFakeTimers();const {scheduler,fetch}=await setup();
    try {
      await vi.advanceTimersByTimeAsync(10);expect(fetch.mock.calls).toHaveLength(1);expect(scheduler.status().pausedJobs).toBe(3);
      scheduler.setInterest('browser-tab-1','test-1');await vi.advanceTimersByTimeAsync(10);expect(scheduler.status().pausedJobs).toBe(1);
      scheduler.setInterest('browser-tab-1',null);expect(scheduler.status().pausedJobs).toBe(3);
      const inactiveCalls=fetch.mock.calls.filter(c=>(c as unknown as [{instrument:{id:string}}])[0].instrument.id==='test-1').length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetch.mock.calls.filter(c=>(c as unknown as [{instrument:{id:string}}])[0].instrument.id==='test-1')).toHaveLength(inactiveCalls);
      scheduler.setInterest('browser-tab-1','test-0');scheduler.setInterest('browser-tab-2','test-1');expect(scheduler.status().pausedJobs).toBe(0);
      scheduler.setInterest('browser-tab-1',null);expect(scheduler.status().pausedJobs).toBe(1);
      await vi.advanceTimersByTimeAsync(91000);expect(scheduler.status().pausedJobs).toBe(3);
    } finally {await scheduler.stop();}
  });
  it('caps background concurrency at four and does not duplicate in-flight jobs after reload',async()=>{
    vi.useFakeTimers();let release!:()=>void;const gate=new Promise<void>(r=>{release=r});
    const fetch=vi.fn(async()=>{await gate;return {ok:true as const,value:{status:200,headers:{},body:new TextEncoder().encode('{}'),receivedAt:new Date().toISOString(),serverDate:null,clockSkewMs:null,egressProfileUsed:'direct' as const,url:'https://example.invalid'}}});
    const {scheduler,snapshot}=await setup(8,Array.from({length:8},(_,i)=>`test-${i}`),fetch);
    try {await vi.advanceTimersByTimeAsync(10);expect(fetch).toHaveBeenCalledTimes(4);await scheduler.applySnapshot({...snapshot,generation:2});await vi.advanceTimersByTimeAsync(1000);expect(fetch).toHaveBeenCalledTimes(4);expect(scheduler.status().activeJobs).toBe(4);}
    finally {await scheduler.stop();release();await vi.advanceTimersByTimeAsync(10);}
  });
});
