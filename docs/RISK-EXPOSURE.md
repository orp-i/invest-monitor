# 风险敞口分析（总览）

上线日期：2026-09-23。位置：总览页“整体投资与盈亏”下方的“风险敞口分析”。接口：`GET /api/risk-exposure`、`GET /api/risk-exposure/reference`。代码：`packages/domain/src/exposure-catalog.ts`（主题目录、规则、方法文本）、`packages/domain/src/risk-exposure.ts`（分析、平衡动作、参考包）、`apps/server/src/risk-exposure.ts`（组合数据源）、`apps/web/src/RiskExposure.tsx`（页面）。

目标是回答三个问题：当前持仓的总体多空方向；哪些风险敞口没有对冲；应如何设置一部分平衡/对冲仓位。分析结果只是参考，不下单。

## 1. 概念与来源

- **风险敞口**：未加保护、暴露在某个风险因子下的头寸部分。多空组合里常用 **净敞口 = 多头 − 空头** 衡量方向性风险，**毛敞口 = 多头 + |空头|** 衡量杠杆程度，两者都以净资产（NAV）为分母表示；净敞口 60% 多 / 40% 空即净 20%、毛 100%（[Investopedia: Net Exposure](https://www.investopedia.com/terms/n/net-exposure.asp)、[CFI](https://corporatefinanceinstitute.com/resources/wealth-management/net-exposure)、[Wall Street Oasis](https://www.wallstreetoasis.com/forum/hedge-fund/hedge-fund-net-vs-gross-exposures)）。
- **Delta 名义（Delta-adjusted exposure / dollar delta）**：把期权折算为“等效股数”：股票 Delta = 1，其 Delta 名义就是市值；期权 Delta 名义 = 数量 × 合约规模 × Delta × 标的价格。10 张 Delta 0.5 的 IBM 认购、IBM 100 美元，Delta 名义 = 500 美元（[Northstar Risk: Delta Exposure](https://www.northstarrisk.com/delta-exposure)、[Khalid Naami: Delta-Adjusted Exposure](https://khalidnaami.com/blog/options-delta-adjusted-exposure-true-risk)）。
- **β 加权与对冲比例**：组合 β = 各持仓市值权重 × β 之和；对冲用指数工具时，先把敞口按 β 换算到基准（500k × 1.15 = 575k），再除以指数价 × 100 × |认沽 Delta| 得到张数；一个 -0.30 Delta 的认沽要比 Delta-1 工具多约 3.3 倍张数；100% 对冲是例外而非默认，25%/50% 部分对冲更常见，保护成本约每年 3%–5%（[Cboe: right-size hedges via beta weighting](https://www.cboe.com/insights/posts/how-to-right-size-hedges-via-beta-weighting-with-xsp-options/)、[GNG Research: Hedging the whole book](https://www.gngresearch.com/articles/4ab1efbb-7c9b-4882-82dc-5b8f99051477/)、[TradeStation: beta hedging](https://www.tradestation.com/learn/options-education-center/the-hidden-threat-in-your-portfolio-how-beta-shows-actual-market-risk/)）。
- **对冲工具**：保护性认沽、认沽价差（降低成本但限定保护区间）、领口（卖认购换认沽，封顶上涨）、反向 ETF 与期货（每日重置、路径依赖）；对冲有成本，且工具与持仓不同时存在**基差风险**（[ProShares: hedging strategies](https://www.proshares.com/browse-all-insights/insights/part-ii-strategies-for-hedging-your-portfolio)、[Swan: put spread collar](https://www.swanglobalinvestments.com/what-is-a-put-spread-collar/)、[StoneX: cross hedge](https://www.stonex.com/en-us/business/financial-glossary/cross-hedge/)）。
- **跨资产关系**：EWY 中 SK 海力士 + 三星电子合计约五成（2026 年，[stockanalysis: EWY holdings](https://stockanalysis.com/etf/ewy/holdings/)、[24/7 Wall St.](https://247wallst.com/investing/2026/05/12/this-boring-country-etf-is-secretly-a-high-octane-ai-hardware-trade/)），因此韩国 ETF 同时是存储芯片敞口；航空燃油约占航空营业成本三成（2026 年）且油价与航空股反向，但“油价为何下跌”决定航空能否受益（[U.S. Global ETFs: oil and JETS](https://usglobaletfs.com/news-archive/oil-prices-and-airline-stocks-how-jets-is-reacting/)、[IATA](https://www.iata.org/en/pressroom/2026-releases/06-07-middle-east-disruptions-high-fuel-prices-halve-airline-industry-profitability/)）。

## 2. 结构化判断流程（`EXPOSURE_METHOD`，版本 `risk-exposure-method-v1`）

1. **输入**：全部真实账户持仓（代码、数量、合约规模、成本）、Tradier 实时报价与期权 Delta、券商报告净资产、主题目录、最新 ready 市场日报判断。
2. **逐腿 Delta 名义**：股票 = 数量 × 价格；期权 = 数量 × 合约规模 × Delta × 标的价格。买入认沽/卖出认购为看空，买入认购/卖出认沽为看多。缺 Delta 或报价的腿标记“待核算”，不推定。
3. **按标的分组识别结构与最大亏损**：单腿、垂直价差（做多较高行权价为看空，认沽/认购同理）、跨式/宽跨式、备兑认购、保护性认沽；限定风险结构记录最大亏损（买入期权 = 权利金，借方价差 = 净支出，贷方价差 = 价差宽度 − 净权利金）；股票空头与未备兑卖出认购标记无上限。
4. **主题映射**：每个标的按目录映射到一个或多个主题及系数（杠杆倍数、指数权重或跨资产经验系数）；主题敞口 = Σ 分组 Delta 名义 × 系数；美股权益另按 250 日日收益回归得到的 β 调整，并对照 SPY/IWM/QQQ。
5. **主题多空判定**：多头、空头、净、毛、覆盖率；状态 = 多头未对冲 / 空头未对冲（独立方向性头寸）/ 部分对冲 / 反向仓位超过多头（净空）/ 接近中性（|净| ≤ 毛 × 10%）；|净| ≥ 净资产 × 20% 视为“大量”。
6. **平衡规则**：
   - **R1 大量空头 → 配置部分同主题多头**：按 25%–50% 配置目录 longTools，或减少空头张数；多头工具若含其他主题系数，须计入附带敞口。
   - **R2 大量正股多头 → 下跌时备兑认购或买入认沽**：对 ≥ 100 股的持仓卖出认购或买入认沽；股数不足一张时改用指数认沽、反向 ETF 或减仓；最新日报为“风险偏好下降”时列为建议执行，否则为备用方案。
   - **R3 跨资产关系对冲**：工具名义 = 目标 ÷ |关系系数|（如 UCO 看多油价 ↔ JETS 系数 -0.3），同时列出附带的其他主题敞口（JETS 的美股 β、旅游主题）与基差风险。
   - **R4 指数对冲定量**：目标 = β 调整净敞口 × 对冲比例；认沽张数 = 目标 ÷（指数价 × 100 × |Delta|）；反向 ETF 股数 = 目标 ÷ 价格；一张就超过目标时优先反向 ETF 或减仓。
   - **R5 限定风险结构以最大亏损控制**：可不对冲 Delta，而把“限定风险期权结构的最大亏损合计 ÷ 净资产”控制在 5% 以内。
7. **输出**：总体方向、每个主题的状态与数字、未平衡清单、建议动作（工具、数量、价格、依据、附带敞口、注意事项）、假设与缺失。

阈值在 `EXPOSURE_THRESHOLDS`：中性带 10%、“大量”20% NAV、对冲比例档 25%/50%/100%、集中度 25% NAV、到期提醒 10 天 / 紧急 3 天、期权一张 100 股、限定亏损上限 5% NAV。

## 3. 主题目录（`EXPOSURE_THEMES` / `INSTRUMENT_PROFILES`）

- 目录按主题定义成员列表，反推每个标的的多重归属：一个标的可同时属于多个主题（EWY = 韩国股市 1 + 存储芯片 0.5；DRAM = 存储 1 + 半导体 1 + 美股 β 1；JETS = 旅游航空 1 + 原油 -0.3 + 美股 β 1；GDX = 金矿股 1 + 黄金 1.5 + 美股 β 0.5）。行业类主题的成员默认带美股 β 1；杠杆/反向 ETF 按每日目标倍数计（SOXL 3、SQQQ -3、UCO 2）；国家/商品/利率/加密/波动率主题不自动带美股 β。
- 覆盖：美股市场 β；科技/半导体/存储芯片/AI 基础设施/软件云/网络安全/互联网平台/支付金融科技/电动车/清洁能源/铀核能/锂电/机器人/太空/量子/网络设备；金融大行、区域银行、信用债；医疗、生物科技；可选消费、零售、必需消费、旅游航空邮轮、住房建筑商、媒体通信；工业、航空航天国防、运输、基建；材料、钢铁、铜、稀土关键矿产、金矿股、黄金、白银、铂钯、农产品；能源股、原油、天然气；公用事业、房地产 REIT；中国、韩国、日本、印度、台湾、欧洲、新兴、拉美、发达市场；美债久期、美元、加密资产、波动率。共 40 余个主题、400 余个常见代码。
- 每个主题列出 longTools / shortTools：直接工具、杠杆/反向 ETF、相关工具（跨资产）、认沽期权、备兑/保护性认沽（`*` 表示作用于持仓本身）。关系系数（航空 -0.3、能源股 0.5、金矿 1.5、REIT 对久期 0.4 等）是经验设定，可在目录里修改，不是市场数据。
- 目录外符号默认只计入美股市场 β，并在假设中提示补充目录；给 LLM 的提示模板要求模型对目录外标的按自身知识补充归属并标注“推断”。

## 4. 数据来源与口径

- 持仓：`/api/brokers` 的非 sandbox 账户（IBKR Flex、Tradier、大象结单）。仅 USD 的股票/期权纳入；其他币种、其他资产类型列入缺失。
- 报价与 Delta：Tradier `markets/quotes`（live 环境带 Greeks），与总览其他报价共享 30 秒缓存和 Token 配额；一次分析请求全部持仓、标的、基准和涉及主题的工具代码（每批 ≤ 50）。无最近成交价时用买卖中间价，再无则用券商报告价并注明。
- β：持仓标的用本地已采集的 Tradier 日 K（`held-*` 标的，320 根内）；基准 SPY/IWM/QQQ 与未配置采集的标的（如期权标的 DRAM）用 Tradier `markets/history`（服务端缓存 6 小时）；共同日期的对数收益 OLS，最多 250 个样本，少于 60 个不估算；β 结果缓存 6 小时，读取失败 5 分钟后重试。缺 β 的美股标的按 β = 1 计入并列入假设。
- 净资产：与总览一致的 `currentPerformance().equity`（各账户券商报告净资产之和，含现金）。
- 市场判断：最近 45 天内最新一篇 ready 日报的 `stance`；`risk-off` 触发 R2 的“建议执行”，其余为备用。
- 毛敞口按标的分组的净 Delta 名义绝对值相加（同标的多腿先轧差）；总体方向以美股权益 β 调整净敞口为主视角，不同主题之间不互相抵消；主题敞口可能因多重归属而重复计入不同主题。
- Delta 名义是一阶瞬时敏感度，不含 Gamma/Vega/Theta；期权真实盈亏不能由标的日 K 反推。最大亏损不含手续费、提前指派与流动性风险。

## 5. 页面与导出

- 总览卡片：总体方向判语、四项指标（多头/空头 Delta 名义、净敞口与占比、限定风险最大亏损）、主题敞口表（点击展开构成与系数依据）、标的明细（结构、Delta、最大亏损、到期、主题归属、β）、发现清单、平衡/对冲动作参考（对冲比例 25/50/100%、认沽 |Delta| 假设可调，页面内重算）、判断方法与数据来源折叠。
- “导出参考包 JSON”下载 `riskExposureReference`：方法步骤/规则/阈值、涉及主题的目录切片、全部数据与 Markdown；“复制 Markdown 给 LLM”复制同一 Markdown（含提示模板）。`GET /api/risk-exposure/reference` 返回同样的包，`?ratio=&putDelta=` 可指定参数。
- 页面在挂载、券商数据更新事件、标签页重新可见时刷新；首次需读取基准历史估算 β，可能数秒。

## 6. 限制与后续

- 认沽张数按“假设 |Delta|”定量，不读取期权链；下单前应以实际合约 Greeks 与流动性复核。备兑/保护性认沽要求 ≥ 100 股，当前账户多数持仓不足一张，页面会提示改用指数工具或减仓。
- 关系系数与 β 都是估计：β 只覆盖市场因子，个股特有风险需靠仓位上限；跨资产对冲（航空 vs 油价）在需求衰退型下跌中可能失效。
- 目录以常见美股上市 ETF 与个股为主，不含非美股市场直接交易的标的；目录维护在代码中，修改后需重建。
- 分析不写入数据库，也不记录历史；如需回看，用导出的参考包。

## 7. 验收

- 测试：`tests/workspace/risk-exposure.test.ts`（目录反推、结构识别、主题聚合、β 回归、R1–R5 定量、参考包、服务端组合、API 路由）。
- 上线时已在真实账户上完成只读核验（页面检查与桌面/手机布局，无写入）。
