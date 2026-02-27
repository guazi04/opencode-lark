/**
 * Interactive CLI setup wizard for opencode-lark.
 * Guides new users through Feishu credentials, server connection, and .env creation.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as readline from "node:readline/promises"
import { createLogger } from "../utils/logger.js"

const logger = createLogger("setup-wizard")

// ANSI color helpers
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`

/** Config file search paths — must match src/utils/config.ts lines 69-76 */
const CONFIG_SEARCH_PATHS = [
  path.resolve("opencode-lark.jsonc"),
  path.resolve("opencode-lark.json"),
  path.resolve("opencode-feishu.jsonc"),
  path.resolve("opencode-feishu.json"),
]

/**
 * Check whether interactive setup is needed.
 * Returns true only when no config exists, no env credentials are set,
 * and stdin is a TTY (so we can prompt).
 */
export async function needsSetup(): Promise<boolean> {
  // 1. Config file exists → no setup needed
  for (const p of CONFIG_SEARCH_PATHS) {
    if (fs.existsSync(p)) return false
  }

  // 2. Env vars already provide credentials → no setup needed
  if (
    process.env.FEISHU_APP_ID &&
    process.env.FEISHU_APP_ID.length > 0 &&
    process.env.FEISHU_APP_SECRET &&
    process.env.FEISHU_APP_SECRET.length > 0
  ) {
    return false
  }

  // 3. Non-interactive environment → skip
  if (process.stdin.isTTY !== true) return false

  return true
}

/**
 * Read a single line with masked input (shows * per character).
 * Uses raw-mode stdin to intercept each keypress.
 */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const buf: string[] = []

    const wasRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")

    const onData = (key: string) => {
      for (const ch of key) {
        const code = ch.charCodeAt(0)

        // Ctrl+C
        if (code === 0x03) {
          process.stdin.setRawMode(wasRaw ?? false)
          process.stdin.pause()
          process.stdin.removeListener("data", onData)
          process.stdout.write("\n")
          process.exit(0)
        }

        // Enter
        if (code === 0x0d || code === 0x0a) {
          process.stdin.setRawMode(wasRaw ?? false)
          process.stdin.pause()
          process.stdin.removeListener("data", onData)
          process.stdout.write("\n")
          resolve(buf.join(""))
          return
        }

        // Backspace
        if (code === 0x7f || code === 0x08) {
          if (buf.length > 0) {
            buf.pop()
            process.stdout.write("\b \b")
          }
          continue
        }

        // Regular printable character
        if (code >= 0x20) {
          buf.push(ch)
          process.stdout.write("*")
        }
      }
    }

    process.stdin.on("data", onData)
  })
}

/**
 * Run the 4-step interactive setup wizard.
 */
export async function runSetupWizard(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    // ── Welcome ──
    process.stdout.write(
      `\n${bold("🚀 Welcome to opencode-lark!")}\n\nNo configuration found. Let's set things up.\n\n`,
    )

    // ── Step 1/4: Feishu Credentials ──
    process.stdout.write(dim("Step 1/4: Feishu Credentials") + "\n")

    let appId = ""
    while (!appId) {
      appId = (await rl.question("  Enter your Feishu App ID: ")).trim()
      if (!appId) {
        process.stdout.write(red("  App ID cannot be empty.") + "\n")
      }
    }

    // Close rl temporarily so we can use raw mode for secret input
    rl.close()

    let appSecret = ""
    while (!appSecret) {
      appSecret = (await readSecret("  Enter your Feishu App Secret: ")).trim()
      if (!appSecret) {
        process.stdout.write(red("  App Secret cannot be empty.") + "\n")
      }
    }

    process.stdout.write("\n")

    // Re-create rl for the remaining prompts
    const rl2 = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    try {
      // ── Step 2/4: opencode Server ──
      process.stdout.write(dim("Step 2/4: opencode Server") + "\n")

      const DEFAULT_URL = "http://localhost:4096"
      const urlInput = (
        await rl2.question(`  opencode server URL [${DEFAULT_URL}]: `)
      ).trim()
      const serverUrl = urlInput || DEFAULT_URL

      // Connectivity check with retry loop
      let connected = false
      while (!connected) {
        try {
          await fetch(serverUrl)
          connected = true
          process.stdout.write(green("  ✓ Connected to opencode server") + "\n\n")
        } catch {
          process.stdout.write(
            red(`  ✗ Cannot reach opencode server at ${serverUrl}`) +
              "\n\n" +
              "  Please start it in another terminal:\n" +
              dim("    OPENCODE_SERVER_PORT=4096 opencode serve") +
              "\n\n",
          )
          await rl2.question("  Press Enter to retry...")
        }
      }

      // ── Step 3/4: Save Configuration ──
      process.stdout.write(dim("Step 3/4: Save Configuration") + "\n")

      const DEFAULT_ENV_PATH = "./.env"
      const envPathInput = (
        await rl2.question(`  Save .env to [${DEFAULT_ENV_PATH}]: `)
      ).trim()
      const envPath = envPathInput || DEFAULT_ENV_PATH

      // Build .env content
      const lines: string[] = [
        `FEISHU_APP_ID=${appId}`,
        `FEISHU_APP_SECRET=${appSecret}`,
      ]
      if (serverUrl !== DEFAULT_URL) {
        lines.push(`OPENCODE_SERVER_URL=${serverUrl}`)
      }

      fs.writeFileSync(path.resolve(envPath), lines.join("\n") + "\n", "utf-8")
      process.stdout.write(green(`  ✓ Configuration saved to ${envPath}`) + "\n")

      // Set on process.env so loadConfig() picks them up immediately
      process.env.FEISHU_APP_ID = appId
      process.env.FEISHU_APP_SECRET = appSecret
      if (serverUrl !== DEFAULT_URL) {
        process.env.OPENCODE_SERVER_URL = serverUrl
      }

      logger.info("Setup wizard completed, .env written to %s", envPath)

      // ── Step 4/4: Starting ──
      process.stdout.write(`\n${bold("Starting opencode-lark...")}\n\n`)
    } finally {
      rl2.close()
    }
  } finally {
    // rl may already be closed; close is idempotent
    rl.close()
  }
}
