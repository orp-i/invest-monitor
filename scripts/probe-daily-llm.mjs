// Run inside the API container; env credentials stay in memory. No business DB access.
// Default: GET /models only. --complete: one tiny, real model request after detection.
import { loadConfigFile } from '@invest/config';
import { EgressHttpClient, EgressDispatcherPool } from '@invest/egress';
import { fileURLToPath } from 'node:url';
import { dailyLlmProvider, DailyLlmError } from '../apps/server/dist/daily-llm.js';
import { dailyLlmEgressProfiles } from '../apps/server/dist/daily-llm-egress.js';

const config = await loadConfigFile(fileURLToPath(new URL('../config/portfolio.yaml', import.meta.url)));
if (!config.ok) throw Error('Cannot read application config');
const raw = config.config.egressProfiles;
const proxy = process.env.EGRESS_SINGLE_PROXY_URL || process.env.DOCKER_EGRESS_PROXY_URL || raw.vpn.proxyUrl;
const profiles = dailyLlmEgressProfiles({ ...raw, vpn: { ...raw.vpn, proxyUrl: proxy } });
const http = new EgressHttpClient(new EgressDispatcherPool(profiles));
const provider = dailyLlmProvider(http);
try {
  const started = Date.now();
  const connection = await provider.checkConnection();
  const result = { at: new Date().toISOString(), provider: provider.status().provider, model: provider.status().model, connection, detectionMs: Date.now() - started };
  console.log(JSON.stringify(result));
  if (process.argv.includes('--complete')) {
    const began = Date.now();
    const reply = await provider.complete('This is an API connectivity test. Return only JSON: {"ok":true}.', 'Return JSON {"ok":true}.', new AbortController().signal);
    const validated = JSON.parse(reply.text).ok === true;
    console.log(JSON.stringify({ completion: validated ? 'passed' : 'unexpected', durationMs: Date.now() - began, model: reply.model, usage: reply.usage, route: reply.connection?.selected }));
    if (!validated) process.exitCode = 1;
  } else if (!connection.recommended) process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ error: error instanceof DailyLlmError ? error.message : 'Connection verification failed' })); process.exitCode = 1; }
finally { await provider.close(); await http.close(); }
