# AGENTS.md — opencode-feishu

Architecture guide for contributors. Covers module layout, key abstractions, data flow, and how to extend the system.

## What This Project Does

`opencode-feishu` bridges Feishu group chats with opencode TUI sessions. Messages sent in Feishu flow into opencode as if typed in the terminal. Agent replies stream back to Feishu as live-updating cards.

```
Feishu client
    ↕  WebSocket (long-lived)
Feishu Open Platform
    ↕  WebSocket / Webhook
opencode-feishu  (this project)
    ↕  HTTP API + SSE
opencode server  (localhost:4096)
    ↕  stdin/stdout
opencode TUI
```

---

## Module Map

```
src/
├── index.ts         Entry point, 9-phase startup + graceful shutdown
├── types.ts         Shared type definitions
├── channel/         ChannelPlugin interface, ChannelManager, FeishuPlugin
├── feishu/          Feishu REST client, CardKit, WebSocket, message dedup
├── handler/         MessageHandler (inbound pipeline) + StreamingBridge (SSE → cards)
├── session/         TUI session discovery, thread→session mapping, progress cards
├── streaming/       EventProcessor (SSE parsing), SessionObserver, SubAgentTracker
├── memory/          SQLite-backed per-thread conversation history
├── cron/            CronService (scheduled jobs) + HeartbeatService
└── utils/           Config loader, logger, SQLite init, EventListenerMap
```

---

## Key Abstractions

### ChannelPlugin (`src/channel/types.ts`)

The core extension contract. Any chat platform (Slack, Discord, etc.) implements this interface to plug into `ChannelManager`.

```typescript
interface ChannelPlugin {
  id: ChannelId           // e.g. "feishu"
  meta: ChannelMeta       // label + description
  config: ChannelConfigAdapter      // list accounts, resolve credentials
  gateway?: ChannelGatewayAdapter   // start/stop connections
  messaging?: ChannelMessagingAdapter  // normalize inbound, format outbound
  outbound?: ChannelOutboundAdapter    // sendText, sendCard
  streaming?: ChannelStreamingAdapter  // createStreamingSession, coalesceUpdates
  threading?: ChannelThreadingAdapter  // resolveThread, mapSession, getSession
}
```

All adapters except `config` are optional. Implement only what your channel needs.

### EventProcessor (`src/streaming/event-processor.ts`)

Consumes the raw SSE stream from opencode and emits structured events: `TextDelta`, `SessionIdle`, `ToolStart`, `ToolEnd`, etc. Other services subscribe via `EventListenerMap`.

### SessionManager (`src/session/session-manager.ts`)

Discovers live opencode TUI sessions for a working directory. Binds a Feishu thread key (chat ID + thread ID) to a specific session ID, persisting the mapping in SQLite so it survives restarts.

### StreamingBridge (`src/handler/streaming-integration.ts`)

Translates accumulated `TextDelta` events into Feishu CardKit updates. Debounces rapid updates to avoid rate limits, and renders a final card once `SessionIdle` fires.

---

## Data Flow

### Inbound (Feishu → opencode)

```
Feishu WebSocket
  → FeishuPlugin.gateway.startAccount()
    → raw event received
      → ChannelMessagingAdapter.normalizeInbound()
        → MessageHandler
          1. MessageDedup: skip if already seen
          2. SessionManager: resolve or discover session
          3. MemoryManager: prepend conversation history
          4. HTTP POST to opencode /session/{id}/message
          5. Register SSE listener for this session
          6. ProgressTracker: show "thinking..." card in Feishu
```

### Outbound (opencode → Feishu)

```
opencode SSE stream
  → EventProcessor: parse raw event → typed event
    → SessionObserver: fan-out to registered listeners
      → StreamingBridge
          TextDelta  → accumulate text, debounced CardKit update
          SessionIdle → flush final card to Feishu via CardKitClient
          ToolStart  → update progress card
```
---

## Startup Phases (`src/index.ts`)

1. Load config (`opencode-feishu.jsonc` or env vars)
2. Connect to opencode server (exponential-backoff retry, max 10 attempts)
3. Init SQLite database
4. Create shared services (SessionManager, MemoryManager, EventProcessor, StreamingBridge)
5. Subscribe to opencode SSE event stream
6. Instantiate FeishuPlugin + register with ChannelManager
7. Start channels (WebSocket) + webhook server (card action callbacks)
8. Start optional CronService + HeartbeatService
9. Register SIGTERM/SIGINT handlers for graceful shutdown
---

## Extension Points

### Adding a New Channel

1. Create `src/channel/{platform}/` directory.
2. Implement `ChannelPlugin` from `src/channel/types.ts`. Start with `config` (required), then add `gateway`, `messaging`, `outbound` as needed.
3. In `src/index.ts` Phase 6, instantiate your plugin and call `channelManager.register(yourPlugin)`.
4. `ChannelManager.startAll()` will call `gateway.startAccount()` for each configured account automatically.
### Adding a Cron Job


1. Open `src/cron/cron-service.ts`.
2. Add your job definition to the cron config schema in `src/types.ts`.
3. Register the new job inside `CronService.start()` with a cron expression and handler function.
4. Enable it in `opencode-feishu.jsonc` under the `cron` key.

### Adding a Heartbeat Check

`src/cron/heartbeat.ts` pings the opencode server and optionally posts a status message to a Feishu chat. Extend `HeartbeatService` to check additional endpoints or post richer status cards via `CardKitClient`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | yes | | Feishu App ID |
| `FEISHU_APP_SECRET` | yes | | Feishu App Secret |
| `OPENCODE_SERVER_URL` | no | `http://localhost:4096` | opencode server URL |
| `FEISHU_WEBHOOK_PORT` | no | `3001` | Card action callback port |
| `OPENCODE_CWD` | no | `process.cwd()` | Override session discovery directory |

See `.env.example` and `opencode-feishu.example.jsonc` for full reference.
