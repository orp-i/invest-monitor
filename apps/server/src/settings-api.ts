// REST surface for account settings: thin routing over `SettingsService`, plus a self-describing schema document
// so an AI agent (or a human with curl) can configure this server without reading source. Never place secret
// values in a response body — the service itself already keeps plaintext out of `view()`/`update()`/`clear()`.
import {
  SETTINGS_GROUPS,
  settingsGroup,
  type SettingsEndpointDoc,
  type SettingsGroupId,
  type SettingsGroupStatus,
  type SettingsSchemaDocument,
  type SettingsTestResult,
} from "@invest/domain";
import { SettingsNotFoundError, SettingsReadonlyError, SettingsValidationError, type SettingsService } from "./settings.js";

export interface SettingsApiDeps {
  settings: SettingsService;
  statuses?: () => Promise<Partial<Record<SettingsGroupId, SettingsGroupStatus | null>>>;
  test?: (groupId: SettingsGroupId, env: NodeJS.ProcessEnv) => Promise<SettingsTestResult>;
  schwab?: {
    authorizeUrl(env: NodeJS.ProcessEnv): string;
    exchange(env: NodeJS.ProcessEnv, code: string): Promise<{ refreshToken: string; issuedAt: string; accessTokenExpiresAt?: string | null }>;
  };
  /** Used only in the schema document's example curl commands. */
  publicOrigin?: string;
}

type Reply = { status: number; body: Record<string, unknown> };
const bad = (message: string, status = 400): Reply => ({ status, body: { message } });

export async function settingsRequest(method: string, url: URL, body: unknown, deps: SettingsApiDeps): Promise<Reply> {
  const pathname = url.pathname;

  if (pathname === "/api/settings") {
    if (method !== "GET") return bad("不支持此操作", 405);
    let statuses: Partial<Record<SettingsGroupId, SettingsGroupStatus | null>> = {};
    if (deps.statuses) { try { statuses = await deps.statuses(); } catch { statuses = {}; } }
    return { status: 200, body: deps.settings.view(statuses) as unknown as Record<string, unknown> };
  }

  if (pathname === "/api/settings/schema") {
    if (method !== "GET") return bad("不支持此操作", 405);
    return { status: 200, body: buildSchema(deps) as unknown as Record<string, unknown> };
  }

  if (pathname === "/api/settings/schwab/authorize-url") {
    if (method !== "GET") return bad("不支持此操作", 405);
    if (!deps.schwab) return bad("尚未启用 Schwab 授权。", 501);
    // "configured" mirrors the field view: a field with a usable default (SCHWAB_REDIRECT_URI) counts even
    // without an explicit override, so this only blocks on the truly required App Key.
    const missing = ["SCHWAB_APP_KEY", "SCHWAB_REDIRECT_URI"].filter(key => deps.settings.effective(key).value === null);
    if (missing.length) return bad(`请先配置 ${missing.join("、")}`);
    try { return { status: 200, body: { url: deps.schwab.authorizeUrl(deps.settings.env()) } }; }
    catch (error) { return bad(errorMessage(error, "无法生成授权地址，请检查回调地址格式。")); }
  }

  if (pathname === "/api/settings/schwab/exchange") {
    if (method !== "POST") return bad("不支持此操作", 405);
    if (!deps.schwab) return bad("尚未启用 Schwab 授权。", 501);
    const parsedBody = body && typeof body === "object" && !Array.isArray(body) ? body as { redirectedUrl?: unknown; code?: unknown } : {};
    const code = extractSchwabCode(parsedBody);
    if (!code) return bad("未找到 Schwab 授权码，请粘贴完整的跳转后地址，或直接粘贴 code。");
    let exchange: { refreshToken: string; issuedAt: string; accessTokenExpiresAt?: string | null };
    try { exchange = await deps.schwab.exchange(deps.settings.env(), code); }
    catch (error) { return bad(errorMessage(error, "Schwab 授权失败，请检查 App Key/Secret 与回调地址后重试。")); }
    try {
      const group = await deps.settings.update("schwab", { SCHWAB_REFRESH_TOKEN: exchange.refreshToken, SCHWAB_REFRESH_TOKEN_ISSUED_AT: exchange.issuedAt }, { system: true });
      return { status: 200, body: { group, issuedAt: exchange.issuedAt } };
    } catch (error) { return mapServiceError(error); }
  }

  const testMatch = /^\/api\/settings\/([a-z]+)\/test$/.exec(pathname);
  if (testMatch) {
    if (method !== "POST") return bad("不支持此操作", 405);
    const groupId = testMatch[1]!;
    const group = settingsGroup(groupId);
    if (!group) return bad("设置分组不存在", 404);
    if (!group.testable) return bad(`${group.label} 不支持连接检测。`);
    if (!deps.test) return bad("尚未启用连接检测。", 501);
    try { return { status: 200, body: { result: await deps.test(groupId as SettingsGroupId, deps.settings.env()) } }; }
    catch (error) { return { status: 200, body: { result: { ok: false, message: errorMessage(error, "检测失败，请稍后重试。") } } }; }
  }

  const groupMatch = /^\/api\/settings\/([a-z]+)$/.exec(pathname);
  if (groupMatch) {
    const groupId = groupMatch[1]!;
    if (method === "PUT") {
      const values = parseValues(body);
      if (!values) return { status: 400, body: { message: "请求体需要 { values: Record<string, string | null> } 格式", issues: [] } };
      try { return { status: 200, body: { group: await deps.settings.update(groupId, values) } }; }
      catch (error) { return mapServiceError(error); }
    }
    if (method === "DELETE") {
      try { return { status: 200, body: { group: await deps.settings.clear(groupId) } }; }
      catch (error) { return mapServiceError(error); }
    }
    return bad("不支持此操作", 405);
  }

  return bad("not found", 404);
}

function parseValues(body: unknown): Record<string, string | null> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).values;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry !== null && typeof entry !== "string") return null;
    values[key] = entry;
  }
  return values;
}

function extractSchwabCode(body: { redirectedUrl?: unknown; code?: unknown }): string | null {
  if (typeof body.code === "string" && body.code.trim()) return body.code.trim();
  const raw = typeof body.redirectedUrl === "string" ? body.redirectedUrl.trim() : "";
  if (!raw) return null;
  try { const fromUrl = new URL(raw).searchParams.get("code"); if (fromUrl) return fromUrl; } catch { /* not an absolute URL: fall through to a manual query scan */ }
  const match = /[?&]code=([^&#]+)/.exec(raw);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return match[1]!; }
}

function mapServiceError(error: unknown): Reply {
  if (error instanceof SettingsValidationError) return { status: 400, body: { message: error.message, issues: error.issues } };
  if (error instanceof SettingsNotFoundError) return { status: 404, body: { message: error.message } };
  if (error instanceof SettingsReadonlyError) return { status: 403, body: { message: error.message } };
  return { status: 500, body: { message: errorMessage(error, "设置服务内部错误") } };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function buildSchema(deps: SettingsApiDeps): SettingsSchemaDocument {
  const origin = (deps.publicOrigin?.trim() || "http://localhost:8080").replace(/\/+$/, "");
  const endpoints: SettingsEndpointDoc[] = [
    { method: "GET", path: "/api/settings", summary: "读取全部设置分组：每个字段的来源、是否已配置、脱敏值与最近检测状态。", response: "SettingsView" },
    { method: "GET", path: "/api/settings/schema", summary: "读取本文档：分组/字段定义、认证方式与调用示例。", response: "SettingsSchemaDocument" },
    { method: "PUT", path: "/api/settings/:group", summary: "写入一个分组的若干字段；值为空字符串或 null 会清除该字段的覆盖值，改为回退到同名环境变量或默认值。", body: "{ values: Record<string, string | null> }", response: "{ group: SettingsGroupView }" },
    { method: "DELETE", path: "/api/settings/:group", summary: "清除一个分组的全部覆盖值，回退到环境变量/默认值。", response: "{ group: SettingsGroupView }" },
    { method: "POST", path: "/api/settings/:group/test", summary: "对已配置的分组发起一次只读连接检测；仅 schema 中 testable=true 的分组支持。", response: "{ result: SettingsTestResult }" },
    { method: "GET", path: "/api/settings/schwab/authorize-url", summary: "生成 Schwab OAuth 授权地址（需已配置 App Key，回调地址可用默认值）。", response: "{ url: string }" },
    { method: "POST", path: "/api/settings/schwab/exchange", summary: "用授权后跳转的完整地址（或直接给出 code）换取 Refresh Token 并保存。", body: "{ redirectedUrl?: string; code?: string }", response: "{ group: SettingsGroupView; issuedAt: string }" },
  ];
  const examples = [
    `curl -sS ${origin}/api/settings/schema -H "Authorization: Bearer <ui_auth_token>"`,
    `curl -sS -X PUT ${origin}/api/settings/tradier -H "Authorization: Bearer <ui_auth_token>" -H "X-Requested-With: XMLHttpRequest" -H "Content-Type: application/json" -d '{"values":{"TRADIER_ACCESS_TOKEN":"<token>","TRADIER_ENVIRONMENT":"live"}}'`,
    `curl -sS -X POST ${origin}/api/settings/tradier/test -H "Authorization: Bearer <ui_auth_token>" -H "X-Requested-With: XMLHttpRequest"`,
    `curl -sS -X PUT ${origin}/api/settings/llm -H "Authorization: Bearer <ui_auth_token>" -H "X-Requested-With: XMLHttpRequest" -H "Content-Type: application/json" -d '{"values":{"DAILY_LLM_BASE_URL":"https://api.deepseek.com/v1","DAILY_LLM_API_KEY":"<key>","DAILY_LLM_MODEL":"deepseek-chat"}}'`,
  ];
  const instructions = [
    "本接口面向配置本系统的 AI Agent 与自动化脚本：先调用 GET /api/settings/schema 了解全部分组、字段与认证方式，再调用 PUT 写入或 POST 测试；无需阅读服务端源码。",
    "认证：脚本与 AI 工具使用 Authorization: Bearer <token>（token 来自服务器 secrets/ui_auth_token），带 Bearer 的请求不需要额外请求头；浏览器会话（Cookie）发起的 PUT/DELETE/POST 等非 GET 请求必须附带 X-Requested-With: XMLHttpRequest，否则会被 CSRF 防护拒绝（403）。",
    "写入字段：PUT /api/settings/:group，body 为 { values: { 字段KEY: 值 } }；把某个字段设为空字符串或 null 会清除该覆盖值，之后自动回退到同名环境变量或字段默认值，而不是报错。",
    "DELETE /api/settings/:group 会一次性清除该分组的全部覆盖值。",
    "POST /api/settings/:group/test 仅对 schema 中 testable=true 的分组可用：会用当前生效配置发起一次只读连接检测，返回 { ok, message }，即使检测失败也是 200。",
    "只读模式（GET 返回的 readonly=true）下所有写操作都会被拒绝，返回 403；GET 类读取接口不受影响。",
    "字段的 value 只对非密钥字段返回明文；kind 为 secret 的字段在任何响应中都不会出现明文，只提供 masked（仅显示末 4 位）与 configured 标记，写入后也无法读回原文。",
  ];
  return {
    version: "settings-v1",
    title: "账户设置 API",
    instructions,
    auth: "Authorization: Bearer <token>（token 即 secrets/ui_auth_token 内容；Bearer 请求免除 CSRF 头）。使用已登录会话 Cookie 时，非 GET 请求另需 X-Requested-With: XMLHttpRequest 头。",
    endpoints,
    groups: SETTINGS_GROUPS.map(group => group),
    examples,
  };
}
