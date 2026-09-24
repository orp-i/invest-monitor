# 安全

## 定位与威胁模型

invest-monitor 是一个**本地自托管、单用户**的个人复盘工具，不是面向多租户的 SaaS。默认假设它跑在用户自己控制的机器或私有网络里（本机、家庭服务器、VPN/内网），而不是直接暴露在公网上。它保存的是**只读**的券商持仓/成交数据和用户自己撰写的复盘/日报内容；项目本身不具备下单、改单、撤单能力，因此被攻破的直接风险主要是**信息泄露**（持仓、成交、账户资金、券商 Token、LLM Key）而不是资金损失，但泄露的券商 Token 仍可能被用来读取该券商账户的其他信息，请按券商侧的权限设置（若支持只读 Key）降低风险。

如果计划把它暴露到不受信任的网络（包括把默认端口转发到公网），请先阅读下面"部署建议"，并把它放在反向代理/VPN 之后。

## 凭证存放位置

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 券商 Token（Tradier/IBKR/Schwab/Alpaca）、LLM Key | 业务 SQLite 数据库，AES-256-GCM 加密 | 通过"账号设置"页或 `PUT /api/settings/{group}` 写入；接口读取时只返回掩码，见 [账号设置与 API](docs/SETTINGS.md) |
| 加密密钥 | `SETTINGS_ENCRYPTION_KEY` 环境变量，或数据库同目录自动生成的密钥文件（默认 `settings.key`） | 后者权限 `0600`；两种情况数据库和密钥都需要一起备份 |
| CLI/脚本鉴权 token | `secrets/ui_auth_token` 文件 | 拥有与网页登录用户同等权限；已被 `.gitignore`/`.dockerignore` 排除 |
| 浏览器会话 | HttpOnly Cookie（密码登录后签发） | `UI_AUTH_COOKIE_SECURE` 建议在 HTTPS 部署下开启 |
| `.env` 里的各项凭证 | 进程环境变量 | 优先级低于账号设置页保存的值；同样被 `.gitignore`/`.dockerignore` 排除 |

## 部署建议

- **首次登录默认密码是 `123456`**，请登录后立即在"账户设置"修改；页面会持续提示尚未修改。
- Docker 编排和便携包的启动脚本都固定启用密码登录；只有直接用 `npm start` 跑源码（不经过便携包脚本）时默认 `UI_AUTH_MODE=off`（不校验登录），只适合本机或完全隔离的环境。一旦这种直接源码运行的部署会被其他设备访问到，必须显式设置 `UI_AUTH_MODE=password`（或 `token`）。
- 建议放在反向代理/VPN（如 Tailscale、Netbird、Nginx + TLS）之后，而不是直接暴露公网端口；启用 HTTPS 时同时设置 `UI_AUTH_COOKIE_SECURE=true`。
- 券商侧如果支持按权限拆分 API Key（只读 vs 可交易），优先使用只读权限的 Key。
- `SETTINGS_READONLY=1` 可以让账号设置完全由部署环境变量接管，禁止通过网页/接口修改，适合更严格的部署。
- 备份数据库时必须连同加密密钥文件（`settings.key` 或 `SETTINGS_KEY_FILE` 指向的文件）一起备份；只备份数据库、丢了密钥文件，会导致所有密钥类账号设置需要重新填写（非密钥数据不受影响）。

## 报告安全问题

这是一个个人/自托管项目，没有正式的响应 SLA。如果发现安全问题，优先通过本仓库的 GitHub Security Advisory（仓库 Security 标签页的 "Report a vulnerability"）私下报告；如果条件不允许，可以提交公开 Issue，但请**只描述问题类型和影响范围，不要贴出真实的 Token、密钥、账户号码或其他个人数据**。
