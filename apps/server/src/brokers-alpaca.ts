import { Decimal } from "decimal.js";
import { normalizeNullableDecimal, type BrokerPosition, type BrokerSnapshot, type BrokerTrade } from "@invest/domain";
import { parseBrokerJson, parseBrokerJsonArray, type BrokerReader } from "./brokers.js";

type Row = Record<string, any>;
const money = normalizeNullableDecimal;
const requiredMoney = (value: unknown, field: string): string => {
  const result = money(value);
  if (result === null) throw new Error(`Alpaca 响应缺少有效字段：${field}`);
  return result;
};
const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Alpaca 响应缺少字段：${field}`);
  return value;
};
const requiredEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`尚未配置 ${key}`);
  return value;
};

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
// Fills carry only a symbol, not an asset class; an OCC-shaped root+date+C/P+strike marks it an option.
const OCC_OPTION = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

function alpacaBase(env: NodeJS.ProcessEnv): { base: string; paper: boolean } {
  const paper = env.ALPACA_ENVIRONMENT === "paper";
  return { base: paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets", paper };
}
function alpacaAssetType(assetClass: unknown): string {
  const value = String(assetClass ?? "unknown");
  return value === "us_equity" ? "STK" : value === "us_option" ? "OPT" : value === "crypto" ? "CRYPTO" : value;
}

export async function syncAlpaca(env: NodeJS.ProcessEnv, read: BrokerReader, now: number = Date.now()): Promise<BrokerSnapshot[]> {
  const { base, paper } = alpacaBase(env);
  const keyId = requiredEnv(env, "ALPACA_API_KEY_ID"), secretKey = requiredEnv(env, "ALPACA_API_SECRET_KEY");
  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey, Accept: "application/json" };
  const get = async (path: string) => parseBrokerJson(await read(new URL(path, base), headers));
  const getArray = async (path: string) => parseBrokerJsonArray(await read(new URL(path, base), headers));

  const account = await get("/v2/account");
  const currency = requiredText(account.currency, "currency");
  if (currency !== "USD") throw new Error("Alpaca 账户币种不是 USD，暂不支持");
  const accountId = requiredText(account.account_number, "account_number");
  const status = requiredText(account.status, "status");

  let optionNoted = false;
  const positions: BrokerPosition[] = (await getArray("/v2/positions")).map(row => {
    const assetClass = String(row.asset_class ?? "unknown");
    const magnitude = new Decimal(requiredMoney(row.qty, "qty")).abs();
    const side = String(row.side ?? "long");
    const quantity = side === "short" ? magnitude.negated() : magnitude;
    const multiplier = assetClass === "us_option" ? "100" : null;
    if (assetClass === "us_option") optionNoted = true;
    return {
      id: `${accountId}:${requiredText(row.symbol, "symbol")}`, symbol: requiredText(row.symbol, "symbol"),
      quantity: quantity.toFixed(), currency: "USD",
      costBasis: money(row.cost_basis), marketValue: money(row.market_value), unrealizedPnl: money(row.unrealized_pl),
      assetType: alpacaAssetType(assetClass), multiplier, averageCost: money(row.avg_entry_price), markPrice: money(row.current_price),
    };
  });

  // Alpaca's activities pagination is cursor-based: pass the last-seen activity id back as page_token.
  const trades: BrokerTrade[] = [];
  const after = new Date(now - NINETY_DAYS_MS).toISOString();
  let pageToken: string | null = null;
  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ after, direction: "asc", page_size: "100" });
    if (pageToken) params.set("page_token", pageToken);
    const batch = await getArray(`/v2/account/activities/FILL?${params.toString()}`);
    for (const row of batch) {
      const symbol = requiredText(row.symbol, "symbol");
      const rawSide = String(row.side ?? "");
      const side: "buy" | "sell" = rawSide === "buy" ? "buy" : rawSide === "sell" || rawSide === "sell_short" ? "sell" : (() => { throw new Error("Alpaca 成交方向无效"); })();
      const isOption = OCC_OPTION.test(symbol.replace(/\s+/g, "").toUpperCase());
      trades.push({
        id: `alpaca:${paper ? "sandbox" : "live"}:${accountId}:${requiredText(row.id, "id")}`,
        externalId: row.order_id != null ? String(row.order_id) : null,
        symbol, side, quantity: requiredMoney(row.qty, "qty"), price: money(row.price), fees: null,
        currency: "USD", tradedAt: requiredText(row.transaction_time, "transaction_time"), timePrecision: "instant",
        assetType: isOption ? "OPT" : "STK", multiplier: isOption ? "100" : undefined,
      });
    }
    if (batch.length < 100) break;
    pageToken = requiredText(batch.at(-1)!.id, "id");
    if (page === 20) throw new Error("Alpaca 成交回报超过本次同步上限（20 页），未保存不完整快照");
  }

  const nowIso = new Date(now).toISOString();
  const unrealizedPnl = positions.length ? positions.reduce((sum, p) => p.unrealizedPnl !== null ? sum.plus(p.unrealizedPnl) : sum, new Decimal(0)).toFixed() : null;
  return [{
    broker: "alpaca", accountId, environment: paper ? "sandbox" : "live", syncedAt: nowIso, asOf: nowIso,
    currency: "USD", equity: money(account.equity), cash: money(account.cash), unrealizedPnl, sessionRealizedPnl: null,
    positions, trades,
    notes: [
      `账户状态 ${status}；成交回报仅覆盖最近 90 天（activities/FILL 接口窗口），更早成交需要更长区间或历史记录补充。`,
      "Alpaca 按 FILL 活动记录成交；监管等费用在独立活动记录中报告，本次同步未计入 fees 字段。",
      ...(optionNoted ? ["期权持仓统一按标准 100 股/合约乘数计算，未逐笔核实合约条款。"] : []),
    ],
  }];
}
