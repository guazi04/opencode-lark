// ═══════════════════════════════════════════
// Sub-Agent Tracker
// Tracks sub-agent lifecycle and fetches child session details via REST API polling.
// ═══════════════════════════════════════════

import type { SubtaskDiscovered } from "./event-processor.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackedSubAgent {
  parentSessionId: string
  childSessionId?: string
  prompt: string
  description: string
  agent: string
  status: "discovering" | "active" | "completed" | "failed"
}

export interface MessageSummary {
  role: string
  text: string
  toolCalls?: string[]
}

export interface SubAgentTrackerOptions {
  serverUrl: string
  maxDepth?: number // default 1, max 1
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5
const BACKOFF_BASE_MS = 500

// ---------------------------------------------------------------------------
// SubAgentTracker
// ---------------------------------------------------------------------------

export class SubAgentTracker {
  private readonly serverUrl: string
  private readonly maxDepth: number
  private readonly tracked: TrackedSubAgent[] = []

  constructor(options: SubAgentTrackerOptions) {
    this.serverUrl = options.serverUrl
    this.maxDepth = Math.min(options.maxDepth ?? 1, 1)
  }

  /**
   * Register a newly-discovered sub-agent and start polling for its child session.
   * Returns the TrackedSubAgent immediately; status updates asynchronously.
   */
  async onSubtaskDiscovered(
    action: SubtaskDiscovered,
    depth: number = 1,
  ): Promise<TrackedSubAgent> {
    if (depth > this.maxDepth) {
      throw new Error(
        `Max sub-agent depth is ${this.maxDepth}; requested depth ${depth}`,
      )
    }

    const agent: TrackedSubAgent = {
      parentSessionId: action.sessionId,
      prompt: action.prompt,
      description: action.description,
      agent: action.agent,
      status: "discovering",
    }

    this.tracked.push(agent)

    // Fire-and-forget: poll for child session in background
    this.pollChildSession(action.sessionId)
      .then((childSessionId) => {
        if (childSessionId) {
          agent.childSessionId = childSessionId
          agent.status = "active"
        } else {
          agent.status = "failed"
        }
      })
      .catch(() => {
        agent.status = "failed"
      })

    return agent
  }

  /**
   * Poll `GET /session/{parentSessionId}/children` to find the child session.
   * Retries up to 5 times with exponential backoff: 500ms, 1s, 2s, 4s, 8s.
   */
  async pollChildSession(
    parentSessionId: string,
    retries: number = MAX_RETRIES,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(
          `${this.serverUrl}/session/${parentSessionId}/children`,
        )
        if (response.ok) {
          const children = (await response.json()) as Array<{
            id: string
            parentID: string
          }>
          if (children.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            return children[children.length - 1]!.id
          }
        }
      } catch {
        // Network error — will retry
      }

      // Don't sleep after the last attempt
      if (attempt < retries - 1) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt)
        await this.sleep(delay)
      }
    }

    return null
  }

  /**
   * Fetch messages from a child session.
   * GET /session/{childSessionId}/message?limit=N
   */
  async getChildMessages(
    childSessionId: string,
    limit: number = 20,
  ): Promise<MessageSummary[]> {
    try {
      const response = await fetch(
        `${this.serverUrl}/session/${childSessionId}/message?limit=${limit}`,
      )
      if (!response.ok) return []

      const messages = (await response.json()) as Array<{
        role?: string
        text?: string
        toolCalls?: Array<{ name?: string }>
      }>

      return messages.map((msg) => {
        const summary: MessageSummary = {
          role: msg.role ?? "unknown",
          text: msg.text ?? "",
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          summary.toolCalls = msg.toolCalls.map((tc) => tc.name ?? "unknown")
        }
        return summary
      })
    } catch {
      return []
    }
  }

  /**
   * Return all tracked sub-agents with current status.
   */
  getTrackedSubAgents(): TrackedSubAgent[] {
    return [...this.tracked]
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}