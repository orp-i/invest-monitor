# 券商接入

四个券商走只读 API/报表同步，另有对账单 PDF 导入给没有可用 API 的券商补历史成交。全部只读：项目不具备下单、改单、撤单能力。凭证统一在网页"账号设置"（`#/settings`）配置，字段与加密方式见 [账号设置与 API](SETTINGS.md)；下面只讲每个券商各自的申请步骤和读取内容。

| 券商 | 接入方式 | 同步频率 | 读取内容 |
| --- | --- | --- | --- |
| [Tradier](#tradier) | REST API | 15 分钟 + 每个交易日收盘前 1 分钟 | 账户余额、持仓、逐笔成交 |
| [IBKR（盈透）](#ibkr盈透-flex-报表) | Flex Web Service 报表（XML） | 60 分钟 | 净资产（NAV）、持仓、逐笔成交 |
| [Charles Schwab](#charles-schwab) | Trader API（OAuth 2.0） | 15 分钟 | 账户余额、持仓、逐笔成交 |
| [Alpaca](#alpaca) | Trading API | 15 分钟 | 账户余额、持仓、逐笔成交 |
| [对账单 PDF 导入](#对账单-pdf-导入) | 手动运行 CLI | 按需 | 历史持仓快照 + 历史成交 |

同步全部只读、只在配置了凭证后才会发起请求；未配置的券商在页面显示"尚未配置"，不影响其他券商和手工记账。

## Tradier

1. 在 [Tradier](https://tradier.com) 开一个账户（或用于测试的 sandbox 账户），在账户 API 设置里生成 Access Token。
2. 在"账号设置 → Tradier"填写 `TRADIER_ACCESS_TOKEN`；实盘账户选环境 `live`，sandbox 测试账户选 `sandbox`（行情延迟约 15 分钟）。
3. 保存后点击"测试连接"，或直接到"券商"页点击同步，确认能读到账户余额/持仓。

这个 Token 同时也是股票/ETF/期权**行情**（搜索、报价、期权链、日 K）的凭证，两者共用同一个限流配额（实盘每分钟 120 次、sandbox 每分钟 60 次，账户接口配额独立）。除了每 15 分钟的常规同步，项目还会在每个交易日**收盘前 1 分钟**额外只读同步一次，专门用来捕获当日的多腿订单（Tradier 的订单接口只能查到当前交易时段，历史订单查不到）。完整的行情接入细节、限流与时区处理见 [Tradier 行情接入](TRADIER-MARKET-DATA.md)。

## IBKR（盈透 Flex 报表）

IBKR 走的是 **Flex Web Service**，这是一种"按需生成报表"的只读接口，不是逐笔实时推送；同步频率是 60 分钟一次，读到的持仓/成交以 Flex 报表的**报表截止日**为准。

**第一步：生成 Token 和 Query**

1. 登录 IBKR 客户门户（Client Portal）→ Performance & Reports → Flex Queries。
2. 生成 Flex Web Service Token（有效期较长，妥善保存）。
3. 新建一个 Activity Flex Query，**Delivery Configuration 的 Format 必须设为 XML**（不是 CSV）。

**第二步：配置查询字段**

Open Positions：选 **Summary** 层级，至少勾选以下字段——

- `Conid`、`Symbol`、`Currency`、`Position`、`Cost Basis Money`、`Position Value`、`Unrealized P/L`

Trades：选 **Execution** 层级，至少勾选以下字段——

- `Trade ID`、`Symbol`、`Currency`、`Buy/Sell`、`Quantity`、`Trade Price`、`IB Commission`、`Date/Time`、`Asset Class`

账户资金（净资产/现金）另外需要：

- **Net Asset Value (NAV) Summary in Base** 全部字段
- **Account Information** 里的 `Base Currency`

保存每个栏目，再保存整个查询，记下 Query ID（数字编号）。

**第三步：填入账号设置**

在"账号设置 → 盈透 IBKR"填写 `IBKR_FLEX_TOKEN` 和 `IBKR_FLEX_QUERY_ID`（纯数字）。同一个 Query ID 之后修改字段可以直接重新同步；如果新建了一个查询，需要把服务器里的 Query ID 也换成新的。

IBKR 官方要求请求携带客户端技术及版本的 User-Agent，本项目固定使用 `Node/24`，不需要用户配置。请求经 `BROKER_EGRESS_PROXY_URL`（账号设置"网络出口"分组）出站，留空则直连。

**已知限制**：Flex 报表不含订单号（`ibOrderID`），因此 IBKR 的成交目前无法像 Tradier 一样做自动开平仓证据配对，多腿策略识别依赖持仓/成交本身的字段与用户手动确认；报表口径为"报表截止日"而非精确到秒的成交时间。官方配置说明：<https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm>。

## Charles Schwab

Schwab 用官方 **Trader API**，OAuth 2.0 授权，刷新令牌**有效期 7 天**，到期前需要重新走一遍授权。

**第一步：注册开发者应用**

1. 在 [Schwab 开发者门户](https://developer.schwab.com/products/trader-api--individual) 注册一个个人开发者账户，创建一个 Trader API 应用。
2. 记下应用的 **App Key**（即 `client_id`）和 **App Secret**（即 `client_secret`）。
3. 登记一个 **Callback URL**（例如 `https://127.0.0.1`），这个地址必须和账号设置里填的 `SCHWAB_REDIRECT_URI` 完全一致（协议、主机、路径逐字符匹配）。应用审核通过前可能有额外等待时间，以 Schwab 官方流程为准。

**第二步：账号设置里完成 OAuth 授权**

1. 在"账号设置 → 嘉信 Charles Schwab"填写 `SCHWAB_APP_KEY`、`SCHWAB_APP_SECRET` 和回调地址（`SCHWAB_REDIRECT_URI`，默认 `https://127.0.0.1`），保存。
2. 点击"获取授权链接"，在新打开的窗口登录 Schwab 并同意授权。
3. 授权后浏览器会跳转到回调地址——**这个地址通常打不开是正常现象**（它不需要真的有服务在监听），需要的是跳转后地址栏里的完整 URL。
4. 把这个完整 URL 粘贴回页面，点击"完成授权"，服务端会用其中的授权码换取刷新令牌并加密保存。

也可以完全用接口走这个流程（`GET /api/settings/schwab/authorize-url` + `POST /api/settings/schwab/exchange`），见 [账号设置与 API](SETTINGS.md)。

**刷新令牌到期**：页面会在令牌临近/超过 7 天有效期时提示"需要重新授权"，重复上面第二步的 2–4 即可，不需要重新填 App Key/Secret。

## Alpaca

1. 在 [Alpaca](https://alpaca.markets) 控制台生成一对 API Key（`ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY`）；如果只是想先试用，可以用 paper（模拟）环境的 Key。Secret 通常只显示一次，请妥善保存。
2. 在"账号设置 → Alpaca"填写两个 Key，环境选 `live`（实盘，`api.alpaca.markets`）或 `paper`（模拟，`paper-api.alpaca.markets`）——paper Key 只能配 `paper` 环境。
3. 建议使用只读权限的 Key（如果 Alpaca 账户支持按权限拆分 Key）；同步只读取账户、持仓与成交回报，不会调用下单接口。

官方文档：<https://docs.alpaca.markets/docs/trading-api>。

## 对账单 PDF 导入

给没有只读 API、或者需要补历史数据的券商准备的离线导入路径，通过命令行运行，不在网页里操作。目前经过验证、可以正确解析的版式有两种：**大象证券**（Elephant，港股/美股经纪商，对账单为香港时间，导入时换算为 UTC）和 **Tradier 确认书**（只有交易日精度，无时分）。遇到没见过的版式，或者费用、数量、金额对不上，脚本会直接停止，不会猜测或补造数据。

原始 PDF 放在 `trade_file/` 目录（被 Git/Docker 忽略，不会进版本库）。依赖宿主机已安装的 [PyMuPDF](https://pymupdf.readthedocs.io/)。

```bash
# 1. 解析 PDF，输出结构化 JSON（默认只读，不碰数据库）
python3 scripts/parse-trade-statements.py trade_file data/import/parsed.json

# 2. 对指定数据库做预检（不加 --apply 时只打印将要新增的结单/成交/档案）
node scripts/import-trade-statements.mjs --input data/import/parsed.json --database /path/to/invest.sqlite

# 3. 确认无误后正式写入：先做一次 SQLite 在线备份，再在单个事务内写入
node scripts/import-trade-statements.mjs --input data/import/parsed.json \
  --database /path/to/invest.sqlite --apply --backup /path/to/new-backup.sqlite
```

脚本会核对每笔"数量 × 价格 × 乘数 = 成交金额"、逐项费用、买卖净现金与文件汇总是否吻合；成交的识别键包含账户归属、证券、方向、原始时间等字段（Tradier 另用 Tag Number 区分同日成交），重复导入同一批结单不会产生重复数据。支持增量续接：新的对账单如果是已有持仓的后续平仓，会按原成交归属并入已有交易档案（保留档案 id、复盘记录，只追加成交），除非归属跨越多个已有档案或与已有分组冲突，这种情况整批拒绝、不自动覆盖或合并。

无成交记录的对账单（例如某天没有任何交易）也可以导入，但要求包含完整的期初/期末资产摘要且不能有"成交表"字段——如果对账单里出现了成交表却解析不出具体行，脚本同样会停止，而不是当成零成交处理。

完整的解析规则、字段映射、去重与统计口径见 [交易复盘与结单导入](TRADING-REVIEW.md#结单导入)。

## 常见问题

**多个券商的同名持仓会重复吗**：不会，跨账户的同一合约只会创建一个关注标的；持仓归零后仍保留该标的方便查历史，不会自动删除。

**能不能只读部分数据（比如只要持仓不要成交）**：不能，四个 API 券商都是整体只读同步（余额 + 持仓 + 成交一起拉取），没有单项开关；如果不希望某个券商参与同步，不填写/清空其凭证即可。

**同步失败了怎么知道原因**：券商页和"账号设置"里对应分组的连接测试都会显示最近一次同步/测试的状态和消息（成功、失败原因、需要重新授权等），失败原因会持久化，重启服务后依然可查。

**为什么 IBKR 的自动多腿策略识别比 Tradier 弱**：因为 IBKR Flex 报表目前没有订单号字段，项目拿不到"这几笔成交属于同一个订单"的证据；Tradier 则利用官方的已平仓批次（`gainloss`）和当日订单接口为成交打开平标记，证据更完整。这个差异是数据源本身的限制，不是配置问题。
