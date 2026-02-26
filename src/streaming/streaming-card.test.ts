import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { StreamingCardSession } from "./streaming-card.js"
import type { CardKitClient, CardKitSchema } from "../feishu/cardkit-client.js"
import { createMockFeishuClient } from "../__tests__/setup.js"

function createMockCardKitClient(): CardKitClient & {
  createCard: ReturnType<typeof vi.fn>
  updateElement: ReturnType<typeof vi.fn>
  closeStreaming: ReturnType<typeof vi.fn>
} {
  return {
    createCard: vi.fn().mockResolvedValue("card_123"),
    updateElement: vi.fn().mockResolvedValue(undefined),
    closeStreaming: vi.fn().mockResolvedValue(undefined),
  } as any
}

function createStartedSession() {
  const cardkitClient = createMockCardKitClient()
  const feishuClient = createMockFeishuClient()
  ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
    code: 0,
    msg: "ok",
    data: { message_id: "msg_456" },
  })

  const session = new StreamingCardSession({
    cardkitClient: cardkitClient as any,
    feishuClient,
    chatId: "chat_789",
  })

  return { session, cardkitClient, feishuClient }
}

describe("StreamingCardSession", () => {
  describe("lifecycle", () => {
    it("isActive is false before start", () => {
      const { session } = createStartedSession()
      expect(session.isActive).toBe(false)
    })

    it("start() creates card with tool-focused initial content", async () => {
      const { session, cardkitClient, feishuClient } = createStartedSession()

      await session.start()

      expect(session.isActive).toBe(true)
      expect(cardkitClient.createCard).toHaveBeenCalledOnce()
      const schema = cardkitClient.createCard.mock.calls[0]![0] as CardKitSchema
      expect(schema.schema).toBe("2.0")
      expect(schema.config.streaming_mode).toBe(true)
      expect(schema.config.summary.content).toBe("[Generating...]")
      expect(schema.config.streaming_config?.print_frequency_ms?.default).toBe(200)
      expect(schema.config.streaming_config?.print_step?.default).toBe(10)
      expect(schema.body.elements[0]!.element_id).toBe("content")
      expect(schema.body.elements[0]!.content).toBe("🛠️ Processing...")

      expect(feishuClient.sendMessage).toHaveBeenCalledWith("chat_789", {
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: "card_123" } }),
      })
    })

    it("start() is idempotent", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.start()
      expect(cardkitClient.createCard).toHaveBeenCalledOnce()
    })

    it("start() throws if no message_id returned", async () => {
      const cardkitClient = createMockCardKitClient()
      const feishuClient = createMockFeishuClient()
      ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        code: 0,
        msg: "ok",
        data: {},
      })

      const session = new StreamingCardSession({
        cardkitClient: cardkitClient as any,
        feishuClient,
        chatId: "chat_789",
      })

      await expect(session.start()).rejects.toThrow("sendMessage returned no message_id")
    })

    it("isActive is false after close", async () => {
      const { session } = createStartedSession()
      await session.start()
      await session.close()
      expect(session.isActive).toBe(false)
    })

    it("close() calls closeStreaming on cardkitClient", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.close()
      expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
    })

    it("close() is idempotent", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.close()
      await session.close()
      expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
    })
  })


  describe("close behavior", () => {
    it("close with no tools produces 'Done' summary", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.close()

      // closeStreaming should be called with "Done" when no tools used
      expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
        "card_123",
        "Done",
        expect.any(Number),
      )
    })

    it("close produces tool-focused summary when tools completed", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.setToolStatus("read_file", "completed")
      await session.setToolStatus("bash", "completed")
      await session.close()

      expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
        "card_123",
        "✅ 2 tool(s) used",
        expect.any(Number),
      )
    })

    it("close with finalText overrides buildFullContent", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.close("final answer")

      // Should have sent "final answer" as the update
      expect(cardkitClient.updateElement).toHaveBeenLastCalledWith(
        "card_123",
        "content",
        "final answer",
        expect.any(Number),
      )
    })

    it("close sends final tool content update if different from last sent", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.setToolStatus("bash", "running")
      cardkitClient.updateElement.mockClear()

      await session.setToolStatus("bash", "completed")
      // At this point, last sent content is the tool status text
      const sentContent = cardkitClient.updateElement.mock.calls.at(-1)![2] as string
      cardkitClient.updateElement.mockClear()

      // Close will call buildFullContent which matches last sent → no extra updateElement
      await session.close()
      expect(cardkitClient.updateElement).not.toHaveBeenCalled()
      expect(cardkitClient.closeStreaming).toHaveBeenCalledOnce()
    })

    it("close with no tools produces Done update and summary", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()
      await session.close()

      // Close should use Done fallback (no tools)
      expect(cardkitClient.updateElement).toHaveBeenCalledWith(
        "card_123",
        "content",
        "✅ Done",
        expect.any(Number),
      )
      expect(cardkitClient.closeStreaming).toHaveBeenCalledWith(
        "card_123",
        "Done",
        expect.any(Number),
      )
    })
  })

  describe("setToolStatus", () => {
    it("updates card with tool status only (no free-form text)", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.setToolStatus("read_file", "running")

      const lastCall = cardkitClient.updateElement.mock.calls.at(-1)!
      expect(lastCall[2]).toContain("🔄 read_file")
    })

    it("updates existing tool status", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.setToolStatus("read_file", "running")
      await session.setToolStatus("read_file", "completed")

      const lastCall = cardkitClient.updateElement.mock.calls.at(-1)!
      expect(lastCall[2]).toContain("✅ read_file")
      expect(lastCall[2]).not.toContain("🔄 read_file")
    })

    it("displays title with tool status when title provided", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.setToolStatus("read_file", "completed", "Read src/index.ts")

      const lastCall = cardkitClient.updateElement.mock.calls.at(-1)!
      expect(lastCall[2]).toContain("✅ read_file · Read src/index.ts")
    })

    it("updates title retroactively on state transition", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.setToolStatus("bash", "running")
      await session.setToolStatus("bash", "completed", "Run tests")

      const lastCall = cardkitClient.updateElement.mock.calls.at(-1)!
      expect(lastCall[2]).toContain("✅ bash · Run tests")
      expect(lastCall[2]).not.toContain("🔄 bash")
    })

    it("no title separator when title is undefined", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.setToolStatus("bash", "running")

      const lastCall = cardkitClient.updateElement.mock.calls.at(-1)!
      expect(lastCall[2]).toContain("🔄 bash")
      expect(lastCall[2]).not.toContain("· ")
    })
  })

  describe("addSubtaskButton", () => {
    it("appends button to card content without free-form text", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.addSubtaskButton("View details", "subtask_1")

      const lastCall = cardkitClient.updateElement.mock.calls.at(-1)!
      expect(lastCall[2]).toContain("View details")
      expect(lastCall[2]).toContain("subtask_1")
    })
  })

  describe("tool-only card content", () => {
    it("card content contains only tool statuses", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      await session.setToolStatus("read_file", "running")
      await session.setToolStatus("bash", "completed", "Run tests")
      await session.setToolStatus("read_file", "completed", "Read config")

      const lastCall = cardkitClient.updateElement.mock.calls.at(-1)!
      const content = lastCall[2] as string
      expect(content).toContain("✅ read_file · Read config")
      expect(content).toContain("✅ bash · Run tests")
      // Content should be ONLY tool status lines (starts with separator)
      expect(content).toMatch(/^\n\n---\n/)
    })

    it("card content is tool-only (no free-form text)", async () => {
      const { session, cardkitClient } = createStartedSession()
      await session.start()

      // Add a tool status — content should be tool status only
      await session.setToolStatus("bash", "running")
      const lastCall = cardkitClient.updateElement.mock.calls.at(-1)!
      expect(lastCall[2]).toContain("🔄 bash")
    })
  })
})
