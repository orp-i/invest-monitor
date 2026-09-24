import type { AppConfig } from "@invest/config";

// Keep account sync and market data on the same environment. Only public
// connection metadata enters descriptors; credentials are resolved separately.
export function applyTradierEnvironment(config: AppConfig, env = process.env): AppConfig {
  const environment = env.TRADIER_ENVIRONMENT?.trim() || "live";
  if (environment !== "live" && environment !== "sandbox") throw new Error("TRADIER_ENVIRONMENT 必须为 live 或 sandbox");
  const baseUrl = environment === "sandbox" ? "https://sandbox.tradier.com/v1" : "https://api.tradier.com/v1";
  const staleAfterSeconds = environment === "sandbox" ? 1200 : 120;
  const quotes = new Set(config.sources.filter(source => source.adapter === "tradier-stocks" && source.capabilities.includes("quote")).map(source => source.id));
  const quoteSource = config.sources.find(source => source.enabled && source.adapter === "tradier-stocks" && source.capabilities.includes("quote"));
  const historySource = config.sources.find(source => source.enabled && source.adapter === "tradier-stocks" && source.capabilities.includes("candle"));
  const legacy = new Set(config.sources.filter(source => source.adapter === "massive-stocks").map(source => source.id));
  return {
    ...config,
    sources: config.sources.map(source => source.adapter !== "tradier-stocks" ? (quoteSource && legacy.has(source.id) ? { ...source, enabled: false } : source) : {
      ...source, baseUrl, followRedirects: false,
      defaultBinding: source.defaultBinding && quotes.has(source.id) ? { ...source.defaultBinding, staleAfterSeconds } : source.defaultBinding,
    }),
    instruments: config.instruments.map(instrument => {
      const sourceBindings = instrument.sourceBindings.flatMap(binding => {
        if (quoteSource && instrument.assetClass === "equity" && legacy.has(binding.sourceId)) {
          if (binding.quoteAsset !== "USD") return [{ ...binding, enabled: false }];
          return binding.capabilities.flatMap(capability => {
            const source = capability === "quote" ? quoteSource : capability === "candle" ? historySource : null;
            if (!source) return [];
            return [{ ...binding, sourceId: source.id, capabilities: [capability], providerSymbol: binding.providerSymbol.replace(/\./g, "/"), params: {},
              cadenceSeconds: capability === "quote" ? 30 : 21600, staleAfterSeconds: capability === "quote" ? staleAfterSeconds : 604800,
              egressProfile: source.egressProfile, egressFallback: source.egressFallback }];
          });
        }
        return [quotes.has(binding.sourceId) ? { ...binding, staleAfterSeconds } : binding];
      });
      return { ...instrument, sourceBindings: sourceBindings.filter((binding, index) => sourceBindings.findIndex(other => other.sourceId === binding.sourceId && other.capabilities.join() === binding.capabilities.join()) === index) };
    }),
  };
}
