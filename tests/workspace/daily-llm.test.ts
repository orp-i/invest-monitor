import { describe, expect, it, vi } from "vitest";
import { dailyLlmProvider } from "../../apps/server/src/daily-llm.js";

const env = { DAILY_LLM_EGRESS_PROFILE: "vpn", DAILY_LLM_BASE_URL: "https://llm.example/v1/", DAILY_LLM_API_KEY: "isolated-secret-not-for-output", DAILY_LLM_MODEL: "isolated-model" };
const normal = { model: "resolved-model", choices: [{ finish_reason: "stop", message: { content: "{\"macro\":{}}" } }], usage: { prompt_tokens: 20, completion_tokens: 30 } };
function transport(body: unknown = normal, status = 200) {
  return { profile: vi.fn(() => ({ userAgent: "invest-test", connectTimeoutMs: 1000, proxyUrl: "http://isolated-proxy:8080" })), request: vi.fn(async (_options?: any) => ({ ok: true, value: { status, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) } })) };
}
const call = (provider: ReturnType<typeof dailyLlmProvider>, signal = new AbortController().signal) => provider.complete("system instruction", "untrusted report input", signal);

describe("daily LLM provider protocol", () => {
  it.each(["openai-compatible", "openai"])("sends one bounded %s request, keeps the key server-side and records returned model/usage", async mode => {
    const http = transport(), provider = dailyLlmProvider(http as any, { ...env, DAILY_LLM_PROVIDER: mode });
    const reply = await call(provider), sent = http.request.mock.calls[0]![0];
    expect(sent).toMatchObject({ url: "https://llm.example/v1/chat/completions", method: "POST", egressProfile: "vpn", egressFallback: [], followRedirects: false, maxRedirects: 0, requestTimeoutMs: 180000 });
    expect(sent.headers.authorization).toBe(`Bearer ${env.DAILY_LLM_API_KEY}`);
    const payload = JSON.parse(sent.body);
    expect(payload).toEqual({ model: env.DAILY_LLM_MODEL, messages: [{ role: "system", content: "system instruction" }, { role: "user", content: "untrusted report input" }], stream: false, [mode === "openai" ? "max_completion_tokens" : "max_tokens"]: 6000 });
    expect(reply).toMatchObject({ text: normal.choices[0]!.message.content, model: "resolved-model", usage: { inputTokens: 20, outputTokens: 30 } });
    expect(JSON.stringify(provider.status())).not.toContain(env.DAILY_LLM_API_KEY); expect(JSON.stringify(provider.status())).not.toContain(env.DAILY_LLM_BASE_URL);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("accepts the full endpoint, applies explicit timeout/token/egress overrides and ignores unrelated news LLM configuration", async () => {
    const http = transport({ ...normal, usage: { prompt_tokens: -2, completion_tokens: "30" } });
    const provider = dailyLlmProvider(http as any, { ...env, DAILY_LLM_BASE_URL: "http://localhost:4321/v1/chat/completions", DAILY_LLM_TIMEOUT_MS: "90000", DAILY_LLM_MAX_OUTPUT_TOKENS: "8000", DAILY_LLM_EGRESS_PROFILE: "direct" });
    expect((await call(provider)).usage).toEqual({ inputTokens: null, outputTokens: null });
    const sent = http.request.mock.calls[0]![0];
    expect(sent).toMatchObject({ url: "http://localhost:4321/v1/chat/completions", requestTimeoutMs: 90000, egressProfile: "direct" });
    expect(JSON.parse(sent.body).max_tokens).toBe(8000);
    const disabled = dailyLlmProvider(http as any, { OPENROUTER_API_KEY: "unrelated-news-key" });
    expect(disabled.status().configured).toBe(false); await expect(call(disabled)).rejects.toThrow("尚未完成配置");
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { DAILY_LLM_BASE_URL: "https://user:secret@example.test/v1" },
    { DAILY_LLM_BASE_URL: "https://example.test/v1?api_key=secret" },
    { DAILY_LLM_BASE_URL: "file:///secret" },
    { DAILY_LLM_PROVIDER: "unsupported" },
    { DAILY_LLM_TIMEOUT_MS: "301000" },
    { DAILY_LLM_MAX_OUTPUT_TOKENS: "-1" },
    { DAILY_LLM_EGRESS_PROFILE: "unknown" },
  ])("rejects invalid configuration without transmitting data: %j", async invalid => {
    const http = transport(), provider = dailyLlmProvider(http as any, { ...env, ...invalid });
    expect(provider.status().configured).toBe(false); await expect(call(provider)).rejects.toThrow(); expect(http.request).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.status())).not.toContain("secret");
  });

  it.each([401, 403, 429, 500, 302])("redacts HTTP %i bodies and does not retry or follow redirects", async status => {
    const http = transport({ error: env.DAILY_LLM_API_KEY }, status);
    const error = await call(dailyLlmProvider(http as any, env)).catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain(env.DAILY_LLM_API_KEY); expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated, malformed, tool-call and refused responses instead of treating partial output as a decision", async () => {
    for (const body of ["not json", { choices: [{ finish_reason: "length", message: { content: "partial" } }] }, { choices: [{ finish_reason: "tool_calls", message: { content: "unexpected tools" } }] }, { choices: [{ finish_reason: "stop", message: { content: "", refusal: "declined" } }] }]) {
      const http = transport(body); await expect(call(dailyLlmProvider(http as any, env))).rejects.toThrow(); expect(http.request).toHaveBeenCalledTimes(1);
    }
  });

  it("handles timeout, cancellation and thrown transport errors without exposing transport details", async () => {
    const http = { profile: () => ({ proxyUrl: "http://isolated-proxy:8080" }), request: vi.fn(async () => ({ ok: false, error: { kind: "timeout", message: env.DAILY_LLM_API_KEY } })) };
    const provider = dailyLlmProvider(http as any, env); await expect(call(provider)).rejects.toThrow("超时");
    const controller = new AbortController(); controller.abort(); await expect(call(provider, controller.signal)).rejects.toThrow("中断"); expect(http.request).toHaveBeenCalledTimes(1);
    http.request.mockImplementation(async () => { throw Error(env.DAILY_LLM_API_KEY); });
    const error = await call(provider).catch(e => e); expect(error.message).not.toContain(env.DAILY_LLM_API_KEY);
  });
});
