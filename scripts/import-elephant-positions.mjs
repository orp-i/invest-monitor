import { readFile } from 'node:fs/promises';
import { BrokerSnapshotSchema, replayBrokerTrades } from '../packages/domain/dist/index.js';
import { Decimal } from 'decimal.js';
import { createStorageDriver } from '../packages/storage/dist/index.js';
const [input, database]=process.argv.slice(2);
if(!input||!database)throw Error('Usage: node scripts/import-elephant-positions.mjs snapshot.json database.sqlite');
const snapshot=BrokerSnapshotSchema.parse(JSON.parse(await readFile(input,'utf8')));
if(snapshot.broker!=='elephant'||!snapshot.sourceStatement)throw Error('Only verified Elephant statements are accepted');
const storage=createStorageDriver('node-sqlite',database);await storage.open();await storage.migrate();
try{
 const imports=await storage.getStatementImports();
 if(!imports.some(s=>s.sha256===snapshot.sourceStatement.sha256))throw Error('Source statement has not been verified/imported');
 const existing=(await storage.getBrokerSnapshots()).find(a=>a.broker==='elephant'&&a.accountId===snapshot.accountId);
 if(existing&&existing.asOf>snapshot.asOf)throw Error('Refusing to replace newer positions with an older report');
 const fills=[...new Map(imports.filter(s=>s.broker==='大象').flatMap(s=>s.fills.map(f=>[f.id,f]))).values()].filter(f=>f.occurredAt.slice(0,10)<=snapshot.asOf);
 snapshot.trades=fills.map(f=>({id:f.id,externalId:f.id,symbol:f.symbol,side:f.side,quantity:f.quantity,price:f.price,fees:f.feeCost,currency:f.currency,tradedAt:f.occurredAt,timePrecision:f.timePrecision,assetType:/\d{6}[CP]\d{8}$/.test(f.symbol)?'OPT':'STK',multiplier:f.multiplier,feeCurrency:f.currency,positionEffect:f.provenance.action,grossAmount:f.provenance.grossAmount}));
 for(const position of snapshot.positions){
   const rows=fills.filter(f=>f.symbol===position.symbol&&f.currency===position.currency).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
   if(!rows.length||rows[0].provenance.action!=='open')continue;
   const projection=replayBrokerTrades(rows.map(f=>({side:f.side,quantity:f.quantity,grossAmount:f.provenance.grossAmount,fees:f.feeCost})));
   if(!projection||!new Decimal(projection.quantity).eq(position.quantity))continue;
   position.costBasis=new Decimal(projection.costBasis).toDecimalPlaces(8).toFixed();
   position.averageCost=new Decimal(position.costBasis).div(position.quantity).div(position.multiplier).toDecimalPlaces(8).toFixed();
   position.unrealizedPnl=new Decimal(position.marketValue).minus(position.costBasis).toFixed();
 }
 snapshot.unrealizedPnl=snapshot.positions.every(p=>p.unrealizedPnl!==null)?snapshot.positions.reduce((n,p)=>n.plus(p.unrealizedPnl),new Decimal(0)).toFixed():null;
 snapshot.notes.push('成本已包含开仓费用；持仓表的浮动盈亏由结单市值减此成本计算，最新 Tradier 估值见总览。');
 await storage.saveBrokerSnapshots([BrokerSnapshotSchema.parse(snapshot)]);
 console.log(JSON.stringify({broker:'elephant',asOf:snapshot.asOf,positions:snapshot.positions.length,trades:snapshot.trades.length,sourceVerified:true}));
}finally{await storage.close()}
