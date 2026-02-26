/**
 * Interactive card action handler.
 * Handles question answers and permission replies from Feishu card button clicks,
 * forwarding responses back to the opencode server.
 */

import type { Logger } from "../utils/logger.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { FeishuCardAction } from "../types.js"

// ── Types ──

export interface InteractiveHandlerDeps {
  serverUrl: string
  feishuClient: Pick<FeishuApiClient, "replyMessage">
  logger: Logger
}

// ── Factory ──

export function createInteractiveHandler(deps: InteractiveHandlerDeps) {
  const { serverUrl, feishuClient, logger } = deps

  return async (action: FeishuCardAction): Promise<void> => {
    const actionValue = action.action?.value
    if (!actionValue) return

    const actionType = actionValue.action

    if (actionType === "question_answer") {
      await handleQuestionAnswer(action, actionValue)
      return
    }

    if (actionType === "permission_reply") {
      await handlePermissionReply(action, actionValue)
      return
    }
  }

  async function handleQuestionAnswer(
    action: FeishuCardAction,
    value: Record<string, string>,
  ): Promise<void> {
    const { requestId, answers } = value
    if (!requestId || !answers) {
      logger.warn("Missing requestId or answers in question_answer action")
      return
    }

    let parsedAnswers: string[][]
    try {
      parsedAnswers = JSON.parse(answers) as string[][]
    } catch {
      logger.warn(`Failed to parse question answers: ${answers}`)
      return
    }

    try {
      const resp = await fetch(`${serverUrl}/question/${requestId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: parsedAnswers }),
      })
      if (!resp.ok) {
        logger.warn(`Question reply failed: ${resp.status} ${resp.statusText}`)
      }
    } catch (err) {
      logger.warn(`Question reply request failed: ${err}`)
    }

    try {
      await feishuClient.replyMessage(action.open_message_id, {
        msg_type: "text",
        content: JSON.stringify({ text: `✅ Answered: ${parsedAnswers[0]?.[0] ?? ""}` }),
      })
    } catch (err) {
      logger.warn(`Question confirmation reply failed: ${err}`)
    }
  }

  async function handlePermissionReply(
    action: FeishuCardAction,
    value: Record<string, string>,
  ): Promise<void> {
    const { requestId, reply } = value
    if (!requestId || !reply) {
      logger.warn("Missing requestId or reply in permission_reply action")
      return
    }

    try {
      const resp = await fetch(`${serverUrl}/permission/${requestId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply }),
      })
      if (!resp.ok) {
        logger.warn(`Permission reply failed: ${resp.status} ${resp.statusText}`)
      }
    } catch (err) {
      logger.warn(`Permission reply request failed: ${err}`)
    }

    const labelMap: Record<string, string> = {
      once: "Allowed (once)",
      always: "Always allowed",
      reject: "Rejected",
    }

    try {
      await feishuClient.replyMessage(action.open_message_id, {
        msg_type: "text",
        content: JSON.stringify({ text: `✅ ${labelMap[reply] ?? reply}` }),
      })
    } catch (err) {
      logger.warn(`Permission confirmation reply failed: ${err}`)
    }
  }
}
