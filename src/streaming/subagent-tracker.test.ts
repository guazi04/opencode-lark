import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  SubAgentTracker,
  type TrackedSubAgent,
  type MessageSummary,
} from "./subagent-tracker.js"
import type { SubtaskDiscovered } from "./event-processor.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_URL = "http://127.0.0.1:4096"

function makeAction(overrides?: Partial<SubtaskDiscovered>): SubtaskDiscovered {
  return {
    type: "SubtaskDiscovered",
    sessionId: "ses-parent",
    prompt: "Fix the bug",
    description: "Investigate and fix",
    agent: "explore",
    ...overrides,
  }
}

function mockFetchResponse(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  })
}

function mockFetchSequence(responses: Array<{ body: unknown; ok?: boolean }>) {
  const fn = vi.fn()
  for (const [i, resp] of responses.entries()) {
    fn.mockResolvedValueOnce({
      ok: resp.ok ?? true,
      json: async () => resp.body,
    })
  }
  return fn
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubAgentTracker", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  // 1. Child found on 1st poll → discovering → active
  it("transitions discovering → active when child found on 1st poll", async () => {
    globalThis.fetch = mockFetchResponse([
      { id: "ses-child-1", parentID: "ses-parent" },
    ])

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })
    const agent = await tracker.onSubtaskDiscovered(makeAction())

    expect(agent.status).toBe("discovering")
    expect(agent.parentSessionId).toBe("ses-parent")

    // Let the background poll resolve
    await vi.runAllTimersAsync()

    expect(agent.status).toBe("active")
    expect(agent.childSessionId).toBe("ses-child-1")
  })

  // 2. Child found on 2nd poll → retry works
  it("finds child on 2nd poll after retry", async () => {
    globalThis.fetch = mockFetchSequence([
      { body: [] },  // 1st attempt: empty
      { body: [{ id: "ses-child-2", parentID: "ses-parent" }] },  // 2nd attempt: found
    ])

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })
    const agent = await tracker.onSubtaskDiscovered(makeAction())

    // Let all timers and promises resolve
    await vi.runAllTimersAsync()

    expect(agent.status).toBe("active")
    expect(agent.childSessionId).toBe("ses-child-2")
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  // 3. Child not found after 5 retries → failed
  it("status becomes failed after 5 retries with no child", async () => {
    globalThis.fetch = mockFetchResponse([]) // always empty

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })
    const agent = await tracker.onSubtaskDiscovered(makeAction())

    // Advance through all 5 retries with backoff timers
    await vi.runAllTimersAsync()

    expect(agent.status).toBe("failed")
    expect(agent.childSessionId).toBeUndefined()
    expect(globalThis.fetch).toHaveBeenCalledTimes(5)
  })

  // 4. getChildMessages returns formatted messages
  it("getChildMessages returns formatted messages", async () => {
    globalThis.fetch = mockFetchResponse([
      { role: "user", text: "Hello" },
      {
        role: "assistant",
        text: "Hi there",
        toolCalls: [{ name: "readFile" }, { name: "writeFile" }],
      },
    ])

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })
    const messages = await tracker.getChildMessages("ses-child-1")

    expect(messages).toEqual<MessageSummary[]>([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there", toolCalls: ["readFile", "writeFile"] },
    ])
  })

  // 5. getChildMessages with empty response → empty array
  it("getChildMessages returns empty array for empty response", async () => {
    globalThis.fetch = mockFetchResponse([])

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })
    const messages = await tracker.getChildMessages("ses-child-1")

    expect(messages).toEqual([])
  })

  // 6. Max depth enforcement: depth > 1 rejected
  it("rejects depth > 1 (no grandchild support)", async () => {
    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })

    await expect(
      tracker.onSubtaskDiscovered(makeAction(), 2),
    ).rejects.toThrow("Max sub-agent depth is 1")
  })

  // 7. Multiple sub-agents tracked simultaneously
  it("tracks multiple sub-agents simultaneously", async () => {
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++
      // First sub-agent's poll finds child immediately
      // Second sub-agent's poll also finds child immediately
      return {
        ok: true,
        json: async () => [{ id: `ses-child-${callCount}`, parentID: "ses-parent" }],
      }
    })

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })

    const agent1 = await tracker.onSubtaskDiscovered(
      makeAction({ prompt: "Task 1" }),
    )
    const agent2 = await tracker.onSubtaskDiscovered(
      makeAction({ prompt: "Task 2" }),
    )

    await vi.runAllTimersAsync()

    const tracked = tracker.getTrackedSubAgents()
    expect(tracked).toHaveLength(2)
    expect(tracked[0]!.prompt).toBe("Task 1")
    expect(tracked[1]!.prompt).toBe("Task 2")
    expect(tracked[0]!.status).toBe("active")
    expect(tracked[1]!.status).toBe("active")
  })

  // 8. getTrackedSubAgents returns all tracked agents (snapshot, not reference)
  it("getTrackedSubAgents returns all agents as a copy", async () => {
    globalThis.fetch = mockFetchResponse([])

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })
    await tracker.onSubtaskDiscovered(makeAction({ prompt: "A" }))
    await tracker.onSubtaskDiscovered(makeAction({ prompt: "B" }))

    const agents = tracker.getTrackedSubAgents()
    expect(agents).toHaveLength(2)
    expect(agents[0]!.prompt).toBe("A")
    expect(agents[1]!.prompt).toBe("B")

    // Verify it's a copy
    agents.push({} as TrackedSubAgent)
    expect(tracker.getTrackedSubAgents()).toHaveLength(2)
  })

  // 9. pollChildSession uses correct URL
  it("pollChildSession calls correct REST endpoint", async () => {
    globalThis.fetch = mockFetchResponse([
      { id: "child-abc", parentID: "parent-xyz" },
    ])

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })
    const result = await tracker.pollChildSession("parent-xyz")

    expect(result).toBe("child-abc")
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${SERVER_URL}/session/parent-xyz/children`,
    )
  })

  // 10. getChildMessages handles fetch failure gracefully
  it("getChildMessages returns empty array on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"))

    const tracker = new SubAgentTracker({ serverUrl: SERVER_URL })
    const messages = await tracker.getChildMessages("ses-child-1")

    expect(messages).toEqual([])
  })

  // 11. maxDepth capped at 1 even if higher value provided
  it("maxDepth option capped at 1", async () => {
    const tracker = new SubAgentTracker({
      serverUrl: SERVER_URL,
      maxDepth: 5,
    })

    // depth=1 should still work
    globalThis.fetch = mockFetchResponse([])
    const agent = await tracker.onSubtaskDiscovered(makeAction(), 1)
    expect(agent).toBeDefined()

    // depth=2 should still be rejected (maxDepth capped to 1)
    await expect(
      tracker.onSubtaskDiscovered(makeAction(), 2),
    ).rejects.toThrow("Max sub-agent depth is 1")
  })
})