// Reclaim the stopped old volume only after verifying the complete /data copy.
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {readFile,lstat,symlink,rename,unlink,writeFile,open} from 'node:fs/promises';
const source='/source-volume/invest.sqlite', backup='/archive/invest/backups/volume/pre-partitions-20260905.sqlite',path='/archive/invest/backups/service-migration-20260905.json';
const report=JSON.parse(await readFile(path,'utf8'));
async function hash(p){const h=createHash('sha256');for await(const chunk of createReadStream(p))h.update(chunk);return h.digest('hex')}
async function syncDirectory(p){const fd=await open(p,'r');try{await fd.sync()}finally{await fd.close()}}
if((await lstat(source)).isSymbolicLink())throw Error('Old source already migrated');
if(await hash(source)!==report.sha256||await hash(backup)!==report.sha256)throw Error('Source or rollback copy differs; refusing cleanup');
for(const dir of ['/archive/invest/db','/archive/invest/backups/volume'])await syncDirectory(dir);
for(const suffix of ['-wal','-shm']){try{const stat=await lstat(source+suffix);if(suffix==='-wal'&&stat.size!==0)throw Error('Old database has new WAL records');await unlink(source+suffix)}catch(e){if(e.code!=='ENOENT')throw e}}
await symlink('/app/backups/volume/pre-partitions-20260905.sqlite',source+'.verified-link');
await rename(source+'.verified-link',source);
await syncDirectory('/source-volume');
report.sourceRetained=false;report.sourceReclaimedAt=new Date().toISOString();report.rollbackCopy=backup.replace('/archive','/data');
const reportTemp=path+'.verified-tmp';
await writeFile(reportTemp,JSON.stringify(report,null,2),{mode:0o600});
const reportFd=await open(reportTemp,'r');try{await reportFd.sync()}finally{await reportFd.close()}
await rename(reportTemp,path);await syncDirectory('/archive/invest/backups');
console.log(JSON.stringify({verified:true,oldDatabaseReclaimed:true,rollbackCopy:report.rollbackCopy}));
