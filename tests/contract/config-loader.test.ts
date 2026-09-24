import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseConfigText } from "@invest/config";

describe("M0/M1/M2 configuration contract", () => {
  it("accepts the complete M0 YAML shape and preserves explicit quote assets", async () => {
    const text = await readFile(new URL("../../config/portfolio.yaml", import.meta.url), "utf8");
    const result = parseConfigText(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.instruments.map((instrument) => instrument.id)).toEqual(["btc-usd", "eth-usd", "gld-usd", "xau-usd", "sol-usd", "aapl-usd"]);
    const binanceBinding = result.config.instruments[0]?.sourceBindings.find((binding) => binding.sourceId === "binance-vision");
    expect(binanceBinding?.quoteAsset).toBe("USDT");
    expect(binanceBinding?.conversion).toBeNull();
    expect(result.config.egressProfiles.direct.proxyUrl).toBeNull();
    // The private deployment routes every source through "vpn" with a "corp" fallback; the public example uses
    // "direct" with no fallback. Both must reference declared profiles only.
    const profiles = new Set(Object.keys(result.config.egressProfiles));
    expect(result.config.sources.every((source) => profiles.has(source.egressProfile))).toBe(true);
    expect(result.config.sources.every((source) => source.egressFallback.every((name) => profiles.has(name) && name !== source.egressProfile))).toBe(true);

    expect(result.config.instruments.flatMap((instrument) => instrument.sourceBindings).every((binding) => profiles.has(binding.egressProfile))).toBe(true);
    expect(result.config.instruments.flatMap((instrument) => instrument.sourceBindings).every((binding) => binding.egressFallback.every((name) => profiles.has(name)))).toBe(true);
    const aapl = result.config.instruments.find((instrument) => instrument.id === "aapl-usd");
    expect(aapl?.assetClass).toBe("equity");
    expect(aapl?.sourceBindings.filter(binding => binding.enabled).map(binding => binding.sourceId)).toEqual(["tradier-stocks", "tradier-stocks-history"]);
    expect(result.config.sources.find(source => source.id === "tradier-stocks")).toMatchObject({ enabled: true, followRedirects: false, authRef: "env:TRADIER_ACCESS_TOKEN" });
    expect(aapl?.sourceBindings.some((binding) => binding.sourceId === "massive-options")).toBe(false);
    expect(result.config.sources.find((source) => source.id === "massive-stocks")?.enabled).toBe(false);
    expect(result.config.sources.find((source) => source.id === "massive-stocks-history")?.params.historyYears).toBe(5);
    expect(result.config.intel.enabled).toBe(true);
    expect(result.config.intel.sources).toContain("google-news-rss");
    expect(result.config.sources.find((source) => source.id === "cnbc-rss")?.enabled).toBe(false);
    expect(result.config.sources.find((source) => source.id === "sec-edgar-atom")?.enabled).toBe(false);
    expect(result.config.llm.providers.find((provider) => provider.id === "openrouter")?.enabled).toBe(false);
    expect(result.config.llm.providers.find((provider) => provider.id === "openrouter")?.egressFallback.every((name) => profiles.has(name))).toBe(true);
  });

  it("rejects a relationship violation while leaving YAML parser errors structured", () => {
    const result = parseConfigText("version: 1\nnot: valid\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.path).toBeDefined();
  });

  it("defaults source, binding, and LLM fallback chains to an empty array", async () => {
    const text = await readFile(new URL("../../config/portfolio.yaml", import.meta.url), "utf8");
    const result = parseConfigText(text.replace(/^\s*egressFallback:.*$/gm, ""));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.sources.every((source) => source.egressFallback.length === 0)).toBe(true);
    expect(result.config.instruments.flatMap((instrument) => instrument.sourceBindings).every((binding) => binding.egressFallback.length === 0)).toBe(true);
    expect(result.config.llm.providers.every((provider) => provider.egressFallback.length === 0)).toBe(true);
  });

  it("rejects an LLM provider host outside the server-side allowlist", async () => {
    const text = await readFile(new URL("../../config/portfolio.yaml", import.meta.url), "utf8");
    const result = parseConfigText(text.replace("https://openrouter.ai/api/v1", "https://127.0.0.1/api/v1"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "llm.providers.openrouter.baseUrl" }),
    ]));
  });
});
