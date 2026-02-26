import { describe, it, expect, vi, beforeEach } from "vitest"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { createStreamingBridge, type StreamingBridgeDeps } from "./streaming-integration.js"
import { EventProcessor } from "../streaming/event-processor.js"
import { createMockLogger, createMockFeishuClient } from "../__tests__/setup.js"
import type { CardKitClient } from "../feishu/cardkit-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"

function createMockCardKitClient() {
  return {
    createCard: vi.fn().mockResolvedValue("card_123"),
    updateElement: vi.fn().mockResolvedValue(undefined),
    closeStreaming: vi.fn().mockResolvedValue(undefined),
  } as unknown as CardKitClient
}

function createMockSubAgentTracker() {
  return {
    onSubtaskDiscovered: vi.fn().mockResolvedValue({
      parentSessionId: "ses-1",
      childSessionId: "child-ses-1",
      prompt: "do something",
      description: "A subtask",
      agent: "code",
      status: "discovering",
    }),
    pollChildSession: vi.fn(),
    getChildMessages: vi.fn(),
    getTrackedSubAgents: vi.fn().mockReturnValue([]),
  } as unknown as SubAgentTracker
}

function makeDeps(overrides: Partial<StreamingBridgeDeps> = {}): StreamingBridgeDeps {
  return {
    cardkitClient: createMockCardKitClient(),
    feishuClient: createMockFeishuClient(),
    subAgentTracker: createMockSubAgentTracker(),
    logger: createMockLogger(),
    ...overrides,
  }
}

const mockSendMessage = () => Promise.resolve('{"parts":[{"type":"text","text":"mock response"}]}')

describe("createStreamingBridge", () => {
  const ownedSessions = new Set<string>(["ses-1"])
  let eventListeners: EventListenerMap
  let eventProcessor: EventProcessor

  beforeEach(() => {
    vi.restoreAllMocks()
    eventListeners = new Map()
    eventProcessor = new EventProcessor({ ownedSessions })
  })

  it("creates a streaming card and registers listener", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    ;[...eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlePromise

    expect(deps.feishuClient.replyMessage).toHaveBeenCalledWith(
      "msg_original",
      expect.objectContaining({ msg_type: "text" }),
    )
    expect(onComplete).toHaveBeenCalledWith("（无回复）")
  })

  it("accumulates TextDelta and buffers text locally", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(onComplete).toHaveBeenCalledWith("Hello World")
  })

  it("handles ToolStateChange by calling setToolStatus", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise
    expect((deps.cardkitClient as any).updateElement).toHaveBeenCalled()
  })

  it("handles SubtaskDiscovered by sending separate card via sendMessage", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "subtask",
          prompt: "research topic",
          description: "Research the topic",
          agent: "researcher",
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect((deps.subAgentTracker as any).onSubtaskDiscovered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SubtaskDiscovered",
        description: "Research the topic",
      }),
    )

    const sendCalls = (deps.feishuClient.sendMessage as any).mock.calls
    const subtaskCardCall = sendCalls.find(
      (call: unknown[]) =>
        call[0] === "chat-1" &&
        typeof (call[1] as Record<string, unknown>)?.content === "string" &&
        ((call[1] as Record<string, unknown>).content as string).includes("Research the topic"),
    )
    expect(subtaskCardCall).toBeDefined()
    const body1 = subtaskCardCall![1] as { msg_type: string; content: string }
    expect(body1.msg_type).toBe("interactive")
    const cardContent = JSON.parse(body1.content)
    expect(cardContent.data.header.template).toBe("indigo")
  })

  it("removes listener on SessionIdle", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    ;[...eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlePromise

    expect(eventListeners.size).toBe(0)
  })

  it("throws when card.start() fails (for fallback in caller)", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockRejectedValue(new Error("Feishu API down")),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation, which will attempt sendMessage and fail
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() attempt
    await new Promise((r) => setTimeout(r, 50))

    // Now complete the session
    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    // The bridge should gracefully handle the sendMessage failure from card.start()
    // and still resolve (not reject)
    await handlePromise

    // Verify the handler completed with a response despite card.start() failure
    expect(onComplete).toHaveBeenCalledWith("（无回复）")
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("card start for tool failed"),
    )
    expect(eventListeners.size).toBe(0)
  })

  it("calls close() on the card when SessionIdle received", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect((deps.cardkitClient as any).closeStreaming).toHaveBeenCalled()
  })

  it("logs info when streaming card starts", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve and log
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Streaming card started"),
    )
  })

  it("still completes even if card.close() throws", async () => {
    const mockCardKit = createMockCardKitClient()
    ;(mockCardKit as any).closeStreaming = vi.fn().mockRejectedValue(new Error("close fail"))

    const deps = makeDeps({
      cardkitClient: mockCardKit,
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(onComplete).toHaveBeenCalledWith("（无回复）")
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("card.close() failed"),
    )
  })

  // ── New tests ──

  it("text delta buffers text and sends as replyMessage on idle", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(mockFeishu.replyMessage).toHaveBeenCalledWith("msg_original", {
      msg_type: "text",
      content: JSON.stringify({ text: "Hello World" }),
    })
    expect(onComplete).toHaveBeenCalledWith("Hello World")
  })

  it("SubtaskDiscovered sends separate card instead of button", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "subtask",
          prompt: "research topic",
          description: "Research the topic",
          agent: "researcher",
        },
      },
    })

    // Wait for async tracker + sendMessage
    await new Promise((r) => setTimeout(r, 50))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    const sendCalls = mockFeishu.sendMessage.mock.calls
    const subtaskCall = sendCalls.find(
      (call: unknown[]) =>
        call[0] === "chat-1" &&
        typeof (call[1] as Record<string, unknown>)?.content === "string" &&
        ((call[1] as Record<string, unknown>).content as string).includes("Research the topic"),
    )
    expect(subtaskCall).toBeDefined()
    const body = subtaskCall![1] as { msg_type: string; content: string }
    expect(body.msg_type).toBe("interactive")
    const parsed = JSON.parse(body.content)
    expect(parsed.data.header.template).toBe("indigo")
    expect(parsed.data.elements[1].actions[0].text.content).toBe("🔍 View Details")
    expect(parsed.data.elements[1].actions[0].value.childSessionId).toBe("child-ses-1")
  })

  it("text buffer truncates at 100KB", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    const bigText = "x".repeat(110_000)
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: bigText },
        delta: bigText,
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    const replyCall = mockFeishu.replyMessage.mock.calls[0]!
    expect(replyCall[0]).toBe("msg_original")
    const replyContent = JSON.parse((replyCall[1] as { content: string }).content)
    expect(replyContent.text).toContain("…(内容过长，已截断)")
    expect(replyContent.text.length).toBeLessThan(110_000)
  })

  it("sends text as reply and calls deleteReaction when reactionId present", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      deleteReaction: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      onComplete,
      "msg_original",
      "reaction_123",
    )
    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Reasoning delta (should be ignored)
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "reasoning" },
        delta: "Let me think...",
      },
    })
    // Text delta
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "Hello World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    // Text should be sent as reply
    expect(mockFeishu.replyMessage).toHaveBeenCalledWith("msg_original", {
      msg_type: "text",
      content: JSON.stringify({ text: "Hello World" }),
    })
    // deleteReaction called with correct args
    expect(mockFeishu.deleteReaction).toHaveBeenCalledWith("msg_original", "reaction_123")
  })

  it("sends text as reply and calls deleteReaction when no reasoning content", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      deleteReaction: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      onComplete,
      "msg_original",
      "reaction_123",
    )
    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "Hello World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    // Text sent as reply
    expect(mockFeishu.replyMessage).toHaveBeenCalledWith("msg_original", {
      msg_type: "text",
      content: JSON.stringify({ text: "Hello World" }),
    })
    // deleteReaction called
    expect(mockFeishu.deleteReaction).toHaveBeenCalledWith("msg_original", "reaction_123")
  })
})
