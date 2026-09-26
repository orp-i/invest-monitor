import { describe, expect, it } from "vitest";
import { accountPerformance, BrokerSnapshotSchema, brokerPositionEffect, directionLabel, executionAction, marketDirection, quantityDirection, reviewExecutionDetails, SAME_DAY_EVIDENCE_SUFFIX, tradingCaseMetrics, type ReviewFill, type TradingCase } from "@invest/domain";
const fill = (id: string, side: "buy" | "sell", price: string, at: string, effect?: "open" | "close", symbol = "NVDA260918P00225000"): ReviewFill => ({ id, transactionId: id, source: "ibkr", instrumentKey: symbol, symbol, side, price, quantity: "1", multiplier: "100", feeCost: "1", currency: "USD", occurredAt: at, timePrecision: "instant", positionEffect: effect });
const entry = (fills: ReviewFill[]): TradingCase => ({ id: "test", title: "test", strategy: "test", instrumentType: "option", horizon: "unspecified", historyComplete: true, fillIds: fills.map(f => f.id), fills, createdAt: "2026-09-01", updatedAt: "2026-09-01", plans: [], evidence: [], events: [], assessments: [], linkHistory: [] });
const open = "2026-09-01T15:00:00Z", close = "2026-09-02T15:00:00Z";

describe("long/short contracts and underlying exposure", () => {
  it("recognizes short entry and cover even when same-day explicit rows arrive in reverse order", () => {
    const c = entry([fill("cover", "buy", "1", open, "close"), fill("short", "sell", "3", open, "open")]);
    c.fills.forEach(f => {f.timePrecision = "day"; f.occurredAt = "2026-09-01";});
    const d = reviewExecutionDetails(c);
    expect(d.legs[0]).toMatchObject({ direction: "short", openingPrice: "3", closingPrice: "1", openingQuantity: "1", closingQuantity: "1", pnl: "198" });
    expect(d.actions.cover).toBe("买入平仓（空头回补）"); expect(d.actions.short).toBe("卖出开仓（空头）");
    expect(d.direction).toBe("看多 · 卖出认沽（Short Put）"); // Short put: short contract, bullish underlying exposure.
  });
  it("distinguishes a bearish long put from a short stock or short option", () => {
    const d = reviewExecutionDetails(entry([fill("put", "buy", "1.09", open, "open")]));
    expect(d.direction).toBe("看空 · 买入认沽（Long Put）");expect(d.legs[0]!.directionLabel).toBe("看空标的 · 买入 Put（合约多头）");
    expect(directionLabel("RDDT", quantityDirection("-1"))).toBe("空头 · 卖出持有");
    expect(marketDirection("NVDA260918C00225000", "short")).toBe("bearish");
    expect(marketDirection("NVDA260918P00225000", "short")).toBe("bullish");
  });
  it("does not infer closed same-day long/short from response order, and does not flip cash P&L", () => {
    const fills = [fill("b", "buy", "1.73", open), fill("s", "sell", "0.77", open)].map((f, i) => ({...f, timePrecision:"day" as const, occurredAt:"2026-09-10", multiplier:null, netCash:i===0?"-173.46":"76.87"}));
    for(const f of [fills, [...fills].reverse()]){
      const c = entry(f), d=reviewExecutionDetails(c);
      expect(d.legs[0]).toMatchObject({ direction:"unknown", openingPrice:null, closingPrice:null, pnl:"-96.59" });
      expect(d.direction).toBe("结构方向待核实");expect(tradingCaseMetrics(c).netPnl).toBe("-96.59");
    }
  });
  it("treats mixed date precision on the same day as ambiguous instead of manufacturing a short entry", () => {
    const a=fill("sell","sell","2",open), b=fill("buy","buy","1","2026-09-01");b.timePrecision="day";
    expect(reviewExecutionDetails(entry([a,b])).legs[0]).toMatchObject({direction:"unknown",classificationKnown:false,pnl:"98"});
  });
  it("separates short-cover and new-long portions of a reversal", () => {
    const c=entry([fill("short","sell","2",open), {...fill("reverse","buy","1",close),quantity:"2"}]);
    const d=reviewExecutionDetails(c);
    expect(d.legs[0]).toMatchObject({direction:"mixed",netQuantity:"1",openingQuantity:"2",closingQuantity:"1",pnl:null});
    expect(d.actions.reverse).toBe("买入平仓（空头回补）；买入开仓（多头）");
  });
  it("recognizes a simultaneously opened bearish put vertical and keeps the short leg distinct", () => {
    const c=entry([fill("short","sell","1.06",open,"open","NVDA260918P00222500"),fill("long","buy","1.68",open,"open")]);
    expect(reviewExecutionDetails(c).direction).toBe("看空认沽价差（买高卖低行权价）");
    expect(reviewExecutionDetails(c).legs.map(l=>l.direction)).toEqual(["short","long"]);
    c.fills[0]!.quantity="2";expect(reviewExecutionDetails(c).direction).toBe("多腿组合 · 方向分别见各腿");
    c.fills[0]!.quantity="1";c.fills[0]!.occurredAt=close;expect(reviewExecutionDetails(c).direction).toBe("多腿组合 · 方向分别见各腿");
  });
  it("recognizes bullish put and bearish call verticals by strikes, never by buy/sell word alone", () => {
    const bullish=entry([fill("short","sell","1.68",open,"open"),fill("long","buy","1.06",open,"open","NVDA260918P00222500")]);
    expect(reviewExecutionDetails(bullish).direction).toBe("看多认沽价差（卖高买低行权价）");
    bullish.fills.forEach(f=>{f.symbol=f.symbol.replace("P002","C002");f.instrumentKey=f.symbol;});
    expect(reviewExecutionDetails(bullish).direction).toBe("看多认购价差（买低卖高行权价）");
    bullish.fills.forEach(f=>{f.side=f.side==="buy"?"sell":"buy";});
    expect(reviewExecutionDetails(bullish).direction).toBe("看空认购价差（卖低买高行权价）");
  });
  it("recognizes an automatic case whose date-only openings carry broker lot flags and whose closes carry order instants", () => {
    const c = entry([
      { ...fill("o1", "buy", "3.55", "2026-09-16", "open", "UCO261016C00055000"), timePrecision: "day", lotId: "lot:a" },
      { ...fill("c1", "sell", "2.32", "2026-09-23T17:40:07.507Z", "close", "UCO261016C00055000"), lotId: "lot:a", orderGroupId: "147475261" },
      { ...fill("o2", "sell", "1.35", "2026-09-16", "open", "UCO261016C00065000"), timePrecision: "day", lotId: "lot:b" },
      { ...fill("c2", "buy", "0.62", "2026-09-23T17:40:07.507Z", "close", "UCO261016C00065000"), lotId: "lot:b", orderGroupId: "147475261" },
    ]);
    c.id = "auto-case-uco"; // an automatic merge, so not a user-confirmed grouping
    const d = reviewExecutionDetails(c);
    expect(d.direction).toBe(`看多认购价差（买低卖高行权价）${SAME_DAY_EVIDENCE_SUFFIX}`);
    expect(d.strategy.timing).toBe("same-day"); expect(d.legs.map(l => l.lots)).toEqual([1, 1]);
    c.fills[0]!.positionEffect = undefined; // one unflagged fill removes the broker-evidence path
    expect(reviewExecutionDetails(c).strategy.referenceUrl).toBeNull();
  });
  it("recognizes a current short opening from negative inventory without reversing the broker buy/sell side", () => {
    const t = { id:"sell",externalId:null,symbol:"RDDT",side:"sell" as const,quantity:"2",price:"150",fees:"1",currency:"USD",tradedAt:open,timePrecision:"instant" as const,assetType:"STK" };
    const a = BrokerSnapshotSchema.parse({broker:"tradier",accountId:"test",environment:"live",currency:"USD",equity:"1000",asOf:open,syncedAt:open,unrealizedPnl:null,sessionRealizedPnl:null,notes:[],positions:[{id:"p",symbol:"RDDT",quantity:"-2",currency:"USD",costBasis:"-299",marketValue:"-280",unrealizedPnl:"19"}],trades:[t]});
    expect(brokerPositionEffect(a,t)).toBe("open");expect(executionAction(t.side,brokerPositionEffect(a,t))).toBe("卖出开仓（空头）");
    a.positions[0]!.quantity="2";expect(brokerPositionEffect(a,t)).toBeNull();
    expect(brokerPositionEffect(a,{...t,side:"buy",positionEffect:"close"})).toBe("close");
  });
  it("keeps short stock partial-cover profit and remaining cost signed with fees allocated once", () => {
    const a=BrokerSnapshotSchema.parse({broker:"ibkr",accountId:"test",environment:"statement",currency:"USD",equity:"1000",asOf:close,syncedAt:close,unrealizedPnl:null,sessionRealizedPnl:null,notes:[],positions:[{id:"p",symbol:"RDDT",quantity:"-2",currency:"USD",costBasis:"-298",marketValue:"-240",unrealizedPnl:"58",multiplier:"1",assetType:"STK"}],trades:[{id:"s",externalId:"s",symbol:"RDDT",side:"sell",quantity:"3",price:"150",fees:"-3",feeCurrency:"USD",currency:"USD",tradedAt:open,timePrecision:"instant",assetType:"STK",multiplier:"1",positionEffect:"open"},{id:"b",externalId:"b",symbol:"RDDT",side:"buy",quantity:"1",price:"100",fees:"-1",feeCurrency:"USD",currency:"USD",tradedAt:close,timePrecision:"instant",assetType:"STK",multiplier:"1",positionEffect:"close"}]});
    expect(accountPerformance([a],[],new Map([["RDDT","120"]]),close)).toMatchObject({realizedNet:"48",unrealizedNet:"58",totalNet:"106",fees:"4",unallocatedFees:"0"});
    expect(executionAction("buy",null)).toBe("开平待核实");
  });
});
