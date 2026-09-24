// The API must be stopped before --migrate. The old volume is retained until
// the deployed application and archived/financial record counts are verified.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { mkdir, chown, chmod, copyFile, open, readdir, symlink, writeFile } from 'node:fs/promises';
const base='/archive/invest';
for(const name of ['db','market-archive','logs']) {
  await mkdir(`${base}/${name}`,{recursive:true,mode:0o700});await chown(`${base}/${name}`,10001,10001);await chmod(`${base}/${name}`,0o700);
}
if(!process.argv.includes('--migrate')) { console.log(JSON.stringify({prepared:true})); process.exit(0); }
const source='/source-volume/invest.sqlite';
const db=new DatabaseSync(source);
const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
if(Object.values(checkpoint)[0]!==0)throw Error('Source still has an active writer/reader; do not copy');
const counts=Object.fromEntries(['quotes','candles','raw_events','source_health','broker_snapshots','trading_statement_imports','trading_review_cases','transactions'].map(t=>[t,db.prepare(`SELECT COUNT(*) AS count FROM ${t}`).get().count]));
const check=db.prepare('PRAGMA quick_check').all();
if(check.some(r=>Object.values(r)[0]!=='ok'))throw Error('Source integrity check failed');
db.close();
async function digest(path) { const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex'); }
const hash=await digest(source);
for(const target of [`${base}/db/invest.sqlite`,`${base}/backups/volume/pre-partitions-20260905.sqlite`]) {
  await copyFile(source,target,constants.COPYFILE_EXCL);await chown(target,10001,10001);await chmod(target,0o600);
  const fd=await open(target,'r+');await fd.sync();await fd.close();
  if(await digest(target)!==hash)throw Error('Database checksum mismatch');
}
for(const name of await readdir('/source-volume')) {
  if(/^(pre-|post-|predeploy-).+\.sqlite$/.test(name))await symlink(`/app/backups/volume/${name}`,`${base}/db/${name}`);
}
const report={at:new Date().toISOString(),checkpoint,counts,sha256:hash,sourceRetained:true};
await writeFile(`${base}/backups/service-migration-20260905.json`,JSON.stringify(report,null,2),{mode:0o600});
await chown(`${base}/backups/service-migration-20260905.json`,1000,1000);
console.log(JSON.stringify(report));
