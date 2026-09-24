import { afterEach, describe, expect, it, vi } from "vitest";
import type { DailyLlmRouteProbe } from "@invest/domain";
import { DailyLlmEgress, dailyLlmEgressProfiles, selectDailyLlmRoute } from "../../apps/server/src/daily-llm-egress.js";
import { dailyLlmProvider } from "../../apps/server/src/daily-llm.js";

afterEach(() => vi.useRealTimers());
const key = "isolated-key-not-in-diagnostics", env = { DAILY_LLM_PROVIDER: "deepseek", DAILY_LLM_BASE_URL: "https://provider.test", DAILY_LLM_MODEL: "isolated-model", DAILY_LLM_API_KEY: key, DAILY_LLM_EGRESS_PROFILE: "auto" };
const profile = (name: string) => ({ name, proxyUrl: name === "direct" ? null : "http://proxy.test:8080", userAgent: "isolated-test", connectTimeoutMs: 1000 });
const response = (body: unknown, status = 200) => ({ ok: true, value: { status, body: Buffer.from(JSON.stringify(body)) } });
const models = () => response({ data: [{ id: env.DAILY_LLM_MODEL }] });
const completion = () => response({ model: env.DAILY_LLM_MODEL, choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] });
const network = () => ({ ok: false, error: { kind: "network", message: key } });
function http(impl?: (options: any) => Promise<any> | any) {
  return { profile: vi.fn(profile), request: vi.fn(async (options: any) => impl ? impl(options) : options.method === "GET" ? models() : completion()) };
}
const call = (provider: ReturnType<typeof dailyLlmProvider>) => provider.complete("Return JSON.", "Connectivity test.", new AbortController().signal);
const probe = (name: "direct" | "vpn", ms: number, successes = 2, modelAvailable: boolean | null = true): DailyLlmRouteProbe => ({ profile: name, attempts: 2, successes, medianMs: ms, modelAvailable, httpStatus: 200, issue: null });

describe("daily LLM route selection", () => {
  it("creates actual direct access independently of the market single-proxy setting", () => {
    const profiles = { direct: profile("direct"), vpn: profile("vpn"), corp: profile("corp") };
    profiles.direct.proxyUrl = "http://global-market-proxy:8080";
    const isolated = dailyLlmEgressProfiles(profiles as any);
    expect(isolated.direct.proxyUrl).toBeNull(); expect(isolated.vpn.proxyUrl).toBe(profiles.vpn.proxyUrl);
    expect(profiles.direct.proxyUrl).toBe("http://global-market-proxy:8080");
  });

  it("prioritizes valid model access and reliability over latency, with hysteresis for small differences", () => {
    expect(selectDailyLlmRoute([probe("direct", 120), probe("vpn", 1159)])).toBe("direct");
    expect(selectDailyLlmRoute([probe("direct", 10, 1), probe("vpn", 1159)])).toBe("vpn");
    expect(selectDailyLlmRoute([probe("direct", 10, 2, null), probe("vpn", 1159)])).toBe("vpn");
    expect(selectDailyLlmRoute([probe("direct", 180), probe("vpn", 140)])).toBe("direct");
    expect(selectDailyLlmRoute([probe("direct", 120), probe("vpn", 140)], "vpn")).toBe("vpn");
    expect(selectDailyLlmRoute([probe("direct", 50, 2, false), probe("vpn", 100, 0)])).toBeNull();
  });

  it("uses only GET /models for detection, deduplicates concurrent checks and sends no report content", async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const transport = http(async () => { await gate; return models(); });
    const provider = dailyLlmProvider(transport as any, env);
    const a = provider.checkConnection!(), b = provider.checkConnection!(); release();
    const [first, second] = await Promise.all([a, b]); expect(first).toEqual(second);
    expect(transport.request).toHaveBeenCalledTimes(4);
    expect(transport.request.mock.calls.every(([o]) => o.method === "GET" && o.url === "https://provider.test/models" && !o.body && !o.egressFallback.length && o.followRedirects === false)).toBe(true);
    expect(JSON.stringify(provider.status())).not.toContain(key); expect(first.selected).toBe("direct");
  });

  it("caches checks for 15 minutes, supports DeepSeek JSON, and leaves page status reads passive", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T07:00:00Z"));
    const transport = http(), provider = dailyLlmProvider(transport as any, env);
    expect(provider.status().configured).toBe(true); expect(transport.request).not.toHaveBeenCalled();
    const one = await call(provider); await call(provider);
    expect(one.connection?.selected).toBe("direct");
    expect(transport.request.mock.calls.filter(([o]) => o.method === "GET")).toHaveLength(4);
    const posts = transport.request.mock.calls.filter(([o]) => o.method === "POST");
    expect(posts).toHaveLength(2); expect(JSON.parse(posts[0]![0].body)).toMatchObject({ response_format: { type: "json_object" }, max_tokens: 6000 });
    expect(posts[0]![0]).toMatchObject({ url: "https://provider.test/chat/completions", egressProfile: "direct", egressFallback: [] });
    vi.setSystemTime(new Date("2026-09-13T07:16:00Z")); await call(provider);
    expect(transport.request.mock.calls.filter(([o]) => o.method === "GET")).toHaveLength(8);
  });

  it("chooses VPN when true direct fails and blocks inference when both routes fail", async () => {
    const transport = http(o => o.egressProfile === "direct" ? network() : o.method === "GET" ? models() : completion());
    const provider = dailyLlmProvider(transport as any, env);
    expect((await call(provider)).connection?.selected).toBe("vpn");
    const unavailable = http(() => network()), disabled = dailyLlmProvider(unavailable as any, env);
    await expect(call(disabled)).rejects.toThrow("未找到可用");
    expect(unavailable.request.mock.calls.some(([o]) => o.method === "POST")).toBe(false);
    expect(JSON.stringify(disabled.status())).not.toContain(key);
  });

  it("rechecks a partially successful route after one minute instead of keeping an unstable result for 15 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T07:00:00Z"));
    const reads: Record<string, number> = {};
    const transport = http(o => {
      if (o.method === "POST") return completion();
      reads[o.egressProfile] = (reads[o.egressProfile] ?? 0) + 1;
      return reads[o.egressProfile] === 1 ? network() : models();
    });
    const provider = dailyLlmProvider(transport as any, env); await call(provider);
    expect(provider.status().connection?.expiresAt).toBe("2026-09-13T07:01:00.000Z");
    vi.setSystemTime(new Date("2026-09-13T07:01:01Z")); await call(provider);
    expect(transport.request.mock.calls.filter(([o]) => o.method === "GET")).toHaveLength(8);
  });

  it.each([
    response({ error: key }, 401), response({ error: key }, 403), response({ error: key }, 429),
    response({ data: [{ id: "wrong-model" }] }), response("<html>not an API</html>"),
  ])("does not mistake authentication, model, quota or HTML responses for a usable route", async bad => {
    const transport = http(o => o.egressProfile === "direct" ? bad : models());
    const result = await dailyLlmProvider(transport as any, env).checkConnection!();
    expect(result.recommended).toBe("vpn"); expect(JSON.stringify(result)).not.toContain(key);
  });

  it("marks unsupported model discovery as unverified and allows a pinned route without mandatory discovery", async () => {
    const transport = http(o => o.method === "GET" ? response({ error: { message: "missing" } }, 404) : completion());
    const provider = dailyLlmProvider(transport as any, env);
    expect((await provider.checkConnection!()).note).toContain("实际推理仍需验证");
    const pinned = http(), manual = dailyLlmProvider(pinned as any, { ...env, DAILY_LLM_EGRESS_PROFILE: "direct" });
    await call(manual); expect(pinned.request).toHaveBeenCalledTimes(1); expect(pinned.request.mock.calls[0]![0].method).toBe("POST");
  });

  it("never replays a submitted completion on a second route; rechecks on the next manual attempt", async () => {
    let failed = false;
    const transport = http(o => {
      if (o.method === "POST" && !failed) { failed = true; return network(); }
      if (o.egressProfile === "direct" && failed) return network();
      return o.method === "GET" ? models() : completion();
    });
    const provider = dailyLlmProvider(transport as any, env);
    await expect(call(provider)).rejects.toThrow("无法连接");
    expect(transport.request.mock.calls.filter(([o]) => o.method === "POST")).toHaveLength(1);
    expect((await call(provider)).connection?.selected).toBe("vpn");
    expect(transport.request.mock.calls.filter(([o]) => o.method === "POST")).toHaveLength(2);
  });

  it("invalidates the route cache after a proxy configuration change and distinguishes an absent VPN", async () => {
    const transport = http(); let proxy: string | null = "http://proxy-one:8080";
    transport.profile.mockImplementation(name => ({ ...profile(name), proxyUrl: name === "direct" ? null : proxy }));
    const provider = dailyLlmProvider(transport as any, env); await call(provider);
    proxy = "http://proxy-two:8080"; expect(provider.status().connection?.checkedAt).toBeNull(); await call(provider);
    expect(transport.request.mock.calls.filter(([o]) => o.method === "GET")).toHaveLength(8);
    proxy = null; const detected = await provider.checkConnection!();
    expect(detected.probes.find(p => p.profile === "vpn")).toMatchObject({ attempts: 0, successes: 0 }); expect(detected.selected).toBe("direct");
  });

  it("aborts outstanding discovery on close without transmitting a completion or caching partial results", async () => {
    const transport = http(o => new Promise(resolve => { o.signal.addEventListener("abort", () => resolve(network()), { once: true }); }));
    const routes = new DailyLlmEgress(transport as any, "https://provider.test/models", key, env.DAILY_LLM_MODEL, "auto");
    const checking = routes.check(); await routes.close();
    expect((await checking).checkedAt).toBeNull(); expect(transport.request).toHaveBeenCalledTimes(2);
  });
});
