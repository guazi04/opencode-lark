# opencode-lark

> Bridge Feishu group chats to opencode TUI sessions with real-time two-way messaging.
>
> 将飞书群聊与 opencode TUI session 打通，实现双向实时消息转发。

![CI](https://github.com/guazi04/opencode-lark/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/opencode-lark.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

---

## Features / 特性

- **Real-time bridging** — Messages sent in Feishu arrive in your opencode TUI instantly, and agent replies stream back as live-updating cards.
  实时桥接，飞书消息即时出现在 opencode TUI，agent 回复以动态卡片形式推送回飞书。

- **WebSocket connection** — Uses Feishu's long-lived WebSocket mode. No webhook polling, no public IP required.
  采用飞书 WebSocket 长连接模式，无需公网 IP，无需轮询。

- **SSE streaming** — Consumes the opencode SSE event stream and debounces card updates to stay within rate limits.
  订阅 opencode SSE 事件流，防抖处理卡片更新，避免触发频率限制。

- **Conversation memory** — SQLite-backed per-thread history is prepended to each message, giving the agent context across turns.
  SQLite 存储每个会话的对话历史，每次消息自动携带上下文。

- **Session auto-discovery** — Finds and binds to the latest opencode TUI session for a working directory. Survives restarts.
  自动发现并绑定当前目录的最新 TUI session，重启后映射关系持久保存。

- **Graceful recovery** — Reconnects to the opencode server with exponential backoff (up to 10 attempts) on startup.
  启动时指数退避重连 opencode server，最多重试 10 次，无需手动等待 server 就绪。

- **Extensible channel layer** — `ChannelPlugin` interface lets you add Slack, Discord, or any other platform without touching core logic.
  `ChannelPlugin` 接口设计，可扩展接入 Slack、Discord 等其他平台，无需修改核心逻辑。

---

## Architecture / 架构概览

```
Feishu client
    ↕  WebSocket
Feishu Open Platform
    ↕  WebSocket
opencode-lark  (this project / 本项目)
    ↕  HTTP API + SSE
opencode server  (localhost:4096)
    ↕  stdin/stdout
opencode TUI
```

**Inbound (飞书 → TUI):** Feishu sends a message over WebSocket. opencode-lark normalizes it, resolves the bound session, prepends conversation history, then POSTs to the opencode API. The TUI sees the message immediately.

**Outbound (TUI → 飞书):** opencode-lark subscribes to the opencode SSE stream. As the agent produces text, `TextDelta` events accumulate and a debounced card update fires. Once `SessionIdle` arrives, the final card is flushed to Feishu.

---

## Install / 安装

```bash
# Global install / 全局安装
npm install -g opencode-lark
# or / 或
bun add -g opencode-lark
```

Or clone and run from source / 或从源码运行:

```bash
git clone https://github.com/guazi04/opencode-lark.git
cd opencode-lark
bun install
```

---

## Feishu App Setup / 飞书应用配置

This section walks you through creating a Feishu Internal App and configuring the required permissions.
本节介绍如何创建飞书企业自建应用并配置所需权限。

### 1. Create an Internal App / 创建企业自建应用

1. Open [Feishu Open Platform](https://open.feishu.cn/app) / 打开[飞书开放平台](https://open.feishu.cn/app)
2. Click **Create App** → **Create Internal App** / 点击**创建应用** → **创建企业自建应用**
3. Fill in app name and description, then confirm / 填写应用名称和描述后确认

### 2. Enable Bot Capability / 开启机器人能力

Navigate to **App Features → Bot** and enable the bot capability.
进入**应用功能 → 机器人**，开启机器人功能。

### 3. Configure Permissions / 配置权限

Navigate to **Development Config → Permissions & Scopes** and add the following:
进入**开发配置 → 权限管理**，开通以下权限：

| Permission / 权限 | Scope Identifier / 权限标识 | Purpose / 用途 | Required / 必需 |
|---|---|---|---|
| 获取与发送单聊、群组消息 | `im:message` | Send messages & update cards / 发送消息、更新卡片 | ✅ |
| 获取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | Receive direct messages / 接收私聊消息 | ✅ |
| 获取群组中所有消息 | `im:message.group_msg:readonly` | Receive group messages / 接收群聊消息 | ✅ |
| 获取与上传图片或文件资源 | `im:resource` | Handle message attachments / 处理消息附件 | ✅ |

### 4. Subscribe to Events / 订阅事件

Navigate to **Development Config → Event Subscriptions** and:
进入**开发配置 → 事件订阅**，操作如下：

1. Select **Long Connection** (WebSocket) mode — no public IP required
   选择**长连接**模式 — 无需公网 IP
2. Add the following event:
   添加以下事件：

| Event Name / 事件名称 | Event Identifier / 事件标识 | Purpose / 用途 | Required / 必需 |
|---|---|---|---|
| 接收消息 | `im.message.receive_v1` | Receive all user messages / 接收用户消息 | ✅ |

> **Optional / 可选**: For interactive card buttons (e.g. card action callbacks), you may also configure a webhook server URL under **Card Engine** settings. Set `FEISHU_WEBHOOK_PORT` and expose it via a reverse proxy.
> **可选**：如需卡片按钮交互，可在卡片引擎配置中填写回调地址，并通过反向代理暴露 `FEISHU_WEBHOOK_PORT`。

### 5. Get Credentials / 获取凭证

Navigate to **Credentials & Basic Info** to find:
进入**凭证与基础信息**找到：

- **App ID** → set as `FEISHU_APP_ID`
- **App Secret** → set as `FEISHU_APP_SECRET`

### 6. Publish the App / 发布应用

Navigate to **App Release → Version Management & Release**, create a version and submit for review.
After approval, add the bot to your workspace.
进入**应用发布 → 版本管理与发布**，创建版本并提交审核。审核通过后，将机器人添加到工作区。

> **Note**: Internal apps in trial status can be used by app administrators immediately without review for testing.
> **注意**：测试阶段，应用管理员可直接使用，无需等待审核通过。

### Troubleshooting / 故障排除

| Symptom / 现象 | Likely Cause / 可能原因 | Fix / 解决方案 |
|---|---|---|
| Bot doesn't receive messages / 机器人收不到消息 | WebSocket not enabled or wrong subscription / 未开启长连接或事件未订阅 | Check event subscription, ensure Long Connection mode is selected / 检查事件订阅，确认选择长连接模式 |
| "Invalid App ID or Secret" / 凭证错误 | Wrong credentials in .env / .env 中凭证有误 | Double-check App ID and App Secret from Feishu console / 从飞书控制台重新确认凭证 |
| Messages received but no reply / 收到消息但无回复 | opencode server not running / opencode server 未启动 | Ensure `opencode` TUI is running before starting opencode-lark / 确保先启动 opencode TUI |
| Card not updating in real-time / 卡片不实时更新 | Rate limit or debounce delay / 频率限制或防抖延迟 | Normal behavior — updates are debounced to stay within Feishu rate limits / 正常行为，防抖处理避免触发频率限制 |

---

## Quick Start / 快速开始

### Prerequisites / 前置要求

- **Node.js >= 22** and **[bun](https://bun.sh)**
- **[opencode](https://opencode.ai)** installed locally
- A **Feishu Open Platform app** with:
  - App ID and App Secret
  - Event subscription `im.message.receive_v1` enabled
  - Connection mode set to **WebSocket** (long-lived, not webhook polling)

### Steps / 步骤

**1. Clone the repo / 克隆仓库**

```bash
git clone https://github.com/guazi04/opencode-lark.git
cd opencode-lark
```

**2. Install dependencies / 安装依赖**

```bash
bun install
```

**3. Configure credentials / 配置凭证**

```bash
cp .env.example .env
```

Open `.env` and fill in your Feishu credentials. At minimum you need `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.

打开 `.env` 填写飞书应用凭证，至少需要填 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。

**4. Start opencode TUI / 启动 opencode TUI**

Open a terminal in your project directory:

```bash
opencode
```

The TUI starts an HTTP server on port 4096 automatically (increments if that port is taken).
TUI 启动后自动在 4096 端口运行 HTTP server，端口被占用时自动递增。

**5. Start opencode-lark / 启动 opencode-lark**

In a second terminal, run from global install:

```bash
opencode-lark
```

Or from source with watch mode / 或从源码以开发模式启动:

```bash
bun run dev
```

`dev` mode runs with `--watch`, so code changes trigger an automatic restart.
`dev` 模式带 `--watch`，代码修改后自动重启。

**6. Send a test message / 发送测试消息**

Send any message to your Feishu bot. On first contact it auto-discovers the latest TUI session and replies:

> Connected to session: ses_xxxxx

After that, Feishu and the TUI share a live two-way channel.
首次消息后飞书收到 session 绑定通知，之后双向消息互通。

---

## Configuration / 配置说明

### Environment Variables / 环境变量

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | yes | | Feishu App ID / 飞书应用 App ID |
| `FEISHU_APP_SECRET` | yes | | Feishu App Secret / 飞书应用 App Secret |
| `OPENCODE_SERVER_URL` | no | `http://localhost:4096` | opencode server URL / opencode server 地址 |
| `FEISHU_WEBHOOK_PORT` | no | `3001` | Card action callback port / 卡片回调端口 |
| `OPENCODE_CWD` | no | `process.cwd()` | Override session discovery directory / 覆盖 session 发现目录 |
| `FEISHU_VERIFICATION_TOKEN` | no | | Event subscription verification token / 事件订阅验证 token |
| `FEISHU_ENCRYPT_KEY` | no | | Event encryption key / 事件加密密钥 |

### JSONC Config / JSONC 配置文件

`opencode-lark.jsonc` (gitignored; copy from `opencode-lark.example.jsonc`):
(also supports `opencode-feishu.jsonc` for backward compatibility)

```jsonc
// opencode-lark.jsonc
{
  "feishu": {
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}",
    "verificationToken": "${FEISHU_VERIFICATION_TOKEN}",
    "webhookPort": 3001,
    "encryptKey": "${FEISHU_ENCRYPT_KEY}"
  },
  "defaultAgent": "build",
  "dataDir": "./data",
  "progress": {
    "debounceMs": 500,
    "maxDebounceMs": 3000
  }
}
```

Supports `${ENV_VAR}` interpolation and JSONC comments. If no config file is found, the app builds a default config from `.env` values directly.
支持 `${ENV_VAR}` 环境变量插值和 JSONC 注释。无配置文件时自动从 `.env` 构建默认配置。

---

## Project Structure / 项目结构

```
src/
├── index.ts         # Entry point, 9-phase startup + graceful shutdown
├── types.ts         # Shared type definitions
├── channel/         # ChannelPlugin interface, ChannelManager, FeishuPlugin
├── feishu/          # Feishu REST client, CardKit, WebSocket, message dedup
├── handler/         # MessageHandler (inbound pipeline) + StreamingBridge (SSE → cards)
├── session/         # TUI session discovery, thread→session mapping, progress cards
├── streaming/       # EventProcessor (SSE parsing), SessionObserver, SubAgentTracker
├── memory/          # SQLite-backed per-thread conversation history
├── cron/            # CronService (scheduled jobs) + HeartbeatService
└── utils/           # Config loader, logger, SQLite init, EventListenerMap
```

---

## Development / 开发

```bash
bun run dev          # Watch mode, auto-restart on changes / 开发模式，代码变更自动重启
bun run start        # Production mode / 生产模式
bun run test:run     # Run all tests (vitest) / 运行全部测试
bun run build        # Compile TypeScript to dist/ / 编译到 dist/
```

> **Note:** Use `bun run test:run` rather than `bun test`. The latter picks up both `src/` and `dist/` test files; `vitest` is configured to scope to `src/` only.
>
> 使用 `bun run test:run` 而非 `bun test`，后者会同时扫描 `src/` 和 `dist/` 下的测试文件。

---

## Contributing / 参与贡献

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on issues, pull requests, and code style.
请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解提 issue、提 PR 和代码风格的规范。

---

## License

[MIT](LICENSE) © 2026 opencode-lark contributors
