import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { InstrumentConfigSchema, type AppConfig } from "@invest/config";
import { tradierSymbol } from "@invest/domain";
import type { StorageDriver } from "@invest/storage";

export async function heldQuoteInstrumentIds(config: AppConfig, storage: StorageDriver): Promise<string[]> {
  const [accounts, manual] = await Promise.all([storage.getBrokerSnapshots(), storage.getPositionProjections()]);
  const symbols = new Set(accounts.flatMap(account => account.positions.filter(p => !new Decimal(p.quantity).isZero()).map(p => `${p.currency}:${tradierSymbol(p.symbol)}`)));
  const manualIds = new Set(manual.filter(p => !new Decimal(p.quantity).isZero()).map(p => p.instrumentId));
  return config.instruments.filter(i => manualIds.has(i.id) || i.sourceBindings.some(b => symbols.has(`${b.quoteAsset}:${tradierSymbol(b.providerSymbol)}`))).map(i => i.id);
}

// Broker positions are verified inventory, so adding them does not depend on
// market hours or a live quote. This never removes a user's existing watch item.
export async function syncHeldInstruments(config: AppConfig, storage: StorageDriver): Promise<void> {
  const sources = config.sources.filter(s => s.enabled && s.adapter === "tradier-stocks");
  if (!sources.some(s => s.capabilities.includes("quote"))) return;
  const user = await storage.getUserInstruments();
  const known = [...config.instruments, ...user];
  const accounts = await storage.getBrokerSnapshots();
  for (const account of accounts) for (const position of account.positions) {
    if (new Decimal(position.quantity).isZero() || position.currency !== "USD") continue;
    const symbol = tradierSymbol(position.symbol);
    const option = /^([A-Z][A-Z0-9.]{0,5})(\d{6})([CP])(\d{8})$/.exec(symbol);
    const assetClass = option ? "option" : "equity";
    if (!option && (!/^(STK|stock|etf|equity)$/i.test(position.assetType ?? "") || !/^[A-Z][A-Z0-9/.-]{0,11}$/.test(symbol))) continue;
    const existing = known.find(i => i.assetClass === assetClass && (i.sourceBindings.some(b => b.providerSymbol === symbol) || tradierSymbol(i.symbol.replace(/\/USD$/, "")) === symbol));
    if (existing) {
      if (!existing.active && user.some(i => i.id === existing.id)) await storage.updateUserInstrument(existing.id, { active: true }, Date.now());
      continue;
    }
    // A multiplier is a contract identity fact, never an assumed 100. The broker
    // may omit it; those instruments are retried when enriched by Tradier.
    const multiplier = option ? position.multiplier : "1";
    if (multiplier == null || !new Decimal(multiplier).gt(0)) continue;
    const id = `held-${createHash("sha256").update(`${assetClass}:${symbol}:USD`).digest("hex").slice(0, 20)}`;
    const instrument = InstrumentConfigSchema.parse({ id, assetClass, symbol: option ? symbol : `${symbol.replace(/\//g, ".")}/USD`, displayName: symbol,
      venue: "US", baseAsset: option ? option[1] : symbol.replace(/\//g, "."), quoteAsset: "USD", contractMultiplier: multiplier,
      underlyingId: option ? known.find(i => i.assetClass === "equity" && i.baseAsset === option[1])?.id ?? null : null,
      precision: { priceScale: 4, quantityScale: option ? 0 : 6 }, tags: ["持仓自动关注"], active: true, watch: true, panelId: option ? "options" : "equity-asset",
      metadata: { autoHeld: true, broker: account.broker, ...(option ? { occSymbol: symbol, expiration: `20${option[2]!.slice(0, 2)}-${option[2]!.slice(2, 4)}-${option[2]!.slice(4, 6)}` } : {}) },
      sourceBindings: sources.filter(s => s.defaultBinding && (s.capabilities.includes("quote") || s.capabilities.includes("candle"))).map((source, index) => ({
        sourceId: source.id, instrumentId: id, enabled: true, priority: index + 10, capabilities: source.capabilities.includes("quote") ? ["quote"] : ["candle"],
        providerSymbol: symbol, quoteAsset: "USD", conversion: null, params: {}, ...source.defaultBinding!, egressFallback: source.egressFallback,
      })),
    });
    await storage.createUserInstrument({ ...instrument, origin: "user", shadowed: false }, Date.now());
    known.push(instrument);
  }
}
