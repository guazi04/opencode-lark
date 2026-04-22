import type { FeishuCardAction } from "../types.js"

export const PERMISSION_LABELS: Record<string, string> = {
  once: "Allowed (once)",
  always: "Always allowed",
  reject: "Rejected",
}

export function buildInteractiveCallbackResponse(
  action: FeishuCardAction,
): Record<string, unknown> {
  const actionType = action.action?.value?.action
  const value = action.action?.value ?? {}

  if (actionType === "question_answer") {
    let answerLabel = "(unknown)"
    try {
      const parsed = JSON.parse(value.answers ?? "[]") as string[][]
      answerLabel = parsed[0]?.[0] ?? answerLabel
    } catch {}

    return {
      toast: { type: "success", content: `✅ Answered: ${answerLabel}` },
      card: {
        type: "raw",
        data: buildAnsweredQuestionCard(answerLabel),
      },
    }
  }

  if (actionType === "permission_reply") {
    const reply = value.reply ?? "unknown"
    const label = PERMISSION_LABELS[reply] ?? reply
    const isRejected = reply === "reject"

    return {
      toast: {
        type: isRejected ? "warning" : "success",
        content: `${isRejected ? "❌" : "✅"} ${label}`,
      },
      card: {
        type: "raw",
        data: buildAnsweredPermissionCard(reply),
      },
    }
  }

  return {}
}

export function buildAnsweredQuestionCard(
  answerLabel?: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: answerLabel ? "✅ Question Answered" : "✅ Question Already Answered",
      },
      template: "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: answerLabel
            ? `**Answer:** ${answerLabel}`
            : "**Status:** Answered in opencode TUI.",
        },
      },
    ],
  }
}

export function buildAnsweredPermissionCard(
  reply?: string,
): Record<string, unknown> {
  const label = reply ? (PERMISSION_LABELS[reply] ?? reply) : undefined
  const isRejected = reply === "reject"

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: label
          ? `${isRejected ? "❌" : "✅"} Permission: ${label}`
          : "✅ Permission Request Resolved",
      },
      template: label && isRejected ? "red" : "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: label
            ? `**Decision:** ${label}`
            : "**Status:** Already handled in opencode TUI.",
        },
      },
    ],
  }
}
