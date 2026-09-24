import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStaticWeb, resolveWebDistDirectory, type StaticWeb } from "../../apps/server/src/static-web.js";
import { ensureConfigFile } from "../../apps/server/src/bootstrap-config.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A built SPA directory: an index page plus one hashed asset, mirroring `apps/web/dist`. */
async function buildSite(): Promise<string> {
  const dir = await tempDir("invest-static-web-");
  await writeFile(join(dir, "index.html"), "<!doctype html><title>invest</title>");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "app.a1b2.js"), "console.log('hi')");
  return dir;
}

interface ServeResult { handled: boolean; statusCode: number; headers: Record<string, string>; body: Buffer | string | undefined }

/** Drives `web.handle` with a minimal fake request/response, mirroring the `api()` helper in api-hardening.test.ts. */
async function serve(web: StaticWeb, method: string, url: string): Promise<ServeResult> {
  const request = { method, url, headers: {} } as unknown as IncomingMessage;
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let body: Buffer | string | undefined;
  const response = {
    writeHead(status: number, h?: Record<string, string>) { statusCode = status; if (h) headers = { ...headers, ...h }; },
    setHeader(name: string, value: string) { headers[name] = value; },
    end(chunk?: Buffer | string) { body = chunk; },
  };
  const handled = await web.handle(request, response as unknown as ServerResponse);
  return { handled, statusCode, headers, body };
}

describe("static SPA server", () => {
  it("serves the index page with a no-cache header", async () => {
    const web = createStaticWeb({ directory: await buildSite() });
    const result = await serve(web, "GET", "/");
    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(result.headers["Content-Type"]).toContain("text/html");
    expect(result.headers["Cache-Control"]).toBe("no-cache");
    expect(String(result.body)).toContain("invest");
  });

  it("serves an asset with an immutable long-lived cache header", async () => {
    const web = createStaticWeb({ directory: await buildSite() });
    const result = await serve(web, "GET", "/assets/app.a1b2.js");
    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(result.headers["Content-Type"]).toContain("text/javascript");
    expect(result.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(String(result.body)).toContain("console.log");
  });

  it("falls back to index.html for extension-less SPA routes but not for a missing asset", async () => {
    const web = createStaticWeb({ directory: await buildSite() });
    const spaRoute = await serve(web, "GET", "/trading-review/case-1");
    expect(spaRoute).toMatchObject({ handled: true, statusCode: 200 });
    expect(spaRoute.headers["Cache-Control"]).toBe("no-cache");
    expect(String(spaRoute.body)).toContain("invest");

    const missingAsset = await serve(web, "GET", "/assets/does-not-exist.js");
    expect(missingAsset.handled).toBe(false); // a real, missing file: caller should 404 it, not get index.html
  });

  it("does not handle /api/ or /health/ paths, leaving them to the caller", async () => {
    const web = createStaticWeb({ directory: await buildSite() });
    const api = await serve(web, "GET", "/api/snapshot");
    expect(api).toMatchObject({ handled: false, statusCode: 0 });
    const health = await serve(web, "GET", "/health/live");
    expect(health).toMatchObject({ handled: false, statusCode: 0 });
  });

  it("blocks path traversal outside the site directory", async () => {
    const web = createStaticWeb({ directory: await buildSite() });
    const result = await serve(web, "GET", "/../../../../../../etc/passwd");
    expect(result).toMatchObject({ handled: true, statusCode: 403 });
  });

  it("answers HEAD requests with headers but no body", async () => {
    const web = createStaticWeb({ directory: await buildSite() });
    const result = await serve(web, "HEAD", "/");
    expect(result).toMatchObject({ handled: true, statusCode: 200 });
    expect(result.headers["Content-Length"]).toBeTruthy();
    expect(result.body).toBeUndefined();
  });

  it("rejects methods other than GET/HEAD", async () => {
    const web = createStaticWeb({ directory: await buildSite() });
    const result = await serve(web, "POST", "/");
    expect(result).toMatchObject({ handled: false, statusCode: 0 });
  });

  it("a disabled instance (no directory) never handles or writes to the response", async () => {
    const web = createStaticWeb({ directory: null });
    expect(web.enabled).toBe(false);
    expect(web.directory).toBeNull();
    const result = await serve(web, "GET", "/");
    expect(result).toMatchObject({ handled: false, statusCode: 0 });
  });
});

describe("resolveWebDistDirectory", () => {
  it("picks the first candidate that contains index.html", async () => {
    const empty = await tempDir("invest-static-web-empty-");
    const real = await buildSite();
    expect(resolveWebDistDirectory(process.env, [join(empty, "missing"), empty, real])).toBe(real);
  });

  it("returns null when no candidate has an index.html", async () => {
    const empty = await tempDir("invest-static-web-empty-");
    expect(resolveWebDistDirectory(process.env, ["", join(empty, "nope"), empty])).toBeNull();
  });
});

describe("ensureConfigFile", () => {
  it("creates the config from the example on first run, including missing parent directories", async () => {
    const dir = await tempDir("invest-bootstrap-config-");
    const examplePath = join(dir, "example.yaml");
    await writeFile(examplePath, "version: 1\n");
    const configPath = join(dir, "nested", "portfolio.yaml");
    expect(await ensureConfigFile(configPath, examplePath)).toBe("created");
    expect(await readFile(configPath, "utf8")).toBe("version: 1\n");
  });

  it("never overwrites an existing config", async () => {
    const dir = await tempDir("invest-bootstrap-config-");
    const examplePath = join(dir, "example.yaml");
    await writeFile(examplePath, "version: 1\nchanged: true\n");
    const configPath = join(dir, "portfolio.yaml");
    await writeFile(configPath, "version: 1\ncustom: yes\n");
    expect(await ensureConfigFile(configPath, examplePath)).toBe("existing");
    expect(await readFile(configPath, "utf8")).toBe("version: 1\ncustom: yes\n");
  });

  it("reports missing when neither the config nor the example exists", async () => {
    const dir = await tempDir("invest-bootstrap-config-");
    expect(await ensureConfigFile(join(dir, "portfolio.yaml"), join(dir, "absent-example.yaml"))).toBe("missing");
  });
});
