import type { FeishuApiClient } from "../feishu/api-client.js"
import { buildThinkingCard, buildResponseCard, buildErrorCard } from "../feishu/card-builder.js"
import { createLogger } from "../utils/logger.js"

const logger = createLogger("progress-tracker")

interface ProgressTrackerOptions {
  feishuClient: FeishuApiClient
}

export interface ProgressTracker {
  sendThinking(chatId: string): Promise<string | null>
  updateWithResponse(messageId: string, text: string): Promise<void>
  updateWithError(messageId: string, msg: string): Promise<void>
}

export function createProgressTracker(options: ProgressTrackerOptions): ProgressTracker {
  const { feishuClient } = options

  return {
    async sendThinking(chatId) {
      try {
        const card = buildThinkingCard()
        const result = await feishuClient.sendMessage(chatId, {
          msg_type: "interactive",
          content: JSON.stringify(card),
        })
        const messageId = result.data?.["message_id"] as string | undefined
        if (!messageId) {
          logger.error("sendThinking: no message_id in response")
          return null
        }
        return messageId
      } catch (error) {
        logger.error(`Failed to send thinking card: ${error}`)
        return null
      }
    },

    async updateWithResponse(messageId, text) {
      try {
        const card = buildResponseCard(text)
        await feishuClient.updateMessage(messageId, JSON.stringify(card))
      } catch (error) {
        logger.error(`Failed to update response card: ${error}`)
      }
    },

    async updateWithError(messageId, msg) {
      try {
        const card = buildErrorCard(msg)
        await feishuClient.updateMessage(messageId, JSON.stringify(card))
      } catch (error) {
        logger.error(`Failed to update error card: ${error}`)
      }
    },
  }
}
