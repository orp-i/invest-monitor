import { describe, expect, it } from "vitest";
import { probeBroker, type BrokerReader } from "../../apps/server/src/brokers.js";
import { syncAlpaca } from "../../apps/server/src/brokers-alpaca.js";

const ENV = { ALPACA_API_KEY_ID: "key-id-test-xyz", ALPACA_API_SECRET_KEY: "secret-key-test-xyz" };
const account = (overrides: Record<string, unknown> = {}) => JSON.stringify({ account_number: "ALP1", currency: "USD", status: "ACTIVE", equity: 1000, cash: 500, ...overrides });

describe("Alpaca Trading API adapter", () => {
  it("uses the live host by default, sends key headers on every call, and never puts the keys in the URL", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const reader: BrokerReader = async (url, headers) => {
      seen.push({ url: url.toString(), headers });
      expect(url.search).not.toContain(ENV.ALPACA_API_KEY_ID);
      expect(url.search).not.toContain(ENV.ALPACA_API_SECRET_KEY);
      if (url.pathname === "/v2/account") return account();
      if (url.pathname === "/v2/positions") return "[]";
      if (url.pathname.startsWith("/v2/account/activities/FILL")) return "[]";
      throw new Error(`unexpected path ${url.pathname}`);
    };
    const [live] = await syncAlpaca(ENV, reader);
    expect(seen[0]!.url.startsWith("https://api.alpaca.markets")).toBe(true);
    expect(seen[0]!.headers["APCA-API-KEY-ID"]).toBe(ENV.ALPACA_API_KEY_ID);
    expect(seen[0]!.headers["APCA-API-SECRET-KEY"]).toBe(ENV.ALPACA_API_SECRET_KEY);
    expect(live).toMatchObject({ broker: "alpaca", environment: "live", accountId: "ALP1", equity: "1000", cash: "500", sessionRealizedPnl: null });
    expect(JSON.stringify(live)).not.toContain(ENV.ALPACA_API_SECRET_KEY);
  });

  it("uses the paper host and writes environment 'sandbox' when ALPACA_ENVIRONMENT=paper", async () => {
    const seen: string[] = [];
    const reader: BrokerReader = async url => {
      seen.push(url.origin);
      if (url.pathname === "/v2/account") return account();
      return "[]";
    };
    const [paper] = await syncAlpaca({ ...ENV, ALPACA_ENVIRONMENT: "paper" }, reader);
    expect(seen[0]).toBe("https://paper-api.alpaca.markets");
    expect(paper.environment).toBe("sandbox");
  });

  it("maps positions with side-derived sign and us_option multiplier 100 plus a note, skipping unrelated fields", async () => {
    const reader: BrokerReader = async url => {
      if (url.pathname === "/v2/account") return account();
      if (url.pathname === "/v2/positions") return JSON.stringify([
        { symbol: "AAPL", qty: 10, side: "long", asset_class: "us_equity", avg_entry_price: 150, cost_basis: 1500, market_value: 1600, unrealized_pl: 100, current_price: 160 },
        { symbol: "TSLA", qty: 5, side: "short", asset_class: "us_equity", avg_entry_price: 200, cost_basis: 1000, market_value: 950, unrealized_pl: 50, current_price: 190 },
        { symbol: "AAPL  261016C00200000", qty: 2, side: "long", asset_class: "us_option", avg_entry_price: 3, cost_basis: 600, market_value: 650, unrealized_pl: 50, current_price: 3.25 },
      ]);
      if (url.pathname.startsWith("/v2/account/activities/FILL")) return "[]";
      throw new Error("unexpected");
    };
    const [snapshot] = await syncAlpaca(ENV, reader);
    expect(snapshot.positions).toHaveLength(3);
    const long = snapshot.positions.find(p => p.symbol === "AAPL")!;
    expect(long).toMatchObject({ quantity: "10", assetType: "STK", multiplier: null, costBasis: "1500", averageCost: "150" });
    const short = snapshot.positions.find(p => p.symbol === "TSLA")!;
    expect(short.quantity).toBe("-5");
    const option = snapshot.positions.find(p => p.symbol.startsWith("AAPL  26"))!;
    expect(option).toMatchObject({ assetType: "OPT", multiplier: "100" });
    expect(snapshot.notes.some(n => n.includes("100"))).toBe(true);
    expect(snapshot.unrealizedPnl).toBe("200"); // 100 + 50 + 50
  });

  it("follows page_token cursor pagination through account/activities/FILL and stops on a short page", async () => {
    const pages: string[] = [];
    const reader: BrokerReader = async url => {
      if (url.pathname === "/v2/account") return account();
      if (url.pathname === "/v2/positions") return "[]";
      pages.push(url.search);
      const token = url.searchParams.get("page_token");
      if (!token) {
        expect(url.searchParams.get("direction")).toBe("asc");
        expect(url.searchParams.get("page_size")).toBe("100");
        expect(url.searchParams.get("after")).toBeTruthy();
        return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: `p1-${i}`, symbol: "AAPL", side: "buy", qty: "1", price: "100", order_id: `o-${i}`, transaction_time: "2026-09-20T14:00:00Z" })));
      }
      expect(token).toBe("p1-99");
      return JSON.stringify([{ id: "p2-0", symbol: "AAPL", side: "sell", qty: "1", price: "101", order_id: "o-last", transaction_time: "2026-09-21T14:00:00Z" }]);
    };
    const [snapshot] = await syncAlpaca(ENV, reader);
    expect(snapshot.trades).toHaveLength(101);
    expect(pages).toHaveLength(2);
    expect(snapshot.trades.at(-1)).toMatchObject({ id: "alpaca:live:ALP1:p2-0", externalId: "o-last", side: "sell", assetType: "STK", fees: null });
  });

  it("refuses to save an incomplete sync when the activities feed is still full at the page cap", async () => {
    const reader: BrokerReader = async url => {
      if (url.pathname === "/v2/account") return account();
      if (url.pathname === "/v2/positions") return "[]";
      return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: `pN-${i}`, symbol: "AAPL", side: "buy", qty: "1", price: "100", order_id: `o-${i}`, transaction_time: "2026-09-20T14:00:00Z" })));
    };
    await expect(syncAlpaca(ENV, reader)).rejects.toThrow("超过本次同步上限");
  });

  it("maps an OCC option symbol from a FILL activity to OPT with multiplier 100, leaves fees null, and notes the fee handling", async () => {
    const reader: BrokerReader = async url => {
      if (url.pathname === "/v2/account") return account();
      if (url.pathname === "/v2/positions") return "[]";
      if (url.pathname.startsWith("/v2/account/activities/FILL")) return JSON.stringify([{ id: "act-1", symbol: "AAPL261016C00200000", side: "buy", qty: "2", price: "3.25", order_id: "ord-1", transaction_time: "2026-09-20T14:05:00Z" }]);
      throw new Error("unexpected");
    };
    const [snapshot] = await syncAlpaca(ENV, reader);
    expect(snapshot.trades[0]).toMatchObject({ assetType: "OPT", multiplier: "100", fees: null, quantity: "2", side: "buy", timePrecision: "instant", externalId: "ord-1" });
    expect(snapshot.notes.some(n => n.includes("监管"))).toBe(true);
  });

  it("maps sell_short fills to side sell", async () => {
    const reader: BrokerReader = async url => {
      if (url.pathname === "/v2/account") return account();
      if (url.pathname === "/v2/positions") return "[]";
      if (url.pathname.startsWith("/v2/account/activities/FILL")) return JSON.stringify([{ id: "act-2", symbol: "TSLA", side: "sell_short", qty: "3", price: "200", order_id: "ord-2", transaction_time: "2026-09-20T14:05:00Z" }]);
      throw new Error("unexpected");
    };
    const [snapshot] = await syncAlpaca(ENV, reader);
    expect(snapshot.trades[0]).toMatchObject({ side: "sell", assetType: "STK" });
  });

  it("rejects a non-USD account with a clear error", async () => {
    const reader: BrokerReader = async url => url.pathname === "/v2/account" ? account({ currency: "EUR" }) : "[]";
    await expect(syncAlpaca(ENV, reader)).rejects.toThrow("USD");
  });

  it("probes the account endpoint and reports status/currency without leaking key values", async () => {
    const result = await probeBroker("alpaca", ENV, async (url, headers) => {
      expect(url.origin).toBe("https://api.alpaca.markets");
      expect(url.pathname).toBe("/v2/account");
      expect(headers["APCA-API-KEY-ID"]).toBe(ENV.ALPACA_API_KEY_ID);
      expect(headers["APCA-API-SECRET-KEY"]).toBe(ENV.ALPACA_API_SECRET_KEY);
      return account();
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("ACTIVE");
    expect(JSON.stringify(result)).not.toContain(ENV.ALPACA_API_SECRET_KEY);
  });

  it("reports missing Alpaca credentials without making a request", async () => {
    const result = await probeBroker("alpaca", {}, async () => { throw new Error("must not call"); });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ALPACA_API_KEY_ID");
  });
});
