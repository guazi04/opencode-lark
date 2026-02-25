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
    memoryManager: {
      saveMemory: vi.fn(),
      searchMemory: vi.fn().mockReturnValue([]),
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

  it("skips non-text messages", async () => {
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
    expect(deps.memoryManager.saveMemory).toHaveBeenCalledWith(
      "ses-1",
      expect.stringContaining("Q: Hello"),
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

  it("includes memory context in message parts when memory results exist", async () => {
    mockFetchOk("")
    const deps = makeDeps({
      memoryManager: {
        saveMemory: vi.fn(),
        searchMemory: vi.fn().mockReturnValue([
          { session_id: "ses-old", snippet: "previous context", rank: 1 },
        ]),
      },
    })
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

    const fetchCall = (globalThis.fetch as any).mock.calls[0]
    const body = JSON.parse(fetchCall[1].body)
    expect(body.parts[0].text).toContain("[Memory Context]")
    expect(body.parts[0].text).toContain("previous context")
    expect(body.parts[0].text).toContain("[User Message]")
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
})
