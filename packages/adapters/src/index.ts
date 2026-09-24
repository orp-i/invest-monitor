export * from "./types.js";
export * from "./common.js";
export * from "./coingecko/index.js";
export * from "./binance-vision/index.js";
export * from "./gold-api/index.js";
export * from "./massive-stocks/index.js";
export * from "./tradier-stocks/index.js";

import { AdapterRegistry } from "./types.js";
import { binanceVisionAdapter } from "./binance-vision/index.js";
import { coinGeckoAdapter } from "./coingecko/index.js";
import { goldApiAdapter } from "./gold-api/index.js";
import { massiveStocksAdapter } from "./massive-stocks/index.js";
import { tradierStocksAdapter } from "./tradier-stocks/index.js";

export function createAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(coinGeckoAdapter);
  registry.register(binanceVisionAdapter);
  registry.register(goldApiAdapter);
  registry.register(massiveStocksAdapter);
  registry.register(tradierStocksAdapter);
  return registry;
}

/** @deprecated Use createAdapterRegistry; retained for existing M0 callers. */
export const createM0AdapterRegistry = createAdapterRegistry;
