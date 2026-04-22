import type { FeishuApiResponse } from "../types.js"

export type InteractiveCardKind = "question" | "permission"
export type InteractiveCardState = "dispatching" | "sent" | "resolving_feishu"

export interface TrackedInteractiveCard {
  requestId: string
  kind: InteractiveCardKind
  chatId: string
  messageId: string
  trackedAt: number
  state: InteractiveCardState
}

export interface InteractiveCardRegistry {
  beginDispatch(kind: InteractiveCardKind, requestId: string): boolean
  failDispatch(kind: InteractiveCardKind, requestId: string): boolean
  track(card: Omit<TrackedInteractiveCard, "trackedAt" | "state">): void
  markFeishuResolving(kind: InteractiveCardKind, requestId: string): void
  clearFeishuResolving(kind: InteractiveCardKind, requestId: string): void
  untrack(kind: InteractiveCardKind, requestId: string): boolean
  list(): TrackedInteractiveCard[]
  close(): void
}

const DEFAULT_TTL_MS = 30 * 60 * 1000
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000

export function createInteractiveCardRegistry(
  ttlMs = DEFAULT_TTL_MS,
): InteractiveCardRegistry {
  const cards = new Map<string, TrackedInteractiveCard>()

  const cleanupExpired = (now = Date.now()): void => {
    for (const [requestId, card] of cards.entries()) {
      if (now - card.trackedAt > ttlMs) {
        cards.delete(requestId)
      }
    }
  }

  const cleanupTimer = setInterval(() => {
    cleanupExpired()
  }, CLEANUP_INTERVAL_MS)

  return {
    beginDispatch(kind, requestId) {
      cleanupExpired()
      const key = interactiveCardKey(kind, requestId)
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
    },

    failDispatch(kind, requestId) {
      const key = interactiveCardKey(kind, requestId)
      const current = cards.get(key)
      if (!current || current.state !== "dispatching") return false
      cards.delete(key)
      return true
    },

    track(card) {
      const key = interactiveCardKey(card.kind, card.requestId)
      cleanupExpired()
      cards.set(key, {
        ...card,
        trackedAt: Date.now(),
        state: "sent",
      })
    },

    markFeishuResolving(kind, requestId) {
      const key = interactiveCardKey(kind, requestId)
      const current = cards.get(key)
      if (!current || current.state !== "sent") return
      cards.set(key, {
        ...current,
        state: "resolving_feishu",
      })
    },

    clearFeishuResolving(kind, requestId) {
      const key = interactiveCardKey(kind, requestId)
      const current = cards.get(key)
      if (!current || current.state !== "resolving_feishu") return
      cards.set(key, {
        ...current,
        state: "sent",
      })
    },

    untrack(kind, requestId) {
      return cards.delete(interactiveCardKey(kind, requestId))
    },

    list() {
      cleanupExpired()
      return Array.from(cards.values())
    },

    close() {
      clearInterval(cleanupTimer)
      cards.clear()
    },
  }
}

export function interactiveCardKey(
  kind: InteractiveCardKind,
  requestId: string,
): string {
  return `${kind}:${requestId}`
}

export function extractFeishuMessageId(
  response: FeishuApiResponse | undefined,
): string | undefined {
  if (!response?.data || typeof response.data !== "object") return undefined
  const messageId = (response.data as Record<string, unknown>).message_id
  return typeof messageId === "string" && messageId.length > 0
    ? messageId
    : undefined
}
