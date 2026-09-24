// Run with only the old backups and /data/invest mounted; never moves invest.sqlite.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, lstat, copyFile, open, rename, unlink, symlink, chmod, chown, writeFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

const apply = process.argv.includes('--apply');
const destination = '/archive/invest/backups';
const volumeNames = /^(?:pre-[a-z0-9-]+-20260905|post-statements-usd-20260905|predeploy-20260905T065228Z)\.sqlite(?:-shm|-wal)?$/;
const report = { at: new Date().toISOString(), files: [], bytes: 0 };
async function hash(path) { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); }
async function directory(path, uid) { await mkdir(path, { recursive: true, mode: 0o700 }); await chown(path, uid, uid); await chmod(path, 0o700); }
async function moveFile(source, target, uid, linkTarget) {
  const before = await lstat(source);
  if (before.isSymbolicLink()) {
    if (await readlink(source) !== linkTarget) throw Error(`Unexpected link: ${source}`);
    await lstat(target); return;
  }
  if (!before.isFile()) throw Error(`Not a regular backup: ${source}`);
  if (source.endsWith('-wal') && before.size !== 0) throw Error(`Backup has uncheckpointed WAL: ${source}`);
  if (!apply) { console.log(JSON.stringify({ source, target, bytes: before.size })); return; }
  const digest = await hash(source);
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  await chmod(target, 0o600); await chown(target, uid, uid);
  const handle = await open(target, 'r+'); await handle.sync(); await handle.close();
  if (await hash(target) !== digest) throw Error(`Checksum mismatch: ${source}`);
  const after = await lstat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error(`Backup changed: ${source}`);
  const temporaryLink = `${source}.migration-link`;
  await symlink(linkTarget, temporaryLink);
  // Atomic replacement only after the complete destination is flushed and verified.
  await rename(temporaryLink, source);
  report.files.push({ source, target, bytes: before.size, sha256: digest }); report.bytes += before.size;
  console.log(JSON.stringify({ migrated: source, bytes: before.size, verified: true }));
}
if (apply) {
  await mkdir('/archive/invest', { recursive: true, mode: 0o755 });
  await mkdir(destination, { recursive: true, mode: 0o755 });
  await directory(`${destination}/volume`, 10001);
  await directory(`${destination}/workspace`, 1000);
}
for (const name of (await readdir('/source-volume')).filter(n => volumeNames.test(n)).sort()) {
  await moveFile(join('/source-volume', name), join(destination, 'volume', name), 10001, `/app/backups/volume/${name}`);
}
async function workspaceFiles(relative = '') {
  const source = join('/source-workspace', relative);
  for (const name of await readdir(source)) {
    const child = join(relative, name), stat = await lstat(join(source, name));
    if (stat.isDirectory()) {
      if (apply) await directory(join(destination, 'workspace', child), 1000);
      await workspaceFiles(child);
    } else await moveFile(join(source, name), join(destination, 'workspace', child), 1000, `/data/invest/backups/workspace/${child}`);
  }
}
await workspaceFiles();
if (apply) {
  const path = `${destination}/migration-20260905.json`;
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  await chown(path, 1000, 1000);
}
console.log(JSON.stringify({ complete: true, apply, files: report.files.length, bytes: report.bytes }));
