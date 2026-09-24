import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { fetch, ProxyAgent } from "undici";
import { Decimal } from "decimal.js";
import { BROKER_PROVIDERS, BrokerSnapshotSchema, normalizeNullableDecimal, type BrokerApiId, type BrokerConnectionStatus, type BrokerOrderObservation, type BrokerSnapshot, type BrokerTrade, type SettingsTestResult } from "@invest/domain";
import { schwabAccessToken, syncSchwab } from "./brokers-schwab.js";
import { syncAlpaca } from "./brokers-alpaca.js";

type Row = Record<string, any>;
export type BrokerReader = (url: URL, headers: Record<string, string>, init?: { method?: "GET" | "POST"; body?: string }) => Promise<string>;
const list = (value: unknown): Row[] => value == null || value === "null" || value === "" ? [] : (Array.isArray(value) ? value : [value]).map(item => {
  if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("券商响应结构无效");
  return item as Row;
});
const money = normalizeNullableDecimal;
const requiredMoney = (value: unknown, field: string): string => {
  const result = money(value);
  if (result === null) throw new Error(`券商报告缺少有效字段：${field}`);
  return result;
};
const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`券商报告缺少字段：${field}`);
  return value;
};

/** Schwab refresh tokens are valid for 7 days from issue; the page needs a countdown so re-authorization happens before sync starts failing. */
function schwabAuthorization(env: NodeJS.ProcessEnv, now: number): NonNullable<BrokerConnectionStatus["authorization"]> {
  const hasRefreshToken = !!env.SCHWAB_REFRESH_TOKEN?.trim();
  const issuedRaw = env.SCHWAB_REFRESH_TOKEN_ISSUED_AT?.trim() || null;
  const issuedMs = issuedRaw ? Date.parse(issuedRaw) : NaN;
  const validIssued = issuedRaw !== null && Number.isFinite(issuedMs);
  const issuedAt = validIssued ? new Date(issuedMs).toISOString() : null;
  const expiresMs = validIssued ? issuedMs + 7 * 24 * 60 * 60 * 1000 : null;
  const expiresAt = expiresMs !== null ? new Date(expiresMs).toISOString() : null;
  const daysLeft = expiresMs !== null ? Math.floor((expiresMs - now) / (24 * 60 * 60 * 1000)) : null;
  const expired = expiresMs !== null && now >= expiresMs;
  const needsReauthorization = !hasRefreshToken || !validIssued || expired;
  const message = !hasRefreshToken ? "尚未完成 OAuth 授权，请在设置页完成授权。"
    : !validIssued ? "刷新令牌签发时间缺失或无效，请重新授权。"
    : expired ? "刷新令牌已过期（7 天有效期），请重新授权。"
    : null;
  return { kind: "oauth", issuedAt, expiresAt, daysLeft, needsReauthorization, message };
}

export function brokerConnections(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): BrokerConnectionStatus[] {
  return BROKER_PROVIDERS.map(provider => {
    const missing = provider.envKeys.filter(key => !env[key]?.trim());
    const mode = provider.id === "tradier" ? (env.TRADIER_ENVIRONMENT === "sandbox" ? "sandbox" : "live")
      : provider.id === "ibkr" ? "Flex 报表"
      : provider.id === "alpaca" ? (env.ALPACA_ENVIRONMENT === "paper" ? "paper" : "live")
      : "live"; // schwab: production API only, no sandbox
    return {
      id: provider.id, name: provider.name, configured: missing.length === 0, missing, mode,
      cadenceMinutes: provider.cadenceMinutes, description: provider.description, docsUrl: provider.docsUrl,
      ...(provider.id === "schwab" ? { authorization: schwabAuthorization(env, now) } : {}),
    };
  }) as BrokerConnectionStatus[];
}

export function parseBrokerJson(text: string): Row {
  // Node 24 provides the original JSON token, before IEEE-754 rounding.
  let value: unknown;
  try { value = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!context?.source) throw new Error("券商金额解析需要 Node.js 24 的无损 JSON 支持");
    return context.source;
  }); } catch { throw new Error("券商 JSON 响应无效或当前 Node.js 不支持无损金额解析"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("券商 JSON 响应无效");
  return value as Row;
}

/** Schwab's accountNumbers/transactions and Alpaca's positions/activities endpoints return a top-level array. */
export function parseBrokerJsonArray(text: string): Row[] {
  let value: unknown;
  try { value = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!context?.source) throw new Error("券商金额解析需要 Node.js 24 的无损 JSON 支持");
    return context.source;
  }); } catch { throw new Error("券商 JSON 响应无效或当前 Node.js 不支持无损金额解析"); }
  if (!Array.isArray(value)) throw new Error("券商 JSON 响应无效");
  return value as Row[];
}

/** Order observations flow in (`known`, from earlier sessions) and out (`observed`, this session) without touching the snapshot contract. */
export interface OrderEvidence { known: readonly BrokerOrderObservation[]; observed: BrokerOrderObservation[] }

/** Shared fetch/proxy/timeout/sanitization for every provider; probes and the Schwab OAuth exchange reuse it when no test reader is supplied. */
export function brokerReader(env: NodeJS.ProcessEnv = process.env): { read: BrokerReader; close(): Promise<void> } {
  const proxy = env.BROKER_EGRESS_PROXY_URL ? new ProxyAgent(env.BROKER_EGRESS_PROXY_URL) : undefined;
  const read: BrokerReader = async (url, headers, init) => {
    try {
      const response = await fetch(url, { method: init?.method ?? "GET", headers, body: init?.body, redirect: "error", signal: AbortSignal.timeout(20_000), dispatcher: proxy });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      let body = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body ?? []) {
        body += decoder.decode(chunk, { stream: true });
        if (body.length > 20_000_000) throw new Error("报告过大");
      }
      return body + decoder.decode();
    } catch (error) {
      // IBKR mandates a token in the query and Schwab a secret in the POST body. Never surface the URL,
      // headers, request/response body, or nested network error in logs or API responses.
      const status = error instanceof Error && /^HTTP \d+$/.test(error.message) ? `（${error.message}）` : "";
      throw new Error(`券商读取失败${status}，请检查凭证、权限及网络出口`);
    }
  };
  return { read, close: async () => { await proxy?.close(); } };
}

export async function syncBroker(broker: BrokerApiId, env: NodeJS.ProcessEnv = process.env, reader?: BrokerReader, orders?: OrderEvidence): Promise<BrokerSnapshot[]> {
  const connection = brokerConnections(env).find(row => row.id === broker)!;
  if (!connection.configured) throw new Error(`尚未配置 ${connection.missing.join("、")}`);
  const owned = reader ? undefined : brokerReader(env);
  const read: BrokerReader = reader ?? owned!.read;
  try {
    const snapshots = broker === "tradier" ? await syncTradier(env, read, orders)
      : broker === "ibkr" ? await syncIbkr(env, read)
      : broker === "schwab" ? await syncSchwab(env, read)
      : await syncAlpaca(env, read);
    return snapshots.map(snapshot => BrokerSnapshotSchema.parse(snapshot));
  } finally { await owned?.close(); }
}

/** One minimal read-only call per provider for the settings page's "test connection" button; never throws. */
export async function probeBroker(broker: BrokerApiId, env: NodeJS.ProcessEnv = process.env, reader?: BrokerReader): Promise<SettingsTestResult> {
  const connection = brokerConnections(env).find(row => row.id === broker)!;
  if (!connection.configured) return { ok: false, message: `缺少 ${connection.missing.join("、")}，请先完成配置。` };
  const owned = reader ? undefined : brokerReader(env);
  const read: BrokerReader = reader ?? owned!.read;
  try {
    if (broker === "tradier") return await probeTradier(env, read);
    if (broker === "ibkr") return await probeIbkr(env, read);
    if (broker === "schwab") return await probeSchwab(env, read);
    return await probeAlpaca(env, read);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "连接测试失败，请检查凭证、权限及网络出口" };
  } finally { await owned?.close(); }
}

async function probeTradier(env: NodeJS.ProcessEnv, read: BrokerReader): Promise<SettingsTestResult> {
  const sandbox = env.TRADIER_ENVIRONMENT === "sandbox";
  const base = sandbox ? "https://sandbox.tradier.com/v1/" : "https://api.tradier.com/v1/";
  const headers = { Authorization: `Bearer ${env.TRADIER_ACCESS_TOKEN}`, Accept: "application/json" };
  const profile = parseBrokerJson(await read(new URL("user/profile", base), headers));
  if (!profile.profile || !("account" in profile.profile)) throw new Error("Tradier 账户资料响应不完整");
  const accounts = list(profile.profile.account);
  return { ok: true, message: `连接成功，读取到 ${accounts.length} 个账户（${sandbox ? "模拟 sandbox" : "实盘 live"}）。`, details: { accounts: accounts.length, environment: sandbox ? "sandbox" : "live" } };
}

async function probeIbkr(env: NodeJS.ProcessEnv, read: BrokerReader): Promise<SettingsTestResult> {
  const base = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/";
  const headers = { "User-Agent": "Node/24", Accept: "application/xml" };
  const request = new URL("SendRequest", base);
  request.search = new URLSearchParams({ t: env.IBKR_FLEX_TOKEN!, q: env.IBKR_FLEX_QUERY_ID!, v: "3" }).toString();
  const sent = xml(await read(request, headers)).FlexStatementResponse;
  if (sent?.Status !== "Success" || !/^\d+$/.test(String(sent?.ReferenceCode ?? ""))) throw new Error("IBKR 未返回成功状态，请检查 Flex token、Query ID 与报表权限");
  return { ok: true, message: "连接成功；该请求（SendRequest）会触发 IBKR 生成一份新报表，本次测试不读取持仓或成交数据。", details: { referenceCode: String(sent.ReferenceCode) } };
}

async function probeSchwab(env: NodeJS.ProcessEnv, read: BrokerReader): Promise<SettingsTestResult> {
  const accessToken = await schwabAccessToken(env, read);
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const numbers = parseBrokerJsonArray(await read(new URL("accounts/accountNumbers", "https://api.schwabapi.com/trader/v1/"), headers));
  return { ok: true, message: `连接成功，读取到 ${numbers.length} 个账户；刷新令牌 7 天内有效。`, details: { accounts: numbers.length } };
}

async function probeAlpaca(env: NodeJS.ProcessEnv, read: BrokerReader): Promise<SettingsTestResult> {
  const paper = env.ALPACA_ENVIRONMENT === "paper";
  const base = paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
  const headers = { "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID!, "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY!, Accept: "application/json" };
  const account = parseBrokerJson(await read(new URL("/v2/account", base), headers));
  if (!("status" in account) || !("currency" in account) || !("equity" in account)) throw new Error("Alpaca 账户响应不完整");
  return { ok: true, message: `连接成功，账户状态 ${account.status}，货币 ${account.currency}（${paper ? "paper" : "live"}）。`, details: { status: String(account.status), currency: String(account.currency), environment: paper ? "paper" : "live" } };
}

async function syncTradier(env: NodeJS.ProcessEnv, read: BrokerReader, orders?: OrderEvidence): Promise<BrokerSnapshot[]> {
  if (env.TRADIER_ENVIRONMENT && !["live", "sandbox"].includes(env.TRADIER_ENVIRONMENT)) throw new Error("TRADIER_ENVIRONMENT 必须为 live 或 sandbox");
  const sandbox = env.TRADIER_ENVIRONMENT === "sandbox";
  const base = sandbox ? "https://sandbox.tradier.com/v1/" : "https://api.tradier.com/v1/";
  const headers = { Authorization: `Bearer ${env.TRADIER_ACCESS_TOKEN}`, Accept: "application/json" };
  const get = async (path: string) => parseBrokerJson(await read(new URL(path, base), headers));
  const profile = await get("user/profile");
  if (!profile.profile || !("account" in profile.profile)) throw new Error("Tradier 账户资料响应不完整");
  const accounts = list(profile.profile.account);
  if (!accounts.length) throw new Error("Tradier 未返回可读取的账户，已保留上次同步记录");
  const snapshots: BrokerSnapshot[] = [];
  for (const account of accounts) {
    const id = requiredText(account.account_number, "account_number");
    const path = `accounts/${encodeURIComponent(id)}`;
    const [positions, balance] = await Promise.all([get(`${path}/positions`), get(`${path}/balances`)]);
    if (!("positions" in positions) || !balance.balances) throw new Error("Tradier 持仓或余额响应不完整，未覆盖已有记录");
    const events: Row[] = [];
    if (!sandbox) {
      for (let page = 1; page <= 20; page++) {
        const history = await get(`${path}/history?type=trade&limit=1000&page=${page}`);
        if (!("history" in history)) throw new Error("Tradier 成交历史响应不完整");
        const batch = list(history.history?.event);
        events.push(...batch);
        if (batch.length < 1000) break;
        if (page === 20) throw new Error("成交历史超过本次同步上限，未保存不完整快照");
      }
    }
    // Supplementary evidence. Neither call may block positions/trades: failures only add a note.
    const evidenceNotes: string[] = [];
    let lots: TradierLot[] = [];
    if (!sandbox) {
      try {
        for (let page = 1; page <= 20; page++) {
          const gainloss = await get(`${path}/gainloss?limit=1000&page=${page}&sortBy=closeDate&sort=desc`);
          if (!("gainloss" in gainloss)) throw new Error("响应不完整");
          const batch = list(gainloss.gainloss?.closed_position);
          lots.push(...batch.map(row => ({ symbol: requiredText(row.symbol, "symbol"), quantity: requiredMoney(row.quantity, "quantity"), openDate: requiredText(row.open_date, "open_date").slice(0, 10), closeDate: requiredText(row.close_date, "close_date").slice(0, 10), cost: money(row.cost), proceeds: money(row.proceeds) })));
          if (batch.length < 1000) break;
          if (page === 20) { lots = []; throw new Error("超过读取上限"); }
        }
      } catch (error) { lots = []; evidenceNotes.push(`本次未取得已平仓批次${error instanceof Error && !/HTTP|读取失败/.test(error.message) ? `（${error.message}）` : ""}，开平仓标记沿用已有记录。`); }
    }
    const sessionOrders: BrokerOrderObservation[] = [];
    try {
      const response = await get(`${path}/orders?includeTags=true`);
      sessionOrders.push(...tradierOrderObservations(list(response.orders?.order), id, sandbox ? "sandbox" : "live", new Date().toISOString()));
    } catch { evidenceNotes.push("本次未读取当日订单，秒级成交时间与腿分组沿用已有记录。"); }
    if (orders) orders.observed.push(...sessionOrders);
    const occurrences = new Map<string, number>();
    const trades: BrokerTrade[] = annotateTradierTrades(events.filter(event => event.type === "trade").map(event => {
      const trade = event.trade;
      if (!trade) throw new Error("Tradier 成交记录缺少 trade 字段");
      const quantity = requiredMoney(trade.quantity, "quantity");
      if (quantity === "0") throw new Error("Tradier 成交数量为零");
      const symbol = requiredText(trade.symbol, "symbol");
      const price = requiredMoney(trade.price, "price");
      const fees = money(trade.commission);
      const date = requiredText(event.date, "date").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error("Tradier 成交日期无效");
      const fingerprint = createHash("sha256").update(JSON.stringify([id, date, symbol, quantity, price, fees, money(event.amount), trade.trade_type])).digest("hex");
      const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
      occurrences.set(fingerprint, occurrence);
      return { id: `tradier:${sandbox ? "sandbox" : "live"}:${id}:${fingerprint}:${occurrence}`, externalId: null, symbol, side: quantity.startsWith("-") ? "sell" : "buy", quantity: quantity.replace(/^-/, ""), price, fees, netCash: money(event.amount), currency: "USD", tradedAt: date, timePrecision: "day", assetType: String(trade.trade_type ?? "unknown") } as BrokerTrade;
    }), lots, [...(orders?.known ?? []), ...sessionOrders].filter(o => o.environment === (sandbox ? "sandbox" : "live") && o.accountId === id));
    const now = new Date().toISOString();
    snapshots.push({ broker: "tradier", accountId: id, environment: sandbox ? "sandbox" : "live", syncedAt: now, asOf: now,
      currency: "USD", equity: money(balance.balances.total_equity), cash: money(balance.balances.total_cash), unrealizedPnl: money(balance.balances.open_pl), sessionRealizedPnl: money(balance.balances.close_pl),
      allocation: [["股票多头", balance.balances.stock_long_value], ["股票空头", balance.balances.margin?.stock_short_value ?? balance.balances.pdt?.stock_short_value], ["期权多头", balance.balances.option_long_value], ["期权空头", balance.balances.option_short_value], ["现金", balance.balances.total_cash]].flatMap(([assetType, value]) => money(value) === null ? [] : [{ assetType: String(assetType), value: money(value)! }]),
      positions: list(positions.positions?.position).map(row => ({ id: requiredText(row.id, "position.id"), symbol: requiredText(row.symbol, "symbol"), quantity: requiredMoney(row.quantity, "quantity"), currency: "USD", costBasis: money(row.cost_basis), marketValue: money(row.market_value), unrealizedPnl: money(row.open_pl), assetType: String(row.asset_type ?? (/\d{6}[CP]\d{8}$/.test(row.symbol) ? "OPT" : "STK")) })),
      trades,
      notes: [sandbox ? "模拟账户不提供成交历史接口；持仓和余额来自模拟环境。" : "成交历史由券商每夜更新，只有日期；开平仓与批次配对取自券商已平仓批次，秒级时间与腿分组取自当日观察到的订单，未观察到的订单不补造。", ...evidenceNotes, "当前持仓盈亏、当日已平仓盈亏直接采用券商余额口径；不代表累计收益。", "成交以内容及同批出现次数去重；同内容交易会保留。券商历史更正需另行核对。"],
    });
  }
  return snapshots;
}

const xml = (body: string): Row => {
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) throw new Error("IBKR XML 报告无效");
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, parseAttributeValue: false, processEntities: false }).parse(body) as Row;
};

async function syncIbkr(env: NodeJS.ProcessEnv, read: BrokerReader): Promise<BrokerSnapshot[]> {
  const base = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/";
  const headers = { "User-Agent": "Node/24", Accept: "application/xml" };
  const request = new URL("SendRequest", base);
  request.search = new URLSearchParams({ t: env.IBKR_FLEX_TOKEN!, q: env.IBKR_FLEX_QUERY_ID!, v: "3" }).toString();
  const sent = xml(await read(request, headers)).FlexStatementResponse;
  if (sent?.Status !== "Success" || !/^\d+$/.test(String(sent?.ReferenceCode ?? ""))) throw new Error("IBKR 报告请求未成功，请检查 Flex token、Query ID 与报表权限");
  // Keep the origin fixed; a response-supplied URL cannot redirect the token.
  const get = new URL("GetStatement", base);
  get.search = new URLSearchParams({ t: env.IBKR_FLEX_TOKEN!, q: sent.ReferenceCode, v: "3" }).toString();
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = await read(get, headers);
    if (!body.trimStart().startsWith("<") && /^[^\n]*,[^\n]*,/m.test(body)) throw new Error("IBKR Flex 查询返回 CSV；请将该查询的输出格式改为 XML，并包含 Open Positions（SUMMARY）和 Trades（EXECUTION），再同步");
    const parsed = xml(body);
    if (parsed.FlexQueryResponse) return parseIbkrStatement(body);
    if (String(parsed.FlexStatementResponse?.ErrorCode) !== "1019") throw new Error("IBKR 报表读取失败，请检查报告配置和访问权限");
    if (attempt < 5) await delay(2000);
  }
  throw new Error("IBKR 仍在生成报表，请稍后再次同步");
}

export function parseIbkrStatement(body: string): BrokerSnapshot[] {
  const statements = list(xml(body).FlexQueryResponse?.FlexStatements?.FlexStatement);
  if (!statements.length) throw new Error("IBKR 报告中没有账户报表");
  const missing = new Set<string>();
  const hasText = (row: Row, field: string) => typeof row[field] === "string" && row[field].trim().length > 0;
  for (const statement of statements) {
    for (const row of list(statement.OpenPositions?.OpenPosition).filter(r => !r.levelOfDetail || r.levelOfDetail === "SUMMARY")) {
      for (const [field, label] of [["conid", "Conid（合约编号）"], ["symbol", "Symbol（代码）"], ["currency", "Currency（币种）"], ["position", "Position（持仓数量）"]]) {
        if (!hasText(row, field!)) missing.add(`Open Positions → ${label}`);
      }
    }
    for (const row of list(statement.Trades?.Trade).filter(r => !r.levelOfDetail || r.levelOfDetail === "EXECUTION")) {
      for (const [field, label] of [["tradeID", "Trade ID（成交编号）"], ["symbol", "Symbol（代码）"], ["currency", "Currency（币种）"], ["buySell", "Buy/Sell（方向）"], ["quantity", "Quantity（数量）"]]) {
        if (!hasText(row, field!)) missing.add(`Trades → ${label}`);
      }
      if (!hasText(row, "dateTime") && !hasText(row, "tradeDate")) missing.add("Trades → Date/Time（成交日期时间）");
    }
  }
  if (missing.size) throw new Error(`IBKR 报告缺少字段：${[...missing].join("；")}。请在 Activity Flex Query 对应栏目勾选这些字段并保存后重试`);
  return statements.map(statement => {
    const id = requiredText(statement.accountId, "accountId");
    if (!("OpenPositions" in statement) || !("Trades" in statement)) throw new Error("Flex 查询必须包含 Open Positions 和 Trades，并选择汇总持仓与逐笔成交字段");
    const positions = list(statement.OpenPositions?.OpenPosition).filter(row => !row.levelOfDetail || row.levelOfDetail === "SUMMARY");
    const trades = list(statement.Trades?.Trade).filter(row => !row.levelOfDetail || row.levelOfDetail === "EXECUTION");
    if (list(statement.OpenPositions?.OpenPosition).length && !positions.length) throw new Error("Flex 持仓需要 SUMMARY 汇总层级");
    if (list(statement.Trades?.Trade).length && !trades.length) throw new Error("Flex 成交需要 EXECUTION 逐笔层级");
    const now = new Date().toISOString();
    const information = list(statement.AccountInformation?.AccountInformation ?? statement.AccountInformation)[0];
    const baseCurrency = typeof information?.currency === "string" && /^[A-Z]{3}$/.test(information.currency) ? information.currency : typeof information?.baseCurrency === "string" && /^[A-Z]{3}$/.test(information.baseCurrency) ? information.baseCurrency : null;
    const nav = list(statement.EquitySummaryInBase?.EquitySummaryByReportDateInBase)
      .filter(row => row.reportDate === statement.toDate && !row.model && money(row.total) !== null).at(-1);
    return { broker: "ibkr", accountId: id, environment: "statement", syncedAt: now,
      asOf: requiredText(statement.toDate, "toDate"), reportFrom: typeof statement.fromDate === "string" ? statement.fromDate : null, currency: baseCurrency, equity: baseCurrency ? money(nav?.total) : null, cash: baseCurrency ? money(nav?.cash) : null, unrealizedPnl: null, sessionRealizedPnl: null,
      allocation: nav && baseCurrency ? [["现金", "cash"], ["股票", "stock"], ["期权", "options"], ["债券", "bonds"], ["商品", "commodities"], ["基金", "funds"], ["票据", "notes"], ["应计利息", "interestAccruals"], ["应计股息", "dividendAccruals"]].flatMap(([assetType, field]) => money(nav[field!]) === null ? [] : [{ assetType: assetType!, value: money(nav[field!])! }]) : [],
      positions: positions.map(row => ({ id: `${id}:${requiredText(row.conid, "conid")}:${requiredText(row.currency, "currency")}`, symbol: requiredText(row.symbol, "symbol"), quantity: requiredMoney(row.position, "position"), currency: row.currency, costBasis: money(row.costBasisMoney), marketValue: money(row.positionValue), unrealizedPnl: money(row.fifoPnlUnrealized), assetType: String(row.assetCategory ?? "unknown"), multiplier: money(row.multiplier), markPrice: money(row.markPrice), averageCost: money(row.costBasisPrice) })),
      trades: trades.map(row => {
        const externalId = requiredText(row.tradeID, "tradeID");
        if (!["BUY", "SELL"].includes(row.buySell)) throw new Error("IBKR 成交方向无效");
        return { id: `ibkr:statement:${id}:${externalId}`, externalId, symbol: requiredText(row.symbol, "symbol"), side: row.buySell === "BUY" ? "buy" : "sell", quantity: requiredMoney(row.quantity, "quantity").replace(/^-/, ""), price: money(row.tradePrice), fees: money(row.ibCommission), feeCurrency: hasText(row, "ibCommissionCurrency") ? row.ibCommissionCurrency : null, multiplier: money(row.multiplier), positionEffect: row.openCloseIndicator === "O" ? "open" : row.openCloseIndicator === "C" ? "close" : null, realizedPnl: money(row.fifoPnlRealized), currency: requiredText(row.currency, "currency"), tradedAt: requiredText(row.dateTime || row.tradeDate, "dateTime / tradeDate"), timePrecision: hasText(row, "dateTime") ? "broker-local" : "day", assetType: String(row.assetCategory ?? "unknown") };
      }),
      notes: ["Flex 为报表快照，持仓与盈亏截至报表日期，不是实时行情。", "日期与时间保留券商报表原值及配置时区；佣金保留券商正负号。", "持仓盈亏采用券商 FIFO 口径，按币种逐项展示；未与手工账户合并。"],
    };
  });
}


interface TradierLot { symbol: string; quantity: string; openDate: string; closeDate: string; cost: string | null; proceeds: string | null }
const decimalEqual = (a: string | null | undefined, b: string | null | undefined) => a != null && b != null && new Decimal(a).eq(b);
const orderSide = (value: unknown): { side: "buy" | "sell"; effect: "open" | "close" | null } | null => {
  const text = String(value ?? "").toLowerCase();
  const side = text.startsWith("buy") ? "buy" : text.startsWith("sell") ? "sell" : null;
  if (!side) return null;
  return { side, effect: text.endsWith("_to_open") ? "open" : text.endsWith("_to_close") || text === "sell_short" ? (text === "sell_short" ? "open" : "close") : null };
};
const orderTime = (value: unknown): string | null => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

/** Filled orders and their legs become one observation per leg; open/rejected orders are ignored. */
export function tradierOrderObservations(rows: Row[], accountId: string, environment: "live" | "sandbox", seenAt: string): BrokerOrderObservation[] {
  const observations: BrokerOrderObservation[] = [];
  for (const order of rows) {
    const status = String(order.status ?? "");
    if (!["filled", "partially_filled"].includes(status)) continue;
    const parentId = order.id == null ? null : String(order.id);
    if (!parentId) continue;
    const legs = list(order.leg);
    const rowsToRecord = legs.length ? legs.map((leg, index) => ({ leg, id: leg.id == null ? `${parentId}:${index + 1}` : String(leg.id), groupId: parentId })) : [{ leg: order, id: parentId, groupId: null }];
    for (const { leg, id, groupId } of rowsToRecord) {
      const executed = money(leg.exec_quantity);
      const parsed = orderSide(leg.side);
      const symbol = typeof leg.option_symbol === "string" && leg.option_symbol ? leg.option_symbol : typeof leg.symbol === "string" ? leg.symbol : "";
      if (!parsed || !symbol || executed === null || new Decimal(executed).lte(0)) continue;
      observations.push({ broker: "tradier", environment, accountId, orderId: id, groupId, status: String(leg.status ?? status), symbol, side: parsed.side, positionEffect: parsed.effect,
        quantity: executed, price: money(leg.avg_fill_price), executedAt: orderTime(leg.transaction_date), createdAt: orderTime(leg.create_date), firstSeenAt: seenAt, lastSeenAt: seenAt });
    }
  }
  return observations;
}

/** Attach closed-lot and observed-order evidence to nightly trades. Base fields are never modified and no trade is added or removed. */
export function annotateTradierTrades(trades: BrokerTrade[], lots: readonly TradierLot[], observations: readonly BrokerOrderObservation[]): BrokerTrade[] {
  const result = trades.map(trade => ({ ...trade }));
  const lotCounts = new Map<string, number>();
  const lotId = (lot: TradierLot) => {
    const key = createHash("sha256").update(JSON.stringify([lot.symbol, lot.openDate, lot.closeDate, lot.quantity, lot.cost, lot.proceeds])).digest("hex").slice(0, 24);
    const n = (lotCounts.get(key) ?? 0) + 1; lotCounts.set(key, n); return `lot:${key}:${n}`;
  };
  const claim = (trade: BrokerTrade, patch: Partial<BrokerTrade>) => Object.assign(trade, patch);
  // Pass 1: exact lot legs. A long lot opens with a buy whose net cash is -cost and closes with a sell of +proceeds;
  // a short lot opens with a sell of -proceeds and closes with a buy of -cost (Tradier reports short proceeds negative).
  for (const lot of lots) {
    const long = !lot.quantity.startsWith("-"), size = lot.quantity.replace(/^-/, "");
    const id = lotId(lot);
    const legs: { date: string; side: "buy" | "sell"; effect: "open" | "close"; amount: string | null }[] = long
      ? [{ date: lot.openDate, side: "buy", effect: "open", amount: lot.cost === null ? null : new Decimal(lot.cost).negated().toFixed() }, { date: lot.closeDate, side: "sell", effect: "close", amount: lot.proceeds }]
      : [{ date: lot.openDate, side: "sell", effect: "open", amount: lot.proceeds === null ? null : new Decimal(lot.proceeds).negated().toFixed() }, { date: lot.closeDate, side: "buy", effect: "close", amount: lot.cost === null ? null : new Decimal(lot.cost).negated().toFixed() }];
    for (const leg of legs) {
      const pool = result.filter(t => !t.lotId && t.symbol === lot.symbol && t.tradedAt === leg.date && t.side === leg.side);
      const byAmount = pool.filter(t => decimalEqual(t.netCash, leg.amount));
      const bySize = pool.filter(t => decimalEqual(t.quantity, size));
      const match = byAmount.length === 1 ? byAmount[0] : byAmount.length === 0 && bySize.length === 1 ? bySize[0] : null;
      if (match) claim(match, { lotId: id, positionEffect: leg.effect, effectSource: "lot" });
    }
  }
  // Pass 2: remaining trades whose symbol/date only touches lots of one direction inherit the side→effect mapping without a lot id.
  for (const trade of result) {
    if (trade.lotId) continue;
    const touching = lots.filter(l => l.symbol === trade.symbol && (l.openDate === trade.tradedAt || l.closeDate === trade.tradedAt));
    if (!touching.length) continue;
    const signs = new Set(touching.map(l => l.quantity.startsWith("-") ? "short" : "long"));
    if (signs.size !== 1) continue;
    const long = signs.has("long");
    claim(trade, { positionEffect: (trade.side === "buy") === long ? "open" : "close", effectSource: "lot" });
  }
  // Pass 3: observed orders give second-level time, leg group and explicit side. Partial fills may map one leg to several trades.
  for (const observation of observations) {
    if (!observation.executedAt) continue;
    const date = observation.executedAt.slice(0, 10);
    const pool = result.filter(t => !t.orderId && t.symbol === observation.symbol && t.tradedAt === date && t.side === observation.side);
    const total = pool.reduce((sum, t) => sum.plus(t.quantity), new Decimal(0));
    const exact = pool.filter(t => decimalEqual(t.quantity, observation.quantity));
    const matches = exact.length === 1 ? exact : pool.length > 1 && total.eq(observation.quantity) ? pool : [];
    for (const trade of matches) claim(trade, { orderId: observation.orderId, orderGroupId: observation.groupId, executedAt: observation.executedAt,
      ...(observation.positionEffect ? { positionEffect: observation.positionEffect, effectSource: "order" } : {}) });
  }
  return result;
}
