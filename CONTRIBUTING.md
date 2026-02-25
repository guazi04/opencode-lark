# Contributing to opencode-feishu

Thanks for your interest in contributing. This guide covers everything you need to get started.

For architecture details, see [AGENTS.md](./AGENTS.md).

## Prerequisites

- **Node.js >= 22**
- **bun** (package manager and runtime): [bun.sh](https://bun.sh)
- **opencode** installed locally: running `opencode` in a terminal should start the TUI and HTTP server on port 4096
- **Feishu/Lark app** with an App ID and App Secret (WebSocket long-connection mode, not webhook polling)

## Dev Setup

```bash
# Clone and install
git clone <repo-url> opencode-feishu
cd opencode-feishu
bun install

# Configure environment
cp .env.example .env
# Fill in FEISHU_APP_ID and FEISHU_APP_SECRET

# Configure the app (optional, auto-derived from .env if absent)
cp opencode-feishu.example.jsonc opencode-feishu.jsonc
# Customize as needed
```

## Running Locally

Start opencode in one terminal (any project directory):

```bash
opencode
```

Start the bridge in another terminal:

```bash
bun run dev
```

`dev` mode runs with `--watch`, so code changes restart the process automatically.

## Testing

```bash
bun run test:run
```

This runs [vitest](https://vitest.dev) scoped to the `src/` directory. Tests cover:

- Feishu message deduplication
- Session discovery and binding logic
- SSE event processing and sub-agent tracking
- Config loading and env-var interpolation
- Memory (SQLite) operations

> Don't use `bun test` directly. It picks up both `src/` and `dist/` test files, which causes double-runs. Always use `bun run test:run`.

## Building

```bash
bun run build
```

Compiles TypeScript to `dist/` via `tsc`. The build must exit cleanly before submitting a PR.

## Code Style

- TypeScript strict mode throughout. No `any` unless genuinely unavoidable.
- Follow the patterns in the file you're editing. Consistency matters more than personal preference.
- No linter is configured. Just match the surrounding code.

## Submitting a PR

1. Fork the repo and create a feature branch: `git checkout -b feat/your-feature`
2. Make your changes. Keep commits focused.
3. Run `bun run test:run` and `bun run build`. Both must pass.
4. Push your branch and open a PR against `main`.
5. Describe what changed and why. Link any related issues.

A maintainer will review and may request changes before merging.

## Reporting Bugs

Open an issue and include:

- What you expected to happen
- What actually happened (logs help a lot)
- Your environment: OS, Node version, bun version, opencode version
- Minimal steps to reproduce

Logs go to stderr. Capture them with `bun run dev 2>/tmp/feishu-bridge.log` and attach the relevant section.
