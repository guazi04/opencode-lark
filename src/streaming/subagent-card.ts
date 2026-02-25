/**
 * Sub-agent card handler for Feishu.
 * Handles button clicks to view sub-agent session conversations.
 * Formats messages and sends as interactive cards.
 */

import type { Logger } from "../utils/logger.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { FeishuCardAction } from "../types.js"
import type { SubAgentTracker, MessageSummary } from "./subagent-tracker.js"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface SubAgentCardDeps {
  subAgentTracker: SubAgentTracker
  feishuClient: FeishuApiClient
  logger: Logger
}

// ─────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────

/**
 * Creates a handler for sub-agent card button clicks.
 * Fetches child session messages and sends as Feishu card.
 */
export function createSubAgentCardHandler(deps: SubAgentCardDeps) {
  const { subAgentTracker, feishuClient, logger } = deps

  return async (action: FeishuCardAction): Promise<void> => {
    // Check action type early
    const actionType = action.action?.value?.action
    if (actionType !== "view_subagent") {
      return
    }

    const childSessionId = action.action?.value?.childSessionId
    const messageId = action.open_message_id

    if (!childSessionId || !messageId) {
      logger.warn("Missing childSessionId or messageId in subagent card action")
      return
    }

    try {
      // Fetch child messages
      const messages = await subAgentTracker.getChildMessages(childSessionId, 50)

      // Format messages for display
      const content = formatSubAgentMessages(messages)

      // Build and send card
      const card = buildSubAgentCard("子任务进展", content)
      await feishuClient.replyMessage(messageId, {
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: card }),
      })

      logger.info(`Sent subagent card for session ${childSessionId}`)
    } catch (error) {
      logger.error(`Failed to send subagent card: ${String(error)}`)
    }
  }
}

/**
 * Formats messages with role indicators and truncation.
 * Role indicators: 👤 user / 🤖 assistant / 🛠 tool
 * Truncates at 4000 chars with "...(内容过长，已截断)"
 */
export function formatSubAgentMessages(messages: MessageSummary[]): string {
  if (messages.length === 0) {
    return "暂无对话内容"
  }

  const roleIcons: Record<string, string> = {
    user: "👤",
    assistant: "🤖",
    tool: "🛠",
  }

  const lines: string[] = []

  for (const msg of messages) {
    const icon = roleIcons[msg.role] ?? "❓"
    const roleLabel = msg.role.charAt(0).toUpperCase() + msg.role.slice(1)
    lines.push(`${icon} **${roleLabel}**`)
    lines.push(msg.text)

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lines.push(`  _工具调用: ${msg.toolCalls.join(", ")}_`)
    }

    lines.push("")
  }

  let content = lines.join("\n")

  // Truncate at 4000 chars
  if (content.length > 4000) {
    content = content.slice(0, 4000) + "\n\n...(内容过长，已截断)"
  }

  return content
}

/**
 * Builds a Feishu card for sub-agent messages.
 * Header: "🔍 子任务详情" with blue template
 * Body: div with lark_md content
 */
export function buildSubAgentCard(
  description: string,
  content: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `🔍 ${description}`,
      },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content,
        },
      },
    ],
  }
}
