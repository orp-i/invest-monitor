import { describe, expect, it } from "vitest";
import { brokerConnections, probeBroker, type BrokerReader } from "../../apps/server/src/brokers.js";
import {
  resetSchwabTokenCache, schwabAccessToken, schwabAuthorizeUrl, schwabExchangeCode, schwabExtractCode, syncSchwab,
} from "../../apps/server/src/brokers-schwab.js";

const ENV = { SCHWAB_APP_KEY: "app-key-test", SCHWAB_APP_SECRET: "app-secret-test-xyz", SCHWAB_REFRESH_TOKEN: "refresh-token-test-xyz" };

describe("broker registry (Schwab OAuth fields, all four providers)", () => {
  it("returns tradier, ibkr, schwab, alpaca in order with provider metadata from the shared registry", () => {
    const now = Date.parse("2026-09-23T00:00:00.000Z");
    const env = {
      TRADIER_ACCESS_TOKEN: "secret-tradier-xyz", IBKR_FLEX_TOKEN: "secret-flex-xyz", IBKR_FLEX_QUERY_ID: "1",
      SCHWAB_APP_KEY: "secret-appkey-xyz", SCHWAB_APP_SECRET: "secret-appsecret-xyz", SCHWAB_REFRESH_TOKEN: "secret-refresh-xyz",
      SCHWAB_REFRESH_TOKEN_ISSUED_AT: new Date(now - 2 * 86400000).toISOString(),
      ALPACA_API_KEY_ID: "secret-alpacakey-xyz", ALPACA_API_SECRET_KEY: "secret-alpacasecret-xyz", ALPACA_ENVIRONMENT: "paper",
    };
    const connections = brokerConnections(env, now);
    expect(connections.map(c => c.id)).toEqual(["tradier", "ibkr", "schwab", "alpaca"]);
    expect(connections.every(c => c.configured)).toBe(true);
    expect(connections.map(c => c.cadenceMinutes)).toEqual([15, 60, 15, 15]);
    expect(connections.every(c => typeof c.description === "string" && c.description.length > 0)).toBe(true);
    expect(connections.every(c => typeof c.docsUrl === "string" && c.docsUrl.startsWith("https://"))).toBe(true);
    expect(connections.find(c => c.id === "alpaca")!.mode).toBe("paper");
    expect(connections.find(c => c.id === "schwab")!.mode).toBe("live");
    expect(connections.find(c => c.id === "ibkr")!.authorization).toBeUndefined();
    expect(connections.find(c => c.id === "alpaca")!.authorization).toBeUndefined();
    const serialized = JSON.stringify(connections);
    for (const secret of [env.TRADIER_ACCESS_TOKEN, env.IBKR_FLEX_TOKEN, env.SCHWAB_APP_KEY, env.SCHWAB_APP_SECRET, env.SCHWAB_REFRESH_TOKEN, env.ALPACA_API_KEY_ID, env.ALPACA_API_SECRET_KEY]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("computes the Schwab authorization countdown (issued + 7 days) from SCHWAB_REFRESH_TOKEN_ISSUED_AT", () => {
    const now = Date.parse("2026-09-23T00:00:00.000Z");
    const issuedAt = new Date(now - 2 * 86400000).toISOString();
    const schwab = brokerConnections({ SCHWAB_REFRESH_TOKEN: "r", SCHWAB_REFRESH_TOKEN_ISSUED_AT: issuedAt }, now).find(c => c.id === "schwab")!;
    expect(schwab.authorization).toMatchObject({ kind: "oauth", daysLeft: 5, needsReauthorization: false, issuedAt });
    expect(schwab.authorization!.expiresAt).toBe(new Date(Date.parse(issuedAt) + 7 * 86400000).toISOString());
  });

  it("flags Schwab re-authorization when the refresh token is missing, the issued-at is invalid, or the token expired", () => {
    const now = Date.parse("2026-09-23T00:00:00.000Z");
    const missing = brokerConnections({}, now).find(c => c.id === "schwab")!.authorization!;
    expect(missing).toMatchObject({ needsReauthorization: true, issuedAt: null, expiresAt: null, daysLeft: null });
    expect(missing.message).toBeTruthy();
    const invalidIssuedAt = brokerConnections({ SCHWAB_REFRESH_TOKEN: "r", SCHWAB_REFRESH_TOKEN_ISSUED_AT: "not-a-date" }, now).find(c => c.id === "schwab")!.authorization!;
    expect(invalidIssuedAt).toMatchObject({ needsReauthorization: true, issuedAt: null });
    const expiredIssuedAt = new Date(now - 8 * 86400000).toISOString();
    const expired = brokerConnections({ SCHWAB_REFRESH_TOKEN: "r", SCHWAB_REFRESH_TOKEN_ISSUED_AT: expiredIssuedAt }, now).find(c => c.id === "schwab")!.authorization!;
    expect(expired.needsReauthorization).toBe(true);
    expect(expired.daysLeft).toBeLessThan(0);
    expect(expired.message).toBeTruthy();
  });

  it("lists exactly the missing Schwab and Alpaca credentials without leaking a configured value", () => {
    const connections = brokerConnections({ SCHWAB_APP_KEY: "k" });
    const schwab = connections.find(c => c.id === "schwab")!;
    expect(schwab.configured).toBe(false);
    expect(schwab.missing).toEqual(["SCHWAB_APP_SECRET", "SCHWAB_REFRESH_TOKEN"]);
    const alpaca = connections.find(c => c.id === "alpaca")!;
    expect(alpaca.configured).toBe(false);
    expect(alpaca.missing).toEqual(["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"]);
  });
});

describe("Schwab OAuth helpers", () => {
  it("builds the authorize URL from the app key and redirect URI, defaulting to https://127.0.0.1", () => {
    const url = new URL(schwabAuthorizeUrl({ SCHWAB_APP_KEY: "key1" }));
    expect(url.origin + url.pathname).toBe("https://api.schwabapi.com/v1/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("key1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://127.0.0.1");
    expect(() => schwabAuthorizeUrl({})).toThrow("尚未配置 SCHWAB_APP_KEY");
    const custom = new URL(schwabAuthorizeUrl({ SCHWAB_APP_KEY: "key1", SCHWAB_REDIRECT_URI: "https://example.com/cb" }));
    expect(custom.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
  });

  it("extracts the authorization code from a raw code or a redirected URL, decoding %40", () => {
    expect(schwabExtractCode("C0.raw-code@")).toBe("C0.raw-code@");
    expect(schwabExtractCode("C0.raw-code%40")).toBe("C0.raw-code@");
    expect(schwabExtractCode("https://127.0.0.1/?code=C0.b2F0Y2gtcHJvZHVjdGlvbg%40&session=abc")).toBe("C0.b2F0Y2gtcHJvZHVjdGlvbg@");
    expect(() => schwabExtractCode("https://127.0.0.1/?session=abc")).toThrow("没有找到 code");
    expect(() => schwabExtractCode("   ")).toThrow("请粘贴");
  });

  it("exchanges an authorization code via POST with Basic auth, never leaking the code or secret", async () => {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const reader: BrokerReader = async (url, headers, init) => {
      calls.push({ url: url.toString(), headers, body: init?.body });
      expect(url.toString()).toBe("https://api.schwabapi.com/v1/oauth/token");
      expect(init?.method).toBe("POST");
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(headers.Authorization).toBe(`Basic ${Buffer.from("app-key-test:app-secret-test-xyz").toString("base64")}`);
      return JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 1800 });
    };
    const result = await schwabExchangeCode(ENV, "https://127.0.0.1/?code=abc%40", reader);
    expect(result).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 1800 });
    expect(new Date(result.issuedAt).toISOString()).toBe(result.issuedAt);
    expect(new Date(result.accessTokenExpiresAt).getTime() - new Date(result.issuedAt).getTime()).toBe(1800_000);
    expect(calls[0]!.body).toBe("grant_type=authorization_code&code=abc%40&redirect_uri=https%3A%2F%2F127.0.0.1");
    expect(JSON.stringify(calls)).not.toContain(ENV.SCHWAB_APP_SECRET);
  });

  it("sanitizes a failed code exchange (invalid code or secret) without leaking details", async () => {
    const reader: BrokerReader = async () => { throw new Error("HTTP 401"); };
    await expect(schwabExchangeCode(ENV, "bad-code", reader)).rejects.toThrow("重新发起授权");
  });
});

describe("Schwab access-token cache", () => {
  it("caches the access token by refresh-token hash until near expiry, then refreshes", async () => {
    resetSchwabTokenCache();
    let tokenRequests = 0;
    const reader: BrokerReader = async (url, headers, init) => {
      expect(url.toString()).toBe("https://api.schwabapi.com/v1/oauth/token");
      expect(init?.body).toBe("grant_type=refresh_token&refresh_token=refresh-token-test-xyz");
      tokenRequests++;
      return JSON.stringify({ access_token: `at-${tokenRequests}`, expires_in: 1800 });
    };
    const now = Date.parse("2026-09-23T00:00:00.000Z");
    expect(await schwabAccessToken(ENV, reader, now)).toBe("at-1");
    expect(await schwabAccessToken(ENV, reader, now + 60_000)).toBe("at-1");
    expect(tokenRequests).toBe(1);
    expect(await schwabAccessToken(ENV, reader, now + 1800_000)).toBe("at-2");
    expect(tokenRequests).toBe(2);
  });

  it("reports a clear re-authorization error on HTTP 401 without leaking the refresh token", async () => {
    resetSchwabTokenCache();
    const reader: BrokerReader = async () => { throw new Error("HTTP 401"); };
    let message = "";
    try { await schwabAccessToken(ENV, reader, Date.now()); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("需要重新授权");
    expect(message).not.toContain(ENV.SCHWAB_REFRESH_TOKEN);
  });
});

describe("syncSchwab", () => {
  it("syncs accounts, skips a flat position, maps single/multi-leg trades and splits multi-leg fees", async () => {
    resetSchwabTokenCache();
    const requests: string[] = [];
    const reader: BrokerReader = async (url, headers) => {
      requests.push(url.pathname + url.search);
      expect(url.origin).toBe("https://api.schwabapi.com");
      if (url.pathname === "/v1/oauth/token") return JSON.stringify({ access_token: "at-1", expires_in: 1800 });
      expect(headers.Authorization).toBe("Bearer at-1");
      if (url.pathname.endsWith("accountNumbers")) return JSON.stringify([{ accountNumber: "SCHWAB1", hashValue: "HASH1" }]);
      if (url.pathname === "/trader/v1/accounts/HASH1") {
        expect(url.search).toBe("?fields=positions");
        return JSON.stringify({ securitiesAccount: {
          accountNumber: "SCHWAB1", type: "MARGIN",
          currentBalances: { liquidationValue: 10250.5, cashBalance: 4200.25 },
          positions: [
            { shortQuantity: 0, longQuantity: 10, averagePrice: 150.25, marketValue: 1550, longOpenProfitLoss: 47.5, shortOpenProfitLoss: 0, instrument: { assetType: "EQUITY", symbol: "MSFT", description: "MICROSOFT CORP" } },
            { shortQuantity: 0, longQuantity: 2, averagePrice: 3.2, marketValue: 700, longOpenProfitLoss: 60, shortOpenProfitLoss: 0, instrument: { assetType: "OPTION", symbol: "MSFT  261016C00400000", description: "MSFT CALL", putCall: "CALL", underlyingSymbol: "MSFT", optionMultiplier: 100 } },
            { shortQuantity: 5, longQuantity: 5, averagePrice: 0, marketValue: 0, longOpenProfitLoss: 0, shortOpenProfitLoss: 0, instrument: { assetType: "EQUITY", symbol: "FLAT", description: "offsetting lots" } },
          ],
        } });
      }
      if (url.pathname === "/trader/v1/accounts/HASH1/transactions") {
        expect(url.searchParams.get("types")).toBe("TRADE");
        expect(url.searchParams.get("startDate")).toBeTruthy();
        expect(url.searchParams.get("endDate")).toBeTruthy();
        return JSON.stringify([
          { activityId: 111, time: "2026-09-15T14:30:00+0000", type: "TRADE", status: "VALID", netAmount: -1502.5,
            transferItems: [
              { instrument: { assetType: "EQUITY", symbol: "MSFT" }, amount: 10, cost: -1502.5, price: 150.25, positionEffect: "OPENING" },
              { feeType: "COMMISSION", cost: -1.5 },
            ] },
          { activityId: 112, time: "2026-09-16T15:00:00+0000", type: "TRADE", status: "VALID", netAmount: -20,
            transferItems: [
              { instrument: { assetType: "OPTION", symbol: "MSFT  261016C00400000", optionMultiplier: 100 }, amount: 1, cost: -320, price: 3.2, positionEffect: "OPENING" },
              { instrument: { assetType: "OPTION", symbol: "MSFT  261016C00410000", optionMultiplier: 100 }, amount: -1, cost: 300, price: 3.0, positionEffect: "OPENING" },
              { feeType: "REG_FEE", cost: -1.32 },
            ] },
        ]);
      }
      throw new Error(`unexpected route ${url.pathname}`);
    };
    const now = Date.parse("2026-09-23T00:00:00.000Z");
    const [snapshot] = await syncSchwab(ENV, reader, now);
    expect(snapshot).toMatchObject({ broker: "schwab", accountId: "SCHWAB1", environment: "live", equity: "10250.5", cash: "4200.25" });
    expect(requests).toEqual([
      "/v1/oauth/token",
      "/trader/v1/accounts/accountNumbers",
      "/trader/v1/accounts/HASH1?fields=positions",
      expect.stringMatching(/^\/trader\/v1\/accounts\/HASH1\/transactions\?startDate=.*&endDate=.*&types=TRADE$/),
    ]);

    // Flat (5 long - 5 short = 0) position is skipped entirely.
    expect(snapshot!.positions).toHaveLength(2);
    const stock = snapshot!.positions.find(p => p.symbol === "MSFT")!;
    expect(stock).toMatchObject({ quantity: "10", assetType: "STK", multiplier: "1", costBasis: "1502.5", unrealizedPnl: "47.5" });
    const option = snapshot!.positions.find(p => p.symbol.startsWith("MSFT  26"))!;
    expect(option).toMatchObject({ quantity: "2", assetType: "OPT", multiplier: "100", costBasis: "640", unrealizedPnl: "60" });
    expect(snapshot!.unrealizedPnl).toBe("107.5");

    expect(snapshot!.trades).toHaveLength(3);
    const single = snapshot!.trades.find(t => t.externalId === "111")!;
    expect(single).toMatchObject({ id: "schwab:live:SCHWAB1:111:1", side: "buy", quantity: "10", price: "150.25", fees: "1.5", netCash: "-1502.5", positionEffect: "open", assetType: "STK", multiplier: "1", timePrecision: "instant" });
    const legs = snapshot!.trades.filter(t => t.externalId === "112");
    expect(legs.map(l => l.id).sort()).toEqual(["schwab:live:SCHWAB1:112:1", "schwab:live:SCHWAB1:112:2"]);
    for (const leg of legs) { expect(leg.fees).toBe("0.66"); expect(leg.netCash).toBeUndefined(); expect(leg.assetType).toBe("OPT"); expect(leg.multiplier).toBe("100"); expect(leg.positionEffect).toBe("open"); }
    expect(legs.map(l => l.side).sort()).toEqual(["buy", "sell"]);
    expect(JSON.stringify(snapshot)).not.toContain(ENV.SCHWAB_APP_SECRET);
    expect(JSON.stringify(snapshot)).not.toContain(ENV.SCHWAB_REFRESH_TOKEN);
  });

  it("does not repeat the token request on a second sync within the cache window", async () => {
    resetSchwabTokenCache();
    let tokenRequests = 0;
    const reader: BrokerReader = async url => {
      if (url.pathname === "/v1/oauth/token") { tokenRequests++; return JSON.stringify({ access_token: "at-1", expires_in: 1800 }); }
      if (url.pathname.endsWith("accountNumbers")) return JSON.stringify([{ accountNumber: "SCHWAB1", hashValue: "HASH1" }]);
      if (url.pathname === "/trader/v1/accounts/HASH1") return JSON.stringify({ securitiesAccount: { accountNumber: "SCHWAB1", currentBalances: {}, positions: [] } });
      if (url.pathname === "/trader/v1/accounts/HASH1/transactions") return "[]";
      throw new Error(`unexpected route ${url.pathname}`);
    };
    const now = Date.parse("2026-09-23T00:00:00.000Z");
    await syncSchwab(ENV, reader, now);
    await syncSchwab(ENV, reader, now + 60_000);
    expect(tokenRequests).toBe(1);
  });
});

describe("probeBroker", () => {
  it("tests Tradier with a minimal profile read and reports the account count without leaking the token", async () => {
    const env = { TRADIER_ACCESS_TOKEN: "secret-tradier-xyz" };
    const reader: BrokerReader = async (url, headers) => {
      expect(url.origin).toBe("https://api.tradier.com");
      expect(url.pathname.endsWith("user/profile")).toBe(true);
      expect(headers.Authorization).toBe("Bearer secret-tradier-xyz");
      return JSON.stringify({ profile: { account: [{ account_number: "A1" }, { account_number: "A2" }] } });
    };
    const result = await probeBroker("tradier", env, reader);
    expect(result).toMatchObject({ ok: true, details: { accounts: 2, environment: "live" } });
    expect(result.message).not.toContain("secret-tradier-xyz");
  });

  it("reports missing Tradier credentials without making a request", async () => {
    const result = await probeBroker("tradier", {}, async () => { throw new Error("must not call"); });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("TRADIER_ACCESS_TOKEN");
  });

  it("tests IBKR with SendRequest and notes that it triggers report generation, without leaking the token", async () => {
    const env = { IBKR_FLEX_TOKEN: "secret-flex-xyz", IBKR_FLEX_QUERY_ID: "42" };
    // IBKR legitimately requires the token in the query string (that is how the Flex Web Service authenticates);
    // the "never leaks" contract is about the probe's returned message/details, checked below.
    const reader: BrokerReader = async url => {
      expect(url.origin).toBe("https://ndcdyn.interactivebrokers.com");
      return "<FlexStatementResponse><Status>Success</Status><ReferenceCode>555</ReferenceCode></FlexStatementResponse>";
    };
    const result = await probeBroker("ibkr", env, reader);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("生成");
    expect(result.message).not.toContain("secret-flex-xyz");
  });

  it("tests Schwab with a token refresh plus account count, and surfaces a re-authorization failure", async () => {
    resetSchwabTokenCache();
    const ok = await probeBroker("schwab", ENV, async (url, headers) => {
      if (url.pathname.endsWith("/oauth/token")) return JSON.stringify({ access_token: "at", expires_in: 1800 });
      expect(headers.Authorization).toBe("Bearer at");
      return JSON.stringify([{ accountNumber: "1", hashValue: "H1" }]);
    });
    expect(ok).toMatchObject({ ok: true, details: { accounts: 1 } });
    resetSchwabTokenCache();
    const failed = await probeBroker("schwab", ENV, async () => { throw new Error("HTTP 401"); });
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("重新授权");
    expect(failed.message).not.toContain(ENV.SCHWAB_REFRESH_TOKEN);
  });
});
