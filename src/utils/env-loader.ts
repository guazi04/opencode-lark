/**
 * Minimal .env file loader.
 *
 * Reads KEY=VALUE lines from a .env file and sets them on process.env.
 * Does NOT override values already present in the environment.
 */

import * as fs from "node:fs"
import * as path from "node:path"

export function loadEnvFile(filePath?: string): void {
  const resolved = filePath ?? path.resolve(".env")

  if (!fs.existsSync(resolved)) return

  const content = fs.readFileSync(resolved, "utf-8")

  for (const line of content.split("\n")) {
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue

    const eqIndex = trimmed.indexOf("=")
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}
