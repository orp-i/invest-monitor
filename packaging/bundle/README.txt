invest-monitor - portable bundle
=================================

中文说明在下方 (Chinese instructions follow after the English section).

--------------------------------------------------------------------
ENGLISH
--------------------------------------------------------------------

This is a self-contained, portable build of invest-monitor: a personal portfolio-review tool
(broker read-only sync, trade-by-trade review, macro market notes and research). It bundles its
own Node.js runtime under node/, so no separate Node install is required.

Quick start
-----------
1. Extract the archive anywhere you like (a folder you can write to).
2. Linux/macOS: run  ./start.sh
   Windows:     double-click  start.cmd  (or run it from a Command Prompt)
3. Open http://127.0.0.1:8080 in a browser.
4. Log in with the default password: 123456
   Change it immediately from the web UI (top-right menu) after the first login.

What start.sh/start.cmd do
---------------------------
- Create ./data (database, market history, logs) and ./secrets (a generated UI token file) next to the
  script, the first time you run it.
- Copy config/portfolio.example.yaml to config/portfolio.yaml on first run if that file does not exist
  yet (never overwrites an existing one).
- Load a .env file from the same directory, if present, for broker/LLM API keys (see below).
- Start the server bound to 127.0.0.1:8080 by default. Set API_BIND_HOST/API_PORT before running the
  script (or in .env, though .env is loaded after these two specific defaults - see "Advanced" below) to
  change that.

Configuring brokers and the daily-report LLM
---------------------------------------------
You do NOT have to edit any file to get started. After logging in, open Settings (账号设置) in the web
UI and fill in Tradier / IBKR Flex / Schwab / Alpaca / the daily-report LLM there; values are encrypted
at rest in the local database.

Alternatively (or for the proxy/data-directory settings, which are not exposed in the UI): copy
.env.example to .env in this same folder and fill in the keys you need, then restart the app
(stop with Ctrl+C, run start.sh/start.cmd again).

Where your data lives
----------------------
Everything invest-monitor writes stays inside this folder:
  data/invest.sqlite          - trades, positions, review notes, market daily reports
  data/market-hot/            - recent quote/candle history
  data/market-archive/        - older quote/candle history, by month
  data/logs/                  - service logs
  secrets/ui_auth_token       - a generated token file (required by the login system; the password
                                 itself lives in the database, not in this file)
  config/portfolio.yaml       - your instrument/source configuration (created on first run)
  .env                        - your broker/LLM keys, if you chose to use a .env file

Back up the data/ folder (and config/portfolio.yaml, and .env if you used one) to preserve your data.
To uninstall, simply delete this folder - nothing is installed outside it unless you ran install.sh
with --systemd (see below), in which case also remove the systemd unit it printed the path to.

Installing permanently (optional)
-----------------------------------
Run ./install.sh to copy this bundle into a permanent location (default:
~/.local/share/invest-monitor, override with ./install.sh /some/dir) and generate its data/secrets
there. Running it again later (after extracting a newer bundle) upgrades the installed copy in place
without touching its data/, secrets/ or .env.

Add --systemd on Linux to also write a user systemd unit so it can start automatically:
  ./install.sh --systemd
  systemctl --user enable --now invest-monitor

Support scripts
----------------
The scripts/ folder has a few maintenance scripts (statement re-import, expiration recording, an LLM
connectivity probe). Run them with the bundled Node, from this folder, e.g.:
  ./node/bin/node scripts/probe-daily-llm.mjs --help          (Linux/macOS)
  node\node.exe scripts\probe-daily-llm.mjs --help             (Windows)

Advanced: environment variables
---------------------------------
start.sh/start.cmd set a handful of path/port defaults (config, database, log, bind address/port
locations) only when they are not already set in your shell environment, then load .env for everything
else (mainly secrets, which have no sensible default). If you need to override one of those defaulted
paths via .env specifically rather than your shell, edit start.sh/start.cmd directly - they are plain
scripts, not compiled.

--------------------------------------------------------------------
中文说明
--------------------------------------------------------------------

这是 invest-monitor 的便携版打包：一个个人投资复盘工具（券商只读同步、逐笔交易复盘、宏观市场日报与研究）。
已内置 Node.js 运行时（node/ 目录），无需单独安装 Node。

快速开始
--------
1. 将压缩包解压到任意可写目录。
2. Linux/macOS：运行 ./start.sh
   Windows：双击 start.cmd（或在命令提示符中运行）
3. 浏览器打开 http://127.0.0.1:8080
4. 使用默认密码登录：123456
   首次登录后请立即在网页右上角菜单中修改密码。

start.sh/start.cmd 会做什么
----------------------------
- 首次运行时在脚本所在目录下创建 ./data（数据库、行情历史、日志）与 ./secrets（自动生成的登录令牌文件）。
- 首次运行且 config/portfolio.yaml 不存在时，从 config/portfolio.example.yaml 自动复制生成（已存在则
  绝不覆盖）。
- 如果同目录下有 .env 文件，会自动加载其中的券商/LLM 等密钥。
- 默认绑定 127.0.0.1:8080。如需更改，运行脚本前设置 API_BIND_HOST/API_PORT 环境变量（或参见下方“进阶”
  一节中关于 .env 与这几个默认值先后顺序的说明）。

配置券商与日报推理 LLM
------------------------
不需要手工编辑任何文件即可开始使用：登录后打开网页的“账号设置”，在其中填写 Tradier / IBKR Flex /
Schwab / Alpaca 及日报推理 LLM 的密钥即可，这些值会加密保存在本地数据库中。

也可以（对于网页设置中没有暴露的代理、数据目录等项，需要这种方式）：将 .env.example 复制为 .env 并
填写所需的项，然后重启程序（Ctrl+C 停止后重新运行 start.sh/start.cmd）。

数据保存位置
------------
invest-monitor 写入的所有内容都在本目录内：
  data/invest.sqlite          —— 交易、持仓、复盘记录、市场日报
  data/market-hot/            —— 近期行情/K 线
  data/market-archive/        —— 按月存放的历史行情/K 线
  data/logs/                  —— 服务日志
  secrets/ui_auth_token       —— 自动生成的令牌文件（登录系统需要；密码本身保存在数据库中，不在此文件）
  config/portfolio.yaml       —— 标的与数据源配置（首次运行时自动创建）
  .env                        —— 如果选择使用 .env 文件，其中是你的券商/LLM 密钥

请备份 data/ 目录（以及 config/portfolio.yaml、如使用了 .env 也一并备份）以保留数据。卸载时直接删除
本目录即可——除非运行过带 --systemd 的 install.sh（见下），此时还需删除其打印出的 systemd unit 文件。

安装到固定位置（可选）
------------------------
运行 ./install.sh 可将本便携包复制到固定位置（默认 ~/.local/share/invest-monitor，可用
./install.sh /自定义目录 指定）并在那里生成 data/secrets。之后如解压了新版本，再次运行 install.sh
会原地升级已安装的程序代码，不会改动其 data/、secrets/ 或 .env。

在 Linux 上加 --systemd 还会写入用户级 systemd unit，实现开机自启：
  ./install.sh --systemd
  systemctl --user enable --now invest-monitor

辅助脚本
--------
scripts/ 目录下有少量运维脚本（结单续接、到期记录、LLM 连接探测等）。请用内置的 Node 从本目录运行，例如：
  ./node/bin/node scripts/probe-daily-llm.mjs --help          （Linux/macOS）
  node\node.exe scripts\probe-daily-llm.mjs --help              （Windows）

进阶：环境变量
----------------
start.sh/start.cmd 只在这几个配置/数据库/日志路径及绑定地址/端口未被当前 shell 环境设置过时才套用默认
值，其余项（主要是各类密钥，没有合理默认值）一律从 .env 加载。如果需要专门通过 .env（而不是 shell 环境
变量）覆盖上述几个有默认值的路径项，请直接编辑 start.sh/start.cmd——它们是纯文本脚本，未经编译。
