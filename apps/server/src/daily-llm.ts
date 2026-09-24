import type { DailyLlmStatus, DailyLlmConnection } from "@invest/domain";
import type { EgressHttpClient } from "@invest/egress";
import type { EgressName } from "@invest/config";
import { DailyLlmEgress } from "./daily-llm-egress.js";

export interface DailyLlmReply { text: string; model: string; usage: { inputTokens: number | null; outputTokens: number | null }; connection?: DailyLlmConnection }
// Implement this interface to add a provider with a different wire protocol.
export interface DailyLlmCompleteOptions { /** Second attempt after a truncated reply: request up to twice the configured output budget (capped at 16000). */ outputTokenBoost?: boolean }
export interface DailyLlmProvider {
  status(): DailyLlmStatus;
  complete(system: string, user: string, signal: AbortSignal, options?: DailyLlmCompleteOptions): Promise<DailyLlmReply>;
  checkConnection?(): Promise<DailyLlmConnection>;
  close?(): Promise<void>;
}
export type DailyLlmErrorCode = "truncated" | "invalid-output";
export class DailyLlmError extends Error {
  constructor(message: string, readonly code: DailyLlmErrorCode | null = null, readonly detail: string | null = null) { super(message); }
}
export const MAX_OUTPUT_TOKENS_CAP = 16000;
export function dailyLlmProvider(http: EgressHttpClient, env: NodeJS.ProcessEnv = process.env): DailyLlmProvider {
  const provider = env.DAILY_LLM_PROVIDER?.trim().toLowerCase() || "openai-compatible";
  const key = env.DAILY_LLM_API_KEY?.trim() || "", base = env.DAILY_LLM_BASE_URL?.trim() || "", model = env.DAILY_LLM_MODEL?.trim() || "";
  const missing = [["DAILY_LLM_BASE_URL", base], ["DAILY_LLM_API_KEY", key], ["DAILY_LLM_MODEL", model]].filter(([, v]) => !v).map(([k]) => k!);
  let issue: string | null = null, endpoint = "";
  if (!["openai-compatible", "openai", "deepseek"].includes(provider)) issue = "DAILY_LLM_PROVIDER 支持 openai-compatible、openai 或 deepseek。";
  if (base) {
    try {
      const url = new URL(base);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
      endpoint = base.replace(/\/+$/, "");
      if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";
    } catch { issue = "DAILY_LLM_BASE_URL 必须是没有账号、查询参数或片段的 HTTP(S) API 地址。"; }
  }
  const timeout = Number(env.DAILY_LLM_TIMEOUT_MS || 180000), maxTokens = Number(env.DAILY_LLM_MAX_OUTPUT_TOKENS || 6000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) issue = "DAILY_LLM_TIMEOUT_MS 范围为 1000–300000。";
  if (!Number.isInteger(maxTokens) || maxTokens < 1000 || maxTokens > MAX_OUTPUT_TOKENS_CAP) issue = "DAILY_LLM_MAX_OUTPUT_TOKENS 范围为 1000–16000。";
  const mode = env.DAILY_LLM_EGRESS_PROFILE?.trim() || "auto";
  if (!["auto", "direct", "vpn", "corp"].includes(mode)) issue = "DAILY_LLM_EGRESS_PROFILE 支持 auto、direct、vpn 或 corp。";
  const routes = new DailyLlmEgress(http, endpoint.replace(/\/chat\/completions$/, "/models"), key, model, mode as DailyLlmConnection["mode"]);
  const status = (): DailyLlmStatus => ({ configured: !missing.length && !issue, provider, model, missing, issue, connection: routes.status() });
  return {
    status,
    async checkConnection() {
      if (!status().configured) throw new DailyLlmError("日报 LLM 尚未完成配置，请检查服务端 .env。");
      return routes.check();
    },
    close: () => routes.close(),
    async complete(system, user, signal, options) {
      if (!status().configured) throw new DailyLlmError("日报 LLM 尚未完成配置，请检查服务端 .env。");
      if (signal.aborted) throw new DailyLlmError("推理已中断，请手动重试。");
      try {
        const egress = await routes.route(signal);
        if (signal.aborted) throw new DailyLlmError("推理已中断，请手动重试。");
        if (!egress) throw new DailyLlmError("未找到可用的LLM出口，请先检测连接并检查网络、Key和模型。");
        const profile = http.profile(egress);
        const reply = await http.request({
          url: endpoint, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], stream: false,
            ...(provider === "deepseek" ? { response_format: { type: "json_object" } } : {}),
            [provider === "openai" ? "max_completion_tokens" : "max_tokens"]: options?.outputTokenBoost ? Math.min(MAX_OUTPUT_TOKENS_CAP, maxTokens * 2) : maxTokens }),
          egressProfile: egress as EgressName, egressFallback: [], userAgent: profile.userAgent,
          followRedirects: false, maxRedirects: 0, connectTimeoutMs: profile.connectTimeoutMs, requestTimeoutMs: timeout, signal,
        });
        if (!reply.ok) { routes.invalidate(); throw new DailyLlmError(reply.error.kind === "timeout" ? "LLM 请求超时，请稍后手动重试。" : "无法连接 LLM，请检查 API 地址和服务端出口。"); }
        const code = reply.value.status;
        if (code >= 500) routes.invalidate();
        if (code < 200 || code >= 300) throw new DailyLlmError(code === 401 || code === 403 ? "LLM 鉴权失败，请检查服务端 API Key。" : code === 429 ? "LLM 配额或速率受限，请稍后手动重试。" : `LLM 返回 HTTP ${code}，请检查 provider、模型与 API 地址。`);
        if (reply.value.body.byteLength > 2_000_000) throw new DailyLlmError("LLM 返回内容过大，未保存为操作建议。");
        const result = JSON.parse(new TextDecoder().decode(reply.value.body));
        const choice = result?.choices?.[0];
        if (choice?.finish_reason === "length") throw new DailyLlmError("LLM 输出被截断，请提高输出 token 上限或缩短参考范围后重试。", "truncated");
        if (choice?.finish_reason !== "stop" || choice?.message?.refusal || typeof choice?.message?.content !== "string" || !choice.message.content.trim()) throw new DailyLlmError("LLM 未返回完整文字结果，请检查模型或稍后重试。");
        const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
        return { text: choice.message.content, model: typeof result.model === "string" ? result.model : model, connection: routes.status(),
          usage: { inputTokens: count(result.usage?.prompt_tokens), outputTokens: count(result.usage?.completion_tokens) } };
      } catch (error) {
        // Never pass provider bodies, URLs containing credentials, or transport details to the UI/logs.
        if (error instanceof DailyLlmError) throw error;
        throw new DailyLlmError("LLM 响应无法读取，请检查模型与兼容协议。");
      }
    },
  };
}
