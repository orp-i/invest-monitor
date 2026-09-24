import type { InstrumentConfig } from "@invest/config";

export interface RuleTags {
  readonly instrumentIds: readonly string[];
  readonly tags: readonly string[];
  readonly sentiment: "unknown";
  readonly importance: "low" | "medium" | "high";
  readonly summary: string;
}

const EVENT_TAGS: ReadonlyArray<{ tag: string; pattern: RegExp }> = [
  { tag: "central-bank", pattern: /\b(federal reserve|fed|fomc|central bank|interest rates?)\b/i },
  { tag: "inflation", pattern: /\b(inflation|cpi|pce|consumer prices?)\b/i },
  { tag: "earnings", pattern: /\b(earnings|revenue|guidance|quarterly results?)\b/i },
  { tag: "regulation", pattern: /\b(sec|regulat(?:or|ion)|lawsuit|antitrust)\b/i },
  { tag: "security", pattern: /\b(cyberattack|ransomware|hacked|data breach|security breach|smart contract exploit|security vulnerability)\b/i },
  { tag: "market-structure", pattern: /\b(etf|exchange|liquidity|listing|delisting)\b/i },
];

const MACRO_TAGS: ReadonlyArray<{ tag: string; pattern: RegExp }> = [
  { tag: "macro:treasuries", pattern: /\b(treasur(?:y|ies)|bond yields?|yield curve|10.year yield|2.year yield)\b|美债|国债收益率|收益率曲线/i },
  { tag: "macro:gold", pattern: /\b(bullion|gold prices?|gold futures?|spot gold|xau)\b|金价|黄金价格|现货黄金/i },
  { tag: "macro:oil", pattern: /\b(crude oil|oil prices?|oil inventories|brent|wti|opec)\b|原油|油价|石油库存/i },
  { tag: "macro:rates", pattern: /\b(federal reserve|fomc|interest rates?|rate (?:hikes?|cuts?|decision)|monetary policy)\b|美联储|加息|降息|利率决议|货币政策/i },
  { tag: "macro:inflation", pattern: /\b(inflation|cpi|pce|consumer prices?)\b|通胀|消费物价/i },
  { tag: "macro:growth", pattern: /\b(gdp|nonfarm|payrolls|unemployment|retail sales|pmi|recession)\b|经济增长|非农|失业率|零售销售/i },
];

export function tagNewsByRules(
  title: string,
  contentText: string | null,
  instruments: readonly InstrumentConfig[],
  sourceId: string,
): RuleTags {
  const haystack = `${title}\n${contentText ?? ""}`;
  const instrumentIds = instruments
    .filter((instrument) => aliasesFor(instrument).some((alias) => containsAlias(haystack, alias)))
    .map((instrument) => instrument.id);
  const tags = EVENT_TAGS.filter((candidate) => candidate.pattern.test(haystack)).map((candidate) => candidate.tag);
  tags.push(...MACRO_TAGS.filter(candidate => candidate.pattern.test(haystack)).map(candidate => candidate.tag));
  if (tags.some(tag => tag.startsWith("macro:"))) tags.push("macro");
  if (sourceId.includes("federal-reserve")) tags.push("official", "macro");
  if (sourceId.includes("sec-edgar")) tags.push("official", "filing");
  for (const instrumentId of instrumentIds) tags.push(`instrument:${instrumentId}`);
  const importance = tags.includes("official") || tags.includes("security") ? "high"
    : instrumentIds.length > 0 || tags.length > 0 ? "medium"
      : "low";
  return {
    instrumentIds,
    tags: [...new Set(tags)],
    sentiment: "unknown",
    importance,
    summary: ruleSummary(contentText ?? title),
  };
}

function aliasesFor(instrument: InstrumentConfig): string[] {
  const configured = Array.isArray(instrument.metadata.aliases)
    ? instrument.metadata.aliases.filter((value): value is string => typeof value === "string")
    : [];
  const displayName = instrument.displayName.replace(/\b(?:incorporated|inc|corp(?:oration)?|ltd)\.?$/i, "").trim();
  return [...new Set([
    ...configured,
    instrument.baseAsset,
    instrument.symbol,
    displayName,
  ].map((value) => value.trim()).filter((value) => value.length >= 2))];
}

function containsAlias(value: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matched = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(value);
  if (!matched || alias.toLocaleLowerCase() !== "gold") return matched;

  // "Gold" is both an asset and a common sports/award term. Keep the generic
  // alias useful for commodity headlines, but require market/resource context
  // so items such as "Gold Cup horse race" do not pollute XAU associations.
  return /\b(?:bullion|commodit(?:y|ies)|futures?|inflation|invest(?:ment|or|ors|ing)|market(?:s)?|metal(?:s)?|min(?:e|es|ing)|ounces?|prices?|rall(?:y|ies)|reserve(?:s)?|resources?|spot|trad(?:e|es|ing)|xau|yields?)\b/iu.test(value);
}

function ruleSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 420) return normalized;
  const slice = normalized.slice(0, 420);
  const boundary = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("。"), slice.lastIndexOf("; "));
  return `${slice.slice(0, boundary > 180 ? boundary + 1 : 417).trim()}…`;
}
