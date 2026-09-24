// Account settings service: merges encrypted database overrides with the process environment so every
// credential the rest of the server reads through `env()` behaves exactly like a process env var, while the
// UI/API can inspect, edit and mask it. Secret plaintext only ever leaves this module through `env()` and
// `effective()`; every other surface (views, thrown errors) carries at most the last four characters via
// `maskSecret`, or nothing at all.
import {
  SETTINGS_GROUPS,
  SETTINGS_KEYS,
  settingsGroup,
  settingsFieldByKey,
  maskSecret,
  settingsIssues,
  type SettingsFieldDef,
  type SettingsFieldView,
  type SettingsGroupDef,
  type SettingsGroupId,
  type SettingsGroupStatus,
  type SettingsGroupView,
  type SettingsSource,
  type SettingsView,
} from "@invest/domain";
import type { StorageDriver, StoredAppSetting } from "@invest/storage";
import type { SecretBox } from "./secret-box.js";

export class SettingsReadonlyError extends Error {
  constructor(message = "设置当前为只读模式，无法修改。") { super(message); this.name = "SettingsReadonlyError"; }
}
export class SettingsNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "SettingsNotFoundError"; }
}
export class SettingsValidationError extends Error {
  readonly issues: { key: string; message: string }[];
  constructor(issues: { key: string; message: string }[]) {
    super(issues.map(issue => issue.message).join("；") || "设置校验失败");
    this.name = "SettingsValidationError";
    this.issues = issues;
  }
}

export interface SettingsService {
  readonly version: "settings-v1";
  readonly readonly: boolean;
  readonly encryption: SettingsView["encryption"];
  /** A fresh env object: the input env plus decrypted stored overrides; mutating it never touches the input. */
  env(): NodeJS.ProcessEnv;
  /** Precedence for one key: stored override → non-empty env var → field default → none. May return secret plaintext. */
  effective(key: string): { value: string | null; source: SettingsSource };
  view(statuses?: Partial<Record<SettingsGroupId, SettingsGroupStatus | null>>): SettingsView;
  update(groupId: string, values: Record<string, string | null | undefined>, options?: { system?: boolean }): Promise<SettingsGroupView>;
  clear(groupId: string): Promise<SettingsGroupView>;
  subscribe(listener: (groupId: SettingsGroupId) => void): () => void;
}

type SettingsStorage = Pick<StorageDriver, "getAppSettings" | "saveAppSettings" | "deleteAppSettings">;

export async function createSettingsService(options: {
  storage: SettingsStorage;
  env?: NodeJS.ProcessEnv;
  secretBox: SecretBox;
  readonly?: boolean;
  now?: () => number;
}): Promise<SettingsService> {
  const { storage, secretBox } = options;
  const baseEnv = options.env ?? process.env;
  const readonlyMode = options.readonly ?? false;
  const nowFn = options.now ?? Date.now;
  const cache = new Map<string, StoredAppSetting>();
  for (const row of await storage.getAppSettings()) cache.set(row.key, row);
  const listeners = new Set<(groupId: SettingsGroupId) => void>();

  function notify(groupId: SettingsGroupId): void {
    for (const listener of listeners) {
      try { listener(groupId); } catch { /* a subscriber's own failure must not break the write that triggered it */ }
    }
  }

  // A stored row that decrypts cleanly; null means "no usable override" (either absent, or present but undecryptable
  // after a key rotation) — callers fall through to env/default in that case, same as if nothing were stored.
  function readOverride(key: string): { value: string; updatedAtMs: number } | null {
    const row = cache.get(key);
    if (!row) return null;
    if (!row.encrypted) return { value: row.value, updatedAtMs: row.updatedAtMs };
    try { return { value: secretBox.decrypt(row.value), updatedAtMs: row.updatedAtMs }; }
    catch { return null; }
  }
  function isUndecryptable(key: string): boolean {
    const row = cache.get(key);
    return !!row && row.encrypted && readOverride(key) === null;
  }
  function computeEffective(key: string): { value: string | null; source: SettingsSource } {
    const override = readOverride(key);
    if (override) return { value: override.value, source: "settings" };
    const envValue = baseEnv[key]?.trim();
    if (envValue) return { value: envValue, source: "env" };
    const fieldDefault = settingsFieldByKey(key)?.field.default;
    if (fieldDefault) return { value: fieldDefault, source: "default" };
    return { value: null, source: "none" };
  }
  function buildFieldView(field: SettingsFieldDef): SettingsFieldView {
    if (isUndecryptable(field.key)) {
      // There is a stored row, but it cannot be read back (key rotated / box unavailable now): show it as an
      // unusable override rather than silently falling back to env/default, so the user knows to re-enter it.
      return { ...field, source: "settings", configured: false, value: null, masked: null, updatedAt: new Date(cache.get(field.key)!.updatedAtMs).toISOString() };
    }
    const eff = computeEffective(field.key);
    const configured = eff.value !== null;
    const updatedAtMs = cache.get(field.key)?.updatedAtMs;
    return {
      ...field,
      source: eff.source,
      configured,
      value: field.kind === "secret" ? null : eff.value,
      masked: field.kind === "secret" && configured ? maskSecret(eff.value!) : null,
      updatedAt: updatedAtMs !== undefined ? new Date(updatedAtMs).toISOString() : null,
    };
  }
  function buildGroupView(group: SettingsGroupDef, status: SettingsGroupStatus | null): SettingsGroupView {
    const fields = group.fields.map(buildFieldView);
    const missing = group.fields.filter((field, index) => field.required && !fields[index]!.configured).map(field => field.key);
    const undecryptableFields = group.fields.filter(field => isUndecryptable(field.key));
    const resolvedStatus: SettingsGroupStatus | null = status ?? (undecryptableFields.length
      ? { state: "error", message: `${undecryptableFields.map(field => field.label).join("、")} 无法解密，需要重新填写`, checkedAt: null }
      : null);
    return { ...group, fields, configured: missing.length === 0, missing, status: resolvedStatus };
  }

  // `settingsIssues` (shared with the UI) always rejects a present `readonly`-kind key outright, so system writes
  // (the Schwab OAuth exchange recording SCHWAB_REFRESH_TOKEN_ISSUED_AT) validate those fields separately here.
  function validateGroupUpdate(group: SettingsGroupDef, values: Record<string, string | null | undefined>, system: boolean): { key: string; message: string }[] {
    const issues: { key: string; message: string }[] = [];
    const nonReadonly: Record<string, string | null | undefined> = {};
    for (const [key, raw] of Object.entries(values)) {
      const field = group.fields.find(candidate => candidate.key === key);
      if (!field) { issues.push({ key, message: `${group.label} 没有字段 ${key}` }); continue; }
      if (field.kind !== "readonly") { nonReadonly[key] = raw; continue; }
      if (!system) { issues.push({ key, message: `${field.label} 由系统写入，不能手工修改` }); continue; }
      const value = raw === null || raw === undefined ? "" : String(raw).trim();
      if (!value) continue;
      if (/[\r\n]/.test(value)) issues.push({ key, message: `${field.label} 不能包含换行` });
      else if (value.length > 4000) issues.push({ key, message: `${field.label} 过长` });
    }
    issues.push(...settingsIssues(group, nonReadonly));
    for (const [key, raw] of Object.entries(values)) {
      const field = group.fields.find(candidate => candidate.key === key);
      if (!field || field.kind !== "secret") continue;
      const value = raw === null || raw === undefined ? "" : String(raw).trim();
      if (value && secretBox.mode === "unavailable") issues.push({ key, message: `加密密钥不可用，无法保存${field.label}：请先设置 SETTINGS_ENCRYPTION_KEY，或确保数据目录可写以生成密钥文件。` });
    }
    return issues;
  }

  return {
    version: "settings-v1",
    readonly: readonlyMode,
    encryption: { mode: secretBox.mode, note: secretBox.note },

    env() {
      const overrides: Record<string, string> = {};
      for (const key of SETTINGS_KEYS) {
        const override = readOverride(key);
        if (override) overrides[key] = override.value;
      }
      return { ...baseEnv, ...overrides };
    },

    effective(key: string) {
      return computeEffective(key);
    },

    view(statuses) {
      const groups = SETTINGS_GROUPS.map(group => buildGroupView(group, statuses ? statuses[group.id] ?? null : null));
      let latest = 0;
      for (const row of cache.values()) latest = Math.max(latest, row.updatedAtMs);
      return {
        version: "settings-v1",
        readonly: readonlyMode,
        encryption: { mode: secretBox.mode, note: secretBox.note },
        updatedAt: cache.size ? new Date(latest).toISOString() : null,
        groups,
      };
    },

    async update(groupId, values, options) {
      if (readonlyMode) throw new SettingsReadonlyError();
      const group = settingsGroup(groupId);
      if (!group) throw new SettingsNotFoundError(`未知的设置分组：${groupId}`);
      const issues = validateGroupUpdate(group, values, options?.system ?? false);
      if (issues.length) throw new SettingsValidationError(issues);

      const now = nowFn();
      const toSave: StoredAppSetting[] = [];
      const toDelete: string[] = [];
      for (const [key, raw] of Object.entries(values)) {
        const field = group.fields.find(candidate => candidate.key === key)!; // validated above: every key is a real field
        const value = raw === null || raw === undefined ? "" : String(raw).trim();
        if (!value) { toDelete.push(key); continue; }
        const encrypted = field.kind === "secret";
        toSave.push({ key, value: encrypted ? secretBox.encrypt(value) : value, encrypted, updatedAtMs: now });
      }
      await storage.saveAppSettings(toSave);
      await storage.deleteAppSettings(toDelete);
      for (const row of toSave) cache.set(row.key, row);
      for (const key of toDelete) cache.delete(key);
      notify(group.id);
      return buildGroupView(group, null);
    },

    async clear(groupId) {
      if (readonlyMode) throw new SettingsReadonlyError();
      const group = settingsGroup(groupId);
      if (!group) throw new SettingsNotFoundError(`未知的设置分组：${groupId}`);
      const keys = group.fields.map(field => field.key);
      await storage.deleteAppSettings(keys);
      for (const key of keys) cache.delete(key);
      notify(group.id);
      return buildGroupView(group, null);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
