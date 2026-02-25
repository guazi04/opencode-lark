/**
 * Tests for sub-agent card handler and utilities.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  createSubAgentCardHandler,
  formatSubAgentMessages,
  buildSubAgentCard,
} from "./subagent-card.js"
import type { SubAgentTracker, MessageSummary } from "./subagent-tracker.js"
import { createMockLogger, createMockFeishuClient } from "../__tests__/setup.js"
import type { FeishuCardAction } from "../types.js"

describe("subagent-card", () => {
  let mockTracker: SubAgentTracker
  let mockFeishuClient: ReturnType<typeof createMockFeishuClient>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    mockFeishuClient = createMockFeishuClient()
    mockLogger = createMockLogger()
    mockTracker = {
      getChildMessages: vi.fn(),
      onSubtaskDiscovered: vi.fn(),
      pollChildSession: vi.fn(),
      getTrackedSubAgents: vi.fn(),
    } as unknown as SubAgentTracker
  })

  describe("formatSubAgentMessages", () => {
    it("returns placeholder for empty messages", () => {
      const result = formatSubAgentMessages([])
      expect(result).toBe("暂无对话内容")
    })

    it("formats single message with user role icon", () => {
      const messages: MessageSummary[] = [
        { role: "user", text: "Hello world" },
      ]
      const result = formatSubAgentMessages(messages)
      expect(result).toContain("👤 **User**")
      expect(result).toContain("Hello world")
    })

    it("formats assistant role with correct icon", () => {
      const messages: MessageSummary[] = [
        { role: "assistant", text: "Response" },
      ]
      const result = formatSubAgentMessages(messages)
      expect(result).toContain("🤖 **Assistant**")
      expect(result).toContain("Response")
    })

    it("formats tool calls when present", () => {
      const messages: MessageSummary[] = [
        {
          role: "tool",
          text: "Tool result",
          toolCalls: ["search", "calculate"],
        },
      ]
      const result = formatSubAgentMessages(messages)
      expect(result).toContain("🛠 **Tool**")
      expect(result).toContain("工具调用: search, calculate")
    })

    it("truncates content at 4000 chars", () => {
      const longText = "x".repeat(5000)
      const messages: MessageSummary[] = [{ role: "user", text: longText }]
      const result = formatSubAgentMessages(messages)
      expect(result.length).toBeLessThanOrEqual(4000 + 20) // 4000 + truncation text
      expect(result).toContain("...(内容过长，已截断)")
    })

    it("handles multiple messages with role capitalization", () => {
      const messages: MessageSummary[] = [
        { role: "user", text: "msg1" },
        { role: "assistant", text: "msg2" },
        { role: "tool", text: "msg3" },
      ]
      const result = formatSubAgentMessages(messages)
      expect(result).toContain("👤 **User**")
      expect(result).toContain("🤖 **Assistant**")
      expect(result).toContain("🛠 **Tool**")
    })

    it("uses unknown icon for unrecognized roles", () => {
      const messages: MessageSummary[] = [
        { role: "unknown_role", text: "test" },
      ]
      const result = formatSubAgentMessages(messages)
      expect(result).toContain("❓")
    })
  })

  describe("buildSubAgentCard", () => {
    it("builds card with correct structure", () => {
      const card = buildSubAgentCard("test desc", "test content")
      expect(card.config).toEqual({ wide_screen_mode: true })
      expect((card.header as Record<string, unknown>)?.template).toBe("blue")
      expect(card.elements).toBeDefined()
    })

    it("includes description in header title", () => {
      const card = buildSubAgentCard("子任务进展", "content")
      expect(
        (card.header as Record<string, unknown>)?.title as Record<
          string,
          unknown
        >
      ).toMatchObject({ content: "🔍 子任务进展" })
    })

    it("includes content in lark_md element", () => {
      const testContent = "test markdown"
      const card = buildSubAgentCard("desc", testContent)
      const elements = card.elements as Array<Record<string, unknown>>
      const firstElement = elements?.[0]
      const text = firstElement?.text as Record<string, unknown>
      expect(text?.content).toBe(testContent)
    })
  })

  describe("createSubAgentCardHandler", () => {
    it("ignores actions without view_subagent type", async () => {
      const handler = createSubAgentCardHandler({
        subAgentTracker: mockTracker,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: { tag: "button", value: { action: "other_action" } },
        open_message_id: "msg_123",
        open_chat_id: "chat_123",
        operator: { open_id: "user_123" },
      }

      await handler(action)

      expect(mockFeishuClient.replyMessage).not.toHaveBeenCalled()
    })

    it("early returns when childSessionId is missing", async () => {
      const handler = createSubAgentCardHandler({
        subAgentTracker: mockTracker,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: { tag: "button", value: { action: "view_subagent" } },
        open_message_id: "msg_123",
        open_chat_id: "chat_123",
        operator: { open_id: "user_123" },
      }

      await handler(action)

      expect(mockFeishuClient.replyMessage).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it("fetches child messages and sends card reply", async () => {
      const messages: MessageSummary[] = [
        { role: "user", text: "test" },
      ]
      ;(mockTracker.getChildMessages as any).mockResolvedValue(messages)
      ;(mockFeishuClient.replyMessage as any).mockResolvedValue({
        code: 0,
      })

      const handler = createSubAgentCardHandler({
        subAgentTracker: mockTracker,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: { action: "view_subagent", childSessionId: "child_123" },
        },
        open_message_id: "msg_123",
        open_chat_id: "chat_123",
        operator: { open_id: "user_123" },
      }

      await handler(action)

      expect(mockTracker.getChildMessages).toHaveBeenCalledWith("child_123", 50)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith(
        "msg_123",
        expect.objectContaining({ msg_type: "interactive" }),
      )
    })

    it("handles fetch error gracefully", async () => {
      ;(mockTracker.getChildMessages as any).mockRejectedValue(
        new Error("fetch failed"),
      )

      const handler = createSubAgentCardHandler({
        subAgentTracker: mockTracker,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: { action: "view_subagent", childSessionId: "child_123" },
        },
        open_message_id: "msg_123",
        open_chat_id: "chat_123",
        operator: { open_id: "user_123" },
      }

      await handler(action)

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send subagent card"),
      )
      expect(mockFeishuClient.replyMessage).not.toHaveBeenCalled()
    })

    it("logs success when card is sent", async () => {
      const messages: MessageSummary[] = []
      ;(mockTracker.getChildMessages as any).mockResolvedValue(messages)
      ;(mockFeishuClient.replyMessage as any).mockResolvedValue({
        code: 0,
      })

      const handler = createSubAgentCardHandler({
        subAgentTracker: mockTracker,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: { action: "view_subagent", childSessionId: "child_456" },
        },
        open_message_id: "msg_123",
        open_chat_id: "chat_123",
        operator: { open_id: "user_123" },
      }

      await handler(action)

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("child_456"),
      )
    })

    it("sends card with formatted content", async () => {
      const messages: MessageSummary[] = [
        { role: "user", text: "user msg" },
        { role: "assistant", text: "assistant msg" },
      ]
      ;(mockTracker.getChildMessages as any).mockResolvedValue(messages)
      ;(mockFeishuClient.replyMessage as any).mockResolvedValue({
        code: 0,
      })

      const handler = createSubAgentCardHandler({
        subAgentTracker: mockTracker,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
      })

      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: { action: "view_subagent", childSessionId: "child_123" },
        },
        open_message_id: "msg_123",
        open_chat_id: "chat_123",
        operator: { open_id: "user_123" },
      }

      await handler(action)

      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      expect(callArgs[1].content).toContain("👤")
      expect(callArgs[1].content).toContain("🤖")
    })
  })
})
