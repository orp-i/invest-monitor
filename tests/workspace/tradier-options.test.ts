import { describe, expect, it } from "vitest";
import { loadConfigFile } from "@invest/config";
import { tradierStocksAdapter, type AdapterContext } from "@invest/adapters";
import { tradierSymbol } from "@invest/domain";
import { tradierMarketData } from "../../apps/server/src/market-data.js";
import { applyTradierEnvironment } from "../../apps/server/src/tradier-config.js";

const OCC = "AAPL301220C00250000";
const option = { symbol: OCC, description: "Synthetic test call", type: "option", underlying: "AAPL", expiration_date: "2030-12-20", option_type: "call", strike: "250", contract_size: "10", last: "1.234567890123456789", bid: 0, ask: "1.3", volume: 0, open_interest: 123,
  trade_date: 1788537600000, bid_date: 1788541200000, ask_date: 1788541200000,
  greeks: { delta: "0.45", gamma: 0, theta: "-0.01", mid_iv: "0.32", updated_at: "2026-09-04 15:00:00" } };
async function setup(body: unknown | ((url: URL) => unknown), status = 200, environment = "live", calendarClose = "16:00") {
  const loaded = await loadConfigFile("config/portfolio.yaml"); if (!loaded.ok) throw Error("config invalid");
  const config = applyTradierEnvironment(loaded.config, { TRADIER_ENVIRONMENT: environment });
  const instrument = config.instruments.find(i => i.id === "aapl-usd")!;
  const source = config.sources.find(s => s.id === "tradier-stocks")!;
  const calls: { url: URL; at: number; headers: unknown; followRedirects: unknown }[] = [];
  const httpClient = { profile: () => ({ maxRedirects: 0, connectTimeoutMs: 1000, requestTimeoutMs: 2000 }), request: async (r: any) => {
    const url = new URL(r.url); calls.push({ url, at: Date.now(), headers: r.headers, followRedirects: r.followRedirects });
    const value = url.pathname.endsWith("/calendar") ? {calendar:{days:{day:Array.from({length:31},(_,i)=>({date:`${url.searchParams.get("year")}-${url.searchParams.get("month").padStart(2,"0")}-${String(i+1).padStart(2,"0")}`, status:"open",premarket:{start:"04:00",end:"09:30"},open:{start:"09:30",end:calendarClose},postmarket:{start:calendarClose,end:"20:00"}}))}}} : typeof body === "function" ? body(url) : body;
    return { ok: true, value: { status, headers: {}, body: new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)), receivedAt: new Date().toISOString(), serverDate: null, clockSkewMs: null, egressProfileUsed: "vpn", url: r.url } };
  } } as unknown as AdapterContext["httpClient"];
  const context: AdapterContext = { source, instrument, binding: instrument.sourceBindings[0]!, httpClient, authToken: "synthetic-secret", now: new Date().toISOString(), clockSkewToleranceMs: 2000, requestId: "test-options", capability: "optionChain" };
  const get = (path: string) => tradierMarketData(new URL(path, "http://localhost"), context);
  return { context, calls, get, config };
}

describe("Tradier options and shared market data", () => {
  it("preserves decimal tokens, zero bids/volume, unknown Greeks and the provider's contract size", async () => {
    const body = JSON.stringify({ options: { option } }).replace('"1.234567890123456789"', '1.234567890123456789');
    const { get, calls } = await setup(body);
    const reply = await get("/api/options?symbol=AAPL&expiration=2030-12-20");
    expect(reply.status).toBe(200);
    expect(reply.body.contracts).toEqual([expect.objectContaining({ symbol: OCC, last: "1.234567890123456789", bid: "0", volume: "0", contractSize: "10", tradeAt: "2026-09-04T16:00:00.000Z", bidAt: "2026-09-04T17:00:00.000Z", greeks: { delta: "0.45", gamma: "0", theta: "-0.01", vega: null, rho: null, midIv: "0.32", updatedAt: "2026-09-04 15:00:00" } })]);
    expect(calls[0]!.url.href).toBe("https://api.tradier.com/v1/markets/options/chains?symbol=AAPL&expiration=2030-12-20&greeks=true");
    expect(calls[0]!.followRedirects).toBe(false);
    expect(JSON.stringify(reply)).not.toContain("synthetic-secret");
  });
  it("accepts single expiration/contract envelopes and marks sandbox separately without requesting Greeks", async () => {
    const { get, calls } = await setup(url => url.pathname.endsWith("expirations") ? { expirations: { date: "2030-12-20" } } : { options: { option: { ...option, greeks: undefined, contract_size: undefined } } }, 200, "sandbox");
    expect((await get("/api/options/expirations?symbol=AAPL")).body.expirations).toEqual(["2030-12-20"]);
    const reply = await get("/api/options?symbol=AAPL&expiration=2030-12-20");
    expect(reply.body).toMatchObject({ environment: "sandbox", contracts: [{ greeks: null, contractSize: null }] });
    expect(calls[1]!.url.hostname).toBe("sandbox.tradier.com"); expect(calls[1]!.url.searchParams.get("greeks")).toBe("false");
  });
  it("batches stocks and OCC contracts, reports missing symbols and shares concurrent cached results", async () => {
    const { get, calls } = await setup({ quotes: { quote: [option, { symbol: "AAPL", type: "stock", last: "251.02", trade_date: option.trade_date }] } });
    const replies = await Promise.all(Array.from({ length: 5 }, () => get(`/api/market/quotes?symbols=AAPL,${OCC},MISSING`)));
    expect(calls).toHaveLength(1); expect(replies[0]!.body.missing).toEqual(["MISSING"]);
    expect(replies[0]!.body.quotes).toHaveLength(2);
    expect((await get(`/api/market/quotes?symbols=${OCC},MISSING,AAPL`)).body).toEqual(replies[0]!.body);
    expect(calls).toHaveLength(1);
  });
  it("distinguishes an empty market response from a malformed one and rejects wrong contract identities", async () => {
    for (const [body, expected] of [[{ options: null }, 200], [{ options: {} }, 502], [{ options: { option: { ...option, underlying: "TSLA" } } }, 502], [{ options: { option: { ...option, expiration_date: "2030-12-21" } } }, 502], [{ quotes: null }, 502]] as const) {
      const { get } = await setup(body); expect((await get("/api/options?symbol=AAPL&expiration=2030-12-20")).status).toBe(expected);
    }
  });
  it("rejects invalid parameters, absent tokens, and nonofficial origins before sending credentials", async () => {
    const { get, calls, context } = await setup({});
    for (const path of ["/api/options?symbol=AAPL&expiration=2030-02-30", "/api/market/quotes?symbols=https://evil.invalid", "/api/market/quotes?symbols=", "/api/options/expirations?symbol=AAPL301220C00250000"]) expect((await get(path)).status).toBe(400);
    const url = new URL("http://localhost/api/market/quotes?symbols=AAPL");
    expect((await tradierMarketData(url, { ...context, authToken: null })).status).toBe(503);
    expect((await tradierMarketData(url, { ...context, source: { ...context.source, baseUrl: "https://evil.invalid/v1" } })).status).toBe(502);
    expect(calls).toHaveLength(0);
  });
  it("sanitizes provider auth failures and keeps failures retryable instead of caching them as empty success", async () => {
    const { get } = await setup({ error: "synthetic-secret provider account data" }, 401);
    const reply = await get("/api/market/quotes?symbols=AAPL");
    expect(reply.status).toBe(502); expect(reply.body.message).toContain("权限"); expect(JSON.stringify(reply)).not.toContain("synthetic-secret");
  });
  it("uses the same request limiter as scheduled stock quotes", async () => {
    const { get, context, calls } = await setup({ quotes: { quote: { symbol: "AAPL", type: "stock", last: "250", trade_date: option.trade_date } } });
    await Promise.all([get("/api/market/quotes?symbols=AAPL"), tradierStocksAdapter.fetch({ ...context, capability: "quote" }, context.source.params, new AbortController().signal)]);
    expect(calls).toHaveLength(2); expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1050);
  });
  it("allows overlapping HTTP requests while retaining the shared start-rate limit", async () => {
    const { get, context, calls } = await setup(url => ({ quotes: { quote: { symbol: url.searchParams.get("symbols"), type: "stock", last: "10", trade_date: option.trade_date } } }));
    let release!: () => void;const gate = new Promise<void>(resolve => { release = resolve; });
    const request = context.httpClient.request.bind(context.httpClient);
    context.httpClient.request = async (...args: Parameters<typeof request>) => { const response = await request(...args); await gate; return response; };
    const first=get("/api/market/quotes?symbols=AAPL"),second=get("/api/market/quotes?symbols=DG");
    try { await new Promise(resolve=>setTimeout(resolve,1300));expect(calls).toHaveLength(2);expect(calls[1].at-calls[0].at).toBeGreaterThanOrEqual(1050); }
    finally {release();await Promise.all([first,second]);}
  });
  it("loads OCC historical candles and explains expired contracts without calling a different provider", async () => {
    const { get, calls } = await setup({ history: { day: { date: "2026-09-01", open: "1", high: "2", low: "0.5", close: "1.2", volume: 40 } } });
    const reply = await get(`/api/market/history?symbol=${OCC}`);
    expect(reply.status).toBe(200); expect(reply.body.candles).toEqual([expect.objectContaining({ sourceId: "tradier-stocks", instrumentId: OCC, close: "1.2" })]);
    expect(calls[0]!.url.searchParams.get("symbol")).toBe(OCC);
    const expired = await get("/api/market/history?symbol=AAPL200117C00250000");
    expect(expired.body.candles).toEqual([]); expect(expired.body.notice).toContain("已到期"); expect(calls).toHaveLength(1);
  });
  it("shares the larger history fetch and returns 240 bars with MA200 seeded before that window", async () => {
    const day = Array.from({ length: 439 }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10), open: String(i + 1), high: String(i + 1), low: String(i + 1), close: String(i + 1), volume: 1 }));
    const { get, calls } = await setup({ history: { day } });
    const replies = await Promise.all([get(`/api/market/history?symbol=${OCC}`), get(`/api/market/history?symbol=${OCC}`)]);
    expect(calls).toHaveLength(1);
    expect(replies[0].body.candles).toHaveLength(240);
    expect((replies[0].body.candles as any[])[0]).toMatchObject({ close: "200", ma: { 200: "100.5" } });
    expect(Date.parse(calls[0].url.searchParams.get("end")!) - Date.parse(calls[0].url.searchParams.get("start")!)).toBe(730 * 86400000);
  });
  it("requests one regular-session intraday date, keeps exact prices, and coalesces repeated reads", async () => {
    const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const timestamp = Date.parse(`${date}T14:30:00Z`) / 1000;
    const { get, calls } = await setup({ series: { data: [{ timestamp, close: "1.234567890123456789" }, { timestamp: timestamp + 300, close: "0" }] } });
    const replies = await Promise.all([get(`/api/market/timesales?symbol=${OCC}&date=${date}`), get(`/api/market/timesales?symbol=${OCC}&date=${date}`)]);
    expect(calls).toHaveLength(2);expect(calls[1].url.searchParams.get("interval")).toBe("5min");expect(calls[1].url.searchParams.get("session_filter")).toBe("open");
    expect(replies[0].body.points).toEqual([{ time: timestamp * 1000, price: "1.234567890123456789" }, { time: (timestamp + 300) * 1000, price: "0" }]);
    expect((await get(`/api/market/timesales?symbol=AAPL&date=2026-02-30`)).status).toBe(400);
    expect((await get(`/api/market/timesales?symbol=AAPL&date=2020-01-01`)).body.points).toEqual([]);expect(calls).toHaveLength(2);
  });
  it("isolates extended sessions, honors calendar early close, and never fabricates overnight prices", async () => {
    const date = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    const at = (time: string) => Date.parse(`${date}T${time}-04:00`) / 1000;
    const {get,calls} = await setup({series:{data:["08:00:00","10:00:00","13:05:00","20:00:00"].map((t,i)=>({timestamp:at(t),close:String(100+i)}))}},200,"live","13:00");
    const regular = await get(`/api/market/timesales?symbol=AAPL&date=${date}`);
    expect(regular.body.points).toEqual([{time:at("10:00:00")*1000,price:"101"}]);
    expect(calls[1].url.searchParams.get("end")).toBe(`${date} 13:00`);
    const post = await get(`/api/market/timesales?symbol=AAPL&date=${date}&session=post`);
    expect(post.body.points).toEqual([{time:at("13:05:00")*1000,price:"102"}]);
    expect(calls[2].url.searchParams.get("session_filter")).toBe("all");
    const pre = await get(`/api/market/timesales?symbol=AAPL&date=${date}&session=pre`);
    expect(pre.body.points).toEqual([{time:at("08:00:00")*1000,price:"100"}]);
    const count = calls.length;
    const night = await get(`/api/market/timesales?symbol=AAPL&date=${date}&session=overnight`);
    expect(night.body.points).toEqual([]);expect(night.body.notice).toContain("覆盖未确认");expect(calls).toHaveLength(count);
    expect((await get(`/api/market/timesales?symbol=${OCC}&date=${date}&session=post`)).body.notice).toContain("不能套用股票时段");
  },10000);
  it("maps existing Massive equity bindings to Tradier while retaining IDs and OCC root spelling", async () => {
    const { config } = await setup({});
    const instrument = config.instruments.find(i => i.id === "aapl-usd")!;
    const legacy = { ...config, instruments: [{ ...instrument, sourceBindings: [{ ...instrument.sourceBindings[0]!, sourceId: "massive-stocks", providerSymbol: "BRK.B", capabilities: ["quote", "candle"] as ("quote" | "candle")[] }] }] };
    const migrated = applyTradierEnvironment(legacy, { TRADIER_ENVIRONMENT: "sandbox" });
    expect(migrated.instruments[0]!.id).toBe(instrument.id);
    expect(migrated.instruments[0]!.sourceBindings).toEqual([expect.objectContaining({ sourceId: "tradier-stocks", providerSymbol: "BRK/B", staleAfterSeconds: 1200 }), expect.objectContaining({ sourceId: "tradier-stocks-history", providerSymbol: "BRK/B" })]);
    expect(migrated.sources.filter(s => s.adapter === "massive-stocks").every(s => !s.enabled)).toBe(true);
    expect(tradierSymbol("BRK.B")).toBe("BRK/B"); expect(tradierSymbol("BRK.B 301220C00250000")).toBe("BRK.B301220C00250000");
  });
});
