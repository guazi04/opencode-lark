import { describe, it, expect, vi } from "vitest"
import { EventProcessor } from "./event-processor.js"
import {
  createSessionObserver,
  type SessionObserverDeps,
} from "./session-observer.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps() {
  const capturedListeners = new Map<string, (event: unknown) => void>()

  const deps: SessionObserverDeps & {
    capturedListeners: typeof capturedListeners
  } = {
    feishuClient: {
      sendMessage: vi.fn().mockResolvedValue({ code: 0, msg: "ok" }),
    },
    eventProcessor: new EventProcessor({
      ownedSessions: new Set(["ses-1"]),
    }),
    addListener: vi.fn((sessionId: string, fn: (event: unknown) => void) => {
      capturedListeners.set(sessionId, fn)
    }),
    removeListener: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    capturedListeners,
  }
  return deps
}

// Raw event factories

function textDeltaEvent(
  sessionId: string,
  messageId: string,
  delta: string,
) {
  return {
    type: "message.part.delta" as const,
    properties: {
      sessionID: sessionId,
      messageID: messageId,
      partID: "prt-1",
      field: "text",
      delta,
    },
  }
}

function sessionIdleEvent(sessionId: string) {
  return {
    type: "session.idle" as const,
    properties: { sessionID: sessionId },
  }
}

function toolStateEvent(sessionId: string, messageId: string) {
  return {
    type: "message.part.updated" as const,
    properties: {
      part: {
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        tool: "bash",
        state: { status: "running" },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionObserver", () => {
  it("accumulates TUI-initiated TextDelta and sends on SessionIdle", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")

    const listener = deps.capturedListeners.get("ses-1")!
    expect(listener).toBeDefined()

    listener(textDeltaEvent("ses-1", "msg-tui-1", "Hello "))
    listener(textDeltaEvent("ses-1", "msg-tui-1", "from TUI"))

    // Not sent yet
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()

    listener(sessionIdleEvent("ses-1"))

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith("chat-1", {
      msg_type: "text",
      content: JSON.stringify({ text: "Hello from TUI" }),
    })
  })

  it("ignores events for owned messageIDs (markOwned)", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")
    observer.markOwned("msg-feishu-1")

    const listener = deps.capturedListeners.get("ses-1")!

    listener(textDeltaEvent("ses-1", "msg-feishu-1", "This is from Feishu"))
    listener(sessionIdleEvent("ses-1"))

    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
  })

  it("does NOT process ToolStateChange events into buffer", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")

    const listener = deps.capturedListeners.get("ses-1")!

    listener(toolStateEvent("ses-1", "msg-tui-1"))
    listener(sessionIdleEvent("ses-1"))

    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
  })

  it("handles multiple TUI turns (buffer resets after SessionIdle)", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")

    const listener = deps.capturedListeners.get("ses-1")!

    // Turn 1
    listener(textDeltaEvent("ses-1", "msg-1", "First turn"))
    listener(sessionIdleEvent("ses-1"))

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith("chat-1", {
      msg_type: "text",
      content: JSON.stringify({ text: "First turn" }),
    })

    // Turn 2
    listener(textDeltaEvent("ses-1", "msg-2", "Second turn"))
    listener(sessionIdleEvent("ses-1"))

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledTimes(2)
    expect(deps.feishuClient.sendMessage).toHaveBeenLastCalledWith("chat-1", {
      msg_type: "text",
      content: JSON.stringify({ text: "Second turn" }),
    })
  })

  it("handles SessionIdle with no buffered text (no-op)", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")

    const listener = deps.capturedListeners.get("ses-1")!
    listener(sessionIdleEvent("ses-1"))

    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
  })

  it("observe() calls addListener, stop() calls removeListener", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")

    expect(deps.addListener).toHaveBeenCalledWith(
      "ses-1",
      expect.any(Function),
    )

    observer.stop()

    expect(deps.removeListener).toHaveBeenCalledWith(
      "ses-1",
      expect.any(Function),
    )
  })

  it("extracts messageId from message.part.updated (part.messageID)", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")
    observer.markOwned("msg-owned")

    const listener = deps.capturedListeners.get("ses-1")!

    // message.part.updated has messageID inside properties.part
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "msg-owned",
          type: "text",
          text: "owned text",
        },
        delta: "owned text",
      },
    })

    listener(sessionIdleEvent("ses-1"))

    // Should be skipped because msg-owned is marked owned
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
  })

  it("skips TextDelta and SessionIdle when session is marked busy", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")
    observer.markSessionBusy("ses-1")

    const listener = deps.capturedListeners.get("ses-1")!

    listener(textDeltaEvent("ses-1", "msg-tui-2", "Busy text"))
    listener(sessionIdleEvent("ses-1"))

    // Observer should skip everything for busy sessions
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
  })

  it("resumes processing after markSessionFree", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")
    observer.markSessionBusy("ses-1")

    const listener = deps.capturedListeners.get("ses-1")!

    // While busy: no forwarding
    listener(textDeltaEvent("ses-1", "msg-busy", "Ignored"))
    listener(sessionIdleEvent("ses-1"))
    expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()

    // Free the session
    observer.markSessionFree("ses-1")

    // Now TUI messages should be forwarded
    listener(textDeltaEvent("ses-1", "msg-free", "Forwarded"))
    listener(sessionIdleEvent("ses-1"))

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith("chat-1", {
      msg_type: "text",
      content: JSON.stringify({ text: "Forwarded" }),
    })
  })

  it("markSessionBusy does not affect other sessions", () => {
    const deps = makeDeps()
    const observer = createSessionObserver(deps)
    observer.observe("ses-1", "chat-1")
    observer.markSessionBusy("ses-other")

    const listener = deps.capturedListeners.get("ses-1")!

    listener(textDeltaEvent("ses-1", "msg-ok", "Not blocked"))
    listener(sessionIdleEvent("ses-1"))

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith("chat-1", {
      msg_type: "text",
      content: JSON.stringify({ text: "Not blocked" }),
    })
  })
})