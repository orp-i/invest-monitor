// Account settings: the AES-256-GCM secret box, the service that merges encrypted overrides with the process
// environment, and the REST routing on top of it. Every test uses an isolated temp directory/database — never
// production paths, never real broker/LLM network calls (schwab/test deps are hand-written fakes).
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageDriver, type StorageDriver } from "@invest/storage";
import type { SettingsGroupId } from "@invest/domain";
import { createSecretBox } from "../../apps/server/src/secret-box.js";
import {
  createSettingsService,
  SettingsNotFoundError,
  SettingsReadonlyError,
  SettingsValidationError,
  type SettingsService,
} from "../../apps/server/src/settings.js";
import { settingsRequest, type SettingsApiDeps } from "../../apps/server/src/settings-api.js";

const dirs: string[] = [];
const storages: StorageDriver[] = [];
afterEach(async () => {
  for (const storage of storages.splice(0)) await storage.close().catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
async function freshStorage(): Promise<StorageDriver> {
  const dir = await tempDir("invest-settings-db-");
  const storage = createStorageDriver("node-sqlite", join(dir, "test.sqlite"));
  await storage.open();
  await storage.migrate();
  storages.push(storage);
  return storage;
}
/** An always-available box: env-key mode from an arbitrary passphrase, no filesystem involved. */
async function availableBox(passphrase: string) {
  return createSecretBox({ env: { SETTINGS_ENCRYPTION_KEY: passphrase }, keyFilePath: "/unused" });
}

describe("secret box", () => {
  it("derives an env-key box from SETTINGS_ENCRYPTION_KEY (64 hex chars used directly, other strings hashed)", async () => {
    const hex = "11".repeat(32);
    const boxHex = await createSecretBox({ env: { SETTINGS_ENCRYPTION_KEY: hex }, keyFilePath: "/unused" });
    expect(boxHex.mode).toBe("env-key");
    const cipher = boxHex.encrypt("hello-secret");
    expect(boxHex.decrypt(cipher)).toBe("hello-secret");

    const boxPass = await availableBox("a short passphrase, not hex");
    expect(boxPass.mode).toBe("env-key");
    expect(boxPass.decrypt(boxPass.encrypt("hi"))).toBe("hi");
    // Different derivations are not interchangeable.
    expect(() => boxPass.decrypt(cipher)).toThrow();
  });

  it("creates a 0600 key file on first use and reuses the same key on a second load", async () => {
    const dir = await tempDir("invest-secretbox-");
    const keyFilePath = join(dir, "nested", "settings.key");
    const box1 = await createSecretBox({ env: {}, keyFilePath });
    expect(box1.mode).toBe("key-file");
    expect(box1.note).toContain("settings.key");
    const stats = await stat(keyFilePath);
    expect(stats.mode & 0o777).toBe(0o600);
    const hex1 = (await readFile(keyFilePath, "utf8")).trim();
    expect(hex1).toMatch(/^[0-9a-f]{64}$/);

    const box2 = await createSecretBox({ env: {}, keyFilePath });
    expect(box2.mode).toBe("key-file");
    expect((await readFile(keyFilePath, "utf8")).trim()).toBe(hex1); // second load must not overwrite the key
    expect(box2.decrypt(box1.encrypt("round-trip"))).toBe("round-trip"); // same underlying key
  });

  it("detects tampering and rejects malformed ciphertext", async () => {
    const box = await availableBox("tamper-detection-key");
    const cipher = box.encrypt("do-not-touch");
    const parts = cipher.split(":");
    const flippedBody = Buffer.from(parts[3]!, "base64");
    flippedBody[0] = flippedBody[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], flippedBody.toString("base64")].join(":");
    expect(() => box.decrypt(tampered)).toThrow();
    expect(() => box.decrypt("not-even-the-right-format")).toThrow();
    expect(() => box.decrypt("v2:aa:bb:cc")).toThrow();
    expect(() => box.decrypt("v1:only:three")).toThrow();
  });

  it("reports itself unavailable when the key file cannot be created, and refuses to encrypt/decrypt", async () => {
    const dir = await tempDir("invest-secretbox-unavailable-");
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const box = await createSecretBox({ env: {}, keyFilePath: join(blocker, "sub", "settings.key") });
    expect(box.mode).toBe("unavailable");
    expect(box.note).toContain("SETTINGS_ENCRYPTION_KEY");
    expect(() => box.encrypt("x")).toThrow();
    expect(() => box.decrypt("v1:a:b:c")).toThrow();
  });
});

describe("settings service", () => {
  it("resolves precedence stored > env > default > none, and env() is isolated from the input env", async () => {
    const storage = await freshStorage();
    const secretBox = await availableBox("precedence-key");
    const inputEnv = { TRADIER_ACCESS_TOKEN: "env-token-value" } as NodeJS.ProcessEnv;
    const settings = await createSettingsService({ storage, secretBox, env: inputEnv });

    expect(settings.effective("TRADIER_ACCESS_TOKEN")).toEqual({ value: "env-token-value", source: "env" });
    expect(settings.effective("TRADIER_ENVIRONMENT")).toEqual({ value: "live", source: "default" }); // schema default, no env/stored value
    expect(settings.effective("UNKNOWN_KEY_NOT_IN_SCHEMA")).toEqual({ value: null, source: "none" });

    await settings.update("tradier", { TRADIER_ACCESS_TOKEN: "stored-token-value" });
    expect(settings.effective("TRADIER_ACCESS_TOKEN")).toEqual({ value: "stored-token-value", source: "settings" });

    const env1 = settings.env();
    expect(env1.TRADIER_ACCESS_TOKEN).toBe("stored-token-value");
    (env1 as Record<string, string>).TRADIER_ACCESS_TOKEN = "mutated-locally";
    expect(settings.env().TRADIER_ACCESS_TOKEN).toBe("stored-token-value"); // a fresh call is unaffected by the earlier mutation
    expect(inputEnv.TRADIER_ACCESS_TOKEN).toBe("env-token-value"); // the original input object was never touched

    await settings.clear("tradier");
    expect(settings.effective("TRADIER_ACCESS_TOKEN")).toEqual({ value: "env-token-value", source: "env" });
  });

  it("masks secrets in the view, keeps plaintext out of the serialized JSON, and reports updatedAt", async () => {
    const storage = await freshStorage();
    const secretBox = await availableBox("masking-key");
    const settings = await createSettingsService({ storage, secretBox, env: {}, now: () => Date.parse("2026-09-23T00:00:00.000Z") });
    const token = "sk-super-secret-1234";
    await settings.update("tradier", { TRADIER_ACCESS_TOKEN: token });

    const view = settings.view();
    const field = view.groups.find(g => g.id === "tradier")!.fields.find(f => f.key === "TRADIER_ACCESS_TOKEN")!;
    expect(field.configured).toBe(true);
    expect(field.value).toBeNull();
    expect(field.masked).toBe("••••••••1234");
    expect(field.updatedAt).toBe("2026-09-23T00:00:00.000Z");
    expect(view.updatedAt).toBe("2026-09-23T00:00:00.000Z");
    expect(JSON.stringify(view)).not.toContain(token);
  });

  it("updates, clears, validates (select/number/url/pattern/readonly) and rejects writes on a readonly service", async () => {
    const storage = await freshStorage();
    const secretBox = await availableBox("validation-key");
    const settings = await createSettingsService({ storage, secretBox, env: {} });

    await expect(settings.update("tradier", { TRADIER_ENVIRONMENT: "bogus" })).rejects.toThrow(SettingsValidationError); // select
    await expect(settings.update("llm", { DAILY_LLM_TIMEOUT_MS: "10" })).rejects.toThrow(SettingsValidationError); // number, below min
    await expect(settings.update("llm", { DAILY_LLM_BASE_URL: "not-a-url" })).rejects.toThrow(SettingsValidationError); // url
    const patternError = await settings.update("ibkr", { IBKR_FLEX_QUERY_ID: "abc" }).catch(error => error); // pattern ^\d+$
    expect(patternError).toBeInstanceOf(SettingsValidationError);
    expect((patternError as SettingsValidationError).issues).toEqual([expect.objectContaining({ key: "IBKR_FLEX_QUERY_ID" })]);
    await expect(settings.update("schwab", { SCHWAB_REFRESH_TOKEN_ISSUED_AT: "2026-01-01T00:00:00.000Z" })).rejects.toThrow(SettingsValidationError); // readonly, no system flag
    await expect(settings.update("does-not-exist", { A: "b" })).rejects.toThrow(SettingsNotFoundError);

    // system: true allows writing the readonly field (the Schwab OAuth exchange records it this way).
    const systemWrite = await settings.update("schwab", { SCHWAB_REFRESH_TOKEN_ISSUED_AT: "2026-01-01T00:00:00.000Z" }, { system: true });
    expect(systemWrite.fields.find(f => f.key === "SCHWAB_REFRESH_TOKEN_ISSUED_AT")?.value).toBe("2026-01-01T00:00:00.000Z");

    const updated = await settings.update("tradier", { TRADIER_ACCESS_TOKEN: "tok-abcdefgh1234", TRADIER_ENVIRONMENT: "sandbox" });
    expect(updated.configured).toBe(true);
    expect(updated.fields.find(f => f.key === "TRADIER_ENVIRONMENT")?.value).toBe("sandbox");

    const cleared = await settings.clear("tradier");
    expect(cleared.fields.find(f => f.key === "TRADIER_ACCESS_TOKEN")?.configured).toBe(false);
    await expect(settings.clear("does-not-exist")).rejects.toThrow(SettingsNotFoundError);

    const ro = await createSettingsService({ storage, secretBox, env: {}, readonly: true });
    expect(ro.readonly).toBe(true);
    await expect(ro.update("tradier", { TRADIER_ACCESS_TOKEN: "x" })).rejects.toThrow(SettingsReadonlyError);
    await expect(ro.clear("tradier")).rejects.toThrow(SettingsReadonlyError);
    // readonly is checked before anything else, so even an unknown group is rejected as readonly, not "not found".
    await expect(ro.update("does-not-exist", {})).rejects.toThrow(SettingsReadonlyError);
  });

  it("notifies subscribers with the changed group id, and stops after unsubscribing", async () => {
    const storage = await freshStorage();
    const secretBox = await availableBox("subscribe-key");
    const settings = await createSettingsService({ storage, secretBox, env: {} });
    const seen: SettingsGroupId[] = [];
    const unsubscribe = settings.subscribe(group => seen.push(group));

    await settings.update("network", { BROKER_EGRESS_PROXY_URL: "http://127.0.0.1:17890" });
    await settings.clear("network");
    expect(seen).toEqual(["network", "network"]);

    unsubscribe();
    await settings.update("network", { BROKER_EGRESS_PROXY_URL: "http://127.0.0.1:17890" });
    expect(seen).toEqual(["network", "network"]); // no further notifications
  });

  it("treats a stored secret it cannot decrypt as undecryptable: skipped by env(), flagged in view(), recoverable by re-entering it", async () => {
    const storage = await freshStorage();
    const boxA = await availableBox("rotation-key-a");
    const settingsA = await createSettingsService({ storage, secretBox: boxA, env: {} });
    await settingsA.update("tradier", { TRADIER_ACCESS_TOKEN: "tok-original-123456" });

    // A second service instance over the same rows, but a different encryption key (as if the key rotated).
    const boxB = await availableBox("rotation-key-b");
    const settingsB = await createSettingsService({ storage, secretBox: boxB, env: {} });

    expect(settingsB.env().TRADIER_ACCESS_TOKEN).toBeUndefined();
    expect(settingsB.effective("TRADIER_ACCESS_TOKEN")).toEqual({ value: null, source: "none" });
    const group = settingsB.view().groups.find(g => g.id === "tradier")!;
    const field = group.fields.find(f => f.key === "TRADIER_ACCESS_TOKEN")!;
    expect(field).toMatchObject({ source: "settings", configured: false, value: null, masked: null });
    expect(group.status).toMatchObject({ state: "error" });
    expect(group.status?.message).toContain("重新填写");

    // An explicit status passed in by the caller is respected as-is, even with an undecryptable field underneath.
    const withStatus = settingsB.view({ tradier: { state: "ok", message: "外部状态", checkedAt: null } });
    expect(withStatus.groups.find(g => g.id === "tradier")!.status).toEqual({ state: "ok", message: "外部状态", checkedAt: null });

    // Re-entering the value under the new key makes it usable again.
    await settingsB.update("tradier", { TRADIER_ACCESS_TOKEN: "tok-replacement-99" });
    expect(settingsB.env().TRADIER_ACCESS_TOKEN).toBe("tok-replacement-99");
    expect(settingsB.view().groups.find(g => g.id === "tradier")!.status).toBeNull();
  });

  it("blocks saving a new secret value when the secret box is unavailable, but still saves non-secret fields", async () => {
    const storage = await freshStorage();
    const dir = await tempDir("invest-secretbox-blocked-");
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const unavailableBox = await createSecretBox({ env: {}, keyFilePath: join(blocker, "sub", "settings.key") });
    expect(unavailableBox.mode).toBe("unavailable");
    const settings = await createSettingsService({ storage, secretBox: unavailableBox, env: {} });

    await expect(settings.update("llm", { DAILY_LLM_API_KEY: "sk-cannot-store-this" })).rejects.toThrow(SettingsValidationError);
    const group = await settings.update("llm", { DAILY_LLM_BASE_URL: "https://api.deepseek.com/v1" });
    expect(group.fields.find(f => f.key === "DAILY_LLM_BASE_URL")?.value).toBe("https://api.deepseek.com/v1");
  });
});

describe("settingsRequest routes", () => {
  async function realDeps(overrides: Partial<SettingsApiDeps> = {}): Promise<{ deps: SettingsApiDeps; settings: SettingsService }> {
    const storage = await freshStorage();
    const secretBox = await availableBox("api-route-tests-key");
    const settings = await createSettingsService({ storage, secretBox, env: {} });
    return { deps: { settings, publicOrigin: "http://example.test:8080", ...overrides }, settings };
  }
  const url = (path: string) => new URL(`http://localhost${path}`);

  it("GET /api/settings returns every group and merges statuses, tolerating a failing statuses()", async () => {
    const { deps } = await realDeps();
    const ok = await settingsRequest("GET", url("/api/settings"), undefined, { ...deps, statuses: async () => ({ tradier: { state: "ok", message: "测试状态", checkedAt: null } }) });
    expect(ok.status).toBe(200);
    const view = ok.body as any;
    expect(view.groups.map((g: any) => g.id).sort()).toEqual(["alpaca", "ibkr", "llm", "network", "schwab", "tradier"]);
    expect(view.groups.find((g: any) => g.id === "tradier").status).toMatchObject({ state: "ok", message: "测试状态" });

    const tolerant = await settingsRequest("GET", url("/api/settings"), undefined, { ...deps, statuses: async () => { throw new Error("boom"); } });
    expect(tolerant.status).toBe(200); // a failing statuses() must not break the view
  });

  it("GET /api/settings/schema documents every group and route, with curl examples using publicOrigin", async () => {
    const { deps } = await realDeps();
    const reply = await settingsRequest("GET", url("/api/settings/schema"), undefined, deps);
    expect(reply.status).toBe(200);
    const schema = reply.body as any;
    expect(schema.version).toBeTruthy();
    expect(schema.groups.map((g: any) => g.id).sort()).toEqual(["alpaca", "ibkr", "llm", "network", "schwab", "tradier"]);
    const routes = schema.endpoints.map((e: any) => `${e.method} ${e.path}`);
    for (const expected of [
      "GET /api/settings", "GET /api/settings/schema", "PUT /api/settings/:group", "DELETE /api/settings/:group",
      "POST /api/settings/:group/test", "GET /api/settings/schwab/authorize-url", "POST /api/settings/schwab/exchange",
    ]) expect(routes).toContain(expected);
    expect(schema.instructions.length).toBeGreaterThan(0);
    expect(schema.auth).toBeTruthy();
    expect(schema.examples.some((example: string) => example.includes("http://example.test:8080"))).toBe(true);
  });

  it("PUT/DELETE a group, rejecting invalid values, bad request bodies and unknown groups", async () => {
    const { deps } = await realDeps();
    const put = await settingsRequest("PUT", url("/api/settings/tradier"), { values: { TRADIER_ACCESS_TOKEN: "tok-abcdefgh12345" } }, deps);
    expect(put.status).toBe(200);
    expect((put.body.group as any).fields.find((f: any) => f.key === "TRADIER_ACCESS_TOKEN").configured).toBe(true);

    const badValue = await settingsRequest("PUT", url("/api/settings/tradier"), { values: { TRADIER_ENVIRONMENT: "bogus" } }, deps);
    expect(badValue.status).toBe(400);
    expect(badValue.body.issues).toEqual([expect.objectContaining({ key: "TRADIER_ENVIRONMENT" })]);

    const badBody = await settingsRequest("PUT", url("/api/settings/tradier"), { values: { TRADIER_ENVIRONMENT: 5 } }, deps);
    expect(badBody.status).toBe(400);
    const noValues = await settingsRequest("PUT", url("/api/settings/tradier"), {}, deps);
    expect(noValues.status).toBe(400);

    const unknownGroup = await settingsRequest("PUT", url("/api/settings/not-a-group"), { values: {} }, deps);
    expect(unknownGroup.status).toBe(404);

    const del = await settingsRequest("DELETE", url("/api/settings/tradier"), undefined, deps);
    expect(del.status).toBe(200);
    expect((del.body.group as any).fields.find((f: any) => f.key === "TRADIER_ACCESS_TOKEN").configured).toBe(false);
    expect((await settingsRequest("DELETE", url("/api/settings/not-a-group"), undefined, deps)).status).toBe(404);
  });

  it("returns 403 for PUT/DELETE on a readonly service", async () => {
    const storage = await freshStorage();
    const secretBox = await availableBox("readonly-route-key");
    const settings = await createSettingsService({ storage, secretBox, env: {}, readonly: true });
    const deps: SettingsApiDeps = { settings };
    expect((await settingsRequest("PUT", url("/api/settings/tradier"), { values: { TRADIER_ACCESS_TOKEN: "x" } }, deps)).status).toBe(403);
    expect((await settingsRequest("DELETE", url("/api/settings/tradier"), undefined, deps)).status).toBe(403);
  });

  it("runs POST /api/settings/:group/test only for testable groups, and turns a thrown error into ok:false", async () => {
    const { deps } = await realDeps({ test: async group => group === "tradier" ? { ok: true, message: "连接成功" } : Promise.reject(new Error("模拟失败")) });
    const ok = await settingsRequest("POST", url("/api/settings/tradier/test"), undefined, deps);
    expect(ok.status).toBe(200);
    expect(ok.body.result).toEqual({ ok: true, message: "连接成功" });

    const failed = await settingsRequest("POST", url("/api/settings/ibkr/test"), undefined, deps);
    expect(failed.status).toBe(200); // an error from deps.test is still a 200 with ok:false, not a 500
    expect((failed.body.result as any).ok).toBe(false);
    expect((failed.body.result as any).message).toContain("模拟失败");

    expect((await settingsRequest("POST", url("/api/settings/network/test"), undefined, deps)).status).toBe(400); // not testable
    expect((await settingsRequest("POST", url("/api/settings/not-a-group/test"), undefined, deps)).status).toBe(404);

    const { deps: depsNoTest } = await realDeps();
    expect((await settingsRequest("POST", url("/api/settings/tradier/test"), undefined, depsNoTest)).status).toBe(501);
  });

  it("Schwab authorize-url requires SCHWAB_APP_KEY but not the redirect URI (it has a default), and 501s without deps.schwab", async () => {
    const { deps, settings } = await realDeps({ schwab: {
      authorizeUrl: env => `https://api.schwabapi.com/v1/oauth/authorize?client_id=${env.SCHWAB_APP_KEY}`,
      exchange: async () => ({ refreshToken: "unused", issuedAt: "unused" }),
    } });
    const missing = await settingsRequest("GET", url("/api/settings/schwab/authorize-url"), undefined, deps);
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain("SCHWAB_APP_KEY");
    expect(missing.body.message).not.toContain("SCHWAB_REDIRECT_URI");

    await settings.update("schwab", { SCHWAB_APP_KEY: "app-key-value" });
    const ok = await settingsRequest("GET", url("/api/settings/schwab/authorize-url"), undefined, deps);
    expect(ok.status).toBe(200);
    expect(ok.body.url).toContain("app-key-value");

    const { deps: depsNoSchwab } = await realDeps();
    expect((await settingsRequest("GET", url("/api/settings/schwab/authorize-url"), undefined, depsNoSchwab)).status).toBe(501);
  });

  it("Schwab exchange extracts the code from a redirected URL, saves the refresh token/issued-at, and never echoes the token", async () => {
    let receivedCode: string | null = null;
    const { deps } = await realDeps({ schwab: {
      authorizeUrl: () => "unused",
      exchange: async (_env, code) => { receivedCode = code; return { refreshToken: "rt-long-secret-value-9999", issuedAt: "2026-09-23T01:02:03.000Z" }; },
    } });
    const reply = await settingsRequest("POST", url("/api/settings/schwab/exchange"), { redirectedUrl: "https://127.0.0.1/?code=abc%40def&session=xyz" }, deps);
    expect(reply.status).toBe(200);
    expect(receivedCode).toBe("abc@def"); // URL-decoded
    expect(reply.body.issuedAt).toBe("2026-09-23T01:02:03.000Z");
    const group = reply.body.group as any;
    expect(group.fields.find((f: any) => f.key === "SCHWAB_REFRESH_TOKEN").masked).toBe("••••••••9999");
    expect(group.fields.find((f: any) => f.key === "SCHWAB_REFRESH_TOKEN_ISSUED_AT").value).toBe("2026-09-23T01:02:03.000Z");
    expect(JSON.stringify(reply.body)).not.toContain("rt-long-secret-value-9999");

    expect((await settingsRequest("POST", url("/api/settings/schwab/exchange"), {}, deps)).status).toBe(400); // no code found

    const { deps: failingDeps } = await realDeps({ schwab: { authorizeUrl: () => "unused", exchange: async () => { throw new Error("Schwab 拒绝了该授权码"); } } });
    const failed = await settingsRequest("POST", url("/api/settings/schwab/exchange"), { code: "raw-code" }, failingDeps);
    expect(failed.status).toBe(400);
    expect(failed.body.message).toContain("拒绝");

    const { deps: depsNoSchwab } = await realDeps();
    expect((await settingsRequest("POST", url("/api/settings/schwab/exchange"), { code: "x" }, depsNoSchwab)).status).toBe(501);
  });

  it("returns 404 for unrecognized paths and 405 for wrong methods on recognized ones", async () => {
    const { deps } = await realDeps();
    const notFound = await settingsRequest("GET", url("/api/settings/tradier/bogus"), undefined, deps);
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ message: "not found" });

    expect((await settingsRequest("GET", url("/api/settings/nope"), undefined, deps)).status).toBe(405); // recognized :group shape, GET unsupported
    expect((await settingsRequest("PATCH", url("/api/settings/tradier"), {}, deps)).status).toBe(405);
    expect((await settingsRequest("POST", url("/api/settings"), {}, deps)).status).toBe(405);
    expect((await settingsRequest("DELETE", url("/api/settings/schema"), undefined, deps)).status).toBe(405);
  });
});
