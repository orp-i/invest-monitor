# 日报推理与持续观察

入口：**宏观研究 → 日报推理**，或在一篇正式日报下点击“结合历史日报推理”。先展示所选日报的原始宏观判断，生成结果后再展示结合历史的模型判断、支持和反对依据、三层操作参考。用户填写的正文、摘要、市场判断和手工 `watch` 原文保持版本化管理；模型结论与观察状态独立保存。

## 日常流程

1. 在“市场日报”正式保存当天内容，支持先补填历史日期。默认分析最近一篇正式日报，也可选择历史日报；草稿和归档不进入当前参考。
2. 在“日报推理”选择历史范围，可补充重点问题。按需勾选已同步持仓、读取关联日 K；点击“生成操作参考并更新观察”。仅该操作发起模型请求，打开页面、保存日报、重启服务不会自动调用模型。
3. 阅读宏观观点的延续、增强、减弱或反转，区分日报观点与独立价格证据；再看短线、中线、长线各自的触发、失效、组合影响、持有与复核条件。证据不足时可全部建议观察。
4. 模型成功完成时，同一事务保存结论、更新参考范围内的旧观察，并新建待验证事项。可在下方人工更新状态，必须填写依据；原日报详情及月度时间表同步展示。历史状态及其证据保留，人工“结束跟踪”后退出后续推理参考。
5. 引用按钮打开本次实际使用的日报版本；可导出完整输入、输出和状态更新清单。刷新页面仍可读取任务和历史结果；报告修订、历史范围或周期口径变化时，旧结论标示过期，需重新分析。

**周期口径：1–2 周是最短操作周期。** 短线主要期权，中线主要 Put Spread / Call Spread 和股票，长线主要股票。第 5 / 10 个交易日是复核节点；中长线按自身趋势、催化和风险条件延续。最短周期不表示风险失效后仍必须持有。模型结构要求预期至少 5 个交易日，并提示中长线应更长；这表示策略规划周期，不是精确价格预测。没有期权链、权利金或完整 Delta 时不编造合约、价格、收益或对冲张数。买入 Put 看空；已有空头时，新增 Put 不能直接当作对冲。

## 输出截断与自动压缩重试（2026-09-20）

2026-09-13 06:39 的首次真实运行失败，原因是 DeepSeek 回复达到 `DAILY_LLM_MAX_OUTPUT_TOKENS=6000` 上限（`finish_reason=length`），页面只能提示提高上限，用户无法自救。现在：

- 系统提示新增篇幅约束（整份 JSON 约 3000 字内，每个文本字段 ≤150 字，supporting/opposing ≤4 条，actions ≤6 条，newObservations ≤5 条，limitations ≤5 条），提示版本升级为 `daily-trend-v3-compact-output`，旧运行在页面标记为过期。
- 回复被截断，或结构/引用/三层周期校验不通过时，服务端在同一任务内**自动重试一次**：用户消息前置 `REPAIR`（说明上次未采用的原因与更紧凑的字段限制），输出上限提高到配置值的 2 倍（不超过 16000）。第二次仍失败才把任务标为失败，错误文案说明已重试两次，并建议提高 `.env` 上限或缩短历史范围。
- `run.attempts` 记录每次请求的开始时间与未采用原因，`run.usage` 为两次合计；页面在结果下方提示“第 1 次模型回复输出被截断，已自动以压缩格式重试一次”。网络、鉴权、限流和超时**不会**自动重试，出口选路也不因此重放。
- 校验失败的具体原因（如“引用不存在于 INPUT”“actions 缺少周期”）只用于修复提示与 `attempts.issue`，不含供应商响应正文。

## `.env` 配置

项目 `.env` 已预留以下配置；API 地址需带供应商版本路径，例如 `/v1`，也可填写完整 `/chat/completions` 地址。根据所选供应商填入真实地址、Key 和模型名，以下留空项不能直接调用。

```dotenv
DAILY_LLM_PROVIDER=openai-compatible
DAILY_LLM_BASE_URL=
DAILY_LLM_API_KEY=
DAILY_LLM_MODEL=
DAILY_LLM_TIMEOUT_MS=180000
DAILY_LLM_MAX_OUTPUT_TOKENS=0
DAILY_LLM_EGRESS_PROFILE=auto
```

`openai-compatible` 使用 Chat Completions 与 `max_tokens`；`deepseek` 使用相同字段并开启 JSON Output；`openai` 使用同一协议与 `max_completion_tokens`。DeepSeek 接入和模型列表按 [Chat Completions 官方文档](https://api-docs.deepseek.com/api/create-chat-completion/)及[模型列表官方接口](https://api-docs.deepseek.com/api/list-models/)实现，支持根 API 地址或带 `/v1` 的路径。OpenAI 官方 API 的字段、完成状态和 token 用量见 [Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。模型需支持非流式 system/user 消息与文本 JSON 输出；这里没有接入 Responses API 或工具调用。具体服务的模型可用性、额度及兼容性由供应商决定。

超时可配 1000–300000 ms；输出上限可配 1000–16000 token。推理型模型的 `max_completion_tokens` 也包含其推理预算，内容被截断会明确失败，需要适当提高上限或缩小材料范围。出口可选 `auto`（默认，检测后选择）、`direct`、`vpn`、`corp`。LLM 使用独立连接池，`direct` 明确不使用应用代理，`vpn` 复用容器的17890代理；其他市场/券商的全局代理配置继续保留。本地接口通常指定 `direct`。容器中的 localhost 是容器自身，访问宿主机服务需使用已配置的 `host.docker.internal`。不接受带账号、查询参数或片段的 API URL，不跟随重定向。自动模式在提交推理前选路；已发出的推理请求失败时不换线路重发，防止重复付费。网络/5xx失败使缓存过期，下一次用户发起时重新检测。

配置只注入 API 容器，不写入 `VITE_` 或浏览器；独立于原有新闻 `OPENROUTER_API_KEY` / YAML LLM 设置。修改后在项目目录执行：

```bash
docker compose up -d --force-recreate api web
```

单纯 restart 不会重载 `.env`；同时重建 Web 容器配置是为了重新解析 API 容器地址。2026-09-13 已读取用户配置的 DeepSeek / deepseek-flash，保留原有地址、Key和模型，仅将出口设为 `auto`。模型列表鉴权/模型可用性与一次最小 JSON 请求已验证成功；没有为连接验证发送真实日报或创建生产推理/观察记录。

## 自动选路与连接检测

“日报推理 → LLM连接 → 检测直连 / VPN”展示两条线路的成功数、响应中位数、模型可用性和当前/推荐出口。检测仅向配置的 API 发送带鉴权的 `GET /models`，不生成分析。两条线路各检测2次；最多并行2路，每次8秒超时，不跟随重定向、不自动换线路重试该请求。VPN在此指17890代理入口，实际是否经过隧道由宿主机代理规则决定。

优先确认模型可用，再比较成功率和延迟；小于100ms或20%的差异不频繁切换，首次相近时优先直连。只收到鉴权失败、错误模型、限流或HTML页面不会判为可用。部分兼容服务 `/models` 返回JSON 404/405时只标网络可达、模型未确认；可手动固定出口直接验证推理接口。

完整成功的结果缓存15分钟；仅部分检测成功或模型列表不受支持时缓存1分钟；双路失败缓存30秒。手动检测总会重新测量，同一时刻重复检测合并。页面读取不会触发检测，只有手动点击或自动模式首次/过期后的推理才检测。配置热更新改变代理地址会使结果失效；退出服务取消正在检测的请求。每次成功推理保存本次出口和诊断快照，历史详情及导出可回看。

2026-09-13 首轮容器内独立三次请求，两路均3/3成功：直连中位121ms，VPN代理1159ms；后续CLI双次分别378/706ms，均2/2，自动选直连。一次真实最小JSON推理耗时942ms，75输入/43输出token。启动时的页面测量曾两路各1/2成功，已保留样本并缩短不稳定结果缓存；这些仅为当时模型列表/小请求的测量，不能等同完整日报分析时长。06:33最终页面复测，两条线路均2/2成功，直连523ms、VPN1132ms，自动选择直连。完整证据见Handoff与 `data/daily-llm-connection-20260913/`。

命令行只读检测（凭据来自运行中API容器，输出脱敏）：

```bash
docker compose exec -T api node scripts/probe-daily-llm.mjs
```

追加 `--complete` 会在选路后发起**一次真实最小模型请求**，不读取业务数据库；适合配置验证，日常无需重复。

## 数据范围和时间

- 参考范围默认过去 60 个日历日，可选 7–180 日；最多最近 31 篇正式日报。按所选日期排除后续日报，但使用本次实际已保存的版本；旧日期分析属于现在的回顾研究，不冒充无前视偏差回测。`reportAsOf`、每篇创建/修订时间和版本一同保存。
- 观察最多携带参考日报范围内 60 条未结束事项。超出范围或条数的观察仍保存在原日报，可回到原日期人工维护；缩短范围可能不再带入较早的长期观察。页面会提示范围限制。
- 最多 12 个关联市场，优先 SPY / QQQ、当前日报关联，再补历史主题。复用研究服务的 24 小时缓存及外部并发 2；数据缺失、缓存过期、刷新失败均显式记录。最多提供每市场最近 40 根已完成日 K，日期不超过所选日报，纽约当日条目排除。窗口之外的数据不能用作本次验证依据。
- 勾选持仓时读取最近保存的券商/结单快照，显示各自 `asOf/syncedAt`；去除账户号码、持仓 ID、全部成交明细及账户总资产，保留判断敞口所需的持仓数量、方向、价值与未实现盈亏，最多 100 行。本次不会强制同步券商；原有 12:00 / 00:00 双券商同步与盈亏日 K 调度继续运行。
- 输入上限 120000 字符；过大时要求缩短范围，不偷偷截断日报正文。启动和刷新后均检查长度；不执行日报、问题或供应商文本里的指令。原文中的政策/季节性/宏观数据仍是待核验材料；模型没有额外联网工具或券商下单能力。

## 观察状态与冲突

| 状态 | 含义 |
| --- | --- |
| 待验证 | 新建条件，等待数据 |
| 继续观察 | 继续跟踪，尚不足形成更明确结论 |
| 出现支持 / 出现反证 | 现有市场数据支持或反对原条件，允许后续修订 |
| 证据分化 | 支持与反对证据并存 |
| 条件失效 | 原先明确的条件出现失效证据 |
| 结束跟踪 | 人工结束，保留历史且不再自动更新 |

新增模型事项只能是待验证或继续观察。对旧事项更新为支持、反证、分化或失效时，必须引用实际输入中含有该观察日期之后数据的市场序列；重复日报观点不足以证明。程序核验引用与数据存在，具体趋势语义仍由模型给出、由用户审阅，不等于机械验证了投资结论，也不按精确点位、单日涨跌或单一终点收益评分。

状态变更保留原问题、所属日报和每版证据；原文 `watch` 不会被覆盖。人工修改使用版本校验，旧窗口返回 409。模型运行期间若观察已被人工更新，自动跳过该事项；若任一引用日报修订/归档，则保留本次旧输入结果但跳过全部观察更新，并显示跳过数量。未通过结构、引用、三层周期校验或接口失败时，保存失败记录且不应用状态更新。

## API 与实现

均沿用应用登录/Bearer 鉴权；写操作需要 `X-Requested-With: XMLHttpRequest`。

| 方法与路径（前缀 `/api/research/daily-inference`） | 行为 |
| --- | --- |
| `GET /state?reportId=…&historyDays=60` | 当前宏观判断、参考摘要、范围内观察、最近 20 次推理、provider 配置状态；不返回 Key/URL，不调用模型 |
| `POST /connection-check` | 手动检测直连/VPN的模型列表，返回脱敏provider/connection；不写入日报、推理任务或观察 |
| `POST /runs` | `{requestId: UUID, reportId, expectedRevision, historyDays:60, includePositions:true, refreshMarkets:true, question:""}`；202 启动后台任务，返回摘要 |
| `GET /runs/:id` | 任务状态、冻结输入、输出、provider/model、版本、用量及观察变更清单 |
| `GET /observations?from=…&to=…&reportId=…` | 最多 300 条，返回 `observations/hasMore` |
| `POST /observations` | `{reportId,text,horizon,evidence?}`；人工新增待验证，201 |
| `GET /observations/:id` | 当前完整状态 |
| `PATCH /observations/:id` | `{expectedRevision,status,evidence}`；追加修订，不覆盖原问题 |
| `GET /observations/:id/history` | 最近 100 次状态版本，历史全量保存在库中 |

相同 `requestId` 和标准化参数重试返回同一任务，不重复付费；同编号不同输入 409。单个运行实例同一时刻仅允许一个任务，新请求冲突 409。重启中断的运行标为失败，用户手动重试；不自动再次调用模型。鉴权失败、限流、网络异常、超时及截断返回脱敏错误，不向页面暴露供应商响应正文或凭据。

领域：`packages/domain/src/daily-inference.ts`。服务/扩展接口：`apps/server/src/daily-inference.ts`、`daily-llm.ts` / `daily-llm-egress.ts`（新增其他协议实现 `DailyLlmProvider.status/complete`）。UI：`DailyInference.tsx`、`DailyObservations.tsx`，由 `ResearchHub/MarketDaily` 接入。新增业务库表 `daily_inference_runs`、`daily_observations`、`daily_observation_revisions`；两个 SQLite 驱动共用原子事务和版本保护。

验收：`tests/workspace/daily-inference.test.ts`、`daily-llm.test.ts`、`daily-llm-egress.test.ts`；隔离浏览器脚本 `scripts/verify-daily-inference-browser.mjs` 的模型输出和写入仅进入临时库。`--snapshot-before` 保存不可覆盖的生产校验基线，`--production-read-only` 验证生产页面、已有数据和未配置状态，不请求真实模型。附加 `--connection-check` 只放行一次真实模型列表诊断POST，以即时业务校验基线验证页面和缓存；仍禁止生成分析与业务写入。检查输出保存在 `data/` 下的私有目录，不进入仓库；脚本内 2026-09-10/11 数据与初次上线零任务断言为本轮验收基线，后续业务增长后应调整。
