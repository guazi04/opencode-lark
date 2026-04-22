import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInteractivePoller } from "../interactive-poller.js"
import { ExpiringSet } from "../../utils/expiring-set.js"
import { interactiveCardKey } from "../../feishu/interactive-card-registry.js"

function createMockInteractiveCardRegistry() {
  const cards = new Map<string, {
    requestId: string
    kind: "question" | "permission"
    chatId: string
    messageId: string
    trackedAt: number
    state: "dispatching" | "sent" | "resolving_feishu"
  }>()

    return {
      beginDispatch: vi.fn((kind: "question" | "permission", requestId: string) => {
        const key = `${kind}:${requestId}`
        if (cards.has(key)) return false
        cards.set(key, {
          requestId,
          kind,
          chatId: "",
          messageId: "",
          trackedAt: Date.now(),
          state: "dispatching",
        })
        return true
      }),
      failDispatch: vi.fn((kind: "question" | "permission", requestId: string) => {
        const key = `${kind}:${requestId}`
        const current = cards.get(key)
        if (!current || current.state !== "dispatching") return false
        cards.delete(key)
        return true
      }),
      track: vi.fn((card: {
        requestId: string
        kind: "question" | "permission"
        chatId: string
        messageId: string
      }) => {
        const key = `${card.kind}:${card.requestId}`
        cards.set(key, { ...card, trackedAt: Date.now(), state: "sent" })
      }),
      markFeishuResolving: vi.fn((kind: "question" | "permission", requestId: string) => {
        const key = `${kind}:${requestId}`
        const current = cards.get(key)
        if (!current || current.state !== "sent") return
        cards.set(key, { ...current, state: "resolving_feishu" })
      }),
      clearFeishuResolving: vi.fn((kind: "question" | "permission", requestId: string) => {
        const key = `${kind}:${requestId}`
        const current = cards.get(key)
        if (!current || current.state !== "resolving_feishu") return
        cards.set(key, { ...current, state: "sent" })
      }),
      untrack: vi.fn((kind: "question" | "permission", requestId: string) => cards.delete(`${kind}:${requestId}`)),
      list: vi.fn(() => Array.from(cards.values())),
      close: vi.fn(() => cards.clear()),
    }
}

const advanceTimers = async (ms: number) => {
  if (typeof vi.advanceTimersByTimeAsync === "function") {
    await vi.advanceTimersByTimeAsync(ms)
  } else {
    vi.advanceTimersByTime(ms)
    await new Promise(r => setImmediate(r))
  }
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }
}

function mockFetchPerUrl(
  questionResp: (() => Promise<unknown>) | Error,
  permissionResp: (() => Promise<unknown>) | Error,
) {
  const mock = vi.fn().mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

    if (typeof url === "string" && url.includes("/question")) {
      if (questionResp instanceof Error) throw questionResp
      return questionResp()
    }
    if (typeof url === "string" && url.includes("/permission")) {
      if (permissionResp instanceof Error) throw permissionResp
      return permissionResp()
    }
    return { ok: false, status: 404, json: () => Promise.resolve(null) }
  })

  return Object.assign(mock, {
    preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
  })
}

const okJson = (data: unknown) => () =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })
const notOk = () => () =>
  Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) })
const badJson = () => () =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error("parse error")) })

const SAMPLE_QUESTION = {
  id: "q_1",
  sessionID: "ses_abc",
  questions: [
    { question: "Pick one", header: "Choice", options: [{ label: "A", description: "Option A" }] },
  ],
}

const SAMPLE_PERMISSION = {
  id: "p_1",
  sessionID: "ses_abc",
  permission: "file_edit",
  patterns: ["/src/foo.ts"],
  metadata: { tool: "edit" },
}

describe("interactive-poller", () => {
  let originalFetch: typeof globalThis.fetch
  const createdSeenInteractiveIds: ExpiringSet<string>[] = []

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const seenSet of createdSeenInteractiveIds.splice(0)) {
      seenSet.close()
    }
  })

  function createDeps(overrides: Record<string, unknown> = {}) {
    const seenInteractiveIds = new ExpiringSet<string>(30 * 60 * 1000, 2 * 60 * 1000)
    createdSeenInteractiveIds.push(seenInteractiveIds)

    return {
      serverUrl: "http://test:4096",
      feishuClient: {
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          msg: "ok",
          data: { message_id: "msg_1" },
        }),
        updateMessage: vi.fn().mockResolvedValue({ code: 0, msg: "ok" }),
      },
      logger: createMockLogger(),
      getChatForSession: vi.fn().mockReturnValue("chat_123"),
      seenInteractiveIds,
      interactiveCardRegistry: createMockInteractiveCardRegistry(),
      ...overrides,
    }
  }

  // ── Lifecycle ──

  describe("start/stop lifecycle", () => {
    it("start() logs and begins polling", () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Interactive poller started"),
      )
    })

    it("start() runs first poll immediately", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://test:4096/question",
        expect.anything(),
      )
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://test:4096/permission",
        expect.anything(),
      )
    })

    it("start() when already started is a no-op", () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      poller.start()

      const startCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: string[]) => c[0].includes("started"))
      expect(startCalls).toHaveLength(1)
    })

    it("stop() clears interval and logs", () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      poller.stop()

      expect(deps.logger.info).toHaveBeenCalledWith("Interactive poller stopped")
    })

    it("stop() when not started is safe", () => {
      const deps = createDeps()
      const poller = createInteractivePoller(deps)
      expect(() => poller.stop()).not.toThrow()
      expect(deps.logger.info).toHaveBeenCalledWith("Interactive poller stopped")
    })
  })

  // ── Question polling ──

  describe("pollQuestions", () => {
    it("sends card for pending question", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([SAMPLE_QUESTION]), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
        "chat_123",
        expect.objectContaining({ msg_type: "interactive" }),
      )
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("pending question q_1"),
      )
    })

    it("deduplicates already-seen question IDs", async () => {
      const deps = createDeps()
      deps.seenInteractiveIds.add(interactiveCardKey("question", "q_1"))
      globalThis.fetch = mockFetchPerUrl(okJson([SAMPLE_QUESTION]), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("skips question when no chatId for session", async () => {
      const deps = createDeps({
        getChatForSession: vi.fn().mockReturnValue(undefined),
      })
      globalThis.fetch = mockFetchPerUrl(okJson([SAMPLE_QUESTION]), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("skips question missing required fields", async () => {
      const deps = createDeps()
      const incomplete = [
        { id: "", sessionID: "ses_abc", questions: [] },
        { id: "q_2", sessionID: "", questions: [] },
        { id: "q_3", sessionID: "ses_abc", questions: "not_array" },
      ]
      globalThis.fetch = mockFetchPerUrl(okJson(incomplete), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles GET /question non-ok response", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(notOk(), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles GET /question network failure", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(new Error("ECONNREFUSED"), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles GET /question non-array JSON", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson({ not: "array" }), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles GET /question invalid JSON", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(badJson(), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("logs warning when sendMessage fails for question", async () => {
      const deps = createDeps()
      deps.feishuClient.sendMessage.mockRejectedValue(new Error("send failed"))
      globalThis.fetch = mockFetchPerUrl(okJson([SAMPLE_QUESTION]), okJson([]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(10)

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Poller question card send failed"),
      )
    })
  })

  // ── Permission polling ──

  describe("pollPermissions", () => {
    it("sends card for pending permission", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([SAMPLE_PERMISSION]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
        "chat_123",
        expect.objectContaining({ msg_type: "interactive" }),
      )
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("pending permission p_1"),
      )
    })

    it("deduplicates already-seen permission IDs", async () => {
      const deps = createDeps()
      deps.seenInteractiveIds.add(interactiveCardKey("permission", "p_1"))
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([SAMPLE_PERMISSION]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("skips permission when no chatId for session", async () => {
      const deps = createDeps({
        getChatForSession: vi.fn().mockReturnValue(undefined),
      })
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([SAMPLE_PERMISSION]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("skips permission missing id or sessionID", async () => {
      const deps = createDeps()
      const incomplete = [
        { id: "", sessionID: "ses_abc", permission: "bash", patterns: [], metadata: {} },
        { id: "p_2", sessionID: "", permission: "bash", patterns: [], metadata: {} },
      ]
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson(incomplete))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles GET /permission non-ok response", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([]), notOk())
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles GET /permission network failure", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([]), new Error("ECONNREFUSED"))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("uses joined patterns as permission title", async () => {
      const deps = createDeps()
      const perm = { ...SAMPLE_PERMISSION, patterns: ["/src/a.ts", "/src/b.ts"] }
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([perm]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      const calls = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.length).toBe(1)
      const card = JSON.parse(calls[0][1].content)
      // Real buildPermissionCard puts action.title in elements[0].text.content
      expect(card.elements[0].text.content).toBe("/src/a.ts, /src/b.ts")
    })

    it("falls back to permission type when patterns empty", async () => {
      const deps = createDeps()
      const perm = { ...SAMPLE_PERMISSION, patterns: [] }
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([perm]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      const calls = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.length).toBe(1)
      const card = JSON.parse(calls[0][1].content)
      expect(card.elements[0].text.content).toBe("file_edit")
    })

    it("logs warning when sendMessage fails for permission", async () => {
      const deps = createDeps()
      deps.feishuClient.sendMessage.mockRejectedValue(new Error("send failed"))
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([SAMPLE_PERMISSION]))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(10)

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Poller permission card send failed"),
      )
    })
  })

  // ── Cross-cutting ──

  describe("cross-cutting", () => {
    it("adds processed IDs to seenInteractiveIds", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(
        okJson([SAMPLE_QUESTION]),
        okJson([SAMPLE_PERMISSION]),
      )
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.seenInteractiveIds.has(interactiveCardKey("question", "q_1"))).toBe(true)
      expect(deps.seenInteractiveIds.has(interactiveCardKey("permission", "p_1"))).toBe(true)
    })

    it("polls again after 3s interval", async () => {
      const deps = createDeps()
      const fetchMock = mockFetchPerUrl(okJson([]), okJson([]))
      globalThis.fetch = fetchMock
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)
      const callsAfterFirst = fetchMock.mock.calls.length

      await advanceTimers(3000)
      expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)

      poller.stop()
    })

    it("stop prevents further polling", async () => {
      const deps = createDeps()
      const fetchMock = mockFetchPerUrl(okJson([]), okJson([]))
      globalThis.fetch = fetchMock
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)
      poller.stop()

      const callsAtStop = fetchMock.mock.calls.length
      await advanceTimers(10000)
      expect(fetchMock.mock.calls.length).toBe(callsAtStop)
    })

    it("updates tracked question cards once answered in TUI", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([SAMPLE_QUESTION]), okJson([]))
      const poller = createInteractivePoller(deps)

      poller.start()
      await advanceTimers(0)

      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([]))
      await advanceTimers(3000)

      expect(deps.feishuClient.updateMessage).toHaveBeenCalledWith(
        "msg_1",
        expect.any(String),
      )
      const updatedCard = JSON.parse(
        (deps.feishuClient.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][1],
      )
      expect(updatedCard.header.title.content).toContain("Already Answered")
      expect(updatedCard.elements[0].text.content).toContain("opencode TUI")
    })

    it("does not overwrite cards while a Feishu reply is resolving", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([SAMPLE_QUESTION]), okJson([]))
      const poller = createInteractivePoller(deps)

      poller.start()
      await advanceTimers(0)

      deps.interactiveCardRegistry.markFeishuResolving("question", "q_1")
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([]))
      await advanceTimers(3000)

      expect(deps.feishuClient.updateMessage).not.toHaveBeenCalled()
    })

    it("updates tracked permission cards once handled in TUI", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([SAMPLE_PERMISSION]))
      const poller = createInteractivePoller(deps)

      poller.start()
      await advanceTimers(0)

      globalThis.fetch = mockFetchPerUrl(okJson([]), okJson([]))
      await advanceTimers(3000)

      expect(deps.feishuClient.updateMessage).toHaveBeenCalledWith(
        "msg_1",
        expect.any(String),
      )
      const updatedCard = JSON.parse(
        (deps.feishuClient.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][1],
      )
      expect(updatedCard.header.title.content).toContain("Resolved")
      expect(updatedCard.elements[0].text.content).toContain("opencode TUI")
    })

    it("does not resolve question cards when the question endpoint failed", async () => {
      const deps = createDeps()
      globalThis.fetch = mockFetchPerUrl(okJson([SAMPLE_QUESTION]), okJson([]))
      const poller = createInteractivePoller(deps)

      poller.start()
      await advanceTimers(0)

      globalThis.fetch = mockFetchPerUrl(new Error("ECONNREFUSED"), okJson([]))
      await advanceTimers(3000)

      expect(deps.feishuClient.updateMessage).not.toHaveBeenCalled()
    })
  })
})
