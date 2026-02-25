# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
