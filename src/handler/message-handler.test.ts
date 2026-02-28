import { describe, it, expect, vi, beforeEach } from "vitest"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { createMessageHandler, type HandlerDeps } from "./message-handler.js"
import { EventProcessor } from "../streaming/event-processor.js"
import { createMockLogger, createMockFeishuClient } from "../__tests__/setup.js"
import type { FeishuMessageEvent } from "../types.js"

function makeEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    event_id: "evt-1",
    event_type: "im.message.receive_v1",
    chat_id: "chat-1",
    chat_type: "p2p",
    message_id: "msg-1",
    sender: {
      sender_id: { open_id: "ou-1" },
      sender_type: "user",
      tenant_key: "tk-1",
    },
    message: {
      message_type: "text",
      content: JSON.stringify({ text: "Hello" }),
    },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const ownedSessions = new Set<string>()
  const eventListeners: EventListenerMap = new Map()

  return {
    serverUrl: "http://127.0.0.1:4096",
    sessionManager: {
      getOrCreate: vi.fn().mockResolvedValue("ses-1"),
      getSession: vi.fn().mockReturnValue(null),
      cleanup: vi.fn().mockReturnValue(0),
    },
    dedup: {
      isDuplicate: vi.fn().mockReturnValue(false),
      close: vi.fn(),
    } as any,
    eventProcessor: new EventProcessor({ ownedSessions }),
    feishuClient: createMockFeishuClient(),
    progressTracker: {
      sendThinking: vi.fn().mockResolvedValue("thinking-msg-1"),
      updateWithResponse: vi.fn().mockResolvedValue(undefined),
      updateWithError: vi.fn().mockResolvedValue(undefined),
    },
    eventListeners,
    ownedSessions,
    logger: createMockLogger(),
    ...overrides,
  }
}

function mockFetchOk(body = ""): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(body),
  }) as any
}

function mockFetchError(status = 500): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(""),
  }) as any
}

describe("createMessageHandler", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("skips duplicate events", async () => {
    const deps = makeDeps({
      dedup: { isDuplicate: vi.fn().mockReturnValue(true), close: vi.fn() } as any,
    })
    const handler = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("skips non-text/post messages", async () => {
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    await handler(
      makeEvent({ message: { message_type: "image", content: "" } }),
    )

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Skipping non-text"),
    )
  })

  it("handles post message type — extracts text from rich content", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const postContent = JSON.stringify({
      zh_cn: {
        title: "Post Title",
        content: [
          [
            { tag: "text", text: "Line 1 text" },
            { tag: "a", href: "https://example.com", text: "link" },
          ],
          [
            { tag: "text", text: "Line 2" },
          ],
        ],
      },
    })

    const handlerPromise = handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(deps.feishuClient.sendMessage).toHaveBeenCalled()
  })

  it("handles post message with multiple paragraphs", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const postContent = JSON.stringify({
      en_us: {
        content: [
          [{ tag: "text", text: "Paragraph 1" }],
          [{ tag: "text", text: "Paragraph 2" }],
          [{ tag: "text", text: "Paragraph 3" }],
        ],
      },
    })

    const handlerPromise = handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.feishuClient.sendMessage).toHaveBeenCalled()
  })

  it("handles post message with empty content gracefully", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    // Empty post content
    const postContent = JSON.stringify({})

    await handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    // Should skip because extracted text is empty
    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("skips empty text messages", async () => {
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    await handler(
      makeEvent({ message: { message_type: "text", content: JSON.stringify({ text: "  " }) } }),
    )

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("handles POST failure with error card", async () => {
    mockFetchError(500)
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "处理请求时出错了。",
    )
  })

  it("handles POST failure without thinking card — sends direct message", async () => {
    mockFetchError(500)
    const deps = makeDeps({
      progressTracker: {
        sendThinking: vi.fn().mockResolvedValue(null),
        updateWithResponse: vi.fn().mockResolvedValue(undefined),
        updateWithError: vi.fn().mockResolvedValue(undefined),
      },
    })
    const handler = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ msg_type: "text" }),
    )
  })

  it("event-driven flow: collects TextDelta and responds on SessionIdle", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())


    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "Hello World",
    )
  })

  it("event-driven flow: removes listener after SessionIdle", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.eventListeners.size).toBe(0)
  })

  it("event-driven flow: responds with default text when no TextDelta received", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "（无回复）",
    )
  })

  it("falls back to sync mode on event-driven timeout", async () => {
    vi.useFakeTimers()

    const syncBody = JSON.stringify({
      parts: [{ type: "text", text: "Sync response" }],
    })
    mockFetchOk(syncBody)
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "Sync response",
    )
    expect(deps.eventListeners.size).toBe(0)

    vi.useRealTimers()
  })

  it("sync fallback handles empty response body", async () => {
    vi.useFakeTimers()

    mockFetchOk("   ")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    await handlerPromise

    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "服务器返回了空响应。",
    )

    vi.useRealTimers()
  })

  it("adds sessionId to ownedSessions", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.ownedSessions.has("ses-1")).toBe(true)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise
  })

  it("group chat replies to message instead of sending to chat", async () => {
    mockFetchOk("")
    const deps = makeDeps({
      progressTracker: {
        sendThinking: vi.fn().mockResolvedValue(null),
        updateWithResponse: vi.fn().mockResolvedValue(undefined),
        updateWithError: vi.fn().mockResolvedValue(undefined),
      },
    })
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({ chat_type: "group", message_id: "group-msg-1" }),
    )

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Reply" },
        delta: "Reply",
      },
    }))

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(deps.feishuClient.replyMessage).toHaveBeenCalledWith(
      "group-msg-1",
      expect.objectContaining({ msg_type: "text" }),
    )
  })


  it("sends bind notification on first message for a feishuKey", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Bind notification was sent
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        msg_type: "text",
        content: expect.stringContaining("\u5df2\u8fde\u63a5 session: ses-1"),
      }),
    )
  })

  it("does not send bind notification on second message for same feishuKey", async () => {
    mockFetchOk("")
    const deps = makeDeps()
    const handler = createMessageHandler(deps)

    // First message
    const p1 = handler(makeEvent({ event_id: "evt-1" }))
    await vi.waitFor(() => { expect(deps.eventListeners.size).toBe(1) })
    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))
    await p1

    const sendCallCount = (deps.feishuClient.sendMessage as any).mock.calls.length

    // Second message (different event_id)
    const p2 = handler(makeEvent({ event_id: "evt-2" }))
    await vi.waitFor(() => { expect(deps.eventListeners.size).toBe(1) })
    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))
    await p2

    // Bind notification should only have been sent once (from first message)
    const bindCalls = (deps.feishuClient.sendMessage as any).mock.calls.filter(
      (c: any[]) => JSON.parse(c[1].content).text?.includes("\u5df2\u8fde\u63a5 session:"),
    )
    expect(bindCalls).toHaveLength(1)
  })

  it("calls observer.observe() with correct args after session resolution", async () => {
    mockFetchOk("")
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }
    const deps = makeDeps({ observer })
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(observer.observe).toHaveBeenCalledWith("ses-1", "chat-1")
  })

  it("calls observer.markOwned() with messageId from events in event-driven path", async () => {
    mockFetchOk("")
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }
    const deps = makeDeps({ observer })
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    // Dispatch event with messageID
    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "oc-msg-42", type: "text", text: "Hello" },
        delta: "Hello",
      },
    }))

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(observer.markOwned).toHaveBeenCalledWith("oc-msg-42")
  })

  it("works without observer (backward compatible)", async () => {
    mockFetchOk("")
    const deps = makeDeps() // No observer
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Should complete without errors
    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalled()
  })

  it("calls observer.markSessionBusy/Free when streaming bridge is used", async () => {
    mockFetchOk("")
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }

    // Create a minimal streaming bridge that resolves immediately
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (_chatId: string, _sessionId: string, _el: EventListenerMap, _ep: unknown, _send: () => Promise<string>, onComplete: (text: string) => void) => {
          onComplete("done")
        },
      ),
    }

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { reaction_id: "r-1" },
    })

    const deps = makeDeps({ observer, streamingBridge, feishuClient })
    const handler = createMessageHandler(deps)

    await handler(makeEvent())

    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-1")
    expect(observer.markSessionFree).toHaveBeenCalledWith("ses-1")
  })

  it("includes quoted message context when parent_id is present", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        items: [{
          msg_type: "text",
          body: { content: JSON.stringify({ text: "original question" }) },
        }],
      },
    })
    const deps = makeDeps({ feishuClient })
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({ parent_id: "parent-msg-1" }),
    )

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(feishuClient.getMessage).toHaveBeenCalledWith("parent-msg-1")

    // Verify the POST body contains quoted context
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toContain("> original question")
    expect(body.parts[0].text).toContain("Hello")
  })

  it("handles getMessage failure gracefully (still sends user message)", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API error"),
    )
    const deps = makeDeps({ feishuClient })
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({ parent_id: "parent-msg-1" }),
    )

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    // Should still have sent the original message without quoted context
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = fetchCalls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/message"),
    )
    expect(postCall).toBeDefined()
    const body = JSON.parse((postCall![1] as { body: string }).body)
    expect(body.parts[0].text).toBe("Hello")
  })

  it("does not fetch quoted message when parent_id is absent", async () => {
    mockFetchOk("")
    const feishuClient = createMockFeishuClient()
    const deps = makeDeps({ feishuClient })
    const handler = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await vi.waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach(fn => fn({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    }))

    await handlerPromise

    expect(feishuClient.getMessage).not.toHaveBeenCalled()
  })
})
