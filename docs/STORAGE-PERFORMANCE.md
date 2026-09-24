# API 负载与分层存储

本次改造将交易业务、近期行情和历史行情文件分开，服务地址和 `.env` 券商凭证保持原有配置。

## 存储布局

| 内容 | 主机位置 | 容器位置 |
| --- | --- | --- |
| 交易、持仓、复盘、新闻、原始证据、运行状态 | `/data/invest/db/invest.sqlite` | `/app/data/invest.sqlite` |
| 最近 30 天行情、最新报价小表 | Docker 卷 `invest_market-hot`，位于根分区 | `/app/market-hot/market.sqlite` |
| 月度行情块 | `/data/invest/market-archive/YYYY-MM.sqlite` | `/app/market-archive/YYYY-MM.sqlite` |
| 块索引 | `/data/invest/market-archive/catalog.sqlite` | `/app/market-archive/catalog.sqlite` |
| API、网页访问及错误日志 | `/data/invest/logs/service-*.jsonl` | `/app/logs` |
| 历史备份 | `/data/invest/backups/{volume,workspace}` | `/app/backups` |

“30 天”采用 UTC 时间的滚动 30×24 小时边界；行情快照按 `captured_at_ms`，K 线按 `open_time_ms` 分配。已休眠或到期标的仅保留一条最新报价索引供展示历史参考，不把其全部历史留在热区。`/data` 已通过 `/etc/fstab` 独立挂载。Compose 使用 `create_host_path: false`，目标目录未准备好时停止启动。

新服务器需要先确认 `/data` 是已挂载的数据分区，再准备目录：`sudo install -d -m 700 -o 10001 -g 10001 /data/invest/db /data/invest/market-archive /data/invest/logs /data/invest/backups`。当前服务器已完成这些步骤。

## 请求与调度

- `/api/snapshot` 一次提供初始化数据，每次只读一次最新行情和源状态；浏览器行情更新通过 SSE 增量合并，取消每次报价后重新请求整个看板。
- 一个采集调度定时器。按用户后续要求，所有启用关注的股票与 ETF 自动并发采集报价与日 K，移除四任务上限；同一标的/来源/能力仍只执行一个任务。Tradier 请求按 Token 共享 1.1 秒启动间隔及 429 退避，允许网络请求重叠。其他类别最多 4 个并发任务，持仓保留估值报价，详情通过每个浏览器标签页的 90 秒租期启用报价与 K 线。切换标签、隐藏网页时释放租期，关闭或断网后自动过期。
- Tradier 的行情、历史、搜索、期权与市场时钟共享既有 Token 请求队列；详细期权链和历史仍按需查询并复用缓存。
- 最新状态读取通过复合索引逐组定位最后一条，避免对整个历史表反复 `GROUP BY/MAX`。出口统计只对给定时间窗做索引范围计数。
- 相同来源、标的和能力的相同原始响应复用已有证据，行情和健康观察独立保留接收时间，减少重复原始 JSON。

## 分块读取与归档

`quotes` 和 `candles` 的复合键分别为 `(instrument_id, source_id, captured_at_ms)` 与 `(instrument_id, source_id, timeframe, open_time_ms)`。热区与月度块有对应的时间、标的索引；目录表记录每个标的/来源/周期在各块的最小、最大时间。

历史请求先查热区，再查目录索引，按从新到旧的候选块读取。每块 SQL 使用时间范围、标的和 `LIMIT`，得到足够数据后停止；最多缓存两个块连接，读连接为只读。不会将全部历史载入内存，也不会为每个行情块启动进程。

- `/api/quotes/history` 和 `/api/candles` 支持 `from`（含）、`before`（不含），可传 epoch 毫秒或 ISO 时间；`limit` 最大 1000。
- 报价历史返回 `nextBefore`；逐来源分页时搭配 `sourceId`，避免同时间多来源边界混淆。
- 初始化每批搬移 1000 行；正常运行每分钟最多归档 2000 行。源记录只在目标文件提交、目录发布、逐字段核对后移除。崩溃重试按自然键幂等，读取会去重；交易业务库不参加行情跨文件事务。
- 历史块采用持久化 WAL 事务，修订的历史 K 线可更新原块。块不是不可变文件；备份时必须使用 SQLite 备份 API，或停止写入并 checkpoint 后复制。不能只复制运行中主文件而漏掉 WAL。

SQLite 的 WAL 仅保证单个数据库文件事务原子性，所以采用“写入并验证目标，再删除来源”，不依赖跨文件原子提交。[SQLite ATTACH 文档](https://www.sqlite.org/lang_attach.html)、[WAL 文档](https://www.sqlite.org/wal.html)。

## 行情时间与日志

Tradier 实盘报价以最近成交时间作为数据参照。当返回数据与最近成交一致，并且最近仍成功接收到报价时，不会因休市或没有新成交被标记为延迟。实际行情滞后、接收中断、数据源错误、Sandbox 延迟权限分别保留。市场开闭状态来自 [Tradier Market Clock](https://docs.tradier.com/reference/brokerage-api-markets-get-clock)，每分钟刷新共享缓存，不硬编码节假日。成交时间与接收时间仍分别显示。

正常服务日志由 API 进程内的写入器统一写入 `/data`，Nginx 通过容器内部 UDP syslog 转发。每个日志文件最多约 10 MiB，保留最近 14 个文件；健康检查不写访问日志。Docker 仅保留最多每容器约 2 MiB 的启动/致命故障后备输出。行情限额、并发与日志配置都不接触下单功能。

## Docker 网络通道

部署主机若需要代理出网，可使用本机代理通道（示例端口 17890）：Docker 守护进程的镜像下载代理按主机代理配置；Compose 构建中的 apt/npm 通过 `.env` 的 `DOCKER_BUILD_PROXY_URL`（如 `http://host.docker.internal:17890`）注入，容器运行时出口通过 `DOCKER_EGRESS_PROXY_URL` 注入，默认均为空即直连，并提供 host-gateway 映射。

运行时 `DOCKER_EGRESS_PROXY_URL` 默认为同一主机网关地址，统一市场数据、新闻和券商连接器的出口。`EGRESS_SINGLE_PROXY_URL` 会清空同一通道上的冗余 fallback，避免失败后绕回旧 NetBird 代理。`.env` 中的 Token 保持不变；如要换代理地址，设置以上两个 Docker 变量。Docker 守护进程已配置代理，无需为本次改造重启整台主机的 Docker 服务。

日报LLM使用独立连接池例外：直连profile的proxyUrl固定为null，VPN沿用上述17890代理，不受“全部profile映射到单一代理”的影响。`DAILY_LLM_EGRESS_PROFILE=auto` 在推理前只读比较模型列表可用性/成功率/延迟，已提交的推理不自动重放。详见 [日报连接检测](DAILY-INFERENCE.md#自动选路与连接检测)。

外部时间检测改为后台执行、最多 8 秒，不阻塞网站就绪。新闻规则不变时不重复写入已有记录。

## 迁移回退记录

迁移脚本：`scripts/migrate-cold-backups.mjs`、`scripts/migrate-service-data.mjs`、`scripts/finish-service-migration.mjs`。业务库切换必须在 API 停止后执行，checkpoint、完整性检查、SHA-256 比较通过后才切换；收尾脚本再次比较旧库及回退副本的校验和，通过后才回收根分区旧库。

迁移前镜像：`invest-api:pre-partitions-20260905`、`invest-web:pre-partitions-20260905`。完整业务及未拆分行情备份：`/data/invest/backups/volume/pre-partitions-20260905.sqlite`。迁移报告位于 `/data/invest/backups/service-migration-20260905.json`。

需要回退时先保存部署后新增的交易、券商同步、复盘等业务数据；不可直接用旧快照覆盖新记录。旧镜像只能读取未拆分数据库，不能单独回退镜像后继续读取已清空历史表的新业务库。新的日常完整备份需同时覆盖业务库、热库、目录库与所有月度块，并对一致性窗口进行记录。

## 2026-09-05 验证结果

业务库与行情热库 `PRAGMA quick_check` 均为 `ok`。迁移后业务库中的旧 `quotes` / `candles` 表为零；校验时热库 160572 条报价、70282 根 K 线，12 个历史月块共 2086 根 K 线。比停机快照多出的 2 条报价、3 根 K 线来自恢复后的正常采集。后续日 K 查询扩至两年后，历史月块会按实际数据继续增加。

229 个冷备文件共 24,460,685,143 字节，逐文件 SHA-256 验证后转移。旧生产库也与 `/data` 的完整回退副本再次比较 SHA-256 后回收；完整副本仍在。主库未进行会造成大规模重写的 VACUUM，删除行情留下的空闲页由后续业务写入复用。

以下为 17:54 的按需采集版本；后续全关注股票自动采集的结果另记。相同浏览器脚本、相同总览页面的 30 秒采样（按单 CPU 核的 cgroup 使用时间计）：

| 指标 | 改造前 | 改造后 |
| --- | ---: | ---: |
| API CPU | 89.70% | 4.75% |
| 浏览器 API 请求数 | 46 | 3 |
| `/api/quotes` 单次响应 | 929 ms | 50 ms |
| `/api/instruments` 单次响应 | 7362 ms | 38 ms |
| `/api/performance` 单次响应 | 2152 ms | 5 ms |
| 根分区已用比例 | 93% | 73% |
| 根分区可用空间 | 约 7.2 GiB | 约 26 GiB |

这是一次受控浏览样本，不代表所有市场时段的固定占用；外部行情请求、首次历史补采和数据库校验仍会产生短时负载。原始记录保存在 `data/server-load-20260905/{before,after,live-report}.json`。

线上核对通过：12 项持仓、29 条结单成交、16 个复盘档案保留；大象已实现净盈亏 11.04 USD、全券商已实现净盈亏 44.22 USD、累计费用 62.228215 USD 均一致。休市实盘最近成交显示正确，跨月查询与手机布局正常。

完成日 K 的 OHLC 未变时，不因接收时间及其时钟偏移等观测字段变化反复重写历史月块；采集健康状态仍记录当前请求成功时间。

## 2026-09-06 全关注股票自动采集验证

03:09 UTC 首轮历史补采结束后，使用同一脚本测量总览页面 30 秒：API CPU 为单核的 6.63%，浏览器 API 请求 3 次，报价接口 64 ms、来源健康 46 ms、标的接口 49 ms、盈亏接口 6 ms；无浏览器错误。原始记录：`data/server-load-20260905/after-auto-stocks.json`。该样本已包含全关注股票自动采集策略，不能将首轮两年历史补采的突发 I/O 与稳定运行混为一谈。

本次根分区仍为 73% 已用、约 26 GiB 可用；业务库、日志、冷行情块与备份继续位于 `/data/invest`。网页图表验证中热历史接口约 30–33 ms，切换回日 K 和拖动窗口不重复发起历史 API 请求。首次请求外部分时数据仍受 Tradier Token 共享配额、网络延迟与启动补采排队影响，实测冷请求约 26 秒；不承诺外部数据具有本地缓存相同的延迟。

历史补采按月提交，先写热区与最近月份，每个月块完成后让出事件循环；关闭存储前等待已开始的分块写入完成。交易日历的失败缓存为 30 秒，成功缓存仍为 6 小时。

最终部署后 03:23 UTC 复测（`after-auto-stocks.json`）：API CPU 6.46%，30 秒总览浏览仍为 3 个 API 请求，报价 73 ms、来源健康 48 ms、标的 42 ms、盈亏 6 ms，无浏览器错误。03:09 的前一版本结果另存 `after-auto-stocks-before-io-fix.json`。历史块观测字段修正及按月让出事件循环后，03:23 的分时首次加载实测为 1327 ms，日 K 首屏为 124 ms，本地历史接口为 31–33 ms。以上为实际样本，外部服务延迟仍会变化。

## 2026-09-12 盈亏日 K 调度

盈亏历史改为北京时间每天12:00和00:00记录，每日一根基于实际样本的K线；旧5分钟记录保留后按日聚合。取消服务端5分钟采样、券商同步写盈亏历史和浏览器5分钟轮询。当前卡片仍支持券商SSE/手动/页面恢复读取，不追加图表样本。调度按保存的半日时段去重、失败重试、重启只补当前时段；采集时间保持真实，不伪造漏掉的过去记录。沿用原表和366天保留期，历史读取上限10000且使用索引/LIMIT。完整验收见[当前交接](HANDOFF.md)。

同日后续更新：每次日K记录前先同步已配置的Tradier与IBKR，等待两家的持仓/成交/盈亏数据及后处理成功；与手动/后台同步共用任务锁，有一方失败则保留上次日K并重试。常规同步本身仍不额外追加采样，Flex保留原报告日期。
