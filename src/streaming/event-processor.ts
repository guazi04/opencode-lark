// ═══════════════════════════════════════════
// SSE Event Processor
// Parses raw opencode SSE events into typed actions.
// ═══════════════════════════════════════════

// ---------------------------------------------------------------------------
// Output action types
// ---------------------------------------------------------------------------

export interface TextDelta {
  readonly type: "TextDelta"
  readonly sessionId: string
  readonly text: string
}

export interface ReasoningDelta {
  readonly type: "ReasoningDelta"
  readonly sessionId: string
  readonly text: string
}

export interface ToolStateChange {
  readonly type: "ToolStateChange"
  readonly sessionId: string
  readonly toolName: string
  readonly state: string
  readonly input?: Record<string, unknown>
  readonly output?: string
  readonly error?: string
  readonly title?: string
}

export interface SubtaskDiscovered {
  readonly type: "SubtaskDiscovered"
  readonly sessionId: string
  readonly prompt: string
  readonly description: string
  readonly agent: string
}

export interface SessionBusy {
  readonly type: "SessionBusy"
  readonly sessionId: string
}

export interface SessionIdle {
  readonly type: "SessionIdle"
  readonly sessionId: string
}

export type ProcessedAction =
  | ReasoningDelta
  | TextDelta
  | ToolStateChange
  | SubtaskDiscovered
  | SessionBusy
  | SessionIdle

// ---------------------------------------------------------------------------
// Input event shapes (from actual opencode SSE stream)
// ---------------------------------------------------------------------------

interface MessagePartUpdatedEvent {
  type: "message.part.updated"
  properties: {
    part: {
      id?: string
      sessionID: string
      messageID: string
      type: string

      text?: string

      tool?: string
      state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string }

      prompt?: string
      description?: string
      agent?: string
    }
    delta?: string
  }
}

// Streaming text delta — separate event type from message.part.updated
interface MessagePartDeltaEvent {
  type: "message.part.delta"
  properties: {
    sessionID: string
    messageID: string
    partID: string
    field: string
    delta: string
  }
}

interface SessionStatusEvent {
  type: "session.status"
  properties: {
    sessionID: string
    status: { type: string }
  }
}

interface SessionIdleEvent {
  type: "session.idle"
  properties: {
    sessionID: string
  }
}

type KnownEvent =
  | MessagePartUpdatedEvent
  | MessagePartDeltaEvent
  | SessionStatusEvent
  | SessionIdleEvent

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object"
}

function hasType(v: unknown): v is { type: string } {
  return isObject(v) && typeof v.type === "string"
}

const KNOWN_TYPES = new Set([
  "message.part.updated",
  "message.part.delta",
  "session.status",
  "session.idle",
])

function isKnownEvent(v: unknown): v is KnownEvent {
  if (!hasType(v)) return false
  return KNOWN_TYPES.has(v.type)
}

// ---------------------------------------------------------------------------
// EventProcessor
// ---------------------------------------------------------------------------

export interface EventProcessorOptions {
  ownedSessions: Set<string>
}

export class EventProcessor {
  private readonly ownedSessions: Set<string>
  private readonly reasoningPartIds = new Set<string>()

  constructor(options: EventProcessorOptions) {
    this.ownedSessions = options.ownedSessions
  }

  processEvent(raw: unknown): ProcessedAction | null {
    try {
      if (!isKnownEvent(raw)) return null

      switch (raw.type) {
        case "message.part.updated":
          return this.processMessagePartUpdated(raw)
        case "message.part.delta":
          return this.processMessagePartDelta(raw)
        case "session.status":
          return this.processSessionStatus(raw)
        case "session.idle":
          return this.processSessionIdle(raw)
        default:
          return null
      }
    } catch {

      return null
    }
  }

  // -------------------------------------------------------------------------
  // Private handlers
  // -------------------------------------------------------------------------

  private processMessagePartUpdated(
    event: MessagePartUpdatedEvent,
  ): ProcessedAction | null {
    const { part, delta } = event.properties
    if (!part || !isObject(part)) return null

    const sessionId = (part as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null

    const partType = (part as Record<string, unknown>).type
    if (typeof partType !== "string") return null

    // Track reasoning part IDs so message.part.delta events can be filtered
    const partId = (part as Record<string, unknown>).id
    if (partType === "reasoning" && typeof partId === "string") {
      this.reasoningPartIds.add(partId)
    }

    switch (partType) {
      case "text":
        return this.processTextPart(sessionId, delta)
      case "reasoning":
        return this.processReasoningPart(sessionId, delta)
      case "tool":
        return this.processToolPart(sessionId, part)
      case "subtask":
        return this.processSubtaskPart(sessionId, part)
      default:
        return null
    }
  }

  private processMessagePartDelta(
    event: MessagePartDeltaEvent,
  ): TextDelta | ReasoningDelta | null {
    const props = event.properties
    if (!isObject(props)) return null

    const sessionId = (props as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null

    const field = (props as Record<string, unknown>).field
    if (field !== "text") return null

    const delta = (props as Record<string, unknown>).delta
    if (typeof delta !== "string" || delta.length === 0) return null

    // Check if this delta belongs to a reasoning part
    const partID = (props as Record<string, unknown>).partID
    if (typeof partID === "string" && this.reasoningPartIds.has(partID)) {
      return { type: "ReasoningDelta", sessionId, text: delta }
    }

    return { type: "TextDelta", sessionId, text: delta }
  }

  private processTextPart(
    sessionId: string,
    delta: string | undefined,
  ): TextDelta | null {
    if (typeof delta !== "string" || delta.length === 0) return null
    return { type: "TextDelta", sessionId, text: delta }
  }

  private processReasoningPart(
    sessionId: string,
    delta: string | undefined,
  ): ReasoningDelta | null {
    if (typeof delta !== "string" || delta.length === 0) return null
    return { type: "ReasoningDelta", sessionId, text: delta }
  }

  private processToolPart(
    sessionId: string,
    part: MessagePartUpdatedEvent["properties"]["part"],
  ): ToolStateChange | null {
    const toolName = part.tool
    const state = part.state
    if (typeof toolName !== "string" || !isObject(state)) return null
    const status = (state as Record<string, unknown>).status
    if (typeof status !== "string") return null

    const error = (state as Record<string, unknown>).error
    const title = (state as Record<string, unknown>).title
    const input = (state as Record<string, unknown>).input
    const output = (state as Record<string, unknown>).output
    const result: ToolStateChange = {
      type: "ToolStateChange",
      sessionId,
      toolName,
      state: status,
      ...(isObject(input) ? { input: input as Record<string, unknown> } : {}),
      ...(typeof output === "string" ? { output } : {}),
      ...(typeof error === "string" ? { error } : {}),
      ...(typeof title === "string" ? { title } : {}),
    }
    return result
  }

  private processSubtaskPart(
    sessionId: string,
    part: MessagePartUpdatedEvent["properties"]["part"],
  ): SubtaskDiscovered | null {
    const { prompt, description, agent } = part
    if (
      typeof prompt !== "string" ||
      typeof description !== "string" ||
      typeof agent !== "string"
    ) {
      return null
    }
    return { type: "SubtaskDiscovered", sessionId, prompt, description, agent }
  }

  private processSessionStatus(
    event: SessionStatusEvent,
  ): SessionBusy | SessionIdle | null {
    const props = event.properties
    if (!isObject(props)) return null

    const sessionId = (props as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null

    const status = props.status
    if (!isObject(status)) return null

    const statusType = (status as Record<string, unknown>).type
    if (typeof statusType !== "string") return null

    switch (statusType) {
      case "busy":
        return { type: "SessionBusy", sessionId }
      case "idle":
        return { type: "SessionIdle", sessionId }
      default:
        return null
    }
  }

  private processSessionIdle(
    event: SessionIdleEvent,
  ): SessionIdle | null {
    const props = event.properties
    if (!isObject(props)) return null

    const sessionId = (props as Record<string, unknown>).sessionID
    if (typeof sessionId !== "string") return null
    if (!this.ownedSessions.has(sessionId)) return null

    return { type: "SessionIdle", sessionId }
  }
}
