# opencode-feishu

> Bridge Feishu group chats to opencode TUI sessions with real-time two-way messaging.
>
> 将飞书群聊与 opencode TUI session 打通，实现双向实时消息转发。

![CI](https://github.com/USERNAME/opencode-feishu/actions/workflows/ci.yml/badge.svg)
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
opencode-feishu  (this project / 本项目)
    ↕  HTTP API + SSE
opencode server  (localhost:4096)
    ↕  stdin/stdout
opencode TUI
```

**Inbound (飞书 → TUI):** Feishu sends a message over WebSocket. opencode-feishu normalizes it, resolves the bound session, prepends conversation history, then POSTs to the opencode API. The TUI sees the message immediately.

**Outbound (TUI → 飞书):** opencode-feishu subscribes to the opencode SSE stream. As the agent produces text, `TextDelta` events accumulate and a debounced card update fires. Once `SessionIdle` arrives, the final card is flushed to Feishu.

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
git clone https://github.com/USERNAME/opencode-feishu.git
cd opencode-feishu
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

**5. Start opencode-feishu / 启动 opencode-feishu**

In a second terminal:

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

`opencode-feishu.jsonc` (gitignored; copy from `opencode-feishu.example.jsonc`):

```jsonc
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

[MIT](LICENSE) © 2026 opencode-feishu contributors
