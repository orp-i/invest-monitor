# 账号设置与 API

入口：网页 **账号设置**（`#/settings`）。用于配置券商只读同步凭证、市场日报 LLM 推理接口和出口代理；同一组接口也设计给 AI Agent / 脚本直接调用（见文末"AI Agent 使用流程"）。相关代码：`packages/domain/src/settings.ts`（分组/字段定义、校验、掩码）、`apps/server/src/secret-box.ts`（加密）、`apps/server/src/settings.ts`（接口实现）、`apps/web/src/SettingsWorkspace.tsx`（页面）。

## 优先级与覆盖规则

每个字段的生效值按以下顺序取第一个存在的：

1. **账号设置页保存的覆盖值**（加密存储在业务库）
2. **环境变量**（`.env` 或部署环境注入）
3. **内置默认值**（如 `TRADIER_ENVIRONMENT` 默认 `live`）

在页面或通过 `PUT` 接口把某个字段的值设为空字符串或 `null`，效果是**清除账号设置里的覆盖**，回退到环境变量/默认值，而不是把该字段"设置为空"。`DELETE` 则一次性清空整个分组的全部覆盖。

页面上每个字段旁边会标注当前来源（账号设置 / 环境变量 / 默认值 / 未配置），接口对应字段是 `source: "settings" | "env" | "default" | "none"`。

## 加密与密钥文件

密钥类字段（Token、API Key、App Secret 等，`kind: "secret"`）使用 **AES-256-GCM** 加密后存入业务库，密文格式为 `v1:<iv>:<authTag>:<ciphertext>`（均为 base64）。

密钥来源：

- 设置了 `SETTINGS_ENCRYPTION_KEY` 环境变量：直接使用（64 位十六进制字符串按原样使用；其他字符串会先做 SHA-256 归一化）。更换这个环境变量后，之前保存的密钥类账号设置会全部**无法解密**，需要重新填写（非密钥类字段不受影响）。
- 未设置：自动在数据库同目录生成一个密钥文件（默认文件名 `settings.key`，可用 `SETTINGS_KEY_FILE` 改路径），权限 `0600`。**这个文件必须和数据库一起备份**，丢失或更换会导致同样的后果。

接口 `GET /api/settings` 返回的 `encryption.mode` 是 `env-key` / `key-file` / `unavailable` 之一；如果两种密钥来源都不可用（例如数据目录不可写且未设置环境变量），`unavailable` 模式下密钥类字段无法保存或读取，但非密钥字段仍可以正常修改。

密钥类字段**读取时永远只返回掩码**（`masked`，形如 `••••••••a1B2`，只保留末 4 位；长度不足 8 的值统一显示 `••••••••`），接口和页面都不会把已保存的明文再吐出来；要更新一个密钥，直接提交新值覆盖，留空表示不修改。

## 只读模式

设置 `SETTINGS_READONLY=1`（或 `true`/`yes`）后，`GET` 接口仍可读取当前状态，但所有写操作——`PUT`、`DELETE`、`POST .../test`，以及 Schwab 的两个 OAuth 接口——都会被拒绝；页面顶部会显示"设置为只读，请通过环境变量配置"的提示。适合把凭证管理完全收敛到部署环境变量、不希望任何人通过网页/API 改配置的场景。

## 分组与字段

六个分组，`id` 即 REST 路径中的 `{group}`：

| 分组 `id` | 名称 | 可测试连接 | 说明 |
| --- | --- | --- | --- |
| `tradier` | Tradier | 是 | 账户同步与行情共用同一个 Access Token |
| `ibkr` | 盈透 IBKR（Flex 报表） | 是 | Flex Web Service 只读报表，XML 格式 |
| `schwab` | 嘉信 Charles Schwab | 是 | Trader API，OAuth 2.0，页面内可直接完成授权 |
| `alpaca` | Alpaca | 是 | Trading API Key，支持 live/paper |
| `llm` | 日报推理 LLM | 是 | 市场日报推理用的 Chat Completions 兼容接口 |
| `network` | 网络出口 | 否 | 券商同步使用的 HTTP 代理 |

字段清单（`*` 为必填；`kind` 决定输入控件与校验规则）：

| 分组 | 字段 | kind | 说明 |
| --- | --- | --- | --- |
| tradier | `TRADIER_ACCESS_TOKEN` * | secret | 实盘用生产 Token，模拟用 sandbox Token |
| tradier | `TRADIER_ENVIRONMENT` | select | `live` / `sandbox`，默认 `live` |
| ibkr | `IBKR_FLEX_TOKEN` * | secret | IBKR 门户 → Performance & Reports → Flex Web Service 生成 |
| ibkr | `IBKR_FLEX_QUERY_ID` * | text | 纯数字，Activity Flex Query 编号，需为 XML 格式输出 |
| schwab | `SCHWAB_APP_KEY` * | secret | 开发者门户应用的 App Key（client_id） |
| schwab | `SCHWAB_APP_SECRET` * | secret | 应用的 Secret（client_secret） |
| schwab | `SCHWAB_REDIRECT_URI` | url | 默认 `https://127.0.0.1`，须与开发者门户登记的 Callback URL 完全一致 |
| schwab | `SCHWAB_REFRESH_TOKEN` | secret | 通常由页面内 OAuth 流程自动写入 |
| schwab | `SCHWAB_REFRESH_TOKEN_ISSUED_AT` | readonly | 系统在授权完成时写入，用于提示 7 天有效期 |
| alpaca | `ALPACA_API_KEY_ID` * | secret | Alpaca 控制台生成 |
| alpaca | `ALPACA_API_SECRET_KEY` * | secret | 与 Key ID 成对生成，只显示一次，请妥善保存 |
| alpaca | `ALPACA_ENVIRONMENT` | select | `live` / `paper`，默认 `live` |
| llm | `DAILY_LLM_PROVIDER` | select | `openai-compatible` / `openai` / `deepseek` |
| llm | `DAILY_LLM_BASE_URL` * | url | 含版本路径，不含 `/chat/completions`；不接受带账号、查询参数或片段的地址 |
| llm | `DAILY_LLM_API_KEY` | secret | 仅保存在服务端 |
| llm | `DAILY_LLM_MODEL` * | text | 服务商的模型名称 |
| llm | `DAILY_LLM_TIMEOUT_MS` | number | 1000–300000，默认 180000 |
| llm | `DAILY_LLM_MAX_OUTPUT_TOKENS` | number | 1000–16000，默认 6000 |
| llm | `DAILY_LLM_EGRESS_PROFILE` | select | `auto` / `direct` / `vpn` / `corp`，默认 `auto` |
| network | `BROKER_EGRESS_PROXY_URL` | url | 留空表示直连；Docker 内访问宿主机代理用 `host.docker.internal` |

`url` 类型字段的校验规则统一：必须是 `http`/`https`，不能带用户名、密码或 `#` 片段；`number` 类型必须是落在 `min`/`max` 区间内的整数；`select` 只能是给定选项之一；任何字段都不能包含换行，长度上限 4000 字符。

## REST API 参考

均需要鉴权：浏览器走会话 Cookie，非 `GET` 请求要带 `X-Requested-With: XMLHttpRequest`；脚本/AI Agent 走 `Authorization: Bearer <token>`（token 是 `secrets/ui_auth_token` 文件内容），**Bearer 请求不需要 `X-Requested-With` 头**。以下示例均用 Bearer 方式，并假设服务运行在 8080（Docker/便携包默认端口；源码模式不设置 `API_PORT` 时默认 3000，按实际替换）。

### `GET /api/settings`

返回全部分组的当前状态，含来源与掩码，从不返回明文密钥。

```bash
curl -s http://127.0.0.1:8080/api/settings \
  -H "Authorization: Bearer $(cat secrets/ui_auth_token)"
```

响应形状（节选一个分组；其余分组结构相同，字段见上表）：

```json
{
  "version": "settings-v1",
  "readonly": false,
  "encryption": {
    "mode": "key-file",
    "note": "密钥保存在数据目录的 settings.key 文件中，请随数据库一起备份；设置 SETTINGS_ENCRYPTION_KEY 可改用环境变量密钥。"
  },
  "updatedAt": "2026-09-23T10:15:00.000Z",
  "groups": [
    {
      "id": "tradier",
      "label": "Tradier",
      "kind": "broker",
      "description": "账户同步与美股/ETF/期权行情共用同一个 Access Token。",
      "docsUrl": "https://docs.tradier.com/docs/account-details",
      "testable": true,
      "configured": true,
      "missing": [],
      "status": { "state": "ok", "message": "账户余额与持仓读取成功", "checkedAt": "2026-09-23T10:14:50.000Z" },
      "fields": [
        {
          "key": "TRADIER_ACCESS_TOKEN", "label": "Access Token", "kind": "secret", "required": true,
          "help": "Tradier 账户 API 设置中生成；实盘用生产 Token，模拟用 sandbox Token。",
          "source": "settings", "configured": true, "value": null,
          "masked": "••••••••a1B2", "updatedAt": "2026-09-20T08:00:00.000Z"
        },
        {
          "key": "TRADIER_ENVIRONMENT", "label": "环境", "kind": "select", "required": false, "default": "live",
          "options": [{ "value": "live", "label": "实盘 live" }, { "value": "sandbox", "label": "模拟 sandbox（行情延迟 15 分钟）" }],
          "help": "行情与账户同步使用同一环境。",
          "source": "default", "configured": false, "value": null, "masked": null, "updatedAt": null
        }
      ]
    }
  ]
}
```

### `GET /api/settings/schema`

机器可读的接口说明：字段定义、端点列表、可复制的调用示例。设计给 AI Agent 在第一次调用前先读取，不需要事先知道字段名称。

```bash
curl -s http://127.0.0.1:8080/api/settings/schema \
  -H "Authorization: Bearer $(cat secrets/ui_auth_token)"
```

响应形状（`groups` 复用与 `GET /api/settings` 相同的字段定义，但不含当前值/掩码；`examples` 是可直接复制执行的完整 `curl` 命令）：

```json
{
  "version": "settings-v1",
  "title": "账户设置 API",
  "instructions": [
    "本接口面向配置本系统的 AI Agent 与自动化脚本：先调用 GET /api/settings/schema 了解全部分组、字段与认证方式，再调用 PUT 写入或 POST 测试；无需阅读服务端源码。",
    "认证：所有请求都带 Authorization: Bearer <token>（token 来自服务器 secrets/ui_auth_token，或使用已登录会话的 Cookie）；PUT/DELETE/POST 等非 GET 请求还必须附带 X-Requested-With: XMLHttpRequest 请求头，否则会被 CSRF 防护拒绝（403）。",
    "写入字段：PUT /api/settings/:group，body 为 { values: { 字段KEY: 值 } }；把某个字段设为空字符串或 null 会清除该覆盖值，之后自动回退到同名环境变量或字段默认值，而不是报错。",
    "DELETE /api/settings/:group 会一次性清除该分组的全部覆盖值。",
    "POST /api/settings/:group/test 仅对 schema 中 testable=true 的分组可用：会用当前生效配置发起一次只读连接检测，返回 { ok, message }，即使检测失败也是 200。",
    "只读模式（GET 返回的 readonly=true）下所有写操作都会被拒绝，返回 403；GET 类读取接口不受影响。",
    "字段的 value 只对非密钥字段返回明文；kind 为 secret 的字段在任何响应中都不会出现明文，只提供 masked（仅显示末 4 位）与 configured 标记，写入后也无法读回原文。"
  ],
  "auth": "Authorization: Bearer <token>（GET 与非 GET 均需要）；非 GET 请求另需 X-Requested-With: XMLHttpRequest 头，或使用已登录会话的 Cookie 代替 Bearer Token。",
  "endpoints": [
    { "method": "GET", "path": "/api/settings", "summary": "读取全部设置分组：每个字段的来源、是否已配置、脱敏值与最近检测状态。", "response": "SettingsView" },
    { "method": "GET", "path": "/api/settings/schema", "summary": "读取本文档：分组/字段定义、认证方式与调用示例。", "response": "SettingsSchemaDocument" },
    { "method": "PUT", "path": "/api/settings/:group", "summary": "写入一个分组的若干字段；值为空字符串或 null 会清除该字段的覆盖值，改为回退到同名环境变量或默认值。", "body": "{ values: Record<string, string | null> }", "response": "{ group: SettingsGroupView }" },
    { "method": "DELETE", "path": "/api/settings/:group", "summary": "清除一个分组的全部覆盖值，回退到环境变量/默认值。", "response": "{ group: SettingsGroupView }" },
    { "method": "POST", "path": "/api/settings/:group/test", "summary": "对已配置的分组发起一次只读连接检测；仅 schema 中 testable=true 的分组支持。", "response": "{ result: SettingsTestResult }" },
    { "method": "GET", "path": "/api/settings/schwab/authorize-url", "summary": "生成 Schwab OAuth 授权地址（需已配置 App Key，回调地址可用默认值）。", "response": "{ url: string }" },
    { "method": "POST", "path": "/api/settings/schwab/exchange", "summary": "用授权后跳转的完整地址（或直接给出 code）换取 Refresh Token 并保存。", "body": "{ redirectedUrl?: string; code?: string }", "response": "{ group: SettingsGroupView; issuedAt: string }" }
  ],
  "groups": [ "... 同 GET /api/settings 的分组/字段定义（不含当前值），见上方字段清单表 ..." ],
  "examples": [
    "curl -sS http://127.0.0.1:8080/api/settings/schema -H \"Authorization: Bearer <ui_auth_token>\"",
    "curl -sS -X PUT http://127.0.0.1:8080/api/settings/tradier -H \"Authorization: Bearer <ui_auth_token>\" -H \"X-Requested-With: XMLHttpRequest\" -H \"Content-Type: application/json\" -d '{\"values\":{\"TRADIER_ACCESS_TOKEN\":\"<token>\",\"TRADIER_ENVIRONMENT\":\"live\"}}'",
    "curl -sS -X POST http://127.0.0.1:8080/api/settings/tradier/test -H \"Authorization: Bearer <ui_auth_token>\" -H \"X-Requested-With: XMLHttpRequest\""
  ]
}
```

端点路径里的 `:group` 就是分组 `id`（`tradier`/`ibkr`/`schwab`/`alpaca`/`llm`/`network`），本文档其余地方用更常见的 `{group}` 记法表示同一个占位符。`instructions`/`auth` 明确建议非 GET 请求带上 `X-Requested-With`；本文档"优先级与覆盖规则"一节前面已经确认过——那实际上是给会话 Cookie 认证准备的，**用 Bearer token 时这个头不是必须的**（服务端的 CSRF 检查里 Bearer 校验通过即可放行，不再要求这个头）。`examples` 里的命令即便用了 Bearer 也依然带着该头，属于防御性写法，照抄可以直接用，不会出错，只是并非严格必需。

### `PUT /api/settings/{group}`

写入一个或多个字段的覆盖值；只需要传要改的字段，未传的字段保持不变。

```bash
curl -s -X PUT http://127.0.0.1:8080/api/settings/tradier \
  -H "Authorization: Bearer $(cat secrets/ui_auth_token)" \
  -H "Content-Type: application/json" \
  -d '{"values": {"TRADIER_ACCESS_TOKEN": "<token>", "TRADIER_ENVIRONMENT": "live"}}'
```

清除某个字段的覆盖（回退到环境变量/默认值）：

```bash
curl -s -X PUT http://127.0.0.1:8080/api/settings/tradier \
  -H "Authorization: Bearer $(cat secrets/ui_auth_token)" \
  -H "Content-Type: application/json" \
  -d '{"values": {"TRADIER_ACCESS_TOKEN": null}}'
```

响应：`{"group": {...}}`（更新后的该分组完整状态，形状同 `GET /api/settings` 里的单个分组）。字段名不属于该分组、`select` 传了非法选项、`number` 超出范围、`url` 带了账号/片段等情况会返回错误，不会部分写入。只读模式下返回拒绝。

### `DELETE /api/settings/{group}`

清空整个分组的全部覆盖：

```bash
curl -s -X DELETE http://127.0.0.1:8080/api/settings/tradier \
  -H "Authorization: Bearer $(cat secrets/ui_auth_token)"
```

### `POST /api/settings/{group}/test`

用该分组**当前生效**的配置（不论来自账号设置还是环境变量）做一次只读连接测试：

```bash
curl -s -X POST http://127.0.0.1:8080/api/settings/tradier/test \
  -H "Authorization: Bearer $(cat secrets/ui_auth_token)"
```

```json
{ "result": { "ok": true, "message": "账户余额与持仓读取成功", "details": { "accounts": 1 } } }
```

`network` 分组不可测试（`testable: false`），因为它本身只是一个代理地址，没有独立的连接目标。

### Schwab OAuth：`GET /api/settings/schwab/authorize-url` + `POST /api/settings/schwab/exchange`

Schwab 使用 OAuth 2.0，需要先保存 `SCHWAB_APP_KEY`/`SCHWAB_APP_SECRET`/`SCHWAB_REDIRECT_URI`，再走一次授权换取刷新令牌：

```bash
# 1. 生成授权链接，在浏览器打开并登录/同意
curl -s http://127.0.0.1:8080/api/settings/schwab/authorize-url \
  -H "Authorization: Bearer $(cat secrets/ui_auth_token)"
# => {"url": "https://api.schwabapi.com/v1/oauth/authorize?..."}

# 2. 把授权后浏览器跳转到的完整 URL（含 code 参数）粘贴回来换取刷新令牌
curl -s -X POST http://127.0.0.1:8080/api/settings/schwab/exchange \
  -H "Authorization: Bearer $(cat secrets/ui_auth_token)" \
  -H "Content-Type: application/json" \
  -d '{"redirectedUrl": "https://127.0.0.1/?code=C0.xxxx&session=yyyy"}'
# => {"group": {...}, "issuedAt": "2026-09-23T10:20:00.000Z"}
```

刷新令牌有效期 7 天，到期前需要重新走一遍这两步（页面上会在临近/超过有效期时提示"需要重新授权"）。详细步骤见 [券商接入](BROKERS.md#charles-schwab)。

## AI Agent 使用流程

推荐顺序：

1. `GET /api/settings/schema` — 了解有哪些分组、字段、类型与约束，不需要提前查文档或读源码。
2. `PUT /api/settings/{group}` — 写入需要的字段；只传要改的 key。
3. `POST /api/settings/{group}/test`（`testable: true` 的分组）— 确认刚写入的配置真的能连上。
4. 需要时 `GET /api/settings` 复核当前来源（是否被环境变量覆盖了页面设置，等等）。

Schwab 额外多两步（授权链接 → 粘贴回调 URL 换取刷新令牌），见上一节。

## 安全注意事项

- 密钥类字段永远不会被 API 原样返回；出现在响应里的只有掩码（末 4 位）。日志、错误消息也不会打印明文。
- CLI/脚本使用的 Bearer token（`secrets/ui_auth_token`）拥有和网页登录用户同等的权限，包括写入/清空账号设置，请像对待密码一样保管，不要提交进版本库、不要打印到公共日志。
- 生产部署如果不希望任何人通过网页/接口修改凭证，设置 `SETTINGS_READONLY=1`，只用环境变量管理配置。
- 更换 `SETTINGS_ENCRYPTION_KEY` 或丢失自动生成的密钥文件（默认 `settings.key`）会让已保存的密钥类账号设置全部失效，需要重新填写；备份数据库时请把这个密钥文件一起备份。
- 保存 Schwab/Tradier 等 Token 时，建议在券商侧使用权限最小化的只读 Key（如果券商支持区分只读/交易权限）。
