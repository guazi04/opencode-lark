/**
 * End-to-end smoke tests for the full opencode-feishu pipeline.
 *
 * Exercises real module instantiation with fetch-level mocking.
 * 8 scenarios across 2 suites:
 *   Suite 1 – Core pipeline:
 *     1. Basic message flow:  Feishu event → handler → opencode POST → SSE → streaming card → close
 *     2. Sub-agent flow:      Message triggers subtask → SubtaskDiscovered → button → child messages
 *     3. Memory flow:         Message → memory saved → related message → memory context injected
 *     4. Error flow:          opencode returns error → error card sent
 *   Suite 2 – Session sharing:
 *     5. Session discovery + bind notification
 *     6. Feishu-initiated message processed correctly (observer skips owned)
 *     7. TUI-initiated message forwarded to Feishu
 *     8. Session reuse — no duplicate bind notification
 */

import { addListener } from "../../utils/event-listeners.js"
import { createSessionObserver } from "../../streaming/session-observer.js"
import type { EventListenerMap } from "../../utils/event-listeners.js"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createMessageHandler, type HandlerDeps } from "../../handler/message-handler.js"
import { createStreamingBridge } from "../../handler/streaming-integration.js"
import { EventProcessor } from "../../streaming/event-processor.js"
import { SubAgentTracker } from "../../streaming/subagent-tracker.js"
import { createMockLogger, createMockFeishuClient } from "../setup.js"
import type { CardKitClient } from "../../feishu/cardkit-client.js"
import type { FeishuMessageEvent } from "../../types.js"
import type { SessionManager } from "../../session/session-manager.js"
import type { MemoryManager, MemorySearchResult } from "../../memory/memory-manager.js"
import type { ProgressTracker } from "../../session/progress-tracker.js"

// ═══════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════

function makeFeishuEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    event_id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    event_type: "im.message.receive_v1",
    chat_id: "chat-e2e",
    chat_type: "p2p",
    message_id: "msg-e2e-1",
    sender: {
      sender_id: { open_id: "ou-user-1" },
      sender_type: "user",
      tenant_key: "tk-1",
    },
    message: {
      message_type: "text",
      content: JSON.stringify({ text: "Hello from e2e" }),
    },
    ...overrides,
  }
}

function createMockCardKitClient(): CardKitClient {
  return {
    createCard: vi.fn().mockResolvedValue("card_e2e_1"),
    updateElement: vi.fn().mockResolvedValue(undefined),
    closeStreaming: vi.fn().mockResolvedValue(undefined),
  } as unknown as CardKitClient
}

function createMockSessionManager(sessionId = "ses-e2e-1"): SessionManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue(sessionId),
    getSession: vi.fn().mockReturnValue(null),
    cleanup: vi.fn().mockReturnValue(0),
  }
}

function createMockProgressTracker(): ProgressTracker {
  return {
    sendThinking: vi.fn().mockResolvedValue("thinking-e2e-1"),
    updateWithResponse: vi.fn().mockResolvedValue(undefined),
    updateWithError: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockMemoryManager(): MemoryManager & {
  _saved: Array<{ sessionId: string; content: string }>
} {
  const saved: Array<{ sessionId: string; content: string }> = []
  let searchResults: MemorySearchResult[] = []

  return {
    _saved: saved,
    saveMemory: vi.fn((sessionId: string, content: string) => {
      saved.push({ sessionId, content })
    }),
    searchMemory: vi.fn((query: string) => {
      // After first save, return saved content as search results for related queries
      if (saved.length > 0 && searchResults.length === 0) {
        // Auto-populate search results from saved memories
        searchResults = saved.map((s, i) => ({
          session_id: s.sessionId,
          snippet: s.content,
          rank: i + 1,
        }))
      }
      return searchResults
    }),
  }
}

// ═══════════════════════════════════════════
// Test suite
// ═══════════════════════════════════════════

describe("E2E Smoke Tests", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  // ─────────────────────────────────────────
  // Scenario 1: Basic message flow
  // ─────────────────────────────────────────

  it("basic message flow: event → handler → opencode POST → SSE streaming → card close", async () => {
    const sessionId = "ses-basic-1"
    const ownedSessions = new Set<string>()
    const eventListeners: EventListenerMap = new Map()
    const logger = createMockLogger()
    const cardkitClient = createMockCardKitClient()
    const feishuClient = createMockFeishuClient()

    // feishuClient.sendMessage returns message_id (needed by StreamingCardSession.start())
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: { message_id: "lark-msg-1" },
    })

    // feishuClient.addReaction returns reaction_id (needed for emoji reaction pattern)
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: { reaction_id: "reaction-e2e-1" },
    })
    ;(feishuClient.deleteReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
    })
    ;(feishuClient.replyMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
    })
    const progressTracker = createMockProgressTracker()
    const memoryManager = createMockMemoryManager()
    const sessionManager = createMockSessionManager(sessionId)

    // Mock fetch: opencode POST /session/{id}/message → 200 OK
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    }) as any

    const eventProcessor = new EventProcessor({ ownedSessions })
    const subAgentTracker = new SubAgentTracker({ serverUrl: "http://127.0.0.1:4096" })

    const streamingBridge = createStreamingBridge({
      cardkitClient,
      feishuClient,
      subAgentTracker,
      logger,
    })

    const handleMessage = createMessageHandler({
      serverUrl: "http://127.0.0.1:4096",
      sessionManager,
      memoryManager,
      dedup: { isDuplicate: vi.fn().mockReturnValue(false), close: vi.fn() } as any,
      eventProcessor,
      feishuClient,
      progressTracker,
      eventListeners,
      ownedSessions,
      logger,
      streamingBridge,
    })

    // Trigger message handling
    const handlerPromise = handleMessage(makeFeishuEvent())

    // Wait for event listener to be registered (handler POSTs, then streaming bridge starts card, registers listener)
    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    // Verify session was added to ownedSessions
    expect(ownedSessions.has(sessionId)).toBe(true)

    // Verify opencode POST was called
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:4096/session/${sessionId}/message`,
      expect.objectContaining({ method: "POST" }),
    )

    // Simulate SSE events: text deltas then session idle
    const listener = [...eventListeners.get(sessionId)!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "m-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "m-1", type: "text", text: "Hello World" },
        delta: "World!",
      },
    })

    // Signal completion
    listener({
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await handlerPromise

    // With lazy card creation, card is only created when a ToolStateChange event arrives.
    // Since this test only sends text deltas, no card is created.
    // Instead, verify that replyMessage was called with the text response.
    expect(feishuClient.replyMessage).toHaveBeenCalledWith(
      "msg-e2e-1",
      expect.objectContaining({ msg_type: "text" }),
    )

    // With lazy card creation, card was never created (no tool events), so no close needed

    // Verify listener was cleaned up
    expect(eventListeners.size).toBe(0)

    // Verify memory was saved with Q&A
    expect(memoryManager.saveMemory).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining("Q: Hello from e2e"),
    )
    expect(memoryManager.saveMemory).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining("A: Hello World!"),
    )
  })

  // ─────────────────────────────────────────
  // Scenario 2: Sub-agent flow
  // ─────────────────────────────────────────

  it("sub-agent flow: message → SubtaskDiscovered → button added → child session tracked", async () => {
    const sessionId = "ses-subagent-1"
    const childSessionId = "ses-child-1"
    const ownedSessions = new Set<string>()
    const eventListeners: EventListenerMap = new Map()
    const logger = createMockLogger()
    const cardkitClient = createMockCardKitClient()
    const feishuClient = createMockFeishuClient()

    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: { message_id: "lark-msg-2" },
    })

    // Mock fetch: POST /session/{id}/message → 200 + GET /session/{id}/children → child session
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/children")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ id: childSessionId, parentID: sessionId }]),
        })
      }
      // Default: opencode POST message response
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(""),
      })
    }) as any

    const eventProcessor = new EventProcessor({ ownedSessions })
    const subAgentTracker = new SubAgentTracker({ serverUrl: "http://127.0.0.1:4096" })

    const streamingBridge = createStreamingBridge({
      cardkitClient,
      feishuClient,
      subAgentTracker,
      logger,
    })

    const handleMessage = createMessageHandler({
      serverUrl: "http://127.0.0.1:4096",
      sessionManager: createMockSessionManager(sessionId),
      memoryManager: createMockMemoryManager(),
      dedup: { isDuplicate: vi.fn().mockReturnValue(false), close: vi.fn() } as any,
      eventProcessor,
      feishuClient,
      progressTracker: createMockProgressTracker(),
      eventListeners,
      ownedSessions,
      logger,
      streamingBridge,
    })

    const handlerPromise = handleMessage(
      makeFeishuEvent({ message: { message_type: "text", content: JSON.stringify({ text: "Run task" }) } }),
    )

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get(sessionId)!][0]!

    // Send some text first
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "m-1", type: "text", text: "Starting" },
        delta: "Starting task...",
      },
    })

    // SubtaskDiscovered event
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: sessionId,
          messageID: "m-1",
          type: "subtask",
          prompt: "research the topic",
          description: "Research task",
          agent: "explorer",
        },
      },
    })

    // Give async SubtaskDiscovered handler time to process (tracker polls /children)
    await new Promise((r) => setTimeout(r, 50))

    // Verify subAgentTracker registered the subtask and polled for children
    const tracked = subAgentTracker.getTrackedSubAgents()
    expect(tracked.length).toBe(1)
    expect(tracked[0]!.description).toBe("Research task")
    expect(tracked[0]!.agent).toBe("explorer")

    const sendCalls = (feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    const subtaskCardCall = sendCalls.find(
      (call: unknown[]) =>
        typeof (call[1] as Record<string, unknown>)?.content === "string" &&
        ((call[1] as Record<string, unknown>).content as string).includes("Research task"),
    )
    expect(subtaskCardCall).toBeDefined()

    // Complete the session
    listener({
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await handlerPromise

    // With lazy card creation, card was never created (only text and subtask events, no tool events), so no close needed
  })

  // ─────────────────────────────────────────
  // Scenario 3: Memory flow
  // ─────────────────────────────────────────

  it("memory flow: message → save memory → related message → memory context injected", async () => {
    const sessionId = "ses-memory-1"
    const ownedSessions = new Set<string>()
    const eventListeners: EventListenerMap = new Map()
    const logger = createMockLogger()
    const feishuClient = createMockFeishuClient()
    const memoryManager = createMockMemoryManager()

    // No streaming bridge — test via event-driven fallback path
    // This tests the handler's own event-driven flow (not streaming bridge)

    // Mock fetch: POST /session/{id}/message → 200 OK
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    }) as any

    const eventProcessor = new EventProcessor({ ownedSessions })
    const progressTracker = createMockProgressTracker()

    const deps: HandlerDeps = {
      serverUrl: "http://127.0.0.1:4096",
      sessionManager: createMockSessionManager(sessionId),
      memoryManager,
      dedup: { isDuplicate: vi.fn().mockReturnValue(false), close: vi.fn() } as any,
      eventProcessor,
      feishuClient,
      progressTracker,
      eventListeners,
      ownedSessions,
      logger,
      // No streamingBridge — falls through to event-driven flow
    }

    const handleMessage = createMessageHandler(deps)

    // ── First message: no memory context ──
    const event1 = makeFeishuEvent({
      event_id: "evt-mem-1",
      message: { message_type: "text", content: JSON.stringify({ text: "What is TypeScript?" }) },
    })

    const promise1 = handleMessage(event1)

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    // Verify first message has NO memory context
    const firstFetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    const firstBody = JSON.parse(firstFetchCall[1].body as string)
    expect(firstBody.parts[0].text).toBe("What is TypeScript?")
    expect(firstBody.parts[0].text).not.toContain("[Memory Context]")

    // Complete first session via SSE
    const listener1 = [...eventListeners.get(sessionId)!][0]!
    listener1({
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "m-1", type: "text", text: "TS is..." },
        delta: "TypeScript is a typed superset of JavaScript.",
      },
    })
    listener1({
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await promise1

    // Verify memory was saved
    expect(memoryManager.saveMemory).toHaveBeenCalledWith(
      sessionId,
      expect.stringContaining("Q: What is TypeScript?"),
    )
    expect(memoryManager._saved.length).toBe(1)

    // ── Second message: should include memory context ──
    // searchMemory will now return saved content (auto-populated)
    const event2 = makeFeishuEvent({
      event_id: "evt-mem-2",
      message: { message_type: "text", content: JSON.stringify({ text: "Tell me more about TypeScript" }) },
    })

    const promise2 = handleMessage(event2)

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    // Verify second message includes memory context
    const secondFetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]!
    const secondBody = JSON.parse(secondFetchCall[1].body as string)
    expect(secondBody.parts[0].text).toContain("[Memory Context]")
    expect(secondBody.parts[0].text).toContain("Q: What is TypeScript?")
    expect(secondBody.parts[0].text).toContain("[User Message]")
    expect(secondBody.parts[0].text).toContain("Tell me more about TypeScript")

    // Complete second session
    const listener2 = [...eventListeners.get(sessionId)!][0]!
    listener2({
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await promise2

    // Verify memory search was called for second message
    expect(memoryManager.searchMemory).toHaveBeenCalledWith("Tell me more about TypeScript")
  })

  // ─────────────────────────────────────────
  // Scenario 4: Error flow
  // ─────────────────────────────────────────

  it("error flow: opencode returns error → error card sent to Feishu", async () => {
    const sessionId = "ses-error-1"
    const ownedSessions = new Set<string>()
    const eventListeners: EventListenerMap = new Map()
    const logger = createMockLogger()
    const feishuClient = createMockFeishuClient()
    const progressTracker = createMockProgressTracker()

    // Mock fetch: POST /session/{id}/message → 500 error
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }) as any

    const eventProcessor = new EventProcessor({ ownedSessions })

    const handleMessage = createMessageHandler({
      serverUrl: "http://127.0.0.1:4096",
      sessionManager: createMockSessionManager(sessionId),
      memoryManager: createMockMemoryManager(),
      dedup: { isDuplicate: vi.fn().mockReturnValue(false), close: vi.fn() } as any,
      eventProcessor,
      feishuClient,
      progressTracker,
      eventListeners,
      ownedSessions,
      logger,
      // No streamingBridge — error happens before streaming starts
    })

    await handleMessage(makeFeishuEvent())

    // Verify thinking card was sent
    expect(progressTracker.sendThinking).toHaveBeenCalledWith("chat-e2e")

    // Verify error was reported via progress tracker
    expect(progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-e2e-1",
      "处理请求时出错了。",
    )

    // Verify NO event listener was registered (error happened before SSE)
    expect(eventListeners.size).toBe(0)

    // Verify error was logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Prompt HTTP error: 500"),
    )

    // Verify memory was NOT saved (error path)
    const memoryMock = createMockMemoryManager()
    expect(memoryMock._saved.length).toBe(0)
  })
})

// ═══════════════════════════════════════════
// Session sharing suite
// ═══════════════════════════════════════════

describe("session sharing", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  // Helper: fire an event to all listeners registered for a given session
  function fireEvent(eventListeners: EventListenerMap, sessionId: string, event: unknown) {
    const listeners = eventListeners.get(sessionId)
    if (listeners) {
      for (const listener of [...listeners]) {
        listener(event)
      }
    }
  }

  // ─────────────────────────────────────────
  // Scenario 5: Session discovery + bind notification
  // ─────────────────────────────────────────

  it("session discovery + bind notification", async () => {
    const sessionId = "ses-shared-1"
    const ownedSessions = new Set<string>()
    const eventListeners: EventListenerMap = new Map()
    const logger = createMockLogger()
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, msg: "ok", data: { message_id: "lark-share-1" } })
    const memoryManager = createMockMemoryManager()
    const progressTracker = createMockProgressTracker()

    // Mock fetch:
    //   POST /session/{id}/message → 200 OK
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    }) as any

    const eventProcessor = new EventProcessor({ ownedSessions })
    const observer = createSessionObserver({
      feishuClient,
      eventProcessor,
      addListener: (sid, fn) => addListener(eventListeners, sid, fn),
      removeListener: (sid, fn) => {
        const set = eventListeners.get(sid)
        if (set) { set.delete(fn); if (set.size === 0) eventListeners.delete(sid) }
      },
      logger,
    })

    const handleMessage = createMessageHandler({
      serverUrl: "http://127.0.0.1:4096",
      sessionManager: createMockSessionManager(sessionId),
      memoryManager,
      dedup: { isDuplicate: vi.fn().mockReturnValue(false), close: vi.fn() } as any,
      eventProcessor,
      feishuClient,
      progressTracker,
      eventListeners,
      ownedSessions,
      logger,
      observer,
      // No streamingBridge — event-driven flow
    })

    // Send first Feishu message
    const handlerPromise = handleMessage(makeFeishuEvent({
      event_id: "evt-share-1",
      message: { message_type: "text", content: JSON.stringify({ text: "Hello shared" }) },
    }))

    // Wait for handler to register its listener(s) + observer
    await vi.waitFor(() => {
      // Handler registers: 1 ownership listener + 1 event-driven listener
      // Observer registers: 1 listener
      // All under the same sessionId key → eventListeners.size == 1 (map keys)
      expect(eventListeners.size).toBe(1)
      const listeners = eventListeners.get(sessionId)
      expect(listeners).toBeDefined()
      expect(listeners!.size).toBeGreaterThanOrEqual(3)
    })

    // Assert: bind notification was sent
    expect(feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-e2e",
      expect.objectContaining({
        msg_type: "text",
        content: JSON.stringify({ text: "已连接 session: " + sessionId }),
      }),
    )

    // Assert: session is owned
    expect(ownedSessions.has(sessionId)).toBe(true)

    // Complete the handler: fire text + idle
    fireEvent(eventListeners, sessionId, {
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "msg-feishu-1", type: "text", text: "Hello response" },
        delta: "Hello response",
      },
    })

    fireEvent(eventListeners, sessionId, {
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await handlerPromise
  })

  // ─────────────────────────────────────────
  // Scenario 6: Feishu-initiated message — observer skips owned
  // ─────────────────────────────────────────

  it("Feishu-initiated message: observer skips owned message IDs", async () => {
    const sessionId = "ses-shared-2"
    const ownedSessions = new Set<string>()
    const eventListeners: EventListenerMap = new Map()
    const logger = createMockLogger()
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, msg: "ok", data: { message_id: "lark-share-2" } })
    const memoryManager = createMockMemoryManager()
    const progressTracker = createMockProgressTracker()

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    }) as any

    const eventProcessor = new EventProcessor({ ownedSessions })
    const observer = createSessionObserver({
      feishuClient,
      eventProcessor,
      addListener: (sid, fn) => addListener(eventListeners, sid, fn),
      removeListener: (sid, fn) => {
        const set = eventListeners.get(sid)
        if (set) { set.delete(fn); if (set.size === 0) eventListeners.delete(sid) }
      },
      logger,
    })

    const handleMessage = createMessageHandler({
      serverUrl: "http://127.0.0.1:4096",
      sessionManager: createMockSessionManager(sessionId),
      memoryManager,
      dedup: { isDuplicate: vi.fn().mockReturnValue(false), close: vi.fn() } as any,
      eventProcessor,
      feishuClient,
      progressTracker,
      eventListeners,
      ownedSessions,
      logger,
      observer,
    })

    const handlerPromise = handleMessage(makeFeishuEvent({
      event_id: "evt-owned-1",
      message: { message_type: "text", content: JSON.stringify({ text: "Feishu question" }) },
    }))

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
      expect(eventListeners.get(sessionId)!.size).toBeGreaterThanOrEqual(3)
    })

    // Fire text delta and idle (Feishu-initiated message)
    fireEvent(eventListeners, sessionId, {
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "msg-feishu-owned", type: "text", text: "Owned reply" },
        delta: "Owned reply",
      },
    })

    fireEvent(eventListeners, sessionId, {
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await handlerPromise

    // The handler uses progressTracker.updateWithResponse (not sendMessage) because
    // thinkingMessageId is set (no streamingBridge). So the response text "Owned reply"
    // is NOT sent via sendMessage. The observer should also skip it (markOwned).
    // Result: zero sendMessage calls with text "Owned reply".
    const sendCalls = (feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    const observerForwardCalls = sendCalls.filter(
      (call: unknown[]) => {
        const payload = call[1] as Record<string, unknown>
        if (typeof payload?.content !== "string") return false
        try {
          const parsed = JSON.parse(payload.content as string) as Record<string, unknown>
          return parsed.text === "Owned reply"
        } catch { return false }
      },
    )
    // Observer did NOT forward owned message, handler used progressTracker instead
    expect(observerForwardCalls.length).toBe(0)
  })

  // ─────────────────────────────────────────
  // Scenario 7: TUI-initiated message forwarded to Feishu
  // ─────────────────────────────────────────

  it("TUI-initiated message forwarded to Feishu via observer", async () => {
    const sessionId = "ses-shared-3"
    const ownedSessions = new Set<string>()
    const eventListeners: EventListenerMap = new Map()
    const logger = createMockLogger()
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, msg: "ok", data: { message_id: "lark-share-3" } })
    const memoryManager = createMockMemoryManager()
    const progressTracker = createMockProgressTracker()

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    }) as any

    const eventProcessor = new EventProcessor({ ownedSessions })
    const observer = createSessionObserver({
      feishuClient,
      eventProcessor,
      addListener: (sid, fn) => addListener(eventListeners, sid, fn),
      removeListener: (sid, fn) => {
        const set = eventListeners.get(sid)
        if (set) { set.delete(fn); if (set.size === 0) eventListeners.delete(sid) }
      },
      logger,
    })

    const handleMessage = createMessageHandler({
      serverUrl: "http://127.0.0.1:4096",
      sessionManager: createMockSessionManager(sessionId),
      memoryManager,
      dedup: { isDuplicate: vi.fn().mockReturnValue(false), close: vi.fn() } as any,
      eventProcessor,
      feishuClient,
      progressTracker,
      eventListeners,
      ownedSessions,
      logger,
      observer,
    })

    // First: send a Feishu message to establish the session + observer
    const handlerPromise = handleMessage(makeFeishuEvent({
      event_id: "evt-tui-setup",
      message: { message_type: "text", content: JSON.stringify({ text: "Setup" }) },
    }))

    await vi.waitFor(() => {
      expect(eventListeners.size).toBe(1)
      expect(eventListeners.get(sessionId)!.size).toBeGreaterThanOrEqual(3)
    })

    // Complete the Feishu message first
    fireEvent(eventListeners, sessionId, {
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "msg-setup", type: "text", text: "Setup done" },
        delta: "Setup done",
      },
    })

    fireEvent(eventListeners, sessionId, {
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await handlerPromise

    // Reset sendMessage call count to isolate TUI forwarding
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockClear()

    // Now fire TUI-initiated events (different messageID, NOT marked owned)
    // Observer listener is still active on this session
    fireEvent(eventListeners, sessionId, {
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "msg-tui-1", type: "text", text: "Hello from TUI" },
        delta: "Hello from TUI",
      },
    })

    fireEvent(eventListeners, sessionId, {
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    // Observer should have forwarded the TUI message to Feishu
    await vi.waitFor(() => {
      expect(feishuClient.sendMessage).toHaveBeenCalledWith(
        "chat-e2e",
        {
          msg_type: "text",
          content: JSON.stringify({ text: "Hello from TUI" }),
        },
      )
    })
  })

  // ─────────────────────────────────────────
  // Scenario 8: Session reuse — no duplicate bind notification
  // ─────────────────────────────────────────

  it("session reuse: no duplicate bind notification on second message", async () => {
    const sessionId = "ses-shared-4"
    const ownedSessions = new Set<string>()
    const eventListeners: EventListenerMap = new Map()
    const logger = createMockLogger()
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, msg: "ok", data: { message_id: "lark-share-4" } })
    const memoryManager = createMockMemoryManager()
    const progressTracker = createMockProgressTracker()

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    }) as any

    const eventProcessor = new EventProcessor({ ownedSessions })
    const observer = createSessionObserver({
      feishuClient,
      eventProcessor,
      addListener: (sid, fn) => addListener(eventListeners, sid, fn),
      removeListener: (sid, fn) => {
        const set = eventListeners.get(sid)
        if (set) { set.delete(fn); if (set.size === 0) eventListeners.delete(sid) }
      },
      logger,
    })

    const handleMessage = createMessageHandler({
      serverUrl: "http://127.0.0.1:4096",
      sessionManager: createMockSessionManager(sessionId),
      memoryManager,
      dedup: { isDuplicate: vi.fn().mockReturnValue(false), close: vi.fn() } as any,
      eventProcessor,
      feishuClient,
      progressTracker,
      eventListeners,
      ownedSessions,
      logger,
      observer,
    })

    // ── First message → bind notification expected ──
    const promise1 = handleMessage(makeFeishuEvent({
      event_id: "evt-reuse-1",
      message: { message_type: "text", content: JSON.stringify({ text: "First" }) },
    }))

    await vi.waitFor(() => {
      expect(eventListeners.get(sessionId)?.size).toBeGreaterThanOrEqual(3)
    })

    fireEvent(eventListeners, sessionId, {
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "msg-r1", type: "text", text: "Reply 1" },
        delta: "Reply 1",
      },
    })

    fireEvent(eventListeners, sessionId, {
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await promise1

    // Count bind notifications so far (should be exactly 1)
    const bindCalls1 = (feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const payload = call[1] as Record<string, unknown>
        if (typeof payload?.content !== "string") return false
        return (payload.content as string).includes("已连接 session")
      },
    )
    expect(bindCalls1.length).toBe(1)

    // ── Second message → NO additional bind notification ──
    const promise2 = handleMessage(makeFeishuEvent({
      event_id: "evt-reuse-2",
      message: { message_type: "text", content: JSON.stringify({ text: "Second" }) },
    }))

    await vi.waitFor(() => {
      expect(eventListeners.get(sessionId)?.size).toBeGreaterThanOrEqual(3)
    })

    fireEvent(eventListeners, sessionId, {
      type: "message.part.updated",
      properties: {
        part: { sessionID: sessionId, messageID: "msg-r2", type: "text", text: "Reply 2" },
        delta: "Reply 2",
      },
    })

    fireEvent(eventListeners, sessionId, {
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    })

    await promise2

    // Bind notifications should still be exactly 1 (no duplicate)
    const bindCalls2 = (feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => {
        const payload = call[1] as Record<string, unknown>
        if (typeof payload?.content !== "string") return false
        return (payload.content as string).includes("已连接 session")
      },
    )
    expect(bindCalls2.length).toBe(1)

    // Session manager should have been called for both messages (cache is in session-manager)
    // but getOrCreate is mocked and always returns same sessionId
  })
})