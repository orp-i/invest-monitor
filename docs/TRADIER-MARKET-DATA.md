# Tradier 股票与期权行情

2026-09-05：美股主来源切换为 Tradier，复用服务器 `.env` 中的 `TRADIER_ACCESS_TOKEN` 和 `TRADIER_ENVIRONMENT`。AAPL 原标的 ID、手工交易和研究关联保持有效。Massive 适配代码作为停用的可选来源保留，当前不要求填写或购买 Massive Key。

## 功能与口径

- `tradier-stocks`：股票 / ETF 名称和代码搜索，约每 30 秒读取最新成交价、买卖价、开高低、昨收与成交量。使用 `GET /v1/markets/search` 和 `GET /v1/markets/quotes`。[搜索接口](https://docs.tradier.com/reference/brokerage-api-markets-get-search)、[报价字段](https://docs.tradier.com/docs/quotes)。
- `tradier-stocks-history`：`GET /v1/markets/history?interval=daily`，每 6 小时读取最近 365 天；新加入的 Tradier 股票自动关联这个独立调度来源。[历史接口](https://docs.tradier.com/reference/brokerage-api-markets-get-history)。
- 实盘 Token 请求 `api.tradier.com`，模拟 Token 请求 `sandbox.tradier.com`；同一个环境变量同时控制行情与账户同步。实盘行情类别为 realtime，模拟为 delayed，模拟报价过期阈值为 1200 秒，实盘为 120 秒。[官方时效说明](https://docs.tradier.com/docs/market-data)。
- 以 `last` 对应的 `trade_date` 判断时效，不用新买卖盘时间把旧成交价标为实时。休市期间，返回数据与最近成交时间一致且接收正常时显示“休市 · 最近成交”；停止接收、实际数据滞后和模拟延迟权限仍单独判断。无有效成交价时不使用零值或其他标的替代。
- 金额从 JSON 原始数字 token 转为十进制字符串，再进入现有 Decimal 核算；不经二进制浮点转换。手工账本的市值和浮动盈亏使用 Tradier 的原生 USD 报价，券商账户的报表盈亏仍保留原统计口径。
- 历史接口只有交易日期。日 K 的 UTC 起止时间代表日期桶，不代表实际开收盘时刻；仅纳入纽约日期早于今天的记录，防止未完成日 K 进入历史图。历史价格不保证股息复权，不作为已计算好的总回报率。[历史数据限制](https://docs.tradier.com/docs/historical-data)。
- `BRK/B` 等 Tradier 原生代码保留在 `providerSymbol`，内部和界面用 `BRK.B`，请求不会丢失股票类别。仅接收 stock / etf 搜索结果，期权使用 OCC 代码；原生期权根符号中的点号保留。

## 配置

```dotenv
TRADIER_ACCESS_TOKEN=
TRADIER_ENVIRONMENT=live
```

Token 为空时不向 Tradier 发起请求，股票页、期权页和搜索显示具体接入说明。填写后运行：

```bash
docker compose --env-file .env up -d --force-recreate --wait api web
```

行情自动采集；「券商」页的持仓、成交同步由用户点击触发。代码只读取券商数据。

Docker 部署可通过 `.env` 的 `DOCKER_EGRESS_PROXY_URL` 让行情与账户同步统一走一个本机代理（默认留空即直连）；构建与镜像下载可用 `DOCKER_BUILD_PROXY_URL`，详见存储与性能说明。

股票/期权报价、期权链、到期日、日 K、搜索、探测及重试按同一 HTTP 客户端和 Token 共用限速，每次请求至少间隔 1.1 秒；收到 429 后遵循 Retry-After，没有该字段时等待 60 秒。官方市场数据限额为实盘 120 次/分钟、模拟 60 次/分钟；账户接口使用独立限额。[官方限流说明](https://docs.tradier.com/docs/rate-limiting)。

请求限制在官方 HTTPS `/v1` 地址，不跟随重定向。Token 仅进入 Authorization header，不进入 URL、前端描述符、错误消息或 raw event。

## 验证

`npm run build` 和 `npm test` 通过，82 项测试 / 16 个文件。新增覆盖真实/模拟地址选择、凭证缺失、错误响应、十进制精度、成交时间、休市陈旧标记、搜索代码映射、日 K 日期与未完成数据过滤、共享限速、搜索新增自动关联历史源，以及手工持仓估值。测试使用标明用途的合成样本与临时 SQLite，不写入生产账本。

2026-09-05 线上验证：真实股票报价与 80 根历史日 K 可用，行情采集健康。报价保留上个交易日成交时间；后续已改为按最近成交与接收情况判断时效，周末正常接收时不再标为陈旧。账户同步与 PDF 结单导入见交易复盘说明。

## 2026-09-05：股票与期权统一来源

- 股票/ETF 搜索、自动采样、日 K，期权到期日、期权链、OCC 合约报价与日 K，均从 Tradier 获取。移除 Massive 期权占位配置。启用 Tradier 时停用 Massive 股票来源，已有 Massive 股票绑定运行时转成 Tradier，保留内部标的 ID 和交易关联。
- 期权页可输入标的代码，切换到期日、Call/Put、报价/Greeks，定位平值附近、分页，选择合约查看历史图；也可直接输入 OCC 合约代码。持仓与券商页批量读取 Tradier 成交报价，保留成交时间。券商报告的市值、净值、成本和盈亏不因新报价改写。
- 新增登录保护下的只读接口：`GET /api/options/expirations?symbol=AAPL`、`GET /api/options?symbol=AAPL&expiration=YYYY-MM-DD`、`GET /api/market/quotes?symbols=AAPL,OCC_SYMBOL`、`GET /api/market/history?symbol=OCC_SYMBOL`。报价最多 50 个代码一次；查询不发送账户 ID、成本和持仓数量。
- 报价/链缓存 30 秒、到期日/日 K 缓存 6 小时，相同并发查询合并；缓存最多 64 项，错误短暂缓存 5 秒。浏览器不可见时停止定时刷新。结果缓存只在服务器内存，不修改交易档案。
- 期权显示买卖价、最后成交、行权价、合约方向、成交量、未平仓量、实际合约规模及 Delta/Gamma/Theta/Vega/Rho/IV。有效的 0 买价、0 成交量保留；缺少字段为 null，不把未知合约规模默认为 100。最近成交时间、买卖价时间、Greeks 时间分别保留。
- 实盘 Greeks/IV 经 Tradier 转供 ORATS，约每小时更新；Sandbox 不提供 Greeks。Greeks 的 `updated_at` 没有时区时原样显示，不冒充带时区的瞬间。[官方行情时效](https://docs.tradier.com/docs/market-data)、[期权链接口](https://docs.tradier.com/reference/brokerage-api-markets-get-options-chains)。
- Tradier 不提供已到期期权的历史行情；页面明确提示，复盘和成交记录仍保留。历史日 K 不保证股息复权。[历史限制](https://docs.tradier.com/docs/historical-data)。
- 已用实盘 Token 验证股票报价、到期日、期权链（含 Greeks）与活跃合约日 K 可读；验证记录不含 Token。
- 自动验证：116 项测试；独立浏览器验收覆盖报价/Greeks、方向/到期日切换、平值定位、K 线、错误状态及 1440/1024/768/390 像素布局。以最终部署验收记录为准。


## 全券商持仓与 USD 盈亏

- IBKR、Tradier 与大象的非零股票/期权持仓自动创建关注标的。跨账户同名合约只创建一次，持仓归零后保留用户关注项。已有停用的用户持仓标的会重新启用。行情绑定仅使用 Tradier 报价和日 K。
- 券商未返回期权规模时，先从 Tradier 的该 OCC 合约报价核实；未确认前不猜乘数。首次启动、同步和定时任务补齐后自动加入。
- 大象依据最新结单期末持仓表导入，保留文件指纹、页码、截止日期；既有历史成交不直接推定成当前持仓。碎股采用结单成交金额（美元分舍入），保留原始单价。
- 大象美元资金按独立列示的投资资产净值和已交收资金相加；未交收资金已经包含于投资资产净值，不重复加。全部直接使用结单 USD 栏，不以 HKD 总额当 USD。
- 总览提供 USD 总净盈亏、已实现净盈亏、未实现净盈亏、手续费支出。交易先按唯一 ID 去重，单账户 Tradier API/结单再按代码、方向、数量、成交价、日期一对一匹配；正式结单包含佣金、交易费及附加费，优先采用完整费用。API commission 与结单佣金一致时不算冲突；佣金本身不一致才提示待核对。大象快照引用同一批结单成交，不重复进入复盘库。
- 净盈亏用已导入成交与当前持仓核算。买入和卖空的开仓费用均进入持仓成本，平仓时按数量释放；尚不能核算收益的成交，已知手续费仍计支出。闭合成交使用已验证现金金额，非闭合部分使用 Tradier 最近成交估值。现金划拨、净值变化不作为交易收益。
- 估值记录每 5 分钟落 SQLite `performance_history`，保留约一年；接口最近一周记录，界面可查看最近 20/40/80 个点。第一次上线前没有记录时不补造历史曲线；补充结单、持仓口径或可估值范围变化时划分新的曲线段。
- 缺成本、缺报价、费用币种不明、非 USD 缺汇率、已到期期权未确认结算时，总盈亏明确标为已知部分。已到期期权在后续结单确认到期/行权前，不推定为 0 持仓或 0 结算价。
- 费用口径：正式结单包含佣金、交易费及附加费，优先采用完整费用；成交详情保留 API 佣金原值与结单完整费用；重复的 API / 结单成交不再累加费用。


最终部署验收（2026-09-05 13:22 UTC）：测试与构建通过；线上各券商持仓均自动关注，原复盘 ID 保留。总览/券商/期权共 12 项桌面与手机布局通过，无 JavaScript 错误。报价、到期日、期权链及权限验证通过。

2026-09-05 更新：默认日 K，热加载 240 根、窗口 80 根，附带 MA5 / 15 / 30 / 200；日 K 查询范围扩至两年，用于补足均线种子。新增同到期日、行权价的 Call / Put 双图及逐日价格对照，分时图按需调用 Tradier Time & Sales。详情见 [图表说明](CHARTS.md)。

后续更新：显示数量滑块可调至 240 根；全关注股票自动并发采集、新增立即补采。黄金现货与 GLD ETF 分开。股票分时区分盘前/盘中/盘后/夜盘；夜盘覆盖未确认时不以旧报价替代。日 K 使用常规时段历史收盘价，异常 OHLC 按日跳过并提示。完整规则见 [图表说明](CHARTS.md)。
