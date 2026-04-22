import { describe, expect, it } from "vitest"
import {
  buildAnsweredPermissionCard,
  buildAnsweredQuestionCard,
  buildInteractiveCallbackResponse,
} from "./interactive-card-response.js"

describe("interactive-card-response", () => {
  it("builds the existing question callback response shape", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: {
          action: "question_answer",
          requestId: "q-1",
          answers: JSON.stringify([["Yes"]]),
        },
      },
      open_message_id: "msg-1",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      toast: { type: "success", content: "✅ Answered: Yes" },
      card: {
        type: "raw",
        data: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: "plain_text", content: "✅ Question Answered" },
            template: "green",
          },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: "**Answer:** Yes" } },
          ],
        },
      },
    })
  })

  it("builds the existing permission callback response shape", () => {
    const response = buildInteractiveCallbackResponse({
      action: {
        tag: "button",
        value: {
          action: "permission_reply",
          requestId: "p-1",
          reply: "reject",
        },
      },
      open_message_id: "msg-1",
      open_chat_id: "chat-1",
      operator: { open_id: "ou-1" },
    })

    expect(response).toEqual({
      toast: { type: "warning", content: "❌ Rejected" },
      card: {
        type: "raw",
        data: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: "plain_text", content: "❌ Permission: Rejected" },
            template: "red",
          },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: "**Decision:** Rejected" } },
          ],
        },
      },
    })
  })

  it("builds TUI-resolved cards that clearly show they were handled elsewhere", () => {
    const questionCard = buildAnsweredQuestionCard()
    const permissionCard = buildAnsweredPermissionCard()

    expect(questionCard).toEqual({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "✅ Question Already Answered" },
        template: "green",
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "**Status:** Answered in opencode TUI." } },
      ],
    })
    expect(permissionCard).toEqual({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "✅ Permission Request Resolved" },
        template: "green",
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "**Status:** Already handled in opencode TUI." } },
      ],
    })
  })
})
