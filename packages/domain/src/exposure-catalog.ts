// Exposure theme catalog: which economic driver each instrument is exposed to, with a signed coefficient
// (leverage multiple, index weight or an empirical cross-asset relation), plus the tools that add or offset
// exposure per theme. Coefficients are documented estimates the user can revise; they are not market data.
// Instrument profiles are derived from the theme member lists (one symbol may belong to several themes).
// The method text at the bottom is the structured procedure exported to other LLMs (docs/RISK-EXPOSURE.md).
export type HedgeBenchmark = "SPY" | "IWM" | "QQQ";
export const HEDGE_BENCHMARKS: readonly HedgeBenchmark[] = ["SPY", "IWM", "QQQ"];
export type ThemeKind = "market" | "sector" | "country" | "commodity" | "rates" | "fx" | "crypto" | "volatility";
export type ToolKind = "direct" | "leveraged" | "inverse" | "related" | "option" | "covered-call" | "protective-put";
export interface HedgeTool { symbol: string; label: string; kind: ToolKind; coefficient: number; note: string }
export interface ThemeMembership { theme: string; coefficient: number; basis: string }
export interface InstrumentProfile { label: string; memberships: ThemeMembership[]; benchmark?: HedgeBenchmark }
export interface ExposureTheme { id: string; label: string; kind: ThemeKind; description: string; benchmark: HedgeBenchmark | null; longTools: HedgeTool[]; shortTools: HedgeTool[]; members: string[] }
type Member = readonly [symbol: string, coefficient: number, label?: string, basis?: string] | { s: string; c: number; l?: string; b?: string; us?: number | null; bm?: HedgeBenchmark };
interface ThemeDef { id: string; label: string; kind: ThemeKind; description: string; benchmark?: HedgeBenchmark; members: readonly Member[]; longTools: HedgeTool[]; shortTools: HedgeTool[] }

const PATH = "每日重置的杠杆/反向目标，多日持有存在路径依赖与费用";
const t = (symbol: string, label: string, kind: ToolKind, coefficient: number, note = ""): HedgeTool => ({ symbol, label, kind, coefficient, note });
const d = (symbol: string, label: string, note = "") => t(symbol, `${symbol} · ${label}`, "direct", 1, note);
const lev = (symbol: string, label: string, mult: number) => t(symbol, `${symbol} · ${label}（${mult}×）`, "leveraged", mult, PATH);
const inv = (symbol: string, label: string, mult: number) => t(symbol, `${symbol} · ${label}（-${mult}×）`, "inverse", -mult, PATH);
const rel = (symbol: string, label: string, coefficient: number, note: string) => t(symbol, `${symbol} · ${label}`, "related", coefficient, note);
const put = (symbol: string, coefficient = 1) => t(symbol, `${symbol} 认沽期权`, "option", -coefficient, "买入认沽：亏损上限为权利金，Delta 随价格变化；按实际合约 Greeks 定量");
const COVERED: HedgeTool = t("*", "对 ≥100 股的持仓卖出认购（备兑）", "covered-call", -1, "每张对应 100 股；收权利金、放弃上涨空间，只缓冲下跌而非保护");
const PROTECT: HedgeTool = t("*", "对 ≥100 股的持仓买入认沽（保护性认沽）", "protective-put", -1, "每张对应 100 股；支付权利金换取下行保护");
const L = (mult: number) => `每日 ${mult}× 目标，路径依赖`;
const lv = (s: string, c: number, l: string): Member => ({ s, c, l, b: L(c) });

const THEME_DEFS: readonly ThemeDef[] = [
  // ---- 市场 ----
  { id: "us-equity", label: "美股权益 · 市场 β", kind: "market", benchmark: "SPY", description: "所有美股个股与美股上市 ETF 共享的市场因子；用历史 β 调整后与 SPY/IWM/QQQ 对照。",
    members: [["SPY", 1, "标普 500 ETF"], ["VOO", 1, "标普 500 ETF"], ["IVV", 1, "标普 500 ETF"], ["SPLG", 1, "标普 500 ETF"], ["VOOG", 1, "标普 500 成长 ETF"], ["RSP", 1, "标普 500 等权 ETF"], ["VTI", 1, "美股全市场 ETF"], ["ITOT", 1, "美股全市场 ETF"], ["DIA", 1, "道琼斯 ETF"], ["MDY", 1, "标普中盘 400 ETF"],
      { s: "QQQ", c: 1, l: "纳指 100 ETF", bm: "QQQ" }, { s: "QQQM", c: 1, l: "纳指 100 ETF", bm: "QQQ" }, { s: "IWM", c: 1, l: "罗素 2000 小盘 ETF", bm: "IWM" }, { s: "IWN", c: 1, l: "罗素 2000 价值 ETF", bm: "IWM" }, { s: "IWO", c: 1, l: "罗素 2000 成长 ETF", bm: "IWM" }, { s: "IJR", c: 1, l: "标普小盘 600 ETF", bm: "IWM" }, { s: "VB", c: 1, l: "小盘 ETF", bm: "IWM" },
      lv("SH", -1, "标普 500 反向 ETF"), lv("SDS", -2, "标普 500 反向 ETF"), lv("SPXU", -3, "标普 500 反向 ETF"), lv("SPXS", -3, "标普 500 反向 ETF"), lv("SSO", 2, "标普 500 杠杆 ETF"), lv("UPRO", 3, "标普 500 杠杆 ETF"), lv("SPXL", 3, "标普 500 杠杆 ETF"),
      { ...lv("PSQ", -1, "纳指 100 反向 ETF"), bm: "QQQ" }, { ...lv("QID", -2, "纳指 100 反向 ETF"), bm: "QQQ" }, { ...lv("SQQQ", -3, "纳指 100 反向 ETF"), bm: "QQQ" }, { ...lv("QLD", 2, "纳指 100 杠杆 ETF"), bm: "QQQ" }, { ...lv("TQQQ", 3, "纳指 100 杠杆 ETF"), bm: "QQQ" },
      { ...lv("RWM", -1, "罗素 2000 反向 ETF"), bm: "IWM" }, { ...lv("TWM", -2, "罗素 2000 反向 ETF"), bm: "IWM" }, { ...lv("TZA", -3, "罗素 2000 反向 ETF"), bm: "IWM" }, { ...lv("UWM", 2, "罗素 2000 杠杆 ETF"), bm: "IWM" }, { ...lv("TNA", 3, "罗素 2000 杠杆 ETF"), bm: "IWM" },
      ["MAGS", 1, "七巨头 ETF"]],
    longTools: [d("SPY", "标普 500 ETF", "市场基准"), d("QQQ", "纳指 100 ETF", "成长/科技权重高"), d("IWM", "罗素 2000 ETF", "小盘股基准")],
    shortTools: [inv("SH", "标普 500 反向 ETF", 1), inv("RWM", "罗素 2000 反向 ETF", 1), inv("PSQ", "纳指 100 反向 ETF", 1), put("SPY"), put("IWM"), put("QQQ"), COVERED, PROTECT, rel("UVXY", "VIX 短期期货杠杆 ETF", -1, "与美股短期负相关，长期衰减极大，只适合数日级别的事件对冲")] },
  // ---- 科技与成长 ----
  { id: "tech-broad", label: "科技板块（XLK）", kind: "sector", benchmark: "QQQ", description: "信息技术板块：软件、硬件、半导体设备等。",
    members: [["XLK", 1, "科技板块 ETF"], ["VGT", 1, "科技板块 ETF"], ["IYW", 1, "科技板块 ETF"], { ...lv("TECL", 3, "科技 3× ETF"), us: 3 }, { ...lv("TECS", -3, "科技 -3× ETF"), us: -3 }, { ...lv("REW", -2, "科技 -2× ETF"), us: -2 }, ["AAPL", 1, "苹果"], ["MSFT", 1, "微软"], ["ORCL", 1, "甲骨文"], ["CSCO", 1, "思科"], ["IBM", 1, "IBM"], ["ACN", 1, "埃森哲"], ["ADBE", 1, "Adobe"], ["CRM", 1, "Salesforce"], ["NOW", 1, "ServiceNow"], ["INTU", 1, "Intuit"]],
    longTools: [d("XLK", "科技板块 ETF"), lev("TECL", "科技 3× ETF", 3)], shortTools: [inv("TECS", "科技 -3× ETF", 3), inv("REW", "科技 -2× ETF", 2), put("XLK")] },
  { id: "semis", label: "半导体", kind: "sector", benchmark: "QQQ", description: "半导体设计、制造、设备与 ETF；存储芯片是其子集。",
    members: [["SOXX", 1, "半导体 ETF", "费城半导体指数"], ["SMH", 1, "半导体 ETF", "台积电、英伟达权重高"], { ...lv("SOXL", 3, "半导体 3× ETF"), us: 3 }, { ...lv("SOXS", -3, "半导体 -3× ETF"), us: -3 }, { ...lv("SSG", -2, "半导体 -2× ETF"), us: -2 },
      ["NVDA", 1, "英伟达"], { ...lv("NVDL", 2, "英伟达 2× ETF"), us: 2 }, ["AMD", 1, "AMD"], ["AVGO", 1, "博通"], ["TSM", 1, "台积电 ADR"], ["ASML", 1, "ASML"], ["AMAT", 1, "应用材料"], ["LRCX", 1, "泛林"], ["KLAC", 1, "科磊"], ["INTC", 1, "英特尔"], ["QCOM", 1, "高通"], ["ARM", 1, "Arm"], ["MRVL", 1, "迈威尔"], ["TXN", 1, "德州仪器"], ["ADI", 1, "亚德诺"], ["ON", 1, "安森美"], ["MU", 1, "美光"], ["DRAM", 1, "存储芯片 ETF（Roundhill Memory）"], ["SNDK", 1, "SanDisk"], ["WDC", 1, "西部数据"], ["STX", 1, "希捷"]],
    longTools: [d("SOXX", "半导体 ETF"), d("SMH", "半导体 ETF"), lev("SOXL", "半导体 3× ETF", 3)], shortTools: [inv("SOXS", "半导体 -3× ETF", 3), inv("SSG", "半导体 -2× ETF", 2), put("SOXX"), put("SMH")] },
  { id: "memory-semis", label: "存储芯片", kind: "sector", benchmark: "QQQ", description: "DRAM/NAND/HBM 周期：美光、SanDisk、西部数据、希捷，以及三星电子与 SK 海力士（通过 EWY 间接暴露）。",
    members: [["DRAM", 1, "存储芯片 ETF（Roundhill Memory）", "存储链一篮子"], ["MU", 1, "美光", "DRAM/HBM 龙头"], ["SNDK", 1, "SanDisk", "NAND"], ["WDC", 1, "西部数据", "硬盘/存储"], ["STX", 1, "希捷", "硬盘"], { s: "EWY", c: 0.5, l: "韩国股市 ETF", b: "三星电子 + SK 海力士约占五成（2026 年，权重随指数调整变化）", us: null }, ["SOXX", 0.3, "半导体 ETF", "存储类成分约三成"], ["SMH", 0.2, "半导体 ETF", "存储类成分约两成"], { ...lv("SOXL", 0.9, "半导体 3× ETF"), b: "存储成分约三成 × 3", us: 3 }, { ...lv("SOXS", -0.9, "半导体 -3× ETF"), b: "存储成分约三成 × -3", us: -3 }],
    longTools: [d("DRAM", "存储芯片 ETF", "存储链一篮子"), d("MU", "美光", "DRAM/HBM 龙头"), d("SNDK", "SanDisk", "NAND"), rel("EWY", "韩国 ETF", 0.5, "三星电子 + SK 海力士约占五成，同时带韩国市场敞口")], shortTools: [put("DRAM"), put("MU"), rel("SOXS", "半导体 -3× ETF", -0.9, "半导体反向 3×，其中存储约三成，基差大"), put("EWY", 0.5)] },
  { id: "ai-infra", label: "AI 基础设施 / 数据中心", kind: "sector", benchmark: "QQQ", description: "GPU、网络、服务器、电力与算力租赁。",
    members: [["NVDA", 1, "英伟达"], ["AVGO", 1, "博通"], ["AMD", 1, "AMD"], ["VRT", 1, "维谛技术"], ["ANET", 1, "Arista"], ["SMCI", 1, "超微电脑"], ["DELL", 1, "戴尔"], ["ETN", 1, "伊顿"], ["CRWV", 1, "CoreWeave"], ["ORCL", 1, "甲骨文"], ["AIQ", 1, "AI 与大数据 ETF"]],
    longTools: [d("AIQ", "AI 与大数据 ETF"), d("NVDA", "英伟达")], shortTools: [put("NVDA"), put("AIQ"), rel("SOXS", "半导体 -3× ETF", -3, "以半导体反向近似，基差大")] },
  { id: "software-cloud", label: "软件 / 云", kind: "sector", benchmark: "QQQ", description: "应用与基础软件、云计算。",
    members: [["IGV", 1, "软件 ETF"], ["WCLD", 1, "云计算 ETF"], ["CLOU", 1, "云计算 ETF"], ["SKYY", 1, "云计算 ETF"], ["MSFT", 1, "微软"], ["CRM", 1, "Salesforce"], ["NOW", 1, "ServiceNow"], ["ORCL", 1, "甲骨文"], ["ADBE", 1, "Adobe"], ["PLTR", 1, "Palantir"], ["SNOW", 1, "Snowflake"], ["DDOG", 1, "Datadog"], ["INTU", 1, "Intuit"], ["SAP", 1, "SAP ADR"]],
    longTools: [d("IGV", "软件 ETF"), d("WCLD", "云计算 ETF")], shortTools: [put("IGV"), put("WCLD")] },
  { id: "cybersecurity", label: "网络安全", kind: "sector", benchmark: "QQQ", description: "安全软件与服务。",
    members: [["CIBR", 1, "网络安全 ETF"], ["HACK", 1, "网络安全 ETF"], ["BUG", 1, "网络安全 ETF"], ["CRWD", 1, "CrowdStrike"], ["PANW", 1, "Palo Alto"], ["ZS", 1, "Zscaler"], ["FTNT", 1, "Fortinet"], ["NET", 1, "Cloudflare"], ["OKTA", 1, "Okta"], ["S", 1, "SentinelOne"]],
    longTools: [d("CIBR", "网络安全 ETF"), d("HACK", "网络安全 ETF")], shortTools: [put("CIBR"), put("HACK")] },
  { id: "internet-megacap", label: "互联网平台 / 七巨头", kind: "sector", benchmark: "QQQ", description: "大型互联网与平台公司。",
    members: [["AAPL", 1, "苹果"], ["MSFT", 1, "微软"], ["GOOGL", 1, "Alphabet"], ["GOOG", 1, "Alphabet"], ["AMZN", 1, "亚马逊"], ["META", 1, "Meta"], ["NFLX", 1, "奈飞"], ["NVDA", 1, "英伟达"], ["TSLA", 1, "特斯拉"], ["MAGS", 1, "七巨头 ETF"]],
    longTools: [d("MAGS", "七巨头 ETF"), d("QQQ", "纳指 100 ETF")], shortTools: [put("MAGS"), put("QQQ"), inv("PSQ", "纳指 100 反向 ETF", 1)] },
  { id: "fintech-payments", label: "支付 / 金融科技", kind: "sector", benchmark: "QQQ", description: "支付网络、消费信贷与互联网券商。",
    members: [["V", 1, "Visa"], ["MA", 1, "万事达"], ["PYPL", 1, "PayPal"], ["XYZ", 1, "Block"], ["AFRM", 1, "Affirm"], ["SOFI", 1, "SoFi"], ["HOOD", 1, "Robinhood"], ["UPST", 1, "Upstart"], ["IPAY", 1, "支付 ETF"], ["FINX", 1, "金融科技 ETF"]],
    longTools: [d("IPAY", "支付 ETF"), d("FINX", "金融科技 ETF")], shortTools: [put("IPAY"), put("PYPL")] },
  { id: "ev-autos", label: "电动车 / 汽车", kind: "sector", benchmark: "QQQ", description: "整车、电动车与自动驾驶。",
    members: [["TSLA", 1, "特斯拉"], { ...lv("TSLL", 2, "特斯拉 2× ETF"), us: 2 }, { ...lv("TSLS", -1, "特斯拉 -1× ETF"), us: -1 }, ["RIVN", 1, "Rivian"], ["LCID", 1, "Lucid"], ["GM", 1, "通用汽车"], ["F", 1, "福特"], ["TM", 1, "丰田 ADR"], ["NIO", 1, "蔚来"], ["XPEV", 1, "小鹏"], ["LI", 1, "理想"], ["DRIV", 1, "自动驾驶与电动车 ETF"], ["IDRV", 1, "自动驾驶与电动车 ETF"]],
    longTools: [d("DRIV", "自动驾驶与电动车 ETF"), d("TSLA", "特斯拉")], shortTools: [inv("TSLS", "特斯拉 -1× ETF", 1), put("TSLA"), put("DRIV")] },
  { id: "clean-energy", label: "清洁能源 / 太阳能", kind: "sector", benchmark: "IWM", description: "光伏、风电、储能与氢能。",
    members: [["TAN", 1, "太阳能 ETF"], ["ICLN", 1, "清洁能源 ETF"], ["QCLN", 1, "清洁能源 ETF"], ["PBW", 1, "清洁能源 ETF"], ["ENPH", 1, "Enphase"], ["FSLR", 1, "First Solar"], ["SEDG", 1, "SolarEdge"], ["RUN", 1, "Sunrun"], ["NXT", 1, "Nextracker"], ["PLUG", 1, "Plug Power"]],
    longTools: [d("TAN", "太阳能 ETF"), d("ICLN", "清洁能源 ETF")], shortTools: [put("TAN"), put("ICLN")] },
  { id: "uranium-nuclear", label: "铀 / 核能", kind: "sector", benchmark: "IWM", description: "铀矿、核燃料与小型堆。",
    members: [["URA", 1, "铀 ETF"], ["URNM", 1, "铀矿 ETF"], ["NLR", 1, "核能 ETF"], ["CCJ", 1, "Cameco"], ["UEC", 1, "Uranium Energy"], ["UUUU", 1, "Energy Fuels"], ["OKLO", 1, "Oklo"], ["SMR", 1, "NuScale"], ["NNE", 1, "Nano Nuclear"], ["LEU", 1, "Centrus"], ["VST", 0.5, "Vistra", "核电资产占比"], ["CEG", 0.5, "Constellation", "核电资产占比"]],
    longTools: [d("URA", "铀 ETF"), d("URNM", "铀矿 ETF"), d("NLR", "核能 ETF")], shortTools: [put("URA"), put("CCJ")] },
  { id: "lithium-battery", label: "锂 / 电池", kind: "sector", benchmark: "IWM", description: "锂矿与电池产业链。",
    members: [["LIT", 1, "锂与电池 ETF"], ["BATT", 1, "电池 ETF"], ["ALB", 1, "雅保"], ["SQM", 1, "SQM ADR"], ["LAC", 1, "Lithium Americas"]],
    longTools: [d("LIT", "锂与电池 ETF"), d("ALB", "雅保")], shortTools: [put("LIT"), put("ALB")] },
  { id: "robotics-automation", label: "机器人 / 自动化", kind: "sector", benchmark: "QQQ", description: "工业与医疗机器人、自动化。",
    members: [["BOTZ", 1, "机器人与 AI ETF"], ["ROBO", 1, "机器人 ETF"], ["ARKQ", 1, "自主科技 ETF"], ["ISRG", 1, "直觉外科"], ["TER", 1, "泰瑞达"], ["SYM", 1, "Symbotic"], ["ROK", 1, "罗克韦尔"]],
    longTools: [d("BOTZ", "机器人与 AI ETF"), d("ROBO", "机器人 ETF")], shortTools: [put("BOTZ"), put("ISRG")] },
  { id: "space", label: "太空 / 卫星", kind: "sector", benchmark: "IWM", description: "火箭、卫星与太空服务。",
    members: [["UFO", 1, "太空 ETF"], ["ARKX", 1, "太空探索 ETF"], ["RKLB", 1, "Rocket Lab"], ["ASTS", 1, "AST SpaceMobile"], ["LUNR", 1, "Intuitive Machines"], ["RDW", 1, "Redwire"], ["PL", 1, "Planet Labs"]],
    longTools: [d("UFO", "太空 ETF"), d("RKLB", "Rocket Lab")], shortTools: [put("RKLB"), put("ASTS")] },
  { id: "quantum", label: "量子计算", kind: "sector", benchmark: "IWM", description: "量子计算硬件与软件。",
    members: [["QTUM", 1, "量子计算 ETF"], ["IONQ", 1, "IonQ"], ["RGTI", 1, "Rigetti"], ["QBTS", 1, "D-Wave"], ["QUBT", 1, "Quantum Computing"]],
    longTools: [d("QTUM", "量子计算 ETF"), d("IONQ", "IonQ")], shortTools: [put("IONQ"), put("QTUM")] },
  { id: "networking-telecom-equipment", label: "网络与通信设备", kind: "sector", benchmark: "QQQ", description: "电信设备、交换与光通信。",
    members: [["NOK", 1, "诺基亚 ADR"], ["ERIC", 1, "爱立信 ADR"], ["CSCO", 1, "思科"], ["ANET", 1, "Arista"], ["CIEN", 1, "Ciena"], ["ALAB", 1, "Astera Labs"]],
    longTools: [d("CSCO", "思科"), d("ANET", "Arista")], shortTools: [put("CSCO"), put("ANET")] },
  // ---- 金融 ----
  { id: "financials-banks", label: "金融 / 大型银行", kind: "sector", benchmark: "SPY", description: "金融板块与大型银行、券商。",
    members: [["XLF", 1, "金融板块 ETF"], ["VFH", 1, "金融板块 ETF"], ["KBE", 1, "银行 ETF"], ["KBWB", 1, "大型银行 ETF"], { ...lv("FAS", 3, "金融 3× ETF"), us: 3 }, { ...lv("FAZ", -3, "金融 -3× ETF"), us: -3 }, { ...lv("SKF", -2, "金融 -2× ETF"), us: -2 }, ["JPM", 1, "摩根大通"], ["BAC", 1, "美国银行"], ["WFC", 1, "富国银行"], ["C", 1, "花旗"], ["GS", 1, "高盛"], ["MS", 1, "摩根士丹利"], ["SCHW", 1, "嘉信理财"], ["BRK/B", 1, "伯克希尔 B"]],
    longTools: [d("XLF", "金融板块 ETF"), lev("FAS", "金融 3× ETF", 3)], shortTools: [inv("FAZ", "金融 -3× ETF", 3), inv("SKF", "金融 -2× ETF", 2), put("XLF")] },
  { id: "regional-banks", label: "区域银行", kind: "sector", benchmark: "IWM", description: "美国区域性银行。",
    members: [["KRE", 1, "区域银行 ETF"], ["IAT", 1, "区域银行 ETF"], { ...lv("DPST", 3, "区域银行 3× ETF"), us: 3 }, ["WAL", 1, "Western Alliance"], ["ZION", 1, "Zions"], ["KEY", 1, "KeyCorp"], ["TFC", 1, "Truist"], ["CFG", 1, "Citizens"]],
    longTools: [d("KRE", "区域银行 ETF"), lev("DPST", "区域银行 3× ETF", 3)], shortTools: [put("KRE"), inv("FAZ", "金融 -3× ETF", 3)] },
  { id: "credit", label: "信用债（高收益 / 投资级）", kind: "rates", description: "公司债利差敞口；与股市风险偏好相关。",
    members: [["HYG", 1, "高收益债 ETF"], ["JNK", 1, "高收益债 ETF"], ["USHY", 1, "高收益债 ETF"], ["LQD", 1, "投资级公司债 ETF"], lv("SJB", -1, "高收益债反向 ETF")],
    longTools: [d("HYG", "高收益债 ETF"), d("LQD", "投资级公司债 ETF")], shortTools: [inv("SJB", "高收益债反向 ETF", 1), put("HYG")] },
  // ---- 医疗 ----
  { id: "healthcare", label: "医疗健康（XLV）", kind: "sector", benchmark: "SPY", description: "制药、医疗服务、器械。",
    members: [["XLV", 1, "医疗板块 ETF"], ["VHT", 1, "医疗板块 ETF"], ["IYH", 1, "医疗板块 ETF"], { ...lv("CURE", 3, "医疗 3× ETF"), us: 3 }, { ...lv("RXD", -2, "医疗 -2× ETF"), us: -2 }, ["UNH", 1, "联合健康"], ["JNJ", 1, "强生"], ["LLY", 1, "礼来"], ["PFE", 1, "辉瑞"], ["MRK", 1, "默沙东"], ["ABBV", 1, "艾伯维"], ["ABT", 1, "雅培"], ["TMO", 1, "赛默飞"], ["DHR", 1, "丹纳赫"], ["NVO", 1, "诺和诺德 ADR"]],
    longTools: [d("XLV", "医疗板块 ETF"), lev("CURE", "医疗 3× ETF", 3)], shortTools: [inv("RXD", "医疗 -2× ETF", 2), put("XLV")] },
  { id: "biotech", label: "生物科技", kind: "sector", benchmark: "IWM", description: "生物科技与基因、AI 制药。",
    members: [["XBI", 1, "生物科技 ETF（等权）"], ["IBB", 1, "生物科技 ETF"], { ...lv("LABU", 3, "生物科技 3× ETF"), us: 3 }, { ...lv("LABD", -3, "生物科技 -3× ETF"), us: -3 }, { ...lv("BIS", -2, "生物科技 -2× ETF"), us: -2 }, ["AMGN", 1, "安进"], ["GILD", 1, "吉利德"], ["VRTX", 1, "福泰"], ["REGN", 1, "再生元"], ["MRNA", 1, "Moderna"], ["BNTX", 1, "BioNTech"], ["RXRX", 1, "Recursion（AI 制药）"], ["CRSP", 1, "CRISPR"], ["NTLA", 1, "Intellia"]],
    longTools: [d("XBI", "生物科技 ETF"), lev("LABU", "生物科技 3× ETF", 3)], shortTools: [inv("LABD", "生物科技 -3× ETF", 3), inv("BIS", "生物科技 -2× ETF", 2), put("XBI")] },
  // ---- 消费 ----
  { id: "consumer-discretionary", label: "可选消费（XLY）", kind: "sector", benchmark: "SPY", description: "零售、汽车、休闲与服装。",
    members: [["XLY", 1, "可选消费 ETF"], ["VCR", 1, "可选消费 ETF"], { ...lv("WANT", 3, "可选消费 3× ETF"), us: 3 }, { ...lv("SCC", -2, "可选消费 -2× ETF"), us: -2 }, ["AMZN", 1, "亚马逊"], ["TSLA", 1, "特斯拉"], ["HD", 1, "家得宝"], ["LOW", 1, "劳氏"], ["NKE", 1, "耐克"], ["SBUX", 1, "星巴克"], ["MCD", 1, "麦当劳"], ["CMG", 1, "Chipotle"], ["LULU", 1, "Lululemon"], ["BKNG", 1, "Booking"]],
    longTools: [d("XLY", "可选消费 ETF"), lev("WANT", "可选消费 3× ETF", 3)], shortTools: [inv("SCC", "可选消费 -2× ETF", 2), put("XLY")] },
  { id: "retail", label: "零售", kind: "sector", benchmark: "IWM", description: "百货、折扣与专业零售。",
    members: [["XRT", 1, "零售 ETF（等权）"], { ...lv("RETL", 3, "零售 3× ETF"), us: 3 }, ["WMT", 1, "沃尔玛"], ["TGT", 1, "塔吉特"], ["COST", 1, "开市客"], ["DG", 1, "Dollar General（折扣零售）"], ["DLTR", 1, "Dollar Tree"], ["BJ", 1, "BJ's"], ["KR", 1, "克罗格"], ["TJX", 1, "TJX"], ["ROST", 1, "Ross"], ["BBY", 1, "百思买"]],
    longTools: [d("XRT", "零售 ETF"), lev("RETL", "零售 3× ETF", 3)], shortTools: [put("XRT"), put("WMT")] },
  { id: "consumer-staples", label: "必需消费 / 食品", kind: "sector", benchmark: "SPY", description: "食品饮料、日用品、烟草与折扣零售。",
    members: [["XLP", 1, "必需消费 ETF"], ["VDC", 1, "必需消费 ETF"], { ...lv("SZK", -2, "必需消费 -2× ETF"), us: -2 }, ["PG", 1, "宝洁"], ["KO", 1, "可口可乐"], ["PEP", 1, "百事"], ["WMT", 1, "沃尔玛"], ["COST", 1, "开市客"], ["PM", 1, "菲利普莫里斯"], ["MO", 1, "奥驰亚"], ["MDLZ", 1, "亿滋"], ["KHC", 1, "卡夫亨氏"], ["GIS", 1, "通用磨坊"], ["TSN", 1, "泰森食品"], ["HRL", 1, "荷美尔"], ["SFD", 1, "Smithfield Foods（猪肉加工）"], ["DG", 0.5, "Dollar General", "折扣零售的必需消费属性"]],
    longTools: [d("XLP", "必需消费 ETF")], shortTools: [inv("SZK", "必需消费 -2× ETF", 2), put("XLP")] },
  { id: "travel-leisure", label: "旅游 / 航空 / 邮轮", kind: "sector", benchmark: "IWM", description: "航空、邮轮、酒店与在线旅游；油价为其主要成本因子。",
    members: [["JETS", 1, "航空股 ETF"], ["PEJ", 1, "休闲娱乐 ETF"], ["DAL", 1, "达美航空"], ["UAL", 1, "联合航空"], ["AAL", 1, "美国航空"], ["LUV", 1, "西南航空"], ["CCL", 1, "嘉年华邮轮"], ["RCL", 1, "皇家加勒比"], ["NCLH", 1, "挪威邮轮"], ["MAR", 1, "万豪"], ["HLT", 1, "希尔顿"], ["ABNB", 1, "Airbnb"], ["BKNG", 1, "Booking"], ["EXPE", 1, "Expedia"], ["LVS", 1, "金沙集团"], ["WYNN", 1, "永利"]],
    longTools: [d("JETS", "航空股 ETF"), d("PEJ", "休闲娱乐 ETF")], shortTools: [put("JETS"), put("DAL"), rel("UCO", "原油 2× ETF", -1, "油价上涨是航空的主要成本风险，可作跨资产对冲；基差大")] },
  { id: "housing", label: "住房 / 建筑商", kind: "sector", benchmark: "IWM", description: "住宅建筑商与建材，利率敏感。",
    members: [["ITB", 1, "建筑商 ETF"], ["XHB", 1, "住宅建筑 ETF"], { ...lv("NAIL", 3, "建筑商 3× ETF"), us: 3 }, ["DHI", 1, "霍顿"], ["LEN", 1, "莱纳"], ["PHM", 1, "普尔特"], ["TOL", 1, "托尔兄弟"], ["NVR", 1, "NVR"], ["KBH", 1, "KB Home"]],
    longTools: [d("ITB", "建筑商 ETF"), lev("NAIL", "建筑商 3× ETF", 3)], shortTools: [put("ITB"), put("XHB"), rel("TBT", "长债 -2× ETF", -0.5, "利率上行伤害建筑商：做空长债是经验对冲，基差大")] },
  { id: "media-communication", label: "媒体 / 通信服务（XLC）", kind: "sector", benchmark: "QQQ", description: "互联网媒体、流媒体、电信与社交平台。",
    members: [["XLC", 1, "通信服务 ETF"], ["VOX", 1, "通信服务 ETF"], ["GOOGL", 1, "Alphabet"], ["META", 1, "Meta"], ["NFLX", 1, "奈飞"], ["DIS", 1, "迪士尼"], ["CMCSA", 1, "康卡斯特"], ["WBD", 1, "华纳兄弟探索"], ["T", 1, "AT&T"], ["VZ", 1, "Verizon"], ["TMUS", 1, "T-Mobile"], ["SPOT", 1, "Spotify"], ["RDDT", 1, "Reddit"], ["DJT", 1, "Trump Media（社交媒体）"], ["SNAP", 1, "Snap"], ["PINS", 1, "Pinterest"], ["RBLX", 1, "Roblox"], ["TTWO", 1, "Take-Two"]],
    longTools: [d("XLC", "通信服务 ETF")], shortTools: [put("XLC"), put("META")] },
  // ---- 工业 ----
  { id: "industrials", label: "工业（XLI）", kind: "sector", benchmark: "SPY", description: "机械、电气设备、综合工业。",
    members: [["XLI", 1, "工业板块 ETF"], ["VIS", 1, "工业板块 ETF"], { ...lv("DUSL", 3, "工业 3× ETF"), us: 3 }, { ...lv("SIJ", -2, "工业 -2× ETF"), us: -2 }, ["CAT", 1, "卡特彼勒"], ["DE", 1, "迪尔"], ["HON", 1, "霍尼韦尔"], ["GE", 1, "GE 航空航天"], ["ETN", 1, "伊顿"], ["MMM", 1, "3M"], ["EMR", 1, "艾默生"], ["PH", 1, "派克汉尼汾"], ["GEV", 1, "GE Vernova"]],
    longTools: [d("XLI", "工业板块 ETF"), lev("DUSL", "工业 3× ETF", 3)], shortTools: [inv("SIJ", "工业 -2× ETF", 2), put("XLI")] },
  { id: "aerospace-defense", label: "航空航天与国防", kind: "sector", benchmark: "SPY", description: "国防承包商、飞机制造与军工科技。",
    members: [["ITA", 1, "航空航天与国防 ETF"], ["XAR", 1, "航空航天与国防 ETF"], ["PPA", 1, "航空航天与国防 ETF"], { ...lv("DFEN", 3, "国防 3× ETF"), us: 3 }, ["LMT", 1, "洛克希德·马丁"], ["RTX", 1, "RTX"], ["NOC", 1, "诺斯罗普·格鲁曼"], ["GD", 1, "通用动力"], ["BA", 1, "波音"], ["LHX", 1, "L3Harris"], ["HII", 1, "亨廷顿·英格尔斯"], ["AXON", 1, "Axon"], ["KTOS", 1, "Kratos"], ["RKLB", 0.5, "Rocket Lab", "国防发射业务占比"]],
    longTools: [d("ITA", "航空航天与国防 ETF"), lev("DFEN", "国防 3× ETF", 3)], shortTools: [put("ITA"), put("LMT")] },
  { id: "transports", label: "运输 / 物流", kind: "sector", benchmark: "SPY", description: "铁路、快递、卡车与物流。",
    members: [["IYT", 1, "运输 ETF"], ["XTN", 1, "运输 ETF"], ["UPS", 1, "UPS"], ["FDX", 1, "联邦快递"], ["UNP", 1, "联合太平洋"], ["CSX", 1, "CSX"], ["NSC", 1, "诺福克南方"], ["ODFL", 1, "Old Dominion"], ["JBHT", 1, "J.B. Hunt"], ["XPO", 1, "XPO"]],
    longTools: [d("IYT", "运输 ETF"), d("XTN", "运输 ETF")], shortTools: [put("IYT"), put("UPS")] },
  { id: "infrastructure", label: "基建 / 建材", kind: "sector", benchmark: "SPY", description: "骨料、工程与设备租赁。",
    members: [["PAVE", 1, "美国基建 ETF"], ["VMC", 1, "Vulcan"], ["MLM", 1, "Martin Marietta"], ["URI", 1, "联合租赁"], ["PWR", 1, "Quanta"], ["FLR", 1, "福陆"], ["J", 1, "Jacobs"]],
    longTools: [d("PAVE", "美国基建 ETF")], shortTools: [put("PAVE"), put("URI")] },
  // ---- 材料与资源 ----
  { id: "materials", label: "材料（XLB）", kind: "sector", benchmark: "SPY", description: "化工、工业气体、金属与采矿。",
    members: [["XLB", 1, "材料板块 ETF"], ["VAW", 1, "材料板块 ETF"], ["LIN", 1, "林德"], ["SHW", 1, "宣伟"], ["APD", 1, "空气产品"], ["DD", 1, "杜邦"], ["DOW", 1, "陶氏"], ["NUE", 1, "纽柯"], ["FCX", 1, "自由港"], ["NEM", 1, "纽蒙特"]],
    longTools: [d("XLB", "材料板块 ETF")], shortTools: [put("XLB"), put("FCX")] },
  { id: "steel", label: "钢铁", kind: "sector", benchmark: "IWM", description: "钢铁生产商。",
    members: [["SLX", 1, "钢铁 ETF"], ["NUE", 1, "纽柯"], ["STLD", 1, "Steel Dynamics"], ["CLF", 1, "克利夫兰-克里夫斯"], ["MT", 1, "安赛乐米塔尔 ADR"], ["RS", 1, "Reliance"]],
    longTools: [d("SLX", "钢铁 ETF"), d("NUE", "纽柯")], shortTools: [put("SLX"), put("NUE")] },
  { id: "copper-metals", label: "铜 / 工业金属", kind: "sector", benchmark: "SPY", description: "铜矿与多元矿业，中国需求敏感。",
    members: [["COPX", 1, "铜矿 ETF"], { s: "CPER", c: 1, l: "铜期货 ETF", us: null }, ["FCX", 1, "自由港"], ["SCCO", 1, "南方铜业"], ["TECK", 1, "泰克资源"], ["RIO", 0.5, "力拓 ADR", "铜业务占比"], ["BHP", 0.5, "必和必拓 ADR", "铜业务占比"], ["VALE", 0.5, "淡水河谷 ADR", "以铁矿为主"]],
    longTools: [d("COPX", "铜矿 ETF"), d("CPER", "铜期货 ETF"), d("FCX", "自由港")], shortTools: [put("COPX"), put("FCX")] },
  { id: "rare-earth-critical-minerals", label: "稀土 / 关键矿产", kind: "sector", benchmark: "IWM", description: "稀土、钨、锑等关键矿产与磁材。",
    members: [["REMX", 1, "稀土与战略金属 ETF"], ["MP", 1, "MP Materials"], ["USAR", 1, "USA Rare Earth"], ["UUUU", 0.5, "Energy Fuels", "稀土分离业务占比"], ["TMC", 1, "TMC the metals company"]],
    longTools: [d("REMX", "稀土与战略金属 ETF"), d("MP", "MP Materials")], shortTools: [put("MP"), put("REMX")] },
  { id: "gold-miners", label: "金矿股", kind: "sector", benchmark: "SPY", description: "金矿股：对金价弹性约 1.5，另含股票 β。",
    members: [{ s: "GDX", c: 1, l: "金矿股 ETF", us: 0.5 }, { s: "GDXJ", c: 1, l: "小型金矿股 ETF", us: 0.5, bm: "IWM" }, { s: "NEM", c: 1, l: "纽蒙特", us: 0.5 }, { s: "GOLD", c: 1, l: "巴里克", us: 0.5 }, { s: "AEM", c: 1, l: "伊格尔矿业", us: 0.5 }, { ...lv("NUGT", 2, "金矿股 2× ETF"), us: 1 }, { ...lv("DUST", -2, "金矿股 -2× ETF"), us: -1 }, { ...lv("JNUG", 2, "小型金矿 2× ETF"), us: 1 }, { ...lv("JDST", -2, "小型金矿 -2× ETF"), us: -1 }],
    longTools: [d("GDX", "金矿股 ETF"), lev("NUGT", "金矿股 2× ETF", 2)], shortTools: [inv("DUST", "金矿股 -2× ETF", 2), put("GDX")] },
  { id: "gold", label: "黄金", kind: "commodity", description: "金价；金矿股为高弹性的相关工具，美元走强通常压制金价。",
    members: [["GLD", 1, "黄金 ETF"], ["IAU", 1, "黄金 ETF"], ["GLDM", 1, "黄金 ETF"], ["SGOL", 1, "黄金 ETF"], lv("UGL", 2, "黄金 2× ETF"), lv("GLL", -2, "黄金 -2× ETF"), ["GDX", 1.5, "金矿股 ETF", "金矿股对金价弹性约 1.5"], ["GDXJ", 1.8, "小型金矿股 ETF", "小型金矿弹性更高"], ["NEM", 1.2, "纽蒙特", "对金价弹性约 1.2"], ["GOLD", 1.2, "巴里克", "对金价弹性约 1.2"], ["AEM", 1.2, "伊格尔矿业", "对金价弹性约 1.2"], ["NUGT", 3, "金矿股 2× ETF", "1.5 × 2"], ["DUST", -3, "金矿股 -2× ETF", "1.5 × -2"], ["JNUG", 3.6, "小型金矿 2× ETF", "1.8 × 2"], ["JDST", -3.6, "小型金矿 -2× ETF", "1.8 × -2"]],
    longTools: [d("GLD", "黄金 ETF"), d("IAU", "黄金 ETF"), rel("GDX", "金矿股 ETF", 1.5, "对金价弹性约 1.5，另含股票 β")], shortTools: [inv("GLL", "黄金 -2× ETF", 2), put("GLD"), rel("DUST", "金矿股 -2× ETF", -3, "以金矿反向近似，基差大")] },
  { id: "silver", label: "白银", kind: "commodity", description: "银价与银矿股。",
    members: [["SLV", 1, "白银 ETF"], ["SIVR", 1, "白银 ETF"], ["PSLV", 1, "白银实物信托"], lv("AGQ", 2, "白银 2× ETF"), lv("ZSL", -2, "白银 -2× ETF"), { s: "SIL", c: 1.5, l: "银矿股 ETF", b: "银矿股弹性约 1.5", us: 0.5 }, { s: "PAAS", c: 1.5, l: "泛美白银", b: "银矿股弹性约 1.5", us: 0.5 }, { s: "HL", c: 1.5, l: "Hecla", b: "银矿股弹性约 1.5", us: 0.5 }, { s: "AG", c: 1.5, l: "First Majestic", b: "银矿股弹性约 1.5", us: 0.5 }, { s: "WPM", c: 1.2, l: "惠顿贵金属", b: "流媒体公司弹性约 1.2", us: 0.5 }],
    longTools: [d("SLV", "白银 ETF"), lev("AGQ", "白银 2× ETF", 2)], shortTools: [inv("ZSL", "白银 -2× ETF", 2), put("SLV")] },
  { id: "platinum-palladium", label: "铂 / 钯", kind: "commodity", description: "铂族金属。", members: [["PPLT", 1, "铂金 ETF"], ["PALL", 1, "钯金 ETF"]], longTools: [d("PPLT", "铂金 ETF"), d("PALL", "钯金 ETF")], shortTools: [put("PPLT")] },
  { id: "agriculture", label: "农产品", kind: "commodity", description: "谷物、软商品与农业企业。",
    members: [["DBA", 1, "农产品 ETF"], ["CORN", 1, "玉米 ETF"], ["WEAT", 1, "小麦 ETF"], ["SOYB", 1, "大豆 ETF"], { s: "MOO", c: 0.5, l: "农业企业 ETF", b: "农业企业对农产品价格敏感度约 0.5", us: 1 }, { s: "ADM", c: 0.5, l: "ADM", b: "农产品加工", us: 1 }, { s: "BG", c: 0.5, l: "邦吉", b: "农产品加工", us: 1 }],
    longTools: [d("DBA", "农产品 ETF"), d("MOO", "农业企业 ETF")], shortTools: [put("DBA"), put("MOO")] },
  // ---- 能源 ----
  { id: "energy-equity", label: "能源股（XLE）", kind: "sector", benchmark: "SPY", description: "油气生产、服务与炼化企业。",
    members: [["XLE", 1, "能源板块 ETF"], ["VDE", 1, "能源板块 ETF"], ["XOP", 1, "油气开采 ETF"], ["OIH", 1, "油田服务 ETF"], ["IEO", 1, "油气开采 ETF"], { ...lv("ERX", 2, "能源 2× ETF"), us: 2 }, { ...lv("ERY", -2, "能源 -2× ETF"), us: -2 }, { ...lv("DUG", -2, "油气 -2× ETF"), us: -2 }, { ...lv("GUSH", 2, "油气开采 2× ETF"), us: 2 }, { ...lv("DRIP", -2, "油气开采 -2× ETF"), us: -2 }, ["XOM", 1, "埃克森美孚"], ["CVX", 1, "雪佛龙"], ["COP", 1, "康菲"], ["OXY", 1, "西方石油"], ["EOG", 1, "EOG"], ["DVN", 1, "德文能源"], ["SLB", 1, "斯伦贝谢"], ["HAL", 1, "哈里伯顿"], ["BKR", 1, "贝克休斯"], ["VLO", 1, "瓦莱罗（炼油）"], ["MPC", 1, "马拉松石油（炼油）"], ["PSX", 1, "菲利普斯 66（炼油）"]],
    longTools: [d("XLE", "能源板块 ETF"), d("XOP", "油气开采 ETF"), lev("ERX", "能源 2× ETF", 2)], shortTools: [inv("ERY", "能源 -2× ETF", 2), inv("DUG", "油气 -2× ETF", 2), put("XLE")] },
  { id: "crude-oil", label: "原油", kind: "commodity", description: "WTI/布伦特价格；能源股正相关、航空与邮轮负相关的跨资产关系。",
    members: [lv("UCO", 2, "原油 2× ETF"), lv("SCO", -2, "原油 -2× ETF"), ["USO", 1, "原油 ETF", "近月期货，含展期成本"], ["BNO", 1, "布伦特原油 ETF"], ["USL", 1, "原油 12 月期货 ETF"], ["DBO", 1, "原油 ETF"], ["OILK", 1, "原油 ETF"],
      ["XLE", 0.5, "能源板块 ETF", "能源股对油价经验敏感度约 0.5"], ["XOP", 0.8, "油气开采 ETF", "上游弹性约 0.8"], ["OIH", 0.6, "油田服务 ETF", "服务商弹性约 0.6"], ["IEO", 0.7, "油气开采 ETF", "上游弹性约 0.7"], ["ERX", 1, "能源 2× ETF", "0.5 × 2"], ["ERY", -1, "能源 -2× ETF", "0.5 × -2"], ["DUG", -1, "油气 -2× ETF", "0.5 × -2"], ["GUSH", 1.6, "油气开采 2× ETF", "0.8 × 2"], ["DRIP", -1.6, "油气开采 -2× ETF", "0.8 × -2"],
      ["XOM", 0.4, "埃克森美孚", "综合油企弹性约 0.4"], ["CVX", 0.4, "雪佛龙", "综合油企弹性约 0.4"], ["COP", 0.6, "康菲", "上游弹性约 0.6"], ["OXY", 0.8, "西方石油", "高杠杆上游弹性约 0.8"], ["EOG", 0.6, "EOG", "上游弹性约 0.6"], ["DVN", 0.8, "德文能源", "上游弹性约 0.8"], ["SLB", 0.5, "斯伦贝谢", "服务商弹性约 0.5"], ["HAL", 0.6, "哈里伯顿", "服务商弹性约 0.6"],
      ["JETS", -0.3, "航空股 ETF", "航空燃油约占营业成本三成（2026 年），油价下跌利好（经验系数 -0.3）"], ["DAL", -0.3, "达美航空", "燃油成本约占营业成本三成"], ["UAL", -0.3, "联合航空", "燃油成本约占营业成本三成"], ["AAL", -0.3, "美国航空", "燃油成本约占营业成本三成"], ["LUV", -0.3, "西南航空", "燃油成本约占营业成本三成"], ["CCL", -0.2, "嘉年华邮轮", "燃油成本敏感"], ["RCL", -0.2, "皇家加勒比", "燃油成本敏感"], ["NCLH", -0.2, "挪威邮轮", "燃油成本敏感"]],
    longTools: [lev("UCO", "原油 2× ETF", 2), d("USO", "原油 ETF", "近月期货，含展期成本"), d("BNO", "布伦特原油 ETF"), rel("XLE", "能源股 ETF", 0.5, "能源股对油价经验敏感度约 0.5，同时含美股 β"), rel("XOP", "油气开采 ETF", 0.8, "上游弹性更高，同时含美股 β")],
    shortTools: [inv("SCO", "原油 -2× ETF", 2), rel("JETS", "航空股 ETF", -0.3, "航空燃油约占营业成本三成，油价下跌利好；油价因需求衰退下跌时航空同样受损，属跨资产基差风险，且附带美股 β"), rel("DAL", "达美航空", -0.3, "单一航空股，燃油敏感度与经营风险并存"), put("USO")] },
  { id: "natural-gas", label: "天然气", kind: "commodity", description: "亨利港天然气价格与气企。",
    members: [["UNG", 1, "天然气 ETF", "展期成本高"], lv("BOIL", 2, "天然气 2× ETF"), lv("KOLD", -2, "天然气 -2× ETF"), { s: "EQT", c: 0.6, l: "EQT", b: "气企对气价弹性约 0.6", us: 1 }, { s: "AR", c: 0.7, l: "Antero", b: "气企弹性约 0.7", us: 1 }, { s: "RRC", c: 0.6, l: "Range Resources", b: "气企弹性约 0.6", us: 1 }, { s: "LNG", c: 0.3, l: "Cheniere", b: "出口商对气价敏感度低", us: 1 }],
    longTools: [d("UNG", "天然气 ETF"), lev("BOIL", "天然气 2× ETF", 2)], shortTools: [inv("KOLD", "天然气 -2× ETF", 2), put("UNG")] },
  // ---- 公用事业与地产 ----
  { id: "utilities", label: "公用事业（XLU）", kind: "sector", benchmark: "SPY", description: "电力、燃气与水务，利率敏感；含 AI 电力需求受益者。",
    members: [["XLU", 1, "公用事业 ETF"], ["VPU", 1, "公用事业 ETF"], { ...lv("UTSL", 3, "公用事业 3× ETF"), us: 3 }, { ...lv("SDP", -2, "公用事业 -2× ETF"), us: -2 }, ["NEE", 1, "NextEra"], ["DUK", 1, "杜克能源"], ["SO", 1, "南方电力"], ["D", 1, "道明尼"], ["AEP", 1, "美国电力"], ["EXC", 1, "Exelon"], ["PCG", 1, "PG&E（太平洋煤气电力）"], ["VST", 1, "Vistra"], ["CEG", 1, "Constellation"], ["NRG", 1, "NRG"]],
    longTools: [d("XLU", "公用事业 ETF"), lev("UTSL", "公用事业 3× ETF", 3)], shortTools: [inv("SDP", "公用事业 -2× ETF", 2), put("XLU")] },
  { id: "real-estate", label: "房地产 / REIT", kind: "sector", benchmark: "SPY", description: "上市 REIT，利率敏感。",
    members: [["VNQ", 1, "房地产 ETF"], ["XLRE", 1, "房地产板块 ETF"], ["IYR", 1, "房地产 ETF"], ["SCHH", 1, "房地产 ETF"], { ...lv("DRN", 3, "房地产 3× ETF"), us: 3 }, { ...lv("DRV", -3, "房地产 -3× ETF"), us: -3 }, { ...lv("SRS", -2, "房地产 -2× ETF"), us: -2 }, ["O", 1, "Realty Income"], ["PLD", 1, "Prologis"], ["AMT", 1, "美国电塔"], ["SPG", 1, "西蒙地产"], ["EQIX", 1, "Equinix"], ["DLR", 1, "Digital Realty"], ["VICI", 1, "VICI"]],
    longTools: [d("VNQ", "房地产 ETF"), lev("DRN", "房地产 3× ETF", 3)], shortTools: [inv("DRV", "房地产 -3× ETF", 3), inv("SRS", "房地产 -2× ETF", 2), put("VNQ")] },
  // ---- 国家 / 地区 ----
  { id: "china-equity", label: "中国股市", kind: "country", description: "中国大盘、离岸互联网、A 股与中概股；铜矿等中国需求敏感资产为相关工具。",
    members: [["FXI", 1, "中国大盘 ETF"], ["MCHI", 1, "中国股市 ETF"], ["KWEB", 1, "中概互联网 ETF"], ["ASHR", 1, "沪深 300 ETF"], ["CQQQ", 1, "中国科技 ETF"], ["EWH", 0.7, "香港股市 ETF", "港股与内地关联"], lv("YINN", 3, "中国大盘 3× ETF"), lv("YANG", -3, "中国大盘 -3× ETF"), lv("FXP", -2, "中国 -2× ETF"), ["BABA", 1, "阿里巴巴 ADR"], ["PDD", 1, "拼多多 ADR"], ["JD", 1, "京东 ADR"], ["BIDU", 1, "百度 ADR"], ["NTES", 1, "网易 ADR"], ["TCOM", 1, "携程 ADR"], ["NIO", 1, "蔚来 ADR"], ["XPEV", 1, "小鹏 ADR"], ["LI", 1, "理想 ADR"], ["EEM", 0.3, "新兴市场 ETF", "中国约占三成"], ["VWO", 0.3, "新兴市场 ETF", "中国约占三成"], ["IEMG", 0.3, "新兴市场 ETF", "中国约占三成"], { s: "COPX", c: 0.3, l: "铜矿 ETF", b: "中国需求敏感（经验 0.3）", us: 1 }, { s: "FCX", c: 0.3, l: "自由港", b: "中国需求敏感（经验 0.3）", us: 1 }],
    longTools: [d("FXI", "中国大盘 ETF"), d("KWEB", "中概互联网 ETF"), lev("YINN", "中国大盘 3× ETF", 3)], shortTools: [inv("YANG", "中国大盘 -3× ETF", 3), inv("FXP", "中国 -2× ETF", 2), put("FXI"), put("KWEB")] },
  { id: "korea-equity", label: "韩国股市", kind: "country", description: "MSCI 韩国：约五成为存储双雄，其余为汽车、金融、互联网等。",
    members: [["EWY", 1, "韩国股市 ETF", "MSCI 韩国"], lv("KORU", 3, "韩国 3× ETF"), ["CPNG", 1, "Coupang", "韩国电商"]],
    longTools: [d("EWY", "韩国 ETF", "唯一常用的美股上市韩国 ETF"), lev("KORU", "韩国 3× ETF", 3)], shortTools: [put("EWY"), rel("DRAM", "存储 ETF（作为反向参照）", 0.5, "看空韩国时若持有 DRAM 多头，约可抵消其存储部分")] },
  { id: "japan-equity", label: "日本股市", kind: "country", description: "日本大盘与日元对冲版本。",
    members: [["EWJ", 1, "日本股市 ETF"], ["DXJ", 1, "日本股市（日元对冲）ETF"], ["BBJP", 1, "日本股市 ETF"], lv("EWV", -2, "日本 -2× ETF"), { s: "TM", c: 1, l: "丰田 ADR", us: 1 }, { s: "SONY", c: 1, l: "索尼 ADR", us: 1 }, { s: "MUFG", c: 1, l: "三菱日联 ADR", us: 1 }],
    longTools: [d("EWJ", "日本股市 ETF"), d("DXJ", "日本股市（日元对冲）ETF")], shortTools: [inv("EWV", "日本 -2× ETF", 2), put("EWJ")] },
  { id: "india-equity", label: "印度股市", kind: "country", description: "印度大盘与中小盘。",
    members: [["INDA", 1, "印度股市 ETF"], ["EPI", 1, "印度盈利 ETF"], ["INDY", 1, "印度 Nifty 50 ETF"], ["SMIN", 1, "印度小盘 ETF"], { s: "INFY", c: 1, l: "Infosys ADR", us: 1 }, { s: "HDB", c: 1, l: "HDFC 银行 ADR", us: 1 }, { s: "IBN", c: 1, l: "ICICI 银行 ADR", us: 1 }, { s: "WIT", c: 1, l: "Wipro ADR", us: 1 }],
    longTools: [d("INDA", "印度股市 ETF"), d("EPI", "印度盈利 ETF")], shortTools: [put("INDA")] },
  { id: "taiwan-equity", label: "台湾股市", kind: "country", description: "MSCI 台湾：台积电约占五成。",
    members: [["EWT", 1, "台湾股市 ETF"], { s: "TSM", c: 0.5, l: "台积电 ADR", b: "台湾指数权重约五成", us: 1 }],
    longTools: [d("EWT", "台湾股市 ETF")], shortTools: [put("EWT"), put("TSM", 0.5)] },
  { id: "europe-equity", label: "欧洲股市", kind: "country", description: "欧洲大盘与主要国家。",
    members: [["VGK", 1, "欧洲股市 ETF"], ["EZU", 1, "欧元区 ETF"], ["FEZ", 1, "欧元区 50 ETF"], ["IEUR", 1, "欧洲股市 ETF"], ["EWG", 1, "德国股市 ETF"], ["EWU", 1, "英国股市 ETF"], ["EWQ", 1, "法国股市 ETF"], ["EWI", 1, "意大利股市 ETF"], ["EWP", 1, "西班牙股市 ETF"], lv("EPV", -2, "欧洲 -2× ETF")],
    longTools: [d("VGK", "欧洲股市 ETF"), d("FEZ", "欧元区 50 ETF")], shortTools: [inv("EPV", "欧洲 -2× ETF", 2), put("VGK")] },
  { id: "em-equity", label: "新兴市场", kind: "country", description: "新兴市场整体。",
    members: [["EEM", 1, "新兴市场 ETF"], ["VWO", 1, "新兴市场 ETF"], ["IEMG", 1, "新兴市场 ETF"], lv("EDC", 3, "新兴市场 3× ETF"), lv("EDZ", -3, "新兴市场 -3× ETF"), lv("EEV", -2, "新兴市场 -2× ETF")],
    longTools: [d("EEM", "新兴市场 ETF"), d("VWO", "新兴市场 ETF")], shortTools: [inv("EDZ", "新兴市场 -3× ETF", 3), inv("EEV", "新兴市场 -2× ETF", 2), put("EEM")] },
  { id: "latam-equity", label: "拉美股市", kind: "country", description: "巴西、墨西哥与拉美。",
    members: [["ILF", 1, "拉美 ETF"], ["EWZ", 1, "巴西股市 ETF"], ["EWW", 1, "墨西哥股市 ETF"], lv("BRZU", 2, "巴西 2× ETF")],
    longTools: [d("ILF", "拉美 ETF"), d("EWZ", "巴西股市 ETF")], shortTools: [put("EWZ")] },
  { id: "intl-developed", label: "发达市场（美国以外）", kind: "country", description: "EAFE：欧洲、日本、澳洲等。",
    members: [["EFA", 1, "发达市场 ETF"], ["VEA", 1, "发达市场 ETF"], ["IEFA", 1, "发达市场 ETF"], lv("EFU", -2, "发达市场 -2× ETF"), lv("EFZ", -1, "发达市场 -1× ETF")],
    longTools: [d("EFA", "发达市场 ETF"), d("VEA", "发达市场 ETF")], shortTools: [inv("EFZ", "发达市场 -1× ETF", 1), inv("EFU", "发达市场 -2× ETF", 2), put("EFA")] },
  // ---- 利率、汇率、加密、波动率 ----
  { id: "rates-duration", label: "美债久期（利率下行受益）", kind: "rates", description: "以 TLT 久期为 1 的相对久期敞口：利率下行获利、上行亏损；建筑商、REIT、公用事业为利率敏感的相关工具。",
    members: [["TLT", 1, "20 年以上美债 ETF", "久期基准（约 16–17 年）"], ["VGLT", 1, "长期美债 ETF"], ["EDV", 1.4, "超长久期美债 ETF", "久期约 24 年"], ["ZROZ", 1.5, "零息长债 ETF", "久期约 26 年"], ["IEF", 0.45, "7–10 年美债 ETF", "久期约 7.5 年"], ["SHY", 0.1, "1–3 年美债 ETF", "久期约 1.9 年"], ["BND", 0.35, "美国债券 ETF", "久期约 6 年"], ["AGG", 0.35, "美国债券 ETF", "久期约 6 年"], ["VCIT", 0.4, "中期公司债 ETF", "久期约 6 年"], ["TIP", 0.4, "通胀保值债 ETF", "实际利率久期约 7 年"], lv("TMF", 3, "长债 3× ETF"), lv("TMV", -3, "长债 -3× ETF"), lv("TBT", -2, "长债 -2× ETF"), lv("TBF", -1, "长债 -1× ETF"),
      { s: "ITB", c: 0.4, l: "建筑商 ETF", b: "利率下行利好建筑商（经验 0.4）", us: 1 }, { s: "XHB", c: 0.4, l: "住宅建筑 ETF", b: "利率敏感（经验 0.4）", us: 1 }, { s: "VNQ", c: 0.4, l: "房地产 ETF", b: "REIT 利率敏感（经验 0.4）", us: 1 }, { s: "XLRE", c: 0.4, l: "房地产板块 ETF", b: "REIT 利率敏感（经验 0.4）", us: 1 }, { s: "IYR", c: 0.4, l: "房地产 ETF", b: "REIT 利率敏感（经验 0.4）", us: 1 }, { s: "XLU", c: 0.3, l: "公用事业 ETF", b: "类债券资产（经验 0.3）", us: 1 }],
    longTools: [d("TLT", "20 年以上美债 ETF"), lev("TMF", "长债 3× ETF", 3)], shortTools: [inv("TBT", "长债 -2× ETF", 2), inv("TBF", "长债 -1× ETF", 1), put("TLT")] },
  { id: "usd", label: "美元", kind: "fx", description: "美元指数；黄金与新兴市场通常与美元反向。",
    members: [["UUP", 1, "美元指数 ETF"], lv("UDN", -1, "美元指数反向 ETF"), ["FXE", -1, "欧元 ETF", "欧元升值 = 美元贬值"], ["FXY", -1, "日元 ETF", "日元升值 = 美元贬值"], ["GLD", -0.3, "黄金 ETF", "金价与美元反向（经验 -0.3）"], ["EEM", -0.3, "新兴市场 ETF", "新兴市场与美元反向（经验 -0.3）"]],
    longTools: [d("UUP", "美元指数 ETF")], shortTools: [inv("UDN", "美元指数反向 ETF", 1), d("FXE", "欧元 ETF")] },
  { id: "crypto", label: "加密资产", kind: "crypto", description: "比特币/以太坊现货或期货 ETF 及相关股票（矿企、交易所、持币公司）。",
    members: [["IBIT", 1, "比特币 ETF"], ["FBTC", 1, "比特币 ETF"], ["GBTC", 1, "比特币信托"], ["BITO", 1, "比特币期货 ETF", "展期成本"], ["ETHA", 1, "以太坊 ETF"], ["ETHE", 1, "以太坊信托"], ["BITQ", 1, "加密经济 ETF"], lv("BITX", 2, "比特币 2× ETF"), lv("BITI", -1, "比特币 -1× ETF"), lv("ETHU", 2, "以太坊 2× ETF"),
      { s: "MSTR", c: 1.5, l: "Strategy（原 MicroStrategy）", b: "比特币持仓杠杆化（经验 1.5）", us: 1 }, { s: "COIN", c: 1, l: "Coinbase", b: "交易量随币价", us: 1 }, { s: "MARA", c: 1.5, l: "MARA（矿企）", b: "矿企弹性约 1.5", us: 1 }, { s: "RIOT", c: 1.5, l: "Riot（矿企）", b: "矿企弹性约 1.5", us: 1 }, { s: "CLSK", c: 1.5, l: "CleanSpark（矿企）", b: "矿企弹性约 1.5", us: 1 }, { s: "HOOD", c: 0.5, l: "Robinhood", b: "加密交易收入占比", us: 1 }],
    longTools: [d("IBIT", "比特币 ETF"), d("BITO", "比特币期货 ETF", "展期成本"), rel("MSTR", "Strategy", 1.5, "杠杆化比特币敞口，另含股票 β")], shortTools: [inv("BITI", "比特币 -1× ETF", 1), put("IBIT"), put("MSTR", 1.5)] },
  { id: "volatility", label: "波动率（VIX）", kind: "volatility", description: "VIX 期货产品；与美股负相关，长期衰减。",
    members: [["VXX", 1, "VIX 短期期货 ETN"], ["VIXY", 1, "VIX 短期期货 ETF"], ["VIXM", 0.5, "VIX 中期期货 ETF", "中期期货敏感度约 0.5"], lv("UVXY", 1.5, "VIX 1.5× ETF"), lv("UVIX", 2, "VIX 2× ETF"), lv("SVXY", -0.5, "VIX -0.5× ETF"), lv("SVIX", -1, "VIX -1× ETF")],
    longTools: [lev("UVXY", "VIX 1.5× ETF", 1.5), d("VXX", "VIX 短期期货 ETN")], shortTools: [inv("SVXY", "VIX -0.5× ETF", 0.5), inv("SVIX", "VIX -1× ETF", 1)] },
];

type MemberObject = { s: string; c: number; l?: string; b?: string; us?: number | null; bm?: HedgeBenchmark };
const isTuple = (raw: Member): raw is readonly [string, number, string?, string?] => Array.isArray(raw);
function buildCatalog() {
  const profiles = new Map<string, InstrumentProfile>();
  const themes: ExposureTheme[] = [];
  for (const def of THEME_DEFS) {
    const members: string[] = [];
    for (const raw of def.members) {
      const mem: MemberObject = isTuple(raw) ? { s: raw[0], c: raw[1], l: raw[2], b: raw[3] } : raw;
      const profile: InstrumentProfile = profiles.get(mem.s) ?? { label: mem.l ?? mem.s, memberships: [] };
      if (profile.label === mem.s && mem.l) profile.label = mem.l;
      if (!profile.memberships.some(x => x.theme === def.id)) profile.memberships.push({ theme: def.id, coefficient: mem.c, basis: mem.b ?? (def.id === "us-equity" ? "美股上市 ETF，市场 β 敞口" : def.label) });
      const usCoefficient = mem.us === undefined ? (def.kind === "sector" ? 1 : null) : mem.us;
      const existing = profile.memberships.find(x => x.theme === "us-equity");
      if (def.id !== "us-equity" && usCoefficient !== null) {
        if (!existing) profile.memberships.push({ theme: "us-equity", coefficient: usCoefficient, basis: mem.us === undefined ? "美股上市，市场 β 敞口" : `美股上市，市场 β 系数 ${usCoefficient}` });
        else if (mem.us !== undefined) { existing.coefficient = usCoefficient; existing.basis = `美股上市，市场 β 系数 ${usCoefficient}`; }
      }
      const benchmark = mem.bm ?? def.benchmark;
      if (!profile.benchmark && benchmark) profile.benchmark = benchmark;
      profiles.set(mem.s, profile);
      members.push(mem.s);
    }
    themes.push({ id: def.id, label: def.label, kind: def.kind, description: def.description, benchmark: def.benchmark ?? null, longTools: def.longTools, shortTools: def.shortTools, members });
  }
  for (const profile of profiles.values()) if (!profile.benchmark && profile.memberships.some(x => x.theme === "us-equity")) profile.benchmark = "SPY";
  return { themes, profiles: Object.fromEntries(profiles) as Record<string, InstrumentProfile> };
}
const catalog = buildCatalog();
export const EXPOSURE_THEMES: readonly ExposureTheme[] = catalog.themes;
export const INSTRUMENT_PROFILES: Record<string, InstrumentProfile> = catalog.profiles;
export const themeById = (id: string): ExposureTheme | undefined => EXPOSURE_THEMES.find(t => t.id === id);
export const UNLISTED_PROFILE: InstrumentProfile = { label: "美股个股（目录外，按美股权益处理）", benchmark: "SPY", memberships: [{ theme: "us-equity", coefficient: 1, basis: "目录外符号默认按美股个股：只计入市场 β；若属于某主题请补充目录" }] };
export const instrumentProfile = (symbol: string): InstrumentProfile => INSTRUMENT_PROFILES[symbol] ?? UNLISTED_PROFILE;

export interface ExposureThresholds { neutralBand: number; significantToEquity: number; balanceRatios: number[]; concentrationToEquity: number; expiryWarnDays: number; expiryUrgentDays: number; optionLot: number; definedLossToEquityLimit: number }
export const EXPOSURE_THRESHOLDS: ExposureThresholds = { neutralBand: 0.10, significantToEquity: 0.20, balanceRatios: [0.25, 0.5, 1], concentrationToEquity: 0.25, expiryWarnDays: 10, expiryUrgentDays: 3, optionLot: 100, definedLossToEquityLimit: 0.05 };
export interface ExposureRule { id: "R1" | "R2" | "R3" | "R4" | "R5"; title: string; condition: string; action: string }
export const EXPOSURE_RULES: readonly ExposureRule[] = [
  { id: "R1", title: "大量空头 → 配置部分同主题多头", condition: "某主题净空头绝对值 ≥ 净资产 × significantToEquity，且同主题多头不足空头的 25%", action: "按 25%–50% 比例配置同主题多头工具（目录 longTools），或减少空头张数；多头工具若含其他主题系数，须同时计入附带敞口" },
  { id: "R2", title: "大量正股多头 → 下跌时备兑认购或买入认沽", condition: "美股权益净多头 ≥ 净资产 × significantToEquity，且最新日报判断为风险偏好下降/分化，或用户自行判断市场下跌", action: "对 ≥ 100 股的持仓卖出认购（备兑）或买入认沽；股数不足一张时改用指数认沽、反向 ETF 或减仓（见 R4）；未触发下跌判断时列为备用方案" },
  { id: "R3", title: "跨资产关系对冲", condition: "商品/国家/行业主题存在显著单向敞口，且目录内有经济关系相反的工具（如 UCO ↔ JETS、EWY ↔ DRAM）", action: "工具名义 = 目标 ÷ |关系系数|；同时列出该工具附带的其他主题敞口（如 JETS 的美股 β），并说明基差风险：油价因需求衰退下跌时航空股不一定受益" },
  { id: "R4", title: "指数对冲定量", condition: "需要以指数认沽或反向 ETF 对冲美股权益多头", action: "目标 = β 调整净敞口 × 对冲比例；认沽张数 = 目标 ÷（指数价 × 100 × |Delta|）；反向 ETF 股数 = 目标 ÷ 价格；一张就超过目标时优先反向 ETF 或减仓" },
  { id: "R5", title: "限定风险结构以最大亏损控制", condition: "价差、买入期权等结构已限定最大亏损", action: "可不对冲 Delta，而把“已限定最大亏损合计 ÷ 净资产”控制在 definedLossToEquityLimit 以内；超过时减少张数或缩小价差宽度" },
];
export const EXPOSURE_METHOD = {
  version: "risk-exposure-method-v1",
  title: "持仓多空方向与风险敞口的结构化判断流程",
  steps: [
    "1. 输入：全部真实账户持仓（代码、数量、合约规模、成本）、实时报价与期权 Delta、券商报告净资产、主题目录、最新市场日报判断。",
    "2. 逐腿 Delta 名义：股票 = 数量 × 价格；期权 = 数量 × 合约规模 × Delta × 标的价格；买入认沽/卖出认购为看空，买入认购/卖出认沽为看多。缺少 Delta 或报价的腿标记为待核算，不推定。",
    "3. 按标的分组识别结构与最大亏损：单腿、垂直价差、跨式/宽跨式、备兑认购、保护性认沽；限定风险结构记录最大亏损（买入期权 = 权利金，借方价差 = 净支出，贷方价差 = 价差宽度 − 净权利金）；股票空头与未备兑卖出认购标记为无上限。",
    "4. 主题映射：每个标的按目录映射到一个或多个主题及系数（杠杆倍数、指数权重或跨资产经验系数）；主题敞口 = Σ 分组 Delta 名义 × 系数；美股权益另按历史 β 调整并对照 SPY/IWM/QQQ。",
    "5. 主题多空判定：多头、空头、净、毛、覆盖率；状态 = 多头未对冲 / 空头未对冲（独立方向性头寸）/ 部分对冲 / 反向仓位超过多头 / 接近中性；|净| ≥ 净资产 × 20% 视为“大量”。",
    "6. 平衡规则 R1–R5（见 rules）：大量空头配置部分同主题多头；大量正股在下跌判断下备兑或买入认沽；跨资产关系对冲并计入附带敞口；指数对冲按 β 与 Delta 定量；限定风险结构按最大亏损占比控制。",
    "7. 输出：总体方向、每个主题的状态与数字、未平衡清单、建议动作（工具、数量、价格、依据、附带敞口、注意事项）、假设与缺失项。结论只是参考，不下单；下单前用实际合约 Greeks 与流动性复核。",
  ],
  thresholds: EXPOSURE_THRESHOLDS,
  rules: EXPOSURE_RULES,
  promptTemplate: "你是投资组合风险分析助手。请严格按 method.steps 的顺序分析 data 中的持仓：先复核每条腿的 Delta 名义与结构识别，再按 catalog 的主题与系数汇总每个主题的多空敞口，判断状态并应用 rules（R1–R5）。输出：1）总体多空方向及依据；2）每个主题的多头/空头/净敞口与状态；3）未对冲或超额对冲的敞口清单；4）建议的平衡/对冲动作（工具、数量、价格、附带的其他主题敞口、基差风险）；5）假设与缺失项。不要编造数据，缺失项直接列出；所有数量必须给出计算过程。catalog 未覆盖的标的，请按你自己的知识补充主题归属与系数，并明确标注为“推断”，不要当作目录事实。",
} as const;
