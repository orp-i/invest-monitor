import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageDriver } from "@invest/storage";
import type { BrokerOrderObservation } from "@invest/domain";
import { brokerConnections, parseBrokerJson, parseIbkrStatement, syncBroker, tradierOrderObservations, type BrokerReader } from "../../apps/server/src/brokers.js";

const ibkrXml = `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U-test" toDate="20260904"><OpenPositions><OpenPosition levelOfDetail="SUMMARY" conid="1" symbol="GLD" currency="USD" position="2" costBasisMoney="400.123456789123456789" positionValue="450" fifoPnlUnrealized="49.876543210876543211" /></OpenPositions><Trades><Trade levelOfDetail="EXECUTION" tradeID="123" symbol="GLD" buySell="BUY" quantity="2" tradePrice="200" ibCommission="-1" currency="USD" dateTime="20260904;093000" assetCategory="STK" /></Trades></FlexStatement></FlexStatements></FlexQueryResponse>`;

describe("read-only broker adapters", () => {
  it("keeps original numeric JSON tokens, including decimals and large IDs", () => {
    expect(parseBrokerJson('{"price":9007199254740993.123456789,"id":9007199254740995}')).toEqual({ price: "9007199254740993.123456789", id: "9007199254740995" });
  });

  it("makes no request without credentials and never returns token values from status", async () => {
    const env = { TRADIER_ACCESS_TOKEN: "secret-test-value" };
    expect(JSON.stringify(brokerConnections(env))).not.toContain(env.TRADIER_ACCESS_TOKEN);
    await expect(syncBroker("ibkr", {}, async () => { throw new Error("must not call"); })).rejects.toThrow("尚未配置");
  });

  it("normalizes singleton positions, trade direction, duplicate occurrences, and account PnL scopes", async () => {
    const requests: string[] = [];
    const reader: BrokerReader = async (url, headers) => {
      requests.push(url.pathname);
      expect(url.origin).toBe("https://api.tradier.com");
      expect(url.search).not.toContain("test-token");
      expect(headers.Authorization).toBe("Bearer test-token");
      if (url.pathname.endsWith("profile")) return '{"profile":{"account":{"account_number":"A-test"}}}';
      if (url.pathname.endsWith("positions")) return '{"positions":{"position":{"id":9007199254740995,"symbol":"GLD","quantity":2,"cost_basis":400.123456789123456789}}}';
      if (url.pathname.endsWith("balances")) return '{"balances":{"total_equity":500.00001,"open_pl":12.3400,"close_pl":-1.23}}';
      if (url.pathname.endsWith("history")) return JSON.stringify({ history: { event: [1, 2].map(() => ({ type: "trade", date: "2026-09-04T00:00:00Z", amount: 20, trade: { symbol: "GLD", quantity: -1, price: 20, commission: 0, trade_type: "Equity" } })) } });
      throw new Error("unexpected route");
    };
    const [snapshot] = await syncBroker("tradier", { TRADIER_ACCESS_TOKEN: "test-token" }, reader);
    expect(snapshot).toMatchObject({ currency: "USD", equity: "500.00001", unrealizedPnl: "12.34", sessionRealizedPnl: "-1.23" });
    expect(snapshot?.positions[0]).toMatchObject({ id: "9007199254740995", costBasis: "400.123456789123456789", marketValue: null, unrealizedPnl: null });
    expect(snapshot?.trades).toHaveLength(2);
    expect(new Set(snapshot?.trades.map(trade => trade.id)).size).toBe(2);
    expect(snapshot?.trades[0]).toMatchObject({ side: "sell", quantity: "1", tradedAt: "2026-09-04", timePrecision: "day", externalId: null });
    expect(requests.some(path => path.endsWith("/orders"))).toBe(true);
    expect(requests.some(path => path.endsWith("/gainloss"))).toBe(true);
    expect(snapshot?.notes.some(note => note.includes("未取得已平仓批次"))).toBe(true);
  });

  it("attaches closed-lot pairing and session order evidence to Tradier trades without changing recorded fields", async () => {
    const event = (date: string, symbol: string, quantity: number, price: number, amount: number) => ({ type: "trade", date: `${date}T00:00:00Z`, amount, trade: { symbol, quantity, price, commission: 0, trade_type: "option", description: symbol } });
    const history = [
      event("2026-09-16", "UCO261016C00065000", -1, 1.35, 134.87), event("2026-09-16", "UCO261016C00055000", 1, 3.55, -355.11),
      event("2026-09-14", "SPY260914P00762000", 1, 0.7, -70.11), event("2026-09-14", "SPY260914P00762000", -1, 0.78, 77.87), event("2026-09-14", "SPY260914P00762000", -1, 0.47, 46.87), event("2026-09-14", "SPY260914P00762000", 1, 0.8, -80.11),
      event("2026-09-14", "SPY260914P00761000", -1, 0.67, 66.87), event("2026-09-14", "SPY260914P00761000", 1, 0.55, -55.11),
      event("2026-09-14", "SPY260914P00757000", 1, 0.18, -18.11), event("2026-09-14", "SPY260914P00757000", -1, 0.27, 26.87),
      event("2026-09-10", "IWM260911P00285000", 1, 1.09, -109.11), event("2026-09-11", "IWM260911P00285000", -1, 0.03, 2.87),
    ];
    const lot = (symbol: string, quantity: number, cost: number, proceeds: number, open = "2026-09-14", close = "2026-09-14") => ({ symbol, quantity, cost, proceeds, gain_loss: 0, open_date: `${open}T00:00:00.000Z`, close_date: `${close}T00:00:00.000Z` });
    const lots = [lot("SPY260914P00761000", 1, 55.11, 66.87), lot("SPY260914P00757000", -1, 18.11, -26.87), lot("SPY260914P00762000", 1, 80.11, 77.87), lot("SPY260914P00762000", 1, 72.35, 46.87), lot("IWM260911P00285000", 1, 109.11, 2.87, "2026-09-10", "2026-09-11")];
    const orders = [
      { id: 900, status: "filled", class: "multileg", symbol: "UCO", leg: [
        { id: 9001, status: "filled", side: "buy_to_open", option_symbol: "UCO261016C00055000", exec_quantity: 1, avg_fill_price: 3.55, transaction_date: "2026-09-16T14:31:02.000Z", create_date: "2026-09-16T14:30:58.000Z" },
        { id: 9002, status: "filled", side: "sell_to_open", option_symbol: "UCO261016C00065000", exec_quantity: 1, avg_fill_price: 1.35, transaction_date: "2026-09-16T14:31:02.000Z", create_date: "2026-09-16T14:30:58.000Z" }] },
      { id: 800, status: "open", class: "option", side: "buy_to_open", option_symbol: "SPY260914P00761000", exec_quantity: 0, quantity: 1 },
      { id: 801, status: "canceled", class: "option", side: "sell_to_close", option_symbol: "SPY260914P00761000", exec_quantity: 0 },
    ];
    const known: BrokerOrderObservation[] = [{ broker: "tradier", environment: "live", accountId: "A-test", orderId: "701", groupId: null, status: "filled", symbol: "SPY260914P00761000", side: "buy", positionEffect: "open", quantity: "1", price: "0.55", executedAt: "2026-09-14T13:45:10.000Z", createdAt: null, firstSeenAt: "2026-09-14T13:46:00.000Z", lastSeenAt: "2026-09-14T13:46:00.000Z" },
      { broker: "tradier", environment: "sandbox", accountId: "A-test", orderId: "702", groupId: null, status: "filled", symbol: "SPY260914P00757000", side: "sell", positionEffect: "close", quantity: "1", price: "0.27", executedAt: "2026-09-14T13:45:10.000Z", createdAt: null, firstSeenAt: "2026-09-14T13:46:00.000Z", lastSeenAt: "2026-09-14T13:46:00.000Z" }];
    const reader: BrokerReader = async url => {
      if (url.pathname.endsWith("profile")) return '{"profile":{"account":{"account_number":"A-test"}}}';
      if (url.pathname.endsWith("positions")) return '{"positions":"null"}';
      if (url.pathname.endsWith("balances")) return '{"balances":{"total_equity":1,"open_pl":0,"close_pl":0}}';
      if (url.pathname.endsWith("history")) return JSON.stringify({ history: { event: history } });
      if (url.pathname.endsWith("gainloss")) return JSON.stringify({ gainloss: { closed_position: lots } });
      if (url.pathname.endsWith("orders")) return JSON.stringify({ orders: { order: orders } });
      throw new Error("unexpected route");
    };
    const evidence = { known, observed: [] as BrokerOrderObservation[] };
    const [snapshot] = await syncBroker("tradier", { TRADIER_ACCESS_TOKEN: "test-token" }, reader, evidence);
    const trades = snapshot!.trades;
    expect(trades).toHaveLength(history.length);
    expect(trades.map(t => [t.symbol, t.tradedAt, t.side, t.quantity, t.price, t.fees, t.netCash, t.timePrecision]))
      .toEqual(history.map(e => [e.trade.symbol, e.date.slice(0, 10), e.trade.quantity < 0 ? "sell" : "buy", String(Math.abs(e.trade.quantity)), String(e.trade.price), "0", String(e.amount), "day"]));
    const find = (symbol: string, side: string, amount: string) => trades.find(t => t.symbol === symbol && t.side === side && t.netCash === amount)!;
    expect(find("SPY260914P00761000", "buy", "-55.11")).toMatchObject({ positionEffect: "open", effectSource: "order", orderId: "701", orderGroupId: null, executedAt: "2026-09-14T13:45:10.000Z" });
    expect(find("SPY260914P00761000", "buy", "-55.11").lotId).toMatch(/^lot:/);
    expect(find("SPY260914P00761000", "sell", "66.87")).toMatchObject({ positionEffect: "close", effectSource: "lot", lotId: find("SPY260914P00761000", "buy", "-55.11").lotId });
    expect(find("SPY260914P00761000", "sell", "66.87").orderId).toBeUndefined();
    expect(find("SPY260914P00757000", "sell", "26.87")).toMatchObject({ positionEffect: "open", effectSource: "lot" });
    expect(find("SPY260914P00757000", "sell", "26.87").orderId).toBeUndefined();
    expect(find("SPY260914P00757000", "buy", "-18.11")).toMatchObject({ positionEffect: "close", effectSource: "lot", lotId: find("SPY260914P00757000", "sell", "26.87").lotId });
    expect(find("SPY260914P00762000", "buy", "-80.11")).toMatchObject({ positionEffect: "open", lotId: find("SPY260914P00762000", "sell", "77.87").lotId });
    expect(find("SPY260914P00762000", "buy", "-70.11")).toMatchObject({ positionEffect: "open", lotId: find("SPY260914P00762000", "sell", "46.87").lotId });
    expect(new Set(trades.filter(t => t.symbol === "SPY260914P00762000").map(t => t.lotId)).size).toBe(2);
    expect(find("IWM260911P00285000", "buy", "-109.11")).toMatchObject({ positionEffect: "open", tradedAt: "2026-09-10" });
    expect(find("IWM260911P00285000", "sell", "2.87")).toMatchObject({ positionEffect: "close", tradedAt: "2026-09-11" });
    for (const symbol of ["UCO261016C00055000", "UCO261016C00065000"]) {
      const leg = trades.find(t => t.symbol === symbol)!;
      expect(leg).toMatchObject({ orderGroupId: "900", executedAt: "2026-09-16T14:31:02.000Z", positionEffect: "open", effectSource: "order", tradedAt: "2026-09-16", timePrecision: "day" });
      expect(leg.lotId).toBeUndefined();
    }
    expect(evidence.observed.map(o => o.orderId).sort()).toEqual(["9001", "9002"]);
    expect(evidence.observed[0]).toMatchObject({ broker: "tradier", environment: "live", accountId: "A-test", groupId: "900", quantity: "1", positionEffect: "open" });
    expect(snapshot!.notes.some(n => n.includes("已平仓批次"))).toBe(true);
    expect(tradierOrderObservations([{ id: 5, status: "partially_filled", side: "sell_short", symbol: "GLD", exec_quantity: 3, avg_fill_price: 10, transaction_date: "bad" }], "A", "live", "2026-09-16T00:00:00.000Z"))
      .toEqual([expect.objectContaining({ orderId: "5", groupId: null, symbol: "GLD", side: "sell", positionEffect: "open", quantity: "3", executedAt: null })]);
  });

  it("persists observed orders with first-seen time across repeated syncs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "invest-orders-"));
    const storage = createStorageDriver("node-sqlite", join(dir, "test.sqlite")); await storage.open(); await storage.migrate();
    try {
      const row: BrokerOrderObservation = { broker: "tradier", environment: "live", accountId: "A", orderId: "1", groupId: null, status: "partially_filled", symbol: "GLD", side: "buy", positionEffect: "open", quantity: "1", price: "10", executedAt: "2026-09-16T14:00:00.000Z", createdAt: null, firstSeenAt: "2026-09-16T14:01:00.000Z", lastSeenAt: "2026-09-16T14:01:00.000Z" };
      await storage.saveBrokerOrderObservations([row]);
      await storage.saveBrokerOrderObservations([{ ...row, status: "filled", quantity: "2", firstSeenAt: "2026-09-16T14:20:00.000Z", lastSeenAt: "2026-09-16T14:20:00.000Z" }]);
      await storage.migrate();
      expect(await storage.getBrokerOrderObservations("tradier")).toEqual([{ ...row, status: "filled", quantity: "2", lastSeenAt: "2026-09-16T14:20:00.000Z" }]);
      expect(await storage.getBrokerOrderObservations("ibkr")).toEqual([]);
    } finally { await storage.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("follows history pagination and refuses to silently save incomplete envelopes", async () => {
    let pages = 0;
    const reader: BrokerReader = async url => {
      if (url.pathname.endsWith("profile")) return '{"profile":{"account":[{"account_number":"A"}]}}';
      if (url.pathname.endsWith("positions")) return '{"positions":"null"}';
      if (url.pathname.endsWith("balances")) return '{"balances":{}}';
      if (!url.pathname.endsWith("history")) return "{}";
      pages++;
      return JSON.stringify({ history: { event: pages === 1 ? Array.from({ length: 1000 }, () => ({ type: "dividend" })) : null } });
    };
    const [snapshot] = await syncBroker("tradier", { TRADIER_ACCESS_TOKEN: "test" }, reader);
    expect(pages).toBe(2);
    expect(snapshot?.positions).toEqual([]);
    expect(snapshot?.trades).toEqual([]);
    await expect(syncBroker("tradier", { TRADIER_ACCESS_TOKEN: "test" }, async () => "{}")).rejects.toThrow("响应不完整");
  });

  it("does not request unavailable sandbox history", async () => {
    const [snapshot] = await syncBroker("tradier", { TRADIER_ACCESS_TOKEN: "test", TRADIER_ENVIRONMENT: "sandbox" }, async url => {
      expect(url.origin).toBe("https://sandbox.tradier.com");
      if (url.pathname.endsWith("profile")) return '{"profile":{"account":{"account_number":"A"}}}';
      if (url.pathname.endsWith("positions")) return '{"positions":null}';
      if (url.pathname.endsWith("balances")) return '{"balances":{}}';
      throw new Error("sandbox history must not be called");
    });
    expect(snapshot?.environment).toBe("sandbox");
    expect(snapshot?.notes[0]).toContain("不提供成交历史");
  });

  it("explains a CSV Flex report without leaking its content", async () => {
    await expect(syncBroker("ibkr", { IBKR_FLEX_TOKEN: "secret", IBKR_FLEX_QUERY_ID: "42" }, async url => url.pathname.endsWith("SendRequest")
      ? '<FlexStatementResponse><Status>Success</Status><ReferenceCode>123</ReferenceCode></FlexStatementResponse>'
      : 'ClientAccountID,TradeDate,AssetClass\nprivate,20260904,STK')).rejects.toThrow("输出格式改为 XML");
  });

  it("keeps IBKR report dates, currencies, fees and exact decimal strings", () => {
    const [snapshot] = parseIbkrStatement(ibkrXml);
    expect(snapshot).toMatchObject({ environment: "statement", asOf: "20260904", equity: null, currency: null });
    expect(snapshot?.positions[0]?.costBasis).toBe("400.123456789123456789");
    expect(snapshot?.trades[0]).toMatchObject({ externalId: "123", fees: "-1", timePrecision: "broker-local", tradedAt: "20260904;093000" });
    expect(() => parseIbkrStatement(ibkrXml.replace(/<OpenPositions>.*<\/OpenPositions>/, ""))).toThrow("必须包含");
    expect(() => parseIbkrStatement('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>')).toThrow("XML 报告无效");
  });

  it("keeps IBKR token on the fixed official origin, ignoring response URL injection", async () => {
    const calls: string[] = [];
    const accounts = await syncBroker("ibkr", { IBKR_FLEX_TOKEN: "secret", IBKR_FLEX_QUERY_ID: "42" }, async (url, headers) => {
      calls.push(url.pathname);
      expect(url.origin).toBe("https://ndcdyn.interactivebrokers.com");
      expect(headers["User-Agent"]).toContain("Node/24");
      if (url.pathname.endsWith("SendRequest")) return '<FlexStatementResponse><Status>Success</Status><ReferenceCode>123</ReferenceCode><url>https://attacker.invalid/GetStatement</url></FlexStatementResponse>';
      return ibkrXml;
    });
    expect(calls).toHaveLength(2);
    expect(accounts).toHaveLength(1);
  });

  it("reports all missing IBKR identifiers together without including account data", () => {
    const report = ibkrXml.replace('conid="1"', 'conid=""').replace('tradeID="123"', '');
    let message = "";
    try { parseIbkrStatement(report); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("Open Positions → Conid");
    expect(message).toContain("Trades → Trade ID");
    expect(message).not.toContain("U-test");
    expect(message).not.toContain("GLD");
    const [snapshot] = parseIbkrStatement(ibkrXml.replace('dateTime="20260904;093000"', 'dateTime="" tradeDate="20260904"'));
    expect(snapshot?.trades[0]).toMatchObject({ tradedAt: "20260904", timePrecision: "day" });
  });
});
