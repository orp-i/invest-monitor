import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { AppConfigSchema, type AppConfig, type ConfigSnapshot } from "./schemas.js";
import { validateConfigRelationships } from "./registry.js";

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: AppConfig; readonly sha256: string; readonly loadedAt: string }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export interface ConfigTransformResult {
  readonly config: AppConfig;
  readonly issues?: readonly ConfigIssue[];
}

export type ConfigTransform = (
  config: AppConfig,
) => AppConfig | ConfigTransformResult | Promise<AppConfig | ConfigTransformResult>;

function zodIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join(".") || "$",
    message: issue.message,
  }));
}

export function parseConfigText(text: string): ConfigLoadResult {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: "$", message: error instanceof Error ? error.message : "invalid YAML" }],
    };
  }

  const parsed = AppConfigSchema.safeParse(document);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const relationshipIssues = validateConfigRelationships(parsed.data);
  if (relationshipIssues.length > 0) return { ok: false, issues: relationshipIssues };
  return {
    ok: true,
    config: parsed.data,
    sha256: createHash("sha256").update(text).digest("hex"),
    loadedAt: new Date().toISOString(),
  };
}

export async function loadConfigFile(path: string): Promise<ConfigLoadResult> {
  try {
    const text = await readFile(path, "utf8");
    return parseConfigText(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path, message: error instanceof Error ? error.message : "unable to read config" }],
    };
  }
}

export interface ConfigEvent {
  readonly type: "loaded" | "invalid";
  readonly snapshot?: ConfigSnapshot;
  readonly issues?: readonly ConfigIssue[];
}

export class ConfigManager {
  private snapshotValue: ConfigSnapshot | null = null;
  private generationValue = 0;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(event: ConfigEvent) => void>();

  public constructor(
    private readonly filePath: string,
    private readonly debounceMs = 350,
    private readonly transform: ConfigTransform = (config) => config,
  ) {}

  public async loadInitial(): Promise<ConfigSnapshot> {
    const result = await loadConfigFile(this.filePath);
    if (!result.ok) {
      throw new Error(`configuration invalid: ${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    }
    const transformed = await this.applyTransform(result.config);
    const snapshot = this.createSnapshot(transformed.config, result.sha256, result.loadedAt, transformed.issues ?? []);
    this.emit({ type: "loaded", snapshot });
    return snapshot;
  }

  public async reload(force = false): Promise<ConfigEvent> {
    const result = await loadConfigFile(this.filePath);
    if (!result.ok) {
      const event: ConfigEvent = { type: "invalid", issues: result.issues };
      this.emit(event);
      return event;
    }
    if (!force && this.snapshotValue?.sha256 === result.sha256) {
      return { type: "loaded", snapshot: this.snapshotValue };
    }
    let transformed: ConfigTransformResult;
    try {
      transformed = await this.applyTransform(result.config);
    } catch (error) {
      const event: ConfigEvent = {
        type: "invalid",
        issues: [{ path: "$runtime", message: error instanceof Error ? error.message : "configuration transform failed" }],
      };
      this.emit(event);
      return event;
    }
    const snapshot = this.createSnapshot(transformed.config, result.sha256, result.loadedAt, transformed.issues ?? []);
    const event: ConfigEvent = { type: "loaded", snapshot };
    this.emit(event);
    return event;
  }

  public get snapshot(): ConfigSnapshot {
    if (!this.snapshotValue) throw new Error("configuration has not been loaded");
    return this.snapshotValue;
  }

  public subscribe(listener: (event: ConfigEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public startWatching(): void {
    if (this.watcher) return;
    const directory = dirname(this.filePath);
    const fileName = basename(this.filePath);
    this.watcher = watch(directory, (_event, changedName) => {
      if (changedName && String(changedName) !== fileName) return;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.reload();
      }, this.debounceMs);
    });
  }

  public stopWatching(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  private async applyTransform(config: AppConfig): Promise<ConfigTransformResult> {
    const transformed = await this.transform(config);
    return "config" in transformed
      ? { config: transformed.config, issues: transformed.issues ?? [] }
      : { config: transformed, issues: [] };
  }

  private createSnapshot(
    config: AppConfig,
    sha256: string,
    loadedAt: string,
    issues: readonly ConfigIssue[],
  ): ConfigSnapshot {
    this.generationValue += 1;
    this.snapshotValue = Object.freeze({
      config,
      generation: this.generationValue,
      sha256,
      loadedAt,
      issues,
    });
    return this.snapshotValue;
  }

  private emit(event: ConfigEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
