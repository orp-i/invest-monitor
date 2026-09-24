import { memo, useCallback, useEffect, useRef, useState } from "react";
import { settingsIssues, type BrokerConnectionStatus, type SettingsFieldView, type SettingsGroupStatus, type SettingsGroupView, type SettingsSchemaDocument, type SettingsTestResult, type SettingsView } from "@invest/domain";
import { getJson, writeJson } from "./api";
import { formatTimestamp } from "./format";

// Account settings: broker API credentials, the daily-report LLM and the broker egress proxy. Values are
// stored encrypted on the server; secrets only ever come back masked, and nothing typed here is persisted
// in the browser (no localStorage, no URL state, no console output).
const API = "/api/settings";
const SOURCE_LABEL = { settings: "账号设置", env: "环境变量", default: "默认值", none: "未配置" } as const;
const SOURCE_TONE = { settings: "live", env: "", default: "muted", none: "muted" } as const;
const STATUS_LABEL: Record<SettingsGroupStatus["state"], string> = { ok: "连接正常", error: "连接异常", reauthorize: "需要重新授权", running: "正在测试", never: "尚未测试", unconfigured: "尚未配置" };
const STATUS_TONE: Record<SettingsGroupStatus["state"], string> = { ok: "live", error: "error", reauthorize: "error", running: "warn", never: "muted", unconfigured: "muted" };
const ENCRYPTION_LABEL = { "env-key": "加密密钥来自环境变量", "key-file": "加密密钥来自服务端密钥文件", unavailable: "加密密钥不可用" } as const;
const SCHWAB_STEPS = ["填写 App Key、App Secret 与回调地址（须与开发者门户登记的 Callback URL 完全一致）并保存。", "点击“获取授权链接”，在新窗口登录 Schwab 并同意授权。", "授权后浏览器会跳转到回调地址（页面可能无法打开，这是正常的），把地址栏里最终的完整 URL 粘贴到下方。", "点击“完成授权”，服务端用其中的授权码换取刷新令牌并加密保存。"];
type Authorization = NonNullable<BrokerConnectionStatus["authorization"]>;
/** key → new value; `null` clears the override; a missing key is unchanged. */
type Draft = Record<string, string | null>;
type Issue = { key: string; message: string };
const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;
const chipText = (v: unknown) => typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : v === null || v === undefined ? "—" : JSON.stringify(v);
const dateOrText = (v: string) => Number.isFinite(Date.parse(v)) ? `${formatTimestamp(v)}（${v}）` : v;

export const SettingsWorkspace = memo(function SettingsWorkspace() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [schwab, setSchwab] = useState<Authorization | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const next = await getJson<SettingsView>(API);
      if (gen !== generation.current) return;
      setView(next); setError("");
      // The refresh-token countdown comes from the broker registry; it is context only, so failures stay quiet.
      if (next.groups.some(g => g.oauth === "schwab")) {
        try { const brokers = await getJson<{ connections: BrokerConnectionStatus[] }>("/api/brokers"); if (gen === generation.current) setSchwab(brokers.connections.find(c => c.id === "schwab")?.authorization ?? null); }
        catch { /* optional context */ }
      }
    } catch (e) { if (gen === generation.current) setError(errorText(e, "账号设置读取失败")); }
    finally { if (gen === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  const locked = view?.encryption.mode === "unavailable";
  return <section className="widget settings-workspace">
    <div className="workspace-intro"><div><p className="eyebrow">ACCOUNT SETTINGS</p><h3>账号设置</h3><p>券商 API、日报推理 LLM 与网络出口的凭证保存在服务端加密存储；未在此填写的项回退到服务器环境变量或默认值。</p></div><button className="text-button" disabled={loading} onClick={() => void refresh()}>{loading ? "读取中…" : "重新读取"}</button></div>
    {error && <div className="inline-error" role="alert">{error}<button className="text-button" onClick={() => void refresh()}>重试读取</button></div>}
    {view?.readonly && <p className="settings-banner settings-banner--warn" role="status">设置为只读，请通过环境变量配置。此页面只显示当前来源与测试结果，不能保存或清除。</p>}
    {view && <p className={`settings-banner${locked ? " settings-banner--warn" : ""}`} role={locked ? "alert" : "status"}><strong>{ENCRYPTION_LABEL[view.encryption.mode]}</strong>{locked ? " · 密钥类字段暂时无法保存，非密钥字段仍可修改。" : ""} {view.encryption.note}{view.updatedAt ? ` · 最近保存 ${formatTimestamp(view.updatedAt)}` : ""}</p>}
    {!view ? <p className="empty-state">{loading ? "正在读取账号设置…" : error ? "读取失败，请重试。" : "暂无设置数据。"}</p>
      : !view.groups.length ? <p className="empty-state">服务端没有返回任何设置分组。</p>
        : <div className="settings-groups">{view.groups.map(group => <SettingsGroupCard key={group.id} group={group} readonly={view.readonly} secretsLocked={locked} authorization={group.oauth === "schwab" ? schwab : null} onChanged={refresh} />)}</div>}
    <SchemaPanel />
  </section>;
});

const SettingsGroupCard = memo(function SettingsGroupCard({ group, readonly, secretsLocked, authorization, onChanged }: { group: SettingsGroupView; readonly: boolean; secretsLocked: boolean; authorization: Authorization | null; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState<"" | "save" | "clear" | "test">("");
  const [notice, setNotice] = useState(""), [error, setError] = useState(""), [issues, setIssues] = useState<Issue[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [test, setTest] = useState<SettingsTestResult | null>(null);
  const changed = Object.keys(draft).length > 0;
  const hasOverrides = group.fields.some(f => f.source === "settings");
  const state = group.status?.state ?? (group.configured ? "never" : "unconfigured");
  useEffect(() => { if (!confirmClear) return; const timer = window.setTimeout(() => setConfirmClear(false), 6000); return () => window.clearTimeout(timer); }, [confirmClear]);
  const edit = useCallback((key: string, value: string | null | undefined) => setDraft(current => { const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = value; return next; }), []);
  const save = async () => {
    if (!changed) { setNotice("没有需要保存的修改。"); return; }
    const found = settingsIssues(group, draft);
    setIssues(found); setError(""); setNotice(""); setConfirmClear(false);
    if (found.length) { setError("请先修正标记的字段。"); return; }
    setBusy("save");
    try { await writeJson<{ group: SettingsGroupView }>(`${API}/${group.id}`, "PUT", { values: draft }); setDraft({}); setNotice(`${group.label} 已保存 ${Object.keys(draft).length} 项。`); await onChanged(); }
    catch (e) { setError(errorText(e, "保存失败")); }
    finally { setBusy(""); }
  };
  const clearAll = async () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    setConfirmClear(false); setBusy("clear"); setError(""); setNotice("");
    try { await writeJson<{ group: SettingsGroupView }>(`${API}/${group.id}`, "DELETE"); setDraft({}); setIssues([]); setNotice(`${group.label} 的账号设置覆盖已清空，现在回退到环境变量或默认值。`); await onChanged(); }
    catch (e) { setError(errorText(e, "清空失败")); }
    finally { setBusy(""); }
  };
  const runTest = async () => {
    setBusy("test"); setError(""); setNotice(""); setTest(null); setConfirmClear(false);
    try { const result = await writeJson<{ result: SettingsTestResult }>(`${API}/${group.id}/test`, "POST", {}); setTest(result.result); await onChanged(); }
    catch (e) { setError(errorText(e, "测试失败")); }
    finally { setBusy(""); }
  };
  const disabled = readonly || !!busy;
  return <article className="settings-card" aria-labelledby={`settings-group-${group.id}`}>
    <header className="settings-card-header"><div><h3 id={`settings-group-${group.id}`}>{group.label}</h3><p>{group.description}{group.docsUrl ? <> <a href={group.docsUrl} target="_blank" rel="noreferrer">官方说明 ↗</a></> : null}</p></div>
      <div className="settings-status"><span className={`risk-chip risk-chip--${STATUS_TONE[state]}`}>{STATUS_LABEL[state]}</span>{group.status?.message ? <span>{group.status.message}</span> : null}{group.status?.checkedAt ? <span>检查于 {formatTimestamp(group.status.checkedAt)}</span> : null}</div></header>
    {!group.configured && group.missing.length ? <p className="settings-missing">缺少：{group.missing.join("、")}</p> : null}
    <div className="settings-fields">{group.fields.map(field => <SettingsFieldRow key={field.key} groupId={group.id} field={field} draft={draft[field.key]} issue={issues.find(i => i.key === field.key)?.message} disabled={disabled} secretsLocked={secretsLocked} onEdit={edit} />)}</div>
    {issues.some(i => !group.fields.some(f => f.key === i.key)) ? <p className="settings-issue" role="alert">{issues.filter(i => !group.fields.some(f => f.key === i.key)).map(i => i.message).join("；")}</p> : null}
    <div className="settings-actions">
      <button type="button" className="primary-button" disabled={disabled || !changed} onClick={() => void save()}>{busy === "save" ? "保存中…" : changed ? `保存修改（${Object.keys(draft).length} 项）` : "保存修改"}</button>
      {group.testable ? <button type="button" className="secondary-button" disabled={!!busy || !group.configured} onClick={() => void runTest()}>{busy === "test" ? "测试中…" : "测试连接"}</button> : null}
      <button type="button" className={`secondary-button${confirmClear ? " settings-danger" : ""}`} disabled={disabled || !hasOverrides} onClick={() => void clearAll()}>{busy === "clear" ? "清空中…" : confirmClear ? "再次点击确认清空" : "清空本组覆盖"}</button>
    </div>
    {notice ? <p className="password-success" role="status">{notice}</p> : null}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {test ? <div className={`settings-test settings-test--${test.ok ? "ok" : "error"}`} role={test.ok ? "status" : "alert"}><strong>{test.ok ? "测试通过" : "测试失败"}</strong> {test.message}{test.details && Object.keys(test.details).length ? <div className="settings-details">{Object.entries(test.details).map(([key, value]) => <span key={key} className="risk-chip risk-chip--muted">{key}: {chipText(value)}</span>)}</div> : null}</div> : null}
    {group.oauth === "schwab" ? <SchwabOauthPanel group={group} disabled={disabled} authorization={authorization} onChanged={onChanged} /> : null}
  </article>;
});

const SettingsFieldRow = memo(function SettingsFieldRow({ groupId, field, draft, issue, disabled, secretsLocked, onEdit }: { groupId: string; field: SettingsFieldView; draft: string | null | undefined; issue: string | undefined; disabled: boolean; secretsLocked: boolean; onEdit: (key: string, value: string | null | undefined) => void }) {
  const [reveal, setReveal] = useState(false);
  const id = `settings-${groupId}-${field.key}`;
  const clearing = draft === null;
  const current = field.value ?? field.default ?? "";
  const locked = disabled || clearing || (field.kind === "secret" && secretsLocked);
  const range = field.kind === "number" && (field.min !== undefined || field.max !== undefined) ? `（${field.min ?? "-∞"}–${field.max ?? "∞"} 的整数）` : "";
  const sourceTone = SOURCE_TONE[field.source] || (field.required && field.source === "none" ? "warn" : "");
  const control = field.kind === "readonly" ? <span className="settings-readonly" id={id}>{field.value ? dateOrText(field.value) : "—"}</span>
    : field.kind === "secret" ? <div className="settings-input"><input id={id} type={reveal ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={draft ?? ""} disabled={locked} placeholder={field.configured ? `已配置 ${field.masked ?? "••••••••"}，留空保持不变` : field.placeholder ?? "尚未配置"} onChange={e => onEdit(field.key, e.target.value === "" ? undefined : e.target.value)} />{typeof draft === "string" && draft.length ? <button type="button" className="text-button" aria-pressed={reveal} aria-label={reveal ? "隐藏输入的新值" : "显示输入的新值"} onClick={() => setReveal(r => !r)}>{reveal ? "隐藏" : "显示"}</button> : null}</div>
      : field.kind === "select" ? <div className="settings-input"><select id={id} value={draft ?? current} disabled={locked} onChange={e => onEdit(field.key, e.target.value === current ? undefined : e.target.value)}>{current && !field.options?.some(o => o.value === current) ? <option value={current}>{current}（当前值）</option> : null}{field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        : <div className="settings-input"><input id={id} type="text" inputMode={field.kind === "number" ? "numeric" : field.kind === "url" ? "url" : "text"} spellCheck={false} value={draft ?? current} disabled={locked} placeholder={field.placeholder ?? (field.default ? `默认 ${field.default}` : "")} onChange={e => onEdit(field.key, e.target.value === current ? undefined : e.target.value)} /></div>;
  return <div className={`settings-field${issue ? " settings-field--invalid" : ""}`}>
    <div className="settings-field-head"><label htmlFor={id}>{field.label}{field.required ? <span aria-hidden="true"> *</span> : null}</label><span className={`risk-chip${sourceTone ? ` risk-chip--${sourceTone}` : ""}`}>{SOURCE_LABEL[field.source]}</span></div>
    {control}
    <p className="settings-help">{field.help}{range}{field.kind === "secret" && secretsLocked ? " 加密密钥不可用，当前无法保存。" : ""}{field.source === "settings" && field.updatedAt ? <small> · 保存于 {formatTimestamp(field.updatedAt)}</small> : null}</p>
    {field.source === "settings" && field.kind !== "readonly" ? <label className="check-label"><input type="checkbox" checked={clearing} disabled={disabled} onChange={e => onEdit(field.key, e.target.checked ? null : undefined)} />清除覆盖（保存后回退到环境变量或默认值）</label> : null}
    {issue ? <p className="settings-issue" role="alert">{issue}</p> : null}
  </div>;
});

function SchwabOauthPanel({ group, disabled, authorization, onChanged }: { group: SettingsGroupView; disabled: boolean; authorization: Authorization | null; onChanged: () => Promise<void> }) {
  const [url, setUrl] = useState(""), [redirected, setRedirected] = useState(""), [issuedAt, setIssuedAt] = useState("");
  const [busy, setBusy] = useState<"" | "url" | "exchange">(""), [error, setError] = useState("");
  const ready = group.fields.filter(f => f.key === "SCHWAB_APP_KEY" || f.key === "SCHWAB_APP_SECRET").every(f => f.configured);
  const fetchUrl = async () => {
    setBusy("url"); setError(""); setIssuedAt("");
    // Open the tab synchronously (inside the click) so popup blockers allow it, then point it at the authorize URL.
    const popup = window.open("about:blank", "_blank");
    try { const result = await getJson<{ url: string }>(`${API}/schwab/authorize-url`); setUrl(result.url); if (popup) { popup.opener = null; popup.location.replace(result.url); } }
    catch (e) { popup?.close(); setError(errorText(e, "获取授权链接失败")); }
    finally { setBusy(""); }
  };
  const exchange = async () => {
    const value = redirected.trim();
    if (!value) { setError("请先粘贴授权后浏览器跳转到的完整 URL。"); return; }
    setBusy("exchange"); setError("");
    try { const result = await writeJson<{ group: SettingsGroupView; issuedAt: string }>(`${API}/schwab/exchange`, "POST", { redirectedUrl: value }); setIssuedAt(result.issuedAt); setRedirected(""); setUrl(""); await onChanged(); }
    catch (e) { setError(errorText(e, "完成授权失败")); }
    finally { setBusy(""); }
  };
  const working = disabled || !!busy;
  return <div className="settings-oauth">
    <h4>OAuth 授权</h4>
    <ol>{SCHWAB_STEPS.map((step, i) => <li key={i}>{step}</li>)}</ol>
    {!ready ? <p className="chart-note">先保存 App Key 与 App Secret，再获取授权链接。</p> : null}
    <div className="settings-actions"><button type="button" className="secondary-button" disabled={working || !ready} onClick={() => void fetchUrl()}>{busy === "url" ? "获取中…" : "获取授权链接"}</button></div>
    {url ? <p className="settings-oauth-url">授权链接（已在新窗口打开；若被拦截可点击）：<a href={url} target="_blank" rel="noreferrer noopener">{url}</a></p> : null}
    <label className="settings-oauth-input">授权后跳转到的完整 URL<textarea aria-label="授权后跳转到的完整 URL" rows={3} spellCheck={false} autoComplete="off" value={redirected} disabled={working} placeholder="https://127.0.0.1/?code=…&session=…" onChange={e => setRedirected(e.target.value)} /></label>
    <div className="settings-actions"><button type="button" className="primary-button" disabled={working || !redirected.trim()} onClick={() => void exchange()}>{busy === "exchange" ? "授权中…" : "完成授权"}</button></div>
    {issuedAt ? <p className="password-success" role="status">授权完成，刷新令牌签发于 {formatTimestamp(issuedAt)}；刷新令牌 7 天有效，到期前请重新授权。</p> : null}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {authorization ? authorization.needsReauthorization
      ? <p className="inline-error" role="alert">{authorization.message ?? "刷新令牌已过期或即将过期，请重新授权。"}</p>
      : <p className="chart-note">{authorization.message ?? `当前刷新令牌${authorization.daysLeft !== null ? `剩余 ${authorization.daysLeft} 天` : "有效期未知"}${authorization.expiresAt ? `，${formatTimestamp(authorization.expiresAt)} 到期` : ""}${authorization.issuedAt ? `（签发于 ${formatTimestamp(authorization.issuedAt)}）` : ""}。`}</p> : null}
  </div>;
}

const SchemaPanel = memo(function SchemaPanel() {
  const [schema, setSchema] = useState<SettingsSchemaDocument | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState(-1);
  const load = async () => {
    if (schema || loading) return;
    setLoading(true); setError("");
    try { setSchema(await getJson<SettingsSchemaDocument>(`${API}/schema`)); }
    catch (e) { setError(errorText(e, "接口说明读取失败")); }
    finally { setLoading(false); }
  };
  const copy = async (text: string, index: number) => {
    try { await navigator.clipboard.writeText(text); setCopied(index); window.setTimeout(() => setCopied(-1), 2000); }
    catch { setError("复制失败，请手动选择文本复制。"); }
  };
  return <details className="settings-schema" onToggle={e => { if (e.currentTarget.open) void load(); }}>
    <summary>供 AI 工具 / 脚本使用的接口</summary>
    <p className="chart-note">脚本与 AI 工具使用 Bearer 令牌（服务器上的 secrets/ui_auth_token）访问同一组接口；非 GET 请求需带 X-Requested-With: XMLHttpRequest。接口只返回来源与掩码，从不返回已保存的密钥值。</p>
    {loading ? <p className="empty-state">正在读取接口说明…</p> : null}
    {error ? <p className="inline-error" role="alert">{error}{!schema ? <button className="text-button" onClick={() => void load()}>重试</button> : null}</p> : null}
    {schema ? <>
      <p><strong>{schema.title}</strong> <span className="muted">版本 {schema.version}</span></p>
      <ol>{schema.instructions.map(item => <li key={item}>{item}</li>)}</ol>
      <p className="chart-note">鉴权：{schema.auth}</p>
      <div className="position-table-wrap"><table className="position-table settings-endpoints"><thead><tr><th>方法</th><th>路径</th><th>说明</th><th>请求体</th><th>响应</th></tr></thead><tbody>{schema.endpoints.map(endpoint => <tr key={`${endpoint.method} ${endpoint.path}`}><td><code>{endpoint.method}</code></td><td><code>{endpoint.path}</code></td><td>{endpoint.summary}</td><td>{endpoint.body ? <code>{endpoint.body}</code> : "—"}</td><td>{endpoint.response ? <code>{endpoint.response}</code> : "—"}</td></tr>)}</tbody></table></div>
      <div className="position-table-wrap"><table className="position-table settings-endpoints"><thead><tr><th>分组</th><th>字段（* 必填）</th></tr></thead><tbody>{schema.groups.map(g => <tr key={g.id}><td><strong>{g.id}</strong><span>{g.label}</span></td><td className="settings-keys">{g.fields.map(f => <code key={f.key}>{f.key}{f.required ? " *" : ""} · {f.kind}{f.options ? `：${f.options.map(o => o.value).join(" / ")}` : ""}</code>)}</td></tr>)}</tbody></table></div>
      {schema.examples.map((example, index) => <div className="settings-example" key={index}><pre>{example}</pre><button type="button" className="secondary-button" aria-label={`复制示例 ${index + 1}`} onClick={() => void copy(example, index)}>{copied === index ? "已复制" : "复制"}</button></div>)}
    </> : null}
  </details>;
});
