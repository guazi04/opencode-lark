import type { Logger } from "../utils/logger.js"
import type { FeishuApiClient } from "../feishu/api-client.js"

export interface HeartbeatOptions {
  intervalMs: number
  serverUrl: string
  feishuClient?: FeishuApiClient
  statusChatId?: string
  logger: Logger
}

/**
 * Periodic health check service.
 * Pings server at intervals and reports status via Feishu on failure.
 */
export class HeartbeatService {
  private readonly options: HeartbeatOptions
  private intervalId: ReturnType<typeof setInterval> | null = null
  private running = false
  private successCount = 0
  private failCount = 0

  constructor(options: HeartbeatOptions) {
    this.options = options
  }

  start(): void {
    if (this.running) return

    const { logger, intervalMs } = this.options
    logger.info(`Heartbeat service started (interval: ${intervalMs}ms)`)

    this.intervalId = setInterval(() => {
      void this.tick()
    }, intervalMs)

    this.running = true
  }

  stop(): void {
    if (!this.running) return

    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    this.running = false
    this.options.logger.info("Heartbeat service stopped")
  }

  private async tick(): Promise<void> {
    const { serverUrl, logger, feishuClient, statusChatId } = this.options

    try {
      const resp = await globalThis.fetch(`${serverUrl}/session/status`)

      if (resp.ok) {
        this.successCount++
        logger.info("Server healthy")
      } else {
        this.failCount++
        logger.error(`Server health check failed with HTTP ${resp.status}`)

        if (feishuClient && statusChatId) {
          await this.sendAlert(feishuClient, statusChatId, `HTTP ${resp.status}`)
        }
      }
    } catch (err) {
      this.failCount++
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Server health check failed: ${message}`)

      if (feishuClient && statusChatId) {
        await this.sendAlert(feishuClient, statusChatId, message)
      }
    }
  }

  private async sendAlert(
    feishuClient: FeishuApiClient,
    chatId: string,
    errorMsg: string,
  ): Promise<void> {
    try {
      await feishuClient.sendMessage(chatId, {
        msg_type: "text",
        content: JSON.stringify({
          text: `❌ Heartbeat alert: Server health check failed (${errorMsg}). Success: ${this.successCount}, Failures: ${this.failCount}`,
        }),
      })
    } catch (err) {
      this.options.logger.error("Failed to send heartbeat alert:", err)
    }
  }

  getStats(): { successCount: number; failCount: number } {
    return { successCount: this.successCount, failCount: this.failCount }
  }
}
