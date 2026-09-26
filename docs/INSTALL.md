# 安装与部署

三种安装方式：源码运行、Docker（预构建镜像或从源码构建）、便携包。三者数据模型相同（SQLite），可以互相迁移数据目录。安装后先看 [README](../README.md) 的"快速开始"做首次登录，再回到本文档查环境变量或排查问题。

## 方式一：源码运行

前置条件：Node.js ≥ 24（项目使用 Node 内置的 `node:sqlite` 模块，见下方"故障排查"）、git。

```bash
git clone <repo-url> invest-monitor
cd invest-monitor
npm ci
npm run build          # tsc -b（各 packages/apps/server）+ vite build（apps/web）
cp .env.example .env   # 可选：填写券商 Token、LLM 等，留空也能启动
npm start               # node apps/server/dist/main.js
```

首次启动时，如果 `config/portfolio.yaml` 不存在，会自动从 `config/portfolio.example.yaml` 复制一份（该文件定义关注的标的与数据源绑定）；`data/invest.sqlite`（业务库）及配套的行情存储也会在首次启动时自动创建。

不设置 `API_PORT` 时默认监听 `http://127.0.0.1:3000`（`API_BIND_HOST`/`API_PORT` 均可调；静态前端来自 `apps/web/dist`，与 API 同源同端口提供，不需要额外的 Nginx）。想和 Docker/便携包保持一致的 8080，可在 `.env` 里设置 `API_PORT=8080`。打开网页即可看到登录页或直接进入（取决于 `UI_AUTH_MODE`，见下方"鉴权"）。

本地开发（不走 `npm run build`/`npm start`，用于改代码时热重载）：

```bash
npm run dev       # 终端 1：API + 采集调度器（tsx 直接跑 TS）
npm run dev:web   # 终端 2：Vite 前端，代理 /api 与 /health 到终端 1
```

## 方式二：Docker

需要一个 CLI/脚本鉴权用的 token 文件（浏览器走密码登录，这个 token 只给脚本/AI Agent 用）：

```bash
mkdir -p secrets
openssl rand -hex 24 > secrets/ui_auth_token
chmod 600 secrets/ui_auth_token
```

**预构建镜像**（`ghcr.io/<owner>/invest-monitor-api`、`ghcr.io/<owner>/invest-monitor-web`）：

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

**从源码构建**：

```bash
docker compose up -d --build
```

关键 `.env` 变量（放在项目根目录，Compose 会读取）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `UI_BIND_IP` | `0.0.0.0` | Web 容器对外监听的绑定地址（全部接口）；只想本机/内网访问就绑定对应网卡或 VPN 地址 |
| `UI_PORT` | `8080` | Web 容器对外映射的端口 |
| `INVEST_DATA_DIR` | `./data` | 宿主机上的数据根目录，自身需要提前存在且可写；`db/`、`market-archive/`、`logs/`、`backups/` 等子目录会自动在它下面创建 |
| `DOCKER_EGRESS_PROXY_URL` | 直连 | 容器运行时访问外部网络（行情、新闻、券商 API）的 HTTP 代理，容器内用 `host.docker.internal` 访问宿主机代理，不是 `localhost`；Compose 会把它同时注入为容器内的 `EGRESS_SINGLE_PROXY_URL` 与 `BROKER_EGRESS_PROXY_URL` |
| `DOCKER_BUILD_PROXY_URL` | 直连 | `docker compose up --build` 时构建阶段（apt/npm）使用的代理，仅从源码构建时需要 |

完整变量表见下方"环境变量参考"。容器内业务逻辑与源码模式完全一致，账号设置页保存的凭证同样加密落库。

修改 `.env` 后必须重新创建容器才会生效，单纯 `restart` 不会重新读取环境变量：

```bash
docker compose up -d --force-recreate
```

## 方式三：便携包

从 GitHub Releases 下载对应平台的包（内置 Node 运行时，不需要本机装 Node）：`invest-monitor-<version>-linux-x64.tar.gz`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`win-x64`（Windows 用 `.zip`）。

解压后直接运行即可，不需要先装到别处：

```bash
tar xzf invest-monitor-<version>-linux-x64.tar.gz
cd invest-monitor-<version>-linux-x64
./start.sh      # 启动；Windows 下双击或运行 start.cmd
```

首次运行会在脚本所在目录下自动创建 `data/`（数据库、行情热库/归档、日志）与 `secrets/`（自动生成的 `ui_auth_token`），并在 `config/portfolio.yaml` 不存在时从 `config/portfolio.example.yaml` 复制一份；同目录下的 `.env`（如果存在）会被自动加载。默认监听 `http://127.0.0.1:8080`（`start.sh` 固定启用密码登录，即 `UI_AUTH_MODE=password`，与 Docker 一致）。浏览器打开该地址，用默认密码 `123456` 登录后立即在网页右上角改密码；券商/LLM 凭证既可以直接在网页"账号设置"里填写，也可以复制 `.env.example` 为 `.env` 手工配置。

`./install.sh` 是可选的一步：把当前这份便携包复制到一个固定位置（默认 `~/.local/share/invest-monitor`，可传参数自定义目录），之后重新解压新版本再执行一次 `install.sh` 即可原地升级程序代码，不会动已安装位置的 `data/`、`secrets/`、`.env`；在 Linux 上加 `--systemd` 还会写入一个用户级 systemd unit 实现开机自启（`systemctl --user enable --now invest-monitor`）。不想固定安装、只是想跑起来看看的话，跳过这一步、直接用 `./start.sh` 即可。

升级（不使用 `install.sh` 时）：下载新版本包解压到新目录，把旧目录的 `data/`、`config/portfolio.yaml`、`.env`、`secrets/` 复制过去，再运行新的 `start.sh`。

## 环境变量参考

除非特别说明，以下变量均可写在 `.env`（源码/便携模式）或 Compose 的 `.env`（Docker 模式）。标记为"账号设置可覆盖"的变量同时也是账号设置页对应字段的默认值来源，两者的优先级是：**账号设置页保存的值 > 环境变量 > 内置默认值**，详见 [账号设置与 API](SETTINGS.md)。

**服务与存储**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | 未设置 | 设为 `production` 时，`UI_AUTH_MODE` 默认变为 `password`；Docker 编排里已固定设为 `production` |
| `APP_CONFIG_PATH` | `config/portfolio.yaml` | 标的与数据源绑定配置文件路径 |
| `APP_CONFIG_EXAMPLE_PATH` | `config/portfolio.example.yaml` | 当 `APP_CONFIG_PATH` 不存在时，用于自动生成的示例文件路径（源码/便携模式；Docker 通常直接挂载一份现成配置） |
| `SQLITE_PATH` | `data/invest.sqlite` | 业务库（交易、持仓、复盘、新闻、账号设置等）文件路径 |
| `STORAGE_DRIVER` | `node-sqlite` | SQLite 驱动，可选 `node-sqlite`（Node 内置 `node:sqlite`）或 `better-sqlite3`（需已安装该原生依赖） |
| `MARKET_HOT_PATH` / `MARKET_ARCHIVE_DIR` | 未设置 | 成对设置后，把近 30 天行情热库和按月归档块分别存到指定路径；不设置则使用存储层默认布局 |
| `WEB_DIST_DIR` | `apps/web/dist` | 静态前端产物目录（源码模式一般不需要改） |
| `API_BIND_HOST` | `127.0.0.1` | API 监听地址；Docker 内部固定 `0.0.0.0`，对外端口由 Compose 映射控制 |
| `API_PORT` | `3000` | API 监听端口 |
| `UI_PUBLIC_URL` | 按请求 Host 头推断 | 显式指定对外地址，仅用于 `GET /api/settings/schema` 示例命令中的地址 |
| `TZ` | 系统时区 | 建议设为 `America/New_York`，与交易日历时区一致，Docker 镜像已默认如此 |
| `EGRESS_SINGLE_PROXY_URL` | 直连 | 行情/新闻出口（Tradier 报价、金价现货、加密货币、RSS 新闻等）统一使用的 HTTP 代理，覆盖 `config/portfolio.yaml` 中全部 `egressProfiles.*.proxyUrl`；源码/便携模式在 `.env` 中设置，Docker 用 `DOCKER_EGRESS_PROXY_URL` |
| `EGRESS_DIRECT_PROXY_URL` / `EGRESS_CORP_PROXY_URL` / `EGRESS_VPN_PROXY_URL` | 沿用 YAML | 只覆盖 `egressProfiles` 中对应一个出口的 `proxyUrl`，留空保持 YAML 值；Compose 不转发这三项 |

**鉴权**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UI_AUTH_MODE` | `password`（`NODE_ENV=production`）否则 `off` | `off` 不校验登录（仅建议本机/隔离环境使用）；`password` 走浏览器密码 + Cookie 登录；`token` 只接受 Bearer token |
| `UI_AUTH_TOKEN_FILE` | 未设置 | 存放 CLI/脚本 Bearer token 的文件路径，例如 `secrets/ui_auth_token`；优先级高于下面两个变量 |
| `UI_AUTH_TOKEN` / `API_AUTH_TOKEN` | 未设置 | 直接以环境变量形式提供 Bearer token（未设置 `UI_AUTH_TOKEN_FILE` 时生效） |
| `UI_AUTH_COOKIE_SECURE` | `false` | 会话 Cookie 是否要求 HTTPS；部署在 HTTPS 之后应设为 `true` |
| `UI_AUTH_SESSION_TTL_SECONDS` | `43200`（12 小时） | 浏览器会话有效期 |

**账号设置加密**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SETTINGS_ENCRYPTION_KEY` | 未设置 | 64 位十六进制字符串（或任意字符串，会做 SHA-256 归一化）作为 AES-256-GCM 密钥；不设置则自动生成密钥文件 |
| `SETTINGS_KEY_FILE` | `<SQLITE_PATH 所在目录>/settings.key` | 自动生成密钥文件的路径；该文件需要和数据库一起备份，随意删除/更换会导致已保存的密钥类账号设置失效 |
| `SETTINGS_READONLY` | `false` | 设为 `true` 后账号设置页/接口只读，无法保存或清除覆盖，适合把配置完全交给环境变量管理的部署 |

**券商（账号设置可覆盖）**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TRADIER_ACCESS_TOKEN` | 未设置 | Tradier Access Token，行情与账户同步共用 |
| `TRADIER_ENVIRONMENT` | `live` | `live`（实盘）或 `sandbox`（模拟，行情延迟约 15 分钟） |
| `IBKR_FLEX_TOKEN` / `IBKR_FLEX_QUERY_ID` | 未设置 | IBKR Flex Web Service 的 Token 与 Query ID |
| `SCHWAB_APP_KEY` / `SCHWAB_APP_SECRET` | 未设置 | Schwab 开发者门户应用的 App Key / Secret |
| `SCHWAB_REDIRECT_URI` | `https://127.0.0.1` | 必须与开发者门户登记的 Callback URL 完全一致 |
| `SCHWAB_REFRESH_TOKEN` | 未设置 | 通常由账号设置页的 OAuth 授权流程自动写入；7 天有效 |
| `SCHWAB_REFRESH_TOKEN_ISSUED_AT` | 未设置 | 系统在授权成功后自动写入，仅用于提示到期时间，不建议手工填写 |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | 未设置 | Alpaca API Key |
| `ALPACA_ENVIRONMENT` | `live` | `live` 或 `paper` |
| `BROKER_EGRESS_PROXY_URL` | 直连 | 券商同步请求使用的 HTTP 代理，与行情/新闻出口的 `EGRESS_SINGLE_PROXY_URL` 相互独立 |

**日报 LLM 推理（账号设置可覆盖）**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DAILY_LLM_PROVIDER` | `openai-compatible` | `openai-compatible` / `openai` / `deepseek`，决定请求字段（`max_tokens` 还是 `max_completion_tokens`）与输出格式 |
| `DAILY_LLM_BASE_URL` | 未设置 | API 地址，含版本路径（如 `/v1`），不含 `/chat/completions` |
| `DAILY_LLM_API_KEY` | 未设置 | API Key |
| `DAILY_LLM_MODEL` | 未设置 | 模型名称 |
| `DAILY_LLM_TIMEOUT_MS` | `180000` | 单次推理请求超时（1000–300000） |
| `DAILY_LLM_MAX_OUTPUT_TOKENS` | `0` | 输出 token 上限；`0` 表示不设上限（不发送 `max_tokens`，由服务商默认值决定），填 1000–400000 则截断时自动以两倍上限压缩重试一次。推理模型（如 DeepSeek 带 reasoning 的模型）的思考过程也计入输出，过小的上限会截断长 JSON |
| `DAILY_LLM_EGRESS_PROFILE` | `auto` | `auto`（比较直连与 VPN 后选择）/ `direct` / `vpn` / `corp` |
| `REVIEW_MERGE_ADVICE_AUTO` | `1` | 券商同步后，待判断的多腿分组有变化时自动请求同一 LLM 给出按 SOP 的合并建议（30 分钟内最多一次）；`0` 表示只在复盘页手动触发 |

**Docker 专用**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UI_BIND_IP` | `0.0.0.0` | Web 容器端口映射的绑定地址（全部接口） |
| `UI_PORT` | `8080` | Web 容器对外端口 |
| `INVEST_DATA_DIR` | `./data` | 宿主机数据根目录，自身需提前存在，子目录自动创建 |
| `DOCKER_EGRESS_PROXY_URL` | 直连 | 容器运行时出口代理（行情/新闻/券商），容器内访问宿主机用 `host.docker.internal`；注入为 `EGRESS_SINGLE_PROXY_URL` + `BROKER_EGRESS_PROXY_URL` |
| `DOCKER_BUILD_PROXY_URL` | 直连 | 源码构建镜像时（apt/npm）使用的代理 |

**其他/历史遗留**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MASSIVE_API_KEY` | 未设置 | 旧股票行情来源，已停用（股票/期权行情统一来自 Tradier），留空即可 |
| `OPENROUTER_API_KEY` | 未设置 | 可选的新闻 LLM 增强，默认规则优先、不调用模型；留空不影响新闻采集 |

## 升级与备份

**升级**：源码模式 `git pull && npm ci && npm run build`，重启进程；Docker 模式拉取新镜像或重新构建后 `docker compose up -d`（会自动重建变化的容器）；便携包解压新版本后，用过 `install.sh` 固定安装的话再执行一次 `install.sh`（原地升级程序代码，不动 `data/`/`secrets/`/`.env`），否则手动把旧目录的 `data/`、`config/portfolio.yaml`、`.env`、`secrets/` 复制到新解压目录。

**改了环境变量必须重新创建容器/重启进程**：单纯 `docker compose restart` 或给进程发信号都不会重新读取 `.env`。

**备份**：至少要覆盖业务库（`SQLITE_PATH`，默认 `data/invest.sqlite`）；如果配置了独立的 `MARKET_HOT_PATH`/`MARKET_ARCHIVE_DIR`，连带备份。SQLite 采用 WAL 模式，不要在服务运行时直接 `cp` 主文件（可能漏掉 WAL 里未 checkpoint 的数据）；建议用 SQLite 在线备份 API，或先确认没有写入任务在跑、执行一次 checkpoint 后再复制。账号设置的加密密钥文件（`SETTINGS_KEY_FILE`，默认在数据库同目录的 `settings.key`）也要一起备份，否则恢复后已保存的密钥类账号设置（券商 Token、LLM Key 等）会失效，需要重新填写。更细的分层存储备份思路见 [存储与性能](STORAGE-PERFORMANCE.md)。

## 故障排查

**端口被占用**：调整 `API_PORT`（源码/便携模式）或 `UI_PORT`（Docker），或停掉占用端口的进程。

**首次登录用什么密码**：默认初始密码是 `123456`，登录后页面会持续提示"当前仍在使用初始密码"，请尽快在"账户设置"改掉。Docker 编排和便携包的 `start.sh`/`start.cmd` 都固定启用 `UI_AUTH_MODE=password`；只有直接用 `npm start` 跑源码（不经过便携包脚本）时默认是 `UI_AUTH_MODE=off`（不校验登录），需要显式设置 `UI_AUTH_MODE=password` 才会出现登录页。如果部署会被本机以外的设备访问到，务必确认登录已启用。

**Node 版本报错 / 启动失败**：源码模式要求 Node.js ≥ 24（存储层默认使用 Node 内置的 `node:sqlite` 模块），用 `node --version` 确认；便携包自带运行时不受本机 Node 版本影响。

**启动日志出现 `ExperimentalWarning: SQLite is an experimental feature`**：来自默认存储驱动 `node:sqlite`，这是 Node 官方对该内置模块的标注，不影响功能，可以忽略。如果想换成 `better-sqlite3`（一个成熟的原生 SQLite 绑定），确认该依赖已安装后设置 `STORAGE_DRIVER=better-sqlite3` 并重启。

**改了 `.env` 不生效**：Docker 下必须 `docker compose up -d --force-recreate`（或 `--build`），单纯 `restart` 不会重新注入环境变量；源码/便携模式需要重启进程。

**容器访问不了代理/外部网络**：容器内要访问宿主机上监听的代理，用 `host.docker.internal`，不是 `localhost` 或 `127.0.0.1`（那指向容器自己）。`DOCKER_BUILD_PROXY_URL` 只影响构建阶段（apt/npm 下载依赖），`DOCKER_EGRESS_PROXY_URL` 只影响容器运行后的出站请求（行情、新闻、券商同步）；两者互相独立，缺一个不会自动复用另一个。

**日志出现 `getaddrinfo ENOTFOUND www.coindesk.com`（或其他行情/新闻站点），来源熔断器显示 `closed` 并反复重试**：示例配置默认直连（`egressProfiles.*.proxyUrl` 为空），这是本机 DNS 或直连被阻断，不是程序错误；`closed` 表示熔断器未打开、下次到点仍会重试。三种处理：① 源码/便携模式在 `.env` 里填 `EGRESS_SINGLE_PROXY_URL=http://<代理地址>:<端口>`（Docker 填 `DOCKER_EGRESS_PROXY_URL`），重启后所有行情/新闻出口走代理；② 只需要券商同步时，填 `BROKER_EGRESS_PROXY_URL` 即可，行情来源的报错不影响券商同步与复盘；③ 不需要该来源时，在 `config/portfolio.yaml` 里删除或停用对应 `sources` 条目。

**`better-sqlite3` 编译失败**：它是可选依赖，默认存储驱动 `node-sqlite` 不需要它；如果不打算切换驱动，可以忽略安装失败（不影响 `STORAGE_DRIVER` 保持默认时的运行）。
