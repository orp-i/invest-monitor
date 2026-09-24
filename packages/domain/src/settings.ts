// Shared contracts for account settings: broker providers, the settings groups/fields that the UI, the
// REST API and the environment share, and the API payload shapes. Values never appear here; secrets are
// stored encrypted by the server and only ever leave it masked.
export type BrokerApiId = "tradier" | "ibkr" | "schwab" | "alpaca";
export type BrokerId = BrokerApiId | "elephant";
export const BROKER_API_IDS: readonly BrokerApiId[] = ["tradier", "ibkr", "schwab", "alpaca"];
export interface BrokerProvider {
  id: BrokerApiId; name: string; label: string; kind: "api" | "report"; cadenceMinutes: number;
  description: string; docsUrl: string; envKeys: string[]; modeKey?: string;
}
export const BROKER_PROVIDERS: readonly BrokerProvider[] = [
  { id: "tradier", name: "Tradier", label: "Tradier", kind: "api", cadenceMinutes: 15, description: "读取账户余额、持仓及历史成交；同一 Token 用于股票、期权行情和搜索。", docsUrl: "https://docs.tradier.com/docs/account-details", envKeys: ["TRADIER_ACCESS_TOKEN"], modeKey: "TRADIER_ENVIRONMENT" },
  { id: "ibkr", name: "IBKR", label: "盈透 IBKR · Flex 报表", kind: "report", cadenceMinutes: 60, description: "通过 Flex Web Service 读取持仓和逐笔成交，按报表截止日展示。", docsUrl: "https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm", envKeys: ["IBKR_FLEX_TOKEN", "IBKR_FLEX_QUERY_ID"] },
  { id: "schwab", name: "Schwab", label: "嘉信 Charles Schwab · Trader API", kind: "api", cadenceMinutes: 15, description: "通过 Schwab Trader API（OAuth 2.0）读取账户余额、持仓与成交；刷新令牌 7 天有效，到期需重新授权。", docsUrl: "https://developer.schwab.com/products/trader-api--individual", envKeys: ["SCHWAB_APP_KEY", "SCHWAB_APP_SECRET", "SCHWAB_REFRESH_TOKEN"] },
  { id: "alpaca", name: "Alpaca", label: "Alpaca · Trading API", kind: "api", cadenceMinutes: 15, description: "通过 Trading API 读取账户、持仓与成交回报；支持实盘与 Paper 环境。", docsUrl: "https://docs.alpaca.markets/docs/trading-api", envKeys: ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"], modeKey: "ALPACA_ENVIRONMENT" },
];
export const brokerProvider = (id: string): BrokerProvider | undefined => BROKER_PROVIDERS.find(p => p.id === id);

export type SettingsGroupId = "tradier" | "ibkr" | "schwab" | "alpaca" | "llm" | "network";
export type SettingsFieldKind = "secret" | "text" | "url" | "select" | "number" | "readonly";
export interface SettingsFieldDef {
  key: string; label: string; kind: SettingsFieldKind; required: boolean; help: string;
  default?: string; options?: { value: string; label: string }[]; placeholder?: string; min?: number; max?: number; pattern?: string;
}
export interface SettingsGroupDef { id: SettingsGroupId; label: string; kind: "broker" | "llm" | "network"; description: string; docsUrl: string | null; testable: boolean; oauth?: "schwab"; fields: SettingsFieldDef[] }
const secret = (key: string, label: string, help: string, required = true): SettingsFieldDef => ({ key, label, kind: "secret", required, help });
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  { id: "tradier", label: "Tradier", kind: "broker", description: "账户同步与美股/ETF/期权行情共用同一个 Access Token。", docsUrl: "https://docs.tradier.com/docs/account-details", testable: true, fields: [
    secret("TRADIER_ACCESS_TOKEN", "Access Token", "Tradier 账户 API 设置中生成；实盘用生产 Token，模拟用 sandbox Token。"),
    { key: "TRADIER_ENVIRONMENT", label: "环境", kind: "select", required: false, default: "live", options: [{ value: "live", label: "实盘 live" }, { value: "sandbox", label: "模拟 sandbox（行情延迟 15 分钟）" }], help: "行情与账户同步使用同一环境。" },
  ] },
  { id: "ibkr", label: "盈透 IBKR（Flex 报表）", kind: "broker", description: "Flex Web Service 只读报表：Open Positions（SUMMARY）+ Trades（EXECUTION），XML 格式。", docsUrl: "https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm", testable: true, fields: [
    secret("IBKR_FLEX_TOKEN", "Flex Token", "IBKR 门户 → Performance & Reports → Flex Web Service 生成。"),
    { key: "IBKR_FLEX_QUERY_ID", label: "Flex Query ID", kind: "text", required: true, pattern: "^\\d+$", help: "Activity Flex Query 的数字编号，输出格式须为 XML。" },
  ] },
  { id: "schwab", label: "嘉信 Charles Schwab", kind: "broker", description: "Schwab Trader API（个人开发者）：先填写 App Key / Secret 与回调地址，再点击“授权”完成 OAuth；刷新令牌 7 天后需重新授权。", docsUrl: "https://developer.schwab.com/products/trader-api--individual", testable: true, oauth: "schwab", fields: [
    secret("SCHWAB_APP_KEY", "App Key", "Schwab 开发者门户中应用的 App Key（client_id）。"),
    secret("SCHWAB_APP_SECRET", "App Secret", "应用的 Secret（client_secret）。"),
    { key: "SCHWAB_REDIRECT_URI", label: "回调地址", kind: "url", required: false, default: "https://127.0.0.1", help: "必须与开发者门户中登记的 Callback URL 完全一致；授权后浏览器会跳转到该地址，把整个跳转后的 URL 粘贴回来即可。" },
    secret("SCHWAB_REFRESH_TOKEN", "Refresh Token", "通常由“授权”流程自动写入；也可从其他工具粘贴。", false),
    { key: "SCHWAB_REFRESH_TOKEN_ISSUED_AT", label: "刷新令牌签发时间", kind: "readonly", required: false, help: "授权完成时自动记录，用于提示 7 天有效期。" },
  ] },
  { id: "alpaca", label: "Alpaca", kind: "broker", description: "Alpaca Trading API Key（只读同步足够，建议使用受限权限的 Key）。", docsUrl: "https://docs.alpaca.markets/docs/trading-api", testable: true, fields: [
    secret("ALPACA_API_KEY_ID", "API Key ID", "Alpaca 控制台生成。"),
    secret("ALPACA_API_SECRET_KEY", "API Secret Key", "与 Key ID 成对生成，只显示一次。"),
    { key: "ALPACA_ENVIRONMENT", label: "环境", kind: "select", required: false, default: "live", options: [{ value: "live", label: "实盘 api.alpaca.markets" }, { value: "paper", label: "Paper paper-api.alpaca.markets" }], help: "Paper Key 只能用于 paper 环境。" },
  ] },
  { id: "llm", label: "日报推理 LLM", kind: "llm", description: "市场日报推理使用的 Chat Completions 兼容接口（DeepSeek / OpenAI / 其他兼容服务）。", docsUrl: null, testable: true, fields: [
    { key: "DAILY_LLM_PROVIDER", label: "协议", kind: "select", required: false, default: "openai-compatible", options: [{ value: "openai-compatible", label: "OpenAI 兼容（max_tokens）" }, { value: "openai", label: "OpenAI（max_completion_tokens）" }, { value: "deepseek", label: "DeepSeek（JSON 输出）" }], help: "决定请求字段与输出格式。" },
    { key: "DAILY_LLM_BASE_URL", label: "API 地址", kind: "url", required: true, placeholder: "https://api.deepseek.com/v1", help: "包含版本路径，不含 /chat/completions；不能带账号、查询参数或片段。" },
    secret("DAILY_LLM_API_KEY", "API Key", "仅保存在服务端。"),
    { key: "DAILY_LLM_MODEL", label: "模型", kind: "text", required: true, placeholder: "deepseek-chat", help: "服务商的模型名称。" },
    { key: "DAILY_LLM_TIMEOUT_MS", label: "超时（毫秒）", kind: "number", required: false, default: "180000", min: 1000, max: 300000, help: "单次推理请求超时。" },
    { key: "DAILY_LLM_MAX_OUTPUT_TOKENS", label: "输出 token 上限", kind: "number", required: false, default: "6000", min: 1000, max: 16000, help: "截断时会自动以两倍上限（≤16000）压缩重试一次。" },
    { key: "DAILY_LLM_EGRESS_PROFILE", label: "出口", kind: "select", required: false, default: "auto", options: [{ value: "auto", label: "自动比较直连与 VPN" }, { value: "direct", label: "直连" }, { value: "vpn", label: "VPN 代理" }, { value: "corp", label: "公司代理" }], help: "auto 会先读取模型列表比较可用性与延迟。" },
  ] },
  { id: "network", label: "网络出口", kind: "network", description: "券商同步（Tradier / IBKR / Schwab / Alpaca）使用的 HTTP 代理；留空直连。行情与新闻的出口在 config/portfolio.yaml 的 egressProfiles 中配置。", docsUrl: null, testable: false, fields: [
    { key: "BROKER_EGRESS_PROXY_URL", label: "券商同步代理", kind: "url", required: false, placeholder: "http://127.0.0.1:17890", help: "http(s):// 代理地址；Docker 内访问宿主机用 host.docker.internal。" },
  ] },
];
export const settingsGroup = (id: string): SettingsGroupDef | undefined => SETTINGS_GROUPS.find(g => g.id === id);
export const SETTINGS_KEYS: ReadonlySet<string> = new Set(SETTINGS_GROUPS.flatMap(g => g.fields.map(f => f.key)));
export const settingsFieldByKey = (key: string): { group: SettingsGroupDef; field: SettingsFieldDef } | undefined => {
  for (const group of SETTINGS_GROUPS) { const field = group.fields.find(f => f.key === key); if (field) return { group, field }; }
  return undefined;
};

export type SettingsSource = "settings" | "env" | "default" | "none";
export interface SettingsFieldView extends SettingsFieldDef { source: SettingsSource; configured: boolean; value: string | null; masked: string | null; updatedAt: string | null }
export interface SettingsGroupStatus { state: "unconfigured" | "never" | "ok" | "error" | "running" | "reauthorize"; message: string | null; checkedAt: string | null; details?: Record<string, unknown> }
export interface SettingsGroupView extends Omit<SettingsGroupDef, "fields"> { fields: SettingsFieldView[]; configured: boolean; missing: string[]; status: SettingsGroupStatus | null }
export interface SettingsView { version: string; readonly: boolean; encryption: { mode: "env-key" | "key-file" | "unavailable"; note: string }; updatedAt: string | null; groups: SettingsGroupView[] }
export interface SettingsUpdateRequest { values: Record<string, string | null> }
export interface SettingsTestResult { ok: boolean; message: string; details?: Record<string, unknown> }
export interface SettingsEndpointDoc { method: "GET" | "PUT" | "POST" | "DELETE"; path: string; summary: string; body?: string; response?: string }
export interface SettingsSchemaDocument { version: string; title: string; instructions: string[]; auth: string; endpoints: SettingsEndpointDoc[]; groups: SettingsGroupDef[]; examples: string[] }

/** Display form of a secret: never more than the last four characters. */
export function maskSecret(value: string): string {
  const tail = value.trim().slice(-4);
  return value.trim().length > 8 ? `••••••••${tail}` : "••••••••";
}
/** Validation shared by the page and the API; `null`/empty means "clear the override". */
export function settingsIssues(group: SettingsGroupDef, values: Record<string, string | null | undefined>): { key: string; message: string }[] {
  const issues: { key: string; message: string }[] = [];
  for (const key of Object.keys(values)) if (!group.fields.some(f => f.key === key)) issues.push({ key, message: `${group.label} 没有字段 ${key}` });
  for (const field of group.fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = String(raw).trim();
    if (field.kind === "readonly") { issues.push({ key: field.key, message: `${field.label} 由系统写入，不能手工修改` }); continue; }
    if (/[\r\n]/.test(value)) { issues.push({ key: field.key, message: `${field.label} 不能包含换行` }); continue; }
    if (field.kind === "select" && !field.options?.some(o => o.value === value)) issues.push({ key: field.key, message: `${field.label} 只能是 ${field.options?.map(o => o.value).join(" / ")}` });
    if (field.kind === "number") { const n = Number(value); if (!Number.isInteger(n) || (field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) issues.push({ key: field.key, message: `${field.label} 须为 ${field.min ?? "-∞"}–${field.max ?? "∞"} 的整数` }); }
    if (field.kind === "url") { try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(); } catch { issues.push({ key: field.key, message: `${field.label} 必须是不含账号或片段的 http(s) 地址` }); } }
    if (field.pattern && !new RegExp(field.pattern).test(value)) issues.push({ key: field.key, message: `${field.label} 格式不正确` });
    if (value.length > 4000) issues.push({ key: field.key, message: `${field.label} 过长` });
  }
  return issues;
}
