// Isolated browser review API. Uses recorded fixtures and never contacts providers.
// Run npm run build first. This server deliberately has no authentication; it binds loopback only.
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../../apps/server/dist/app.js';
import { SseEventHub } from '../../apps/server/dist/events.js';
import { createStorageDriver } from '../../packages/storage/dist/index.js';
import { loadConfigFile } from '../../packages/config/dist/index.js';
import { tagNewsByRules } from '../../packages/intel/dist/index.js';
import { QuoteSchema, computeFreshness } from '../../packages/domain/dist/index.js';
for (const key of ['TRADIER_ACCESS_TOKEN', 'IBKR_FLEX_TOKEN', 'IBKR_FLEX_QUERY_ID']) delete process.env[key];
const readFixture = async name => JSON.parse(await readFile(new URL(`../../docs/prototype/fixtures/${name}.json`, import.meta.url), 'utf8'));
const fixture = process.env.INVEST_REVIEW_FIXTURE
  ? JSON.parse(await readFile(process.env.INVEST_REVIEW_FIXTURE, 'utf8'))
  : { quotes: await readFixture('quotes'), news: await readFixture('news'), health: await readFixture('source-health'), charts: { btc: await readFixture('history-btc-binance') } };
const loaded = await loadConfigFile(new URL('../../config/portfolio.yaml', import.meta.url).pathname);
if (!loaded.ok) throw Error('config invalid');
const directory = process.env.INVEST_REVIEW_DATA_DIR ?? await mkdtemp(join(tmpdir(), 'invest-ui-review-'));
await mkdir(directory, { recursive: true });
const storage = createStorageDriver('node-sqlite', join(directory, 'invest.sqlite'));
await storage.open(); await storage.migrate();
await storage.syncConfigInstruments(loaded.config.instruments.map(instrument => ({ ...instrument, origin: 'config', shadowed: false })), Date.now());
const quotes = fixture.quotes.quotes.filter(row => row.quote).map(row => ({ ...row.quote, rawRef: null }));
await storage.appendQuotes(quotes.map(row => QuoteSchema.parse(row)));
for (const data of Object.values(fixture.charts)) {
  for (const row of data.history ?? []) {
    const base = quotes.find(quote => quote.sourceId === row.sourceId && quote.instrumentId === row.instrumentId);
    if (!base) continue;
    const capturedAt = new Date(row.capturedAtMs).toISOString(), receivedAt = new Date(row.receivedAtMs).toISOString();
    const quote = QuoteSchema.parse({ ...base, ...row, capturedAt, receivedAt, freshness: computeFreshness(capturedAt, receivedAt, base.freshness.staleAfterSeconds) });
    await storage.appendQuotes([quote]);
  }
}
for (const original of fixture.news.news) { const rules = tagNewsByRules(original.title, original.contentText, loaded.config.instruments, original.sourceId); const item = { ...original, ...rules }; await storage.writeNews({ item, associations: item.instrumentIds.map(id => ({ instrumentId: id, method: 'rule', confidence: null })), provenance: { sourceId: item.sourceId, url: item.url, title: item.title, contentHash: item.contentHash, fetchedAt: item.fetchedAt, rawEventId: null } }); }
for (const row of (await storage.getLatestSourceHealth()).length ? [] : fixture.health.health) await storage.recordSourceHealth({ ...row, observedAt: new Date(row.observedAtMs).toISOString(), lastSuccessAt: row.lastSuccessAtMs ? new Date(row.lastSuccessAtMs).toISOString() : null, lastError: null, egressProfileUsed: row.egressProfileUsed ?? 'direct' });
const candles = (await readFixture('candles-btc-binance')).candles;
if (candles?.length) await storage.appendCandles(candles);
const events = new SseEventHub();
const deps = {
  configManager: { snapshot: { config: loaded.config, generation: 1, sha256: 'local-review', loadedAt: new Date().toISOString() } }, storage, events,
  scheduler: { sourceCapabilityAvailable: (id, cap) => loaded.config.sources.some(source => source.id === id && source.enabled && source.capabilities.includes(cap)), sourceFreshnessClass: () => 'realtime', sourceAuthConfigured: () => false },
  authMode: 'off', authToken: null,
};
const server = createServer(async (req, res) => { try { await handleRequest(req, res, deps); } catch (error) { console.error(error.message); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'local review server error' })); } });
server.listen(3105, '127.0.0.1', () => console.log(`Isolated review API on 127.0.0.1:3105; captured market data. Disposable ledger: ${directory}`));
process.on('SIGTERM', async () => { events.close(); server.close(); await storage.close(); process.exit(0); });
