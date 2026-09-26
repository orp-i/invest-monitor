import { Decimal } from "decimal.js";
import { optionIdentity } from "./trade-direction.js";
import type { ReviewFill } from "./trading-review.js";

export const MERGE_SOP_VERSION = "merge-sop-v1";
/** Standard operating procedure for grouping broker fills into strategy cases. Mechanical rules are applied in
 * code (pairing, clusters, SOP-4 default); the same text is handed verbatim to the LLM advisor as its rulebook. */
export const MERGE_SOP_RULES: readonly string[] = [
  "SOP-1 分组边界：只在同账户/环境、同币种、同标的（期权按标的解析）内归组；不同账户或模拟盘的成交从不混合；不新增、删除或改写任何成交。",
  "SOP-2 结构库：按 OptionStrat 常见结构命名开仓结构（单腿、垂直价差、跨式/宽跨式、蝶式、鹰式、铁蝶/铁鹰、日历/对角等）；标签描述开仓结构，不代表实时 Delta 或交易意图。",
  "SOP-3 证据优先级：券商多腿订单 id ＞ 同秒成交时间 ＞ 券商开平标记（已平仓批次 / 当日订单 / 持仓推断 / 结单动作）＞ 同日结构形态 ＞ 仅同日同标的。前三级可自动合并；只有形态或同日证据时只能建议，由人确认。",
  "SOP-4 开平判定：有券商标记以标记为准；跨日成交按日期先后（先开后平）；同日且无标记时默认“借方价差优先”——买入权利金更高的一腿（认购买低行权价、认沽买高行权价），并明确标注为推断；券商标记到达后自动改用券商标记。",
  "SOP-5 多轮往返：同一组合同日开平多次而没有秒级时间或订单号时，不拆分轮次（两种跨腿配对合计相同、无法区分），合并为一档并注明轮数；只有订单 id 或秒级时间才能拆成独立档案。",
  "SOP-6 共用行权价：某一腿同日既有多头批次又有空头批次（如两组价差共用中间行权价），只提出可能的拆分方案并标记待人工确认，不自动合并。",
  "SOP-7 金额口径：净现金已含费用，买入为负、卖出为正；组合盈亏 = 各腿净现金之和；不能由标的日 K 反推期权盈亏；不推定乘数或到期结算；不改变任何金额的符号。",
  "SOP-8 交易风格（可修改）：短线主要 0DTE 与短期期权价差，中线 Put Spread / Call Spread 与股票，长线股票；看空多用买高卖低的认沽价差，看多多用买低卖高的认购价差。",
  "SOP-9 输出要求：每条建议给出结构、方向、各腿多空角色、开仓/平仓成交 id、轮数、置信度与依据，并列出所用 SOP 条目；证据不足写 low 并说明还缺什么证据。",
];

export interface SopInference { effects: Map<string, "open" | "close">; rule: string; note: string }
/** SOP-4 default for a grouping the user confirmed: two legs of one option type and expiry at different strikes,
 * each leg bought and sold the same quantity, no broker open/close flag anywhere and only date precision. The
 * higher-premium leg (calls: lower strike; puts: higher strike) is treated as the long leg. Never used for
 * automatic cases or clusters, and broker flags always take precedence. */
const reportDay = (value: string) => { const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
export function sopInferEffects(fills: readonly ReviewFill[]): SopInference | null {
  if (!fills.length || fills.some(f => f.positionEffect ?? f.provenance?.action) || fills.some(f => f.timePrecision !== "day")) return null;
  // Only when everything happened on one report day; across days the date order already tells open from close.
  if (new Set(fills.map(f => reportDay(f.occurredAt))).size !== 1) return null;
  const ids = fills.map(f => optionIdentity(f.symbol));
  const first = ids[0];
  if (!first || ids.some(i => !i || i.underlying !== first.underlying || i.expiry !== first.expiry || i.type !== first.type)) return null;
  const legs = new Map<string, { strike: Decimal; bought: Decimal; sold: Decimal }>();
  fills.forEach((f, i) => {
    const leg = legs.get(f.symbol) ?? { strike: new Decimal(ids[i]!.strike), bought: new Decimal(0), sold: new Decimal(0) };
    if (f.side === "buy") leg.bought = leg.bought.plus(f.quantity); else leg.sold = leg.sold.plus(f.quantity);
    legs.set(f.symbol, leg);
  });
  if (legs.size !== 2) return null;
  const [a, b] = [...legs.entries()] as [[string, { strike: Decimal; bought: Decimal; sold: Decimal }], [string, { strike: Decimal; bought: Decimal; sold: Decimal }]];
  if (a[1].strike.eq(b[1].strike) || !a[1].bought.gt(0) || !a[1].bought.eq(a[1].sold) || !b[1].bought.eq(b[1].sold) || !a[1].bought.eq(b[1].bought)) return null;
  const lowerFirst = a[1].strike.lt(b[1].strike);
  const longSymbol = first.type === "C" ? (lowerFirst ? a[0] : b[0]) : (lowerFirst ? b[0] : a[0]);
  const effects = new Map<string, "open" | "close">();
  for (const f of fills) effects.set(f.id, (f.symbol === longSymbol) === (f.side === "buy") ? "open" : "close");
  const strike = optionIdentity(longSymbol)!.strike;
  return { effects, rule: "SOP-4", note: `按 SOP-4 默认借方价差：${first.type === "C" ? "买低卖高" : "买高卖低"}行权价，${strike} 为多头腿，共 ${a[1].bought.toFixed()} 轮；券商开平标记到达后自动改用券商标记。` };
}
