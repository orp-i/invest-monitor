import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { normalizeNullableDecimal, type BrokerPosition, type BrokerSnapshot, type BrokerTrade } from "@invest/domain";
import { brokerReader, parseBrokerJson, parseBrokerJsonArray, type BrokerReader } from "./brokers.js";

type Row = Record<string, any>;
const money = normalizeNullableDecimal;
const requiredMoney = (value: unknown, field: string): string => {
  const result = money(value);
  if (result === null) throw new Error(`Schwab 响应缺少有效字段：${field}`);
  return result;
};
const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Schwab 响应缺少字段：${field}`);
  return value;
};
const requiredEnv = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`尚未配置 ${key}`);
  return value;
};
const arr = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];

const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const API_BASE = "https://api.schwabapi.com/trader/v1/";
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

function redirectUri(env: NodeJS.ProcessEnv): string {
  return env.SCHWAB_REDIRECT_URI?.trim() || "https://127.0.0.1";
}
function basicAuth(env: NodeJS.ProcessEnv): string {
  const appKey = requiredEnv(env, "SCHWAB_APP_KEY"), appSecret = requiredEnv(env, "SCHWAB_APP_SECRET");
  return `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`;
}
function sanitizeTokenError(error: unknown, reauthMessage: string): Error {
  const message = error instanceof Error ? error.message : "";
  if (/HTTP (400|401)\b/.test(message)) return new Error(reauthMessage);
  if (/^Schwab /.test(message)) return new Error(message); // our own validation messages are already safe
  return new Error("Schwab 令牌请求失败，请检查凭证、权限及网络出口");
}

/** Where the user's browser is sent to grant access; Schwab redirects back with `?code=...`. */
export function schwabAuthorizeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const appKey = requiredEnv(env, "SCHWAB_APP_KEY");
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ response_type: "code", client_id: appKey, redirect_uri: redirectUri(env) }).toString();
  return url.toString();
}

/** Accepts either the bare authorization code or the full URL the browser was redirected to; Schwab codes end with `@` (percent-encoded `%40`). */
export function schwabExtractCode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("请粘贴授权后跳转的地址或 code 参数");
  let url: URL | null = null;
  try { url = new URL(trimmed); } catch { url = null; }
  if (url) {
    const code = url.searchParams.get("code");
    if (!code) throw new Error("跳转地址中没有找到 code 参数");
    return code;
  }
  try { return decodeURIComponent(trimmed); } catch { return trimmed; }
}

/** One-time exchange of an authorization code for a refresh token; never logs the code, secret or response body. */
export async function schwabExchangeCode(env: NodeJS.ProcessEnv, code: string, read?: BrokerReader): Promise<{ refreshToken: string; accessToken: string; expiresIn: number; issuedAt: string; accessTokenExpiresAt: string }> {
  const auth = basicAuth(env);
  const extracted = schwabExtractCode(code);
  const owned = read ? undefined : brokerReader(env);
  const doRead = read ?? owned!.read;
  const headers = { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams({ grant_type: "authorization_code", code: extracted, redirect_uri: redirectUri(env) }).toString();
  try {
    const now = new Date();
    const payload = parseBrokerJson(await doRead(new URL(TOKEN_URL), headers, { method: "POST", body }));
    const refreshToken = requiredText(payload.refresh_token, "refresh_token");
    const accessToken = requiredText(payload.access_token, "access_token");
    const expiresIn = Number(payload.expires_in ?? "0");
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("Schwab 响应缺少有效字段：expires_in");
    return { refreshToken, accessToken, expiresIn, issuedAt: now.toISOString(), accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString() };
  } catch (error) {
    throw sanitizeTokenError(error, "Schwab 授权码交换失败（凭证或授权码可能已失效），请重新发起授权");
  } finally { await owned?.close(); }
}

// Access tokens live roughly 30 minutes; cache by a hash of the refresh token so repeated syncs within the
// window skip the refresh-grant call entirely. Never key or log the raw refresh token.
const tokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();
export function resetSchwabTokenCache(): void { tokenCache.clear(); }

export async function schwabAccessToken(env: NodeJS.ProcessEnv, read: BrokerReader, now: number = Date.now()): Promise<string> {
  const refreshToken = requiredEnv(env, "SCHWAB_REFRESH_TOKEN");
  const auth = basicAuth(env);
  const cacheKey = createHash("sha256").update(refreshToken).digest("hex");
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) return cached.accessToken;
  const headers = { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString();
  let payload: Row;
  try { payload = parseBrokerJson(await read(new URL(TOKEN_URL), headers, { method: "POST", body })); }
  catch (error) { throw sanitizeTokenError(error, "Schwab 刷新令牌已失效，需要重新授权"); }
  const accessToken = requiredText(payload.access_token, "access_token");
  const expiresIn = Number(payload.expires_in ?? "0");
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("Schwab 响应缺少有效字段：expires_in");
  tokenCache.set(cacheKey, { accessToken, expiresAtMs: now + (expiresIn - 60) * 1000 });
  return accessToken;
}

function schwabAssetType(raw: unknown): string {
  const value = String(raw ?? "unknown");
  return value === "EQUITY" ? "STK" : value === "OPTION" ? "OPT" : value;
}
/** Multiplier is only ever a broker-reported value: 1 for shares/funds, the option's own multiplier when Schwab reports one, otherwise unknown (never guessed). */
function schwabMultiplier(rawAssetType: string, optionMultiplier: unknown): string | null {
  if (rawAssetType === "OPTION") return money(optionMultiplier);
  if (rawAssetType === "EQUITY" || rawAssetType === "COLLECTIVE_INVESTMENT") return "1";
  return null;
}

export async function syncSchwab(env: NodeJS.ProcessEnv, read: BrokerReader, now: number = Date.now()): Promise<BrokerSnapshot[]> {
  const accessToken = await schwabAccessToken(env, read, now);
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const get = async (path: string) => parseBrokerJson(await read(new URL(path, API_BASE), headers));
  const getArray = async (path: string) => parseBrokerJsonArray(await read(new URL(path, API_BASE), headers));
  const numbers = await getArray("accounts/accountNumbers");
  if (!numbers.length) throw new Error("Schwab 未返回可读取的账户，已保留上次同步记录");
  const nowIso = new Date(now).toISOString();
  const endDate = nowIso, startDate = new Date(now - SIXTY_DAYS_MS).toISOString();
  const snapshots: BrokerSnapshot[] = [];
  for (const entry of numbers) {
    const hashValue = requiredText(entry.hashValue, "hashValue");
    const detail = await get(`accounts/${encodeURIComponent(hashValue)}?fields=positions`);
    const account = detail.securitiesAccount;
    if (!account || typeof account !== "object") throw new Error("Schwab 账户详情响应不完整");
    const accountId = requiredText(account.accountNumber, "securitiesAccount.accountNumber");
    const balances = account.currentBalances ?? {};
    const positions: BrokerPosition[] = arr(account.positions).flatMap(row => {
      const long = money(row.longQuantity) ?? "0", short = money(row.shortQuantity) ?? "0";
      const quantity = new Decimal(long).minus(short);
      if (quantity.isZero()) return [];
      const instrument = row.instrument ?? {};
      const rawAssetType = String(instrument.assetType ?? "unknown");
      const multiplier = schwabMultiplier(rawAssetType, instrument.optionMultiplier);
      const averageCost = money(row.averagePrice);
      const costBasis = multiplier !== null && averageCost !== null ? new Decimal(averageCost).times(quantity).times(multiplier).toFixed() : null;
      const unrealizedPnl = new Decimal(money(row.longOpenProfitLoss) ?? "0").plus(money(row.shortOpenProfitLoss) ?? "0").toFixed();
      return [{
        id: `${accountId}:${requiredText(instrument.symbol, "instrument.symbol")}`, symbol: requiredText(instrument.symbol, "instrument.symbol"),
        quantity: quantity.toFixed(), currency: "USD", costBasis, marketValue: money(row.marketValue), unrealizedPnl,
        assetType: schwabAssetType(rawAssetType), multiplier, averageCost,
      }];
    });
    const query = new URLSearchParams({ startDate, endDate, types: "TRADE" }).toString();
    const transactions = await getArray(`accounts/${encodeURIComponent(hashValue)}/transactions?${query}`);
    const trades: BrokerTrade[] = [];
    for (const tx of transactions) {
      if (String(tx.type ?? "") !== "TRADE") continue;
      const activityId = requiredText(tx.activityId, "activityId");
      const time = requiredText(tx.time, "time");
      if (!Number.isFinite(Date.parse(time))) throw new Error("Schwab 成交时间无效");
      const items = arr(tx.transferItems);
      const legItems = items.filter(item => !item.feeType);
      const feeItems = items.filter(item => item.feeType);
      if (!legItems.length) continue;
      const totalFees = feeItems.reduce((sum, item) => sum.plus(money(item.cost) ?? "0"), new Decimal(0)).abs();
      const perLegFee = legItems.length > 1 ? totalFees.div(legItems.length) : totalFees;
      legItems.forEach((item, index) => {
        const instrument = item.instrument ?? {};
        const rawAssetType = String(instrument.assetType ?? "unknown");
        const amount = requiredMoney(item.amount, "amount");
        trades.push({
          id: `schwab:live:${accountId}:${activityId}:${index + 1}`, externalId: activityId,
          symbol: requiredText(instrument.symbol, "instrument.symbol"), side: new Decimal(amount).isNeg() ? "sell" : "buy",
          quantity: new Decimal(amount).abs().toFixed(), price: money(item.price), fees: perLegFee.toFixed(),
          ...(legItems.length === 1 ? { netCash: money(tx.netAmount) } : {}),
          currency: "USD", tradedAt: new Date(time).toISOString(), timePrecision: "instant",
          assetType: schwabAssetType(rawAssetType), multiplier: schwabMultiplier(rawAssetType, instrument.optionMultiplier),
          positionEffect: item.positionEffect === "OPENING" ? "open" : item.positionEffect === "CLOSING" ? "close" : null,
        });
      });
    }
    snapshots.push({
      broker: "schwab", accountId, environment: "live", syncedAt: nowIso, asOf: nowIso, currency: "USD",
      equity: money(balances.liquidationValue), cash: money(balances.cashBalance),
      unrealizedPnl: positions.length ? positions.reduce((sum, p) => p.unrealizedPnl !== null ? sum.plus(p.unrealizedPnl) : sum, new Decimal(0)).toFixed() : null,
      sessionRealizedPnl: null, positions, trades,
      notes: [
        "成交仅覆盖最近 60 天（Schwab 成交历史查询窗口）；更早成交需要更长区间或历史结单补充。",
        "OAuth 刷新令牌有效期 7 天，到期后需要在设置页重新授权。",
        "单腿成交的费用全部计入该笔成交；多腿成交的费用按腿数平均分摊，仅为估算，不代表交易所实际分配。",
      ],
    });
  }
  return snapshots;
}
