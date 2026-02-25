/**
 * Zod-validated config loader.
 * Loads from opencode-lark.jsonc (or opencode-feishu.jsonc for backward compat) with env var interpolation.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"

const FeishuConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  verificationToken: z.string().optional().default(""),
  webhookPort: z.number().int().positive().default(3000),
  encryptKey: z.string().optional(),
})

const ProgressConfigSchema = z.object({
  debounceMs: z.number().int().positive().default(500),
  maxDebounceMs: z.number().int().positive().default(3000),
})


const CronJobSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  chatId: z.string(),
})

const CronConfigSchema = z.object({
  jobs: z.array(CronJobSchema),
})

const HeartbeatConfigSchema = z.object({
  intervalMs: z.number().default(60000),
  statusChatId: z.string().optional(),
})

const AppConfigSchema = z.object({
  feishu: FeishuConfigSchema,
  defaultAgent: z.string().default("build"),
  dataDir: z.string().default("./data"),
  progress: ProgressConfigSchema.optional(),
  cron: CronConfigSchema.optional(),
  heartbeat: HeartbeatConfigSchema.optional(),
})

export type AppConfig = z.infer<typeof AppConfigSchema>
export type CronConfig = z.infer<typeof CronConfigSchema>
export type CronJobConfig = z.infer<typeof CronJobSchema>
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>

/** Replace ${ENV_VAR} placeholders with actual environment variable values */
function interpolateEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? ""
  })
}

/** Strip JSONC comments (// and /* *​/) for JSON.parse */
function stripJsoncComments(text: string): string {
  return text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const searchPaths = configPath
    ? [configPath]
    : [
        path.resolve("opencode-lark.jsonc"),
        path.resolve("opencode-lark.json"),
        path.resolve("opencode-feishu.jsonc"),
        path.resolve("opencode-feishu.json"),
      ]

  let rawText: string | undefined
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      rawText = fs.readFileSync(p, "utf-8")
      break
    }
  }

  // Fall back to pure env vars if no config file
  if (!rawText) {
    rawText = JSON.stringify({
      feishu: {
        appId: process.env["FEISHU_APP_ID"] ?? "",
        appSecret: process.env["FEISHU_APP_SECRET"] ?? "",
        verificationToken: process.env["FEISHU_VERIFICATION_TOKEN"] ?? "",
        webhookPort: Number(process.env["OPENCODE_FEISHU_PORT"] ?? "3000"),
        encryptKey: process.env["FEISHU_ENCRYPT_KEY"],
      },
      defaultAgent: "build",
      dataDir: "./data",
    })
  }

  const interpolated = interpolateEnvVars(rawText)
  const stripped = stripJsoncComments(interpolated)
  const parsed = JSON.parse(stripped) as unknown

  return AppConfigSchema.parse(parsed)
}
