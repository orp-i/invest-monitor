import { useEffect, useState } from "react";
import { tradierSymbol, type BrokerSnapshot, type MarketQuotesResponse, type MarketQuote } from "@invest/domain";
import { getJson } from "./api";
import { formatMoney, formatTimestamp } from "./format";

export function useTradierQuotes(accounts: BrokerSnapshot[]) {
  const symbols = [...new Set(accounts.flatMap(a => a.positions.filter(p => p.currency === "USD" && ["STK", "OPT", "stock", "etf", "option", "equity"].includes(p.assetType ?? "")).map(p => tradierSymbol(p.symbol))))].filter(s => /^[A-Z][A-Z0-9/.-]{0,19}$/.test(s) || /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/.test(s)).sort().join(",");
  const [result, setResult] = useState<{ key: string; quotes: Map<string, MarketQuote>; environment: string; receivedAt: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!symbols) { setResult(null); setError(""); return; }
    let alive = true, running = false;
    const refresh = async () => {
      if (running) return; running = true;
      try {
        const all = symbols.split(","), values: MarketQuotesResponse[] = [];
        // Keep broker/account IDs, quantities and costs out of market requests.
        for (let i = 0; i < all.length; i += 50) values.push(await getJson<MarketQuotesResponse>(`/api/market/quotes?symbols=${encodeURIComponent(all.slice(i, i + 50).join(","))}`));
        if (alive) { setResult({ key: symbols, quotes: new Map(values.flatMap(v => v.quotes.map(q => [q.symbol, q] as const))), environment: values[0].environment, receivedAt: values[0].receivedAt }); setError(""); }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : "Tradier 行情读取失败"); }
      finally { running = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [symbols]);
  return { quotes: result?.key === symbols ? result.quotes : new Map<string, MarketQuote>(), error, environment: result?.environment, receivedAt: result?.receivedAt };
}

export function TradierPositionPrice({ quote }: { quote: MarketQuote | undefined }) {
  return <><strong>{formatMoney(quote?.last ?? null, 4)}</strong><span>{quote?.tradeAt ? formatTimestamp(quote.tradeAt) : "暂无成交报价"}</span>{quote && <span>买 / 卖 {formatMoney(quote.bid, 4)} / {formatMoney(quote.ask, 4)}</span>}</>;
}
