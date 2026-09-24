import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { createStorageDriver } from "@invest/storage";
import { handleRequest } from "../../apps/server/src/app.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function api(method: string, url: string, body: unknown, deps: unknown, headers: Record<string, string> = {}) {
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
  request.method = method; request.url = url; request.headers = headers;
  let status = 0, text = "";
  const response = { set statusCode(v: number) { status = v; }, setHeader() {}, end(v?: string) { text = v ?? ""; } };
  await handleRequest(request, response as never, deps as never);
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* non-JSON reply */ }
  return { status, body: parsed };
}

it("requires the request header on every state-changing API method, including routes that do not exist yet", async () => {
  const deps = { authMode: "off", authToken: null };
  for (const [method, url] of [["POST", "/api/not-a-route"], ["PATCH", "/api/research/board/x"], ["DELETE", "/api/transactions/x"], ["PUT", "/api/anything"]] as const) {
    const reply = await api(method, url, {}, deps);
    expect(reply.status).toBe(403); expect(reply.body).toEqual({ error: "csrf_required" });
  }
  expect((await api("POST", "/api/not-a-route", {}, deps, { "x-requested-with": "XMLHttpRequest" })).status).not.toBe(403);
  expect((await api("GET", "/api/not-a-route", undefined, deps)).status).not.toBe(403);
  expect((await api("POST", "/api/not-a-route", {}, { ...deps, authMode: "token", authToken: "isolated-token" }, { authorization: "Bearer isolated-token" })).status).not.toBe(403);
});

it("omits raw performance samples when history=0 while keeping the aggregated daily candles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invest-api-hardening-")); dirs.push(dir);
  const storage = createStorageDriver("node-sqlite", join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
  try {
    const deps = { storage, authMode: "off", authToken: null, configManager: { snapshot: { config: { sources: [], instruments: [] } } } };
    const full = await api("GET", "/api/performance", undefined, deps);
    expect(full.status).toBe(200); expect(full.body).toHaveProperty("history"); expect(full.body).toHaveProperty("daily"); expect(full.body).toHaveProperty("schedule");
    const slim = await api("GET", "/api/performance?history=0", undefined, deps);
    expect(slim.status).toBe(200); expect(slim.body).not.toHaveProperty("history");
    expect(slim.body.daily).toEqual(full.body.daily); expect({ ...slim.body.current, capturedAt: null }).toEqual({ ...full.body.current, capturedAt: null });
  } finally { await storage.close(); }
});
