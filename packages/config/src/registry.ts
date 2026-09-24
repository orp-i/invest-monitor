import type { SourceBinding } from "@invest/domain";
import { InstrumentConfigSchema, SourceParams, type AppConfig, type InstrumentConfig, type SourceConfig } from "./schemas.js";
import type { ConfigIssue } from "./loader.js";

const ALLOWED_HOSTS: Record<string, readonly string[]> = {
  "tradier-stocks": ["api.tradier.com", "sandbox.tradier.com"],
  coingecko: ["api.coingecko.com"],
  "binance-vision": ["data-api.binance.vision"],
  "gold-api": ["api.gold-api.com"],
  "massive-stocks": ["api.massive.com", "api.polygon.io"],
  "massive-options": ["api.massive.com", "api.polygon.io"],
  rss: [
    "news.google.com",
    "www.federalreserve.gov",
    "cointelegraph.com",
    "www.cnbc.com",
    "seekingalpha.com",
    "www.coindesk.com",
    "www.sec.gov",
  ],
};

const LLM_ALLOWED_HOSTS: Record<string, readonly string[]> = {
  openrouter: ["openrouter.ai"],
  openai: ["api.openai.com"],
  anthropic: ["api.anthropic.com"],
  deepseek: ["api.deepseek.com"],
};

export function validateConfigRelationships(config: AppConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const profiles = config.egressProfiles;
  for (const name of ["direct", "corp", "vpn"] as const) {
    if (!profiles[name]) issues.push({ path: `egressProfiles.${name}`, message: "required egress profile is missing" });
    else if (profiles[name].name !== name) issues.push({ path: `egressProfiles.${name}.name`, message: "profile key and name must match" });
  }

  const sourceIds = new Set<string>();
  const instrumentIds = new Set<string>();
  for (const source of config.sources) {
    if (sourceIds.has(source.id)) issues.push({ path: "sources", message: `duplicate source id: ${source.id}` });
    sourceIds.add(source.id);
    if (!profiles[source.egressProfile]) issues.push({ path: `sources.${source.id}.egressProfile`, message: "unknown egress profile" });
    if (source.capabilities.includes("instrumentSearch") && !source.defaultBinding) {
      issues.push({ path: `sources.${source.id}.defaultBinding`, message: "instrumentSearch sources require defaultBinding" });
    }
    if (source.defaultBinding && !profiles[source.defaultBinding.egressProfile]) {
      issues.push({ path: `sources.${source.id}.defaultBinding.egressProfile`, message: "unknown egress profile" });
    }
    const allowedHosts = ALLOWED_HOSTS[source.adapter];
    if (source.adapter === "tradier-stocks") {
      const url = new URL(source.baseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !/^\/v1\/?$/.test(url.pathname) || url.search || url.hash || source.followRedirects) {
        issues.push({ path: `sources.${source.id}.baseUrl`, message: "Tradier requires credential-free HTTPS /v1 and redirects disabled" });
      }
    }
    if (allowedHosts) {
      const host = new URL(source.baseUrl).hostname.toLowerCase();
      if (!allowedHosts.includes(host)) {
        issues.push({ path: `sources.${source.id}.baseUrl`, message: `host ${host} is not allowed for adapter ${source.adapter}` });
      }
    }
    const paramsSchema = SourceParams[source.adapter as keyof typeof SourceParams];
    if (paramsSchema) {
      const parsedParams = paramsSchema.safeParse(source.params);
      if (!parsedParams.success) {
        issues.push({ path: `sources.${source.id}.params`, message: parsedParams.error.message });
      }
    }
  }

  const sectionIds = new Set<string>();
  for (const section of config.sections) {
    if (sectionIds.has(section.id)) issues.push({ path: "sections", message: `duplicate section id: ${section.id}` });
    sectionIds.add(section.id);
    if (section.match.assetClasses.length === 0 && section.match.capabilities.length === 0 && section.id !== "other") {
      issues.push({ path: `sections.${section.id}.match`, message: "section must match an assetClass or capability" });
    }
  }

  for (const provider of config.llm.providers) {
    if (!profiles[provider.egressProfile]) {
      issues.push({ path: `llm.providers.${provider.id}.egressProfile`, message: "unknown egress profile" });
    }
    const url = new URL(provider.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      issues.push({ path: `llm.providers.${provider.id}.baseUrl`, message: "LLM base URL must be credential-free HTTPS" });
    }
    const allowedHosts = LLM_ALLOWED_HOSTS[provider.id];
    if (!allowedHosts) {
      issues.push({ path: `llm.providers.${provider.id}.id`, message: `unsupported LLM provider: ${provider.id}` });
    } else if (!allowedHosts.includes(url.hostname.toLowerCase())) {
      issues.push({ path: `llm.providers.${provider.id}.baseUrl`, message: `host ${url.hostname} is not allowed for provider ${provider.id}` });
    }
  }

  for (const instrument of config.instruments) {
    if (instrumentIds.has(instrument.id)) issues.push({ path: "instruments", message: `duplicate instrument id: ${instrument.id}` });
    instrumentIds.add(instrument.id);
    const bindingKeys = new Set<string>();
    for (const binding of instrument.sourceBindings) {
      if (binding.instrumentId !== instrument.id) {
        issues.push({ path: `instruments.${instrument.id}.sourceBindings`, message: `binding instrumentId must be ${instrument.id}` });
      }
      const key = `${binding.sourceId}:${binding.instrumentId}`;
      if (bindingKeys.has(key)) issues.push({ path: `instruments.${instrument.id}.sourceBindings`, message: `duplicate binding: ${key}` });
      bindingKeys.add(key);
      const source = config.sources.find((candidate) => candidate.id === binding.sourceId);
      if (!source) {
        issues.push({ path: `instruments.${instrument.id}.sourceBindings`, message: `unknown source: ${binding.sourceId}` });
      } else {
        if (!source.capabilities.some((capability) => binding.capabilities.includes(capability))) {
          issues.push({ path: `instruments.${instrument.id}.sourceBindings`, message: `binding has no capability declared by ${source.id}` });
        }
        if (!profiles[binding.egressProfile]) {
          issues.push({ path: `instruments.${instrument.id}.sourceBindings`, message: `unknown binding egress profile: ${binding.egressProfile}` });
        }
      }
    }
  }

  for (const symbolMap of config.symbolMaps) {
    if (!sourceIds.has(symbolMap.sourceId)) {
      issues.push({ path: "symbolMaps", message: `symbol map references unknown source: ${symbolMap.sourceId}` });
    }
    for (const instrumentId of Object.keys(symbolMap.entries)) {
      if (!instrumentIds.has(instrumentId)) {
        issues.push({ path: `symbolMaps.${symbolMap.sourceId}.entries`, message: `symbol map references unknown instrument: ${instrumentId}` });
      }
    }
  }
  for (const sourceId of config.intel.sources) {
    const source = config.sources.find((candidate) => candidate.id === sourceId);
    if (!source) {
      issues.push({ path: "intel.sources", message: `unknown news source: ${sourceId}` });
    } else if (!source.capabilities.includes("news")) {
      issues.push({ path: "intel.sources", message: `${sourceId} does not declare the news capability` });
    }
  }
  const route = config.llm.routes[config.intel.llmRouteId];
  if (config.intel.enabled && !route) {
    issues.push({ path: "intel.llmRouteId", message: `unknown LLM route: ${config.intel.llmRouteId}` });
  }
  if (route) {
    const providerIds = new Set(config.llm.providers.map((provider) => provider.id));
    for (const providerId of route.orderedProviders) {
      if (!providerIds.has(providerId)) {
        issues.push({ path: `llm.routes.${config.intel.llmRouteId}.orderedProviders`, message: `unknown LLM provider: ${providerId}` });
      }
    }
  }
  return issues;
}

export interface SymbolMapResolution {
  readonly strategy: "explicit" | "template" | "alias";
  readonly providerSymbol: string;
}

export interface ConfigMergeResult {
  readonly config: AppConfig;
  readonly issues: readonly ConfigIssue[];
  readonly shadowedUserInstrumentIds: readonly string[];
}

export class ConfigRegistry {
  private readonly config: AppConfig;
  public readonly issues: readonly ConfigIssue[];
  public readonly shadowedUserInstrumentIds: readonly string[];

  public constructor(config: AppConfig, databaseInstruments: readonly unknown[] = []) {
    const merged = ConfigRegistry.merge(config, databaseInstruments);
    this.config = merged.config;
    this.issues = merged.issues;
    this.shadowedUserInstrumentIds = merged.shadowedUserInstrumentIds;
  }

  public static merge(config: AppConfig, databaseInstruments: readonly unknown[]): ConfigMergeResult {
    const issues: ConfigIssue[] = [];
    const shadowedUserInstrumentIds: string[] = [];
    const yamlIds = new Set(config.instruments.map((instrument) => instrument.id));
    const accepted: InstrumentConfig[] = [];

    for (const value of databaseInstruments) {
      const parsed = InstrumentConfigSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          issues.push({
            path: `database.instruments.${issue.path.map(String).join(".") || "$"}`,
            message: issue.message,
          });
        }
        continue;
      }
      const instrument = {
        ...parsed.data,
        sourceBindings: parsed.data.sourceBindings.map((binding) => {
          const source = config.sources.find((candidate) => candidate.id === binding.sourceId);
          return source ? { ...binding, egressFallback: source.egressFallback } : binding;
        }),
      };
      if (yamlIds.has(instrument.id)) {
        if (typeof value === "object" && value !== null) {
          try {
            (value as { shadowed?: boolean }).shadowed = true;
          } catch {
            // Read-only caller objects are still reported through the explicit
            // shadowed ID list and ConfigIssue below.
          }
        }
        shadowedUserInstrumentIds.push(instrument.id);
        issues.push({
          path: `database.instruments.${instrument.id}`,
          message: `user instrument is shadowed by YAML instrument ${instrument.id}; YAML remains authoritative`,
        });
        continue;
      }
      const withPanel = {
        ...instrument,
        metadata: { ...instrument.metadata, origin: "user" },
        panelId: panelIdFor(config, instrument),
      };
      const relationshipIssues = validateConfigRelationships({
        ...config,
        instruments: [...config.instruments, ...accepted, withPanel],
      }).filter((issue) => issue.path.includes(`instruments.${instrument.id}`));
      if (relationshipIssues.length > 0) {
        issues.push(...relationshipIssues.map((issue) => ({
          path: `database.${issue.path}`,
          message: issue.message,
        })));
        continue;
      }
      accepted.push(withPanel);
    }

    return {
      config: { ...config, instruments: [...config.instruments, ...accepted] },
      issues,
      shadowedUserInstrumentIds,
    };
  }

  public appConfig(): AppConfig {
    return this.config;
  }

  public source(sourceId: string): SourceConfig | undefined {
    return this.config.sources.find((source) => source.id === sourceId);
  }

  public instrument(instrumentId: string): InstrumentConfig | undefined {
    return this.config.instruments.find((instrument) => instrument.id === instrumentId);
  }

  public binding(instrumentId: string, sourceId: string): SourceBinding | undefined {
    return this.instrument(instrumentId)?.sourceBindings.find((binding) => binding.sourceId === sourceId);
  }

  public resolve(instrumentId: string, sourceId: string): SymbolMapResolution | null {
    const binding = this.binding(instrumentId, sourceId);
    if (binding) return { strategy: "explicit", providerSymbol: binding.providerSymbol };
    const map = this.config.symbolMaps.find((entry) => entry.sourceId === sourceId);
    const providerSymbol = map?.entries[instrumentId];
    return providerSymbol ? { strategy: "alias", providerSymbol } : null;
  }
}

export function panelIdFor(config: AppConfig, instrument: InstrumentConfig): string {
  const capabilities = new Set(instrument.sourceBindings.flatMap((binding) => binding.capabilities));
  const matched = [...config.sections]
    .sort((left, right) => left.order - right.order)
    .find((section) => section.id !== "other" && (
      section.match.assetClasses.includes(instrument.assetClass)
      || section.match.capabilities.some((capability) => capabilities.has(capability))
    ));
  return matched?.id ?? config.sections.find((section) => section.id === "other")?.id ?? "other";
}
