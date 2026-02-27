# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.3] - 2026-02-26

### Fixed

- Shebang changed from `#!/usr/bin/env node` to `#!/usr/bin/env bun` — project requires Bun runtime (`bun:sqlite`)

## [0.1.2] - 2026-02-26

### Added

- Interactive CLI setup wizard: first-run experience guides new users through credential entry, server validation, `.env` creation, and auto-start
- `opencode-lark init` command to re-run the setup wizard at any time
- Minimal `.env` file parser (`loadEnvFile`) — loads environment variables before config phase

### Changed

- Startup Phase 0 added: env file loading + setup wizard check before normal boot sequence
- `needsSetup()` only triggers when no config file exists, credentials are missing, AND stdin is a TTY

### Docs

- READMEs updated: setup wizard shown as primary Quick Start path
- Added `opencode-lark init` tip for re-running wizard

## [0.1.1] - 2026-02-26

### Added

- Interactive question cards: when the AI agent asks a question, Feishu users see a card with clickable answer buttons
- Interactive permission cards: file edit, bash, and webfetch approvals rendered as Feishu cards with Allow/Reject buttons
- Card action callbacks via WebSocket long connection (`card.action.trigger`)
- Toast feedback + card replacement on button click (buttons disabled after answering)
- Interactive poller fallback: polls `/question` and `/permission` endpoints every 3s in case SSE events are missed
- Chinese README (`README.zh-CN.md`)

### Fixed

- Card action callback timeout (error 200340): handler now returns immediately within Feishu's 3s requirement
- Interactive cards sent as direct JSON instead of CardKit v2 wrapper (fixes `content type illegal` error)
- Permission event type corrected from `permission.updated` to `permission.asked`
- POST timeout no longer kills SSE listener when session is blocked on a question

### Changed

- Removed dead code: `editMessage`, `appendText`, `SessionBusy`, `ReasoningDelta`

### Docs

- Added callback subscription setup guide (Step 8) — required for interactive cards
- Added `cardkit:card:write` permission to required permissions table
- Added error 200340 to troubleshooting table

## [0.1.0] - 2026-02-25

### Initial Open-Source Release

- Feishu/Lark ↔ opencode bidirectional messaging via WebSocket long connection
- Real-time streaming cards with tool progress indicators (CardKit v2)
- Sub-agent task tracking with expandable progress cards
- Channel abstraction layer (`ChannelPlugin` interface for extensibility)
- Session management with TUI session discovery and automatic binding
- Cron scheduling service with configurable jobs
- Heartbeat monitoring with Feishu status notifications
- SQLite-backed conversation memory with context injection
- Message deduplication to prevent duplicate processing
- Configurable via JSONC config file + environment variables
- TypeScript with strict mode, zero-error build
- 248 unit + integration tests (vitest)
