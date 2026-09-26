# 更新日志 / Changelog

版本号取自 `apps/server/package.json`；日期为 UTC。公开记录只保留功能与口径变化，不含任何账户数据。
Versions follow `apps/server/package.json`; dates are UTC. Entries describe features and rules only, never account data.

## 0.2.0 — 2026-09-26

### 交易复盘 / Trading review
- **多腿识别第 3 步**：各腿乘数全部未知但属于同一标准 OCC 根代码时视为等规模（Tradier 当日了结的期权没有乘数）；新增“券商开平标记”同日识别（已平仓批次 / 当日订单 / 持仓推断 / 结单动作），标签后缀“按同日开仓识别（券商开平标记）”；策略簇新增 `structure` 证据档（order ＞ instant ＞ structure ＞ day），同日对齐且全部成交带标记、结构可识别时自动合并，同日多轮往返保留在一个档案；`day` 级建议附形态提示。
- **多腿识别第 4 步 / 复盘 SOP**：新增 9 条 SOP（`merge-sop-v1`）；用户确认的分组内按日期顺序判出的开仓视为已确认；同日无标记的两腿价差按 SOP-4“借方价差默认”判定开平并明确标注为推断，券商标记到达即覆盖。
- **模型合并建议**：复用日报 LLM，对仍未解决的同日簇与结构未识别的多腿档案按 SOP 给出分组、开平角色与轮数建议；程序重算净现金、数量平衡、结构与可执行性，不采信模型数字；券商同步后待判断分组变化时自动分析（30 分钟节流，`REVIEW_MERGE_ADVICE_AUTO=0` 关闭）；复盘页面板可重新分析并一键按建议合并。接口 `GET/POST /api/trading-review/advice[/run|/runs/:id]`。
- **交易经验模块**：新标签页“交易经验”，分期权 / 股票 / 对冲设置三类；标题、内容、适用场景、下次动作、标签、关联档案、有效/停用；修改保留历史并以 `expectedRevision` 防止覆盖；档案详情可一键记录该笔交易的经验。接口 `GET/POST /api/trading-review/lessons[/:id]`。
- Multi-leg recognition step 3 (uniform unknown contract size on one standard OCC root; same-day recognition from broker open/close flags; new `structure` cluster evidence with automatic merge; shape hints on day-level suggestions), step 4 (9-rule merge SOP; date-ordered openings count as confirmed inside user groupings; SOP-4 debit-spread default for same-day unflagged verticals, clearly labelled and overridden by broker flags), LLM merge advice re-checked by code and executable from the page, and a categorized trading-lessons module (options / stocks / hedging) with edit history.

### 盈亏与图表 / P&L and charts
- 盈亏日 K 覆盖全部已保存样本，显示历史总变化；核算范围变化只在蜡烛上标注 `basisChanged` 并在页面列出日期（旧“只取最后一段相同范围”口径保留为 `scope: "latest-basis"`）。
- Daily P&L candles now chart the whole saved history; accounting-scope changes are flagged instead of truncating the series.

### LLM / 设置 / Settings
- `DAILY_LLM_MAX_OUTPUT_TOKENS=0`（新默认）表示不发送 `max_tokens`，由服务商默认值决定；可填 1000–400000；截断错误携带输出片段以便诊断。推理模型的思考过程计入输出 token。
- `REVIEW_MERGE_ADVICE_AUTO` 控制券商同步后是否自动请求合并建议。
- `DAILY_LLM_MAX_OUTPUT_TOKENS=0` (new default) omits `max_tokens`; explicit budgets accept 1000–400000; truncated replies keep a sample for diagnosis. `REVIEW_MERGE_ADVICE_AUTO` toggles automatic merge advice after broker syncs.

### 运维 / Operations
- 记录并修复了 2026-09-24 至 09-26 的出口代理事故排查口径（券商同时报“读取失败”时先分层核对代理、凭证与直连）；文档补充出口代理变量说明。
- Documented the egress-proxy troubleshooting order for simultaneous broker sync failures.

## 0.1.0 — 2026-09-23

- 首个公开版本：多券商只读同步（Tradier、IBKR Flex、Schwab OAuth、Alpaca）、加密账号设置、交易复盘与自动配对、市场日报与日报推理、风险敞口分析、盈亏日 K、Docker Compose 与便携包发布。
- Initial public release: read-only multi-broker sync (Tradier, IBKR Flex, Schwab OAuth, Alpaca), encrypted account settings, trade review with automatic pairing, macro daily reports with LLM inference, risk-exposure analysis, daily P&L candles, Docker Compose and portable bundles.
