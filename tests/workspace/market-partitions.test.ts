import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CandleSchema, InstrumentSchema, QuoteSchema, computeFreshness } from "@invest/domain";
import { createStorageDriver } from "@invest/storage";

const instrument = InstrumentSchema.parse({ id: "aapl-usd", assetClass: "equity", symbol: "AAPL/USD", displayName: "Apple", baseAsset: "AAPL", quoteAsset: "USD", contractMultiplier: "1", precision: { priceScale: 2, quantityScale: 2 }, active: true, venue: null, underlyingId: null, tags: [], metadata: {} });
const now = Date.parse("2026-09-05T12:00:00Z");
const quote = (at: string, price = "100", sourceId = "tradier-stocks") => QuoteSchema.parse({
  instrumentId: instrument.id, sourceId, providerSymbol: "AAPL", capturedAt: at, receivedAt: at,
  price, quoteAsset: "USD", quality: "authoritative", freshness: computeFreshness(at, at, 120, new Date(at)),
  bid: null, ask: null, mid: null, dayOpen: null, dayHigh: null, dayLow: null, previousClose: null, volume: null, convertedTo: null, rawRef: null,
});
const candle = (day: string, close = "100") => {
  const at = `${day}T00:00:00.000Z`;
  return CandleSchema.parse({ instrumentId: instrument.id, sourceId: "tradier-stocks-history", timeframe: "1d", openTime: at, closeTime: new Date(Date.parse(at)+86400000-1).toISOString(), open: "90", high: "110", low: "80", close, quoteAsset: "USD", session: "regular", volume: null, tradeCount: null, convertedTo: null, freshness: computeFreshness(at, at, 86400, new Date(at), "eod") });
};

describe.each(["node-sqlite", "better-sqlite3"] as const)("indexed market partitions (%s)", kind => {
  it("migrates history without losing decimal values, routes dates to monthly blocks, and reopens idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "invest-partitions-"));
    const path = join(directory, "business.sqlite"), options = { hotPath: join(directory,"hot","market.sqlite"), archiveDirectory: join(directory,"archive"), now: () => now };
    let storage = createStorageDriver(kind, path);
    try {
      await storage.open(); await storage.migrate(); await storage.upsertInstrument(instrument, now);
      const quotes = [quote("2026-07-20T10:00:00.000Z","100.000000000000000001"), quote("2026-08-06T12:00:00.000Z","101"), quote("2026-08-06T11:59:59.999Z","102"), quote("2026-09-05T10:00:00.000Z","103")];
      await storage.appendQuotes(quotes); await storage.appendQuotes([quote("2026-09-05T10:00:00.000Z","104","second-source")]);
      await storage.appendCandles([candle("2025-09-05"),candle("2026-07-20"),candle("2026-09-04")]);
      const expected = await storage.getQuoteHistory(instrument.id,"tradier-stocks",100);
      await storage.close(); storage=createStorageDriver(kind,path,options); await storage.open(); await storage.migrate();
      expect((await storage.getQuoteHistory(instrument.id,"tradier-stocks",100)).map(r=>[r.capturedAtMs,r.price])).toEqual(expected.map(r=>[r.capturedAtMs,r.price]));
      expect((await storage.getLatestQuotes()).map(r=>r.price).sort()).toEqual(["103","104"]);
      expect((await storage.getCandles(instrument.id,undefined,"1d",100)).map(r=>r.openTimeMs)).toEqual(["2026-09-04","2026-07-20","2025-09-05"].map(d=>Date.parse(d)));
      expect(await readdir(options.archiveDirectory)).toEqual(expect.arrayContaining(["2025-09.sqlite","2026-07.sqlite","2026-08.sqlite","catalog.sqlite"]));
      const before = Date.parse("2026-08-06T12:00:00.000Z");
      expect((await storage.getQuoteHistory(instrument.id,"tradier-stocks",1,before)).map(r=>r.price)).toEqual(["102"]);
      expect(await storage.getQuoteHistory(instrument.id,"missing",10)).toEqual([]);
      expect(await storage.getQuoteHistory(instrument.id,undefined,10,before,before-1)).toHaveLength(1);
      await storage.appendCandles([candle("2025-09-05","105")]);
      expect((await storage.getCandles(instrument.id,undefined,"1d",100)).at(-1)?.close).toBe("105");
      const unchanged = candle("2025-09-05", "105");
      unchanged.freshness = computeFreshness(unchanged.freshness.capturedAt, "2026-09-05T12:00:00.000Z", 86400, new Date(now), "eod");
      const previousReceived = (await storage.getCandles(instrument.id,undefined,"1d",100)).at(-1)?.receivedAtMs;
      await storage.appendCandles([unchanged]);
      expect((await storage.getCandles(instrument.id,undefined,"1d",100)).at(-1)?.receivedAtMs).toBe(previousReceived);
      await storage.close(); storage=createStorageDriver(kind,path,options); await storage.open(); await storage.migrate();
      expect(await storage.getQuoteHistory(instrument.id,undefined,100)).toHaveLength(5);
      expect((await storage.getLatestQuotes()).map(r=>r.price).sort()).toEqual(["103","104"]);
    } finally { await storage.close(); await rm(directory,{recursive:true,force:true}); }
  });
  it("rolls over bounded batches while preserving latest marks and cross-block ordering", async () => {
    const directory=await mkdtemp(join(tmpdir(),"invest-rollover-"));let clock=now;
    const storage=createStorageDriver(kind,join(directory,"business.sqlite"),{hotPath:join(directory,"hot.sqlite"),archiveDirectory:join(directory,"archive"),now:()=>clock});
    try {
      await storage.open();await storage.migrate();await storage.upsertInstrument(instrument,now);
      await storage.appendQuotes([quote("2026-09-01T10:00:00.000Z","1"),quote("2026-09-02T10:00:00.000Z","2"),quote("2026-09-03T10:00:00.000Z","3")]);
      clock+=35*86400000;
      expect(await storage.maintainMarketHistory(2)).toBe(2);
      expect((await storage.getQuoteHistory(instrument.id,undefined,10)).map(r=>r.price)).toEqual(["3","2","1"]);
      expect(await storage.maintainMarketHistory(2)).toBe(1);
      expect(await storage.maintainMarketHistory(2)).toBe(0);
      expect((await storage.getLatestQuotes())[0]?.price).toBe("3");
      await storage.appendQuotes([quote("2026-09-01T10:00:00.000Z","1.5")]);
      expect((await storage.getLatestQuotes())[0]?.price).toBe("3");
      expect((await storage.getQuoteHistory(instrument.id,undefined,10)).map(r=>r.price)).toEqual(["3","2","1.5"]);
      const writing = storage.appendCandles([candle("2024-01-05"),candle("2024-02-05"),candle("2024-03-05")]);
      await storage.close(); await writing; await storage.open(); await storage.migrate();
      expect(await storage.getCandles(instrument.id,undefined,"1d",100)).toHaveLength(3);
    } finally { await storage.close();await rm(directory,{recursive:true,force:true}); }
  });
});
