import type { CronConfig, CronJobConfig } from "../utils/config.js"
import type { SessionManager } from "../session/session-manager.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"

export interface CronServiceOptions {
  config: CronConfig
  sessionManager: SessionManager
  feishuClient: FeishuApiClient
  serverUrl: string
  logger: Logger
}

interface ParsedSchedule {
  type: "interval" | "daily"
  intervalMs?: number
  hour?: number
  minute?: number
}

/**
 * Supported formats:
 *   "every Nm" → interval of N minutes
 *   "every Nh" → interval of N hours
 *   "daily HH:MM" → execute once per day at HH:MM
 *
 * @throws Error on invalid format
 */
export function parseSchedule(schedule: string): ParsedSchedule {
  const trimmed = schedule.trim()

  // "every Nm" or "every Nh" → regex: digit(s) + unit letter
  const intervalMatch = trimmed.match(/^every\s+(\d+)\s*([mh])$/i)
  if (intervalMatch) {
    const value = Number(intervalMatch[1])
    const unit = intervalMatch[2]!.toLowerCase()
    if (value <= 0) {
      throw new Error(`Invalid schedule "${schedule}": interval must be positive`)
    }
    const multiplier = unit === "m" ? 60_000 : 3_600_000
    return { type: "interval", intervalMs: value * multiplier }
  }

  // "daily HH:MM" → regex: 1-2 digit hour + 2 digit minute
  const dailyMatch = trimmed.match(/^daily\s+(\d{1,2}):(\d{2})$/i)
  if (dailyMatch) {
    const hour = Number(dailyMatch[1])
    const minute = Number(dailyMatch[2])
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`Invalid schedule "${schedule}": invalid time (expected HH:MM with 0-23:0-59)`)
    }
    return { type: "daily", hour, minute }
  }

  throw new Error(
    `Invalid schedule format "${schedule}". Supported: "every Nm", "every Nh", "daily HH:MM"`,
  )
}

export class CronService {
  private readonly options: CronServiceOptions
  private readonly intervals: ReturnType<typeof setInterval>[] = []
  private running = false
  private lastDailyRun = new Map<string, string>()

  constructor(options: CronServiceOptions) {
    this.options = options
  }

  /** @throws Error if any job has an invalid schedule */
  start(): void {
    if (this.running) return

    const { config, logger } = this.options
    const jobs = config.jobs

    const parsed = jobs.map((job) => ({
      job,
      schedule: parseSchedule(job.schedule),
    }))

    for (const { job, schedule } of parsed) {
      if (schedule.type === "interval") {
        logger.info(`Cron job "${job.name}": every ${schedule.intervalMs!}ms`)
        const id = setInterval(() => {
          void this.executeJob(job)
        }, schedule.intervalMs!)
        this.intervals.push(id)
      } else if (schedule.type === "daily") {
        logger.info(`Cron job "${job.name}": daily at ${String(schedule.hour!).padStart(2, "0")}:${String(schedule.minute!).padStart(2, "0")}`)
        const id = setInterval(() => {
          const now = new Date()
          if (now.getHours() === schedule.hour && now.getMinutes() === schedule.minute) {
            const dateKey = `${job.name}:${now.toISOString().slice(0, 10)}`
            if (!this.lastDailyRun.has(dateKey)) {
              this.lastDailyRun.set(dateKey, now.toISOString())
              void this.executeJob(job)
            }
          }
        }, 60_000)
        this.intervals.push(id)
      }
    }

    this.running = true
    logger.info(`Cron service started with ${jobs.length} job(s)`)
  }

  stop(): void {
    if (!this.running) return

    for (const id of this.intervals) {
      clearInterval(id)
    }
    this.intervals.length = 0
    this.lastDailyRun.clear()
    this.running = false
    this.options.logger.info("Cron service stopped")
  }

  private async executeJob(job: CronJobConfig): Promise<void> {
    const { sessionManager, feishuClient, serverUrl, logger } = this.options
    const cronKey = `cron:${job.name}`

    try {
      logger.info(`Executing cron job "${job.name}"...`)

      const sessionId = await sessionManager.getOrCreate(cronKey)

      const resp = await fetch(`${serverUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: job.prompt }],
        }),
      })

      if (!resp.ok) {
        logger.error(`Cron job "${job.name}": POST failed with HTTP ${resp.status}`)
        return
      }

      const result = await this.waitForResponse(sessionId)

      await feishuClient.sendMessage(job.chatId, {
        msg_type: "text",
        content: JSON.stringify({ text: result }),
      })

      logger.info(`Cron job "${job.name}" completed`)
    } catch (err) {
      logger.error(`Cron job "${job.name}" failed:`, err)
    }
  }

  private async waitForResponse(sessionId: string, maxWaitMs = 300_000): Promise<string> {
    const { serverUrl } = this.options
    const start = Date.now()
    const pollInterval = 2_000

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollInterval))

      const statusResp = await fetch(`${serverUrl}/session/${sessionId}`)
      if (!statusResp.ok) continue

      const session = (await statusResp.json()) as { status?: { type?: string } }
      if (session.status?.type === "idle") {
        const msgResp = await fetch(`${serverUrl}/session/${sessionId}/message?limit=1`)
        if (msgResp.ok) {
          const messages = (await msgResp.json()) as Array<{ role?: string; text?: string }>
          const last = messages.find((m) => m.role === "assistant")
          return last?.text ?? "(no response)"
        }
        return "(failed to retrieve response)"
      }
    }

    return "(timed out waiting for response)"
  }
}
