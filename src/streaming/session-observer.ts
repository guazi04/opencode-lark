// ═══════════════════════════════════════════
// Session Observer
// Observes opencode sessions and forwards TUI-initiated
// messages to Feishu chats.
// ═══════════════════════════════════════════

import type { EventProcessor } from "./event-processor.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import { buildQuestionCard, buildPermissionCard, buildFinalResponseCard } from "../handler/streaming-integration.js"
import type { ExpiringSet } from "../utils/expiring-set.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import {
  extractFeishuMessageId,
  interactiveCardKey,
} from "../feishu/interactive-card-registry.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionObserverDeps {
  feishuClient: Pick<FeishuApiClient, "sendMessage">
  eventProcessor: EventProcessor
  addListener: (sessionId: string, fn: (event: unknown) => void) => void
  removeListener: (sessionId: string, fn: (event: unknown) => void) => void
  logger: Logger
  seenInteractiveIds: ExpiringSet<string>
  interactiveCardRegistry?: InteractiveCardRegistry
}

export interface SessionObserver {
  observe(sessionId: string, chatId: string): void
  markOwned(messageId: string): void
  markSessionBusy(sessionId: string): void
  markSessionFree(sessionId: string): void
  getChatForSession(sessionId: string): string | undefined
  stop(): void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessageId(rawEvent: unknown): string | undefined {
  if (rawEvent === null || typeof rawEvent !== "object") return undefined
  const props = (rawEvent as Record<string, unknown>).properties
  if (!props || typeof props !== "object") return undefined
  const p = props as Record<string, unknown>
  // message.part.updated  → properties.part.messageID
  // message.part.delta    → properties.messageID
  const part = p.part
  if (part && typeof part === "object") {
    const mid = (part as Record<string, unknown>).messageID
    if (typeof mid === "string") return mid
  }
  const mid = p.messageID
  if (typeof mid === "string") return mid
  return undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionObserver(
  deps: SessionObserverDeps,
): SessionObserver {
  const { feishuClient, eventProcessor, addListener, removeListener, logger, seenInteractiveIds } =
    deps

  // Feishu-initiated message IDs — skip these in forwarding
  const knownMessageIds = new Set<string>()
  // Sessions with an active streaming bridge — skip TextDelta/SessionIdle
  const busySessions = new Set<string>()
  // Per-messageId text accumulation with TTL tracking
  const textBuffers = new Map<string, { text: string; lastUpdated: number }>()
  // Periodic cleanup of stale text buffers (every 5 minutes, evict buffers older than 30 minutes)
  const BUFFER_TTL_MS = 30 * 60 * 1000
  const bufferCleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [messageId, entry] of textBuffers) {
      if (now - entry.lastUpdated > BUFFER_TTL_MS) {
        textBuffers.delete(messageId)
        logger.info(`Evicted stale text buffer for messageId=${messageId}`)
      }
    }
  }, 5 * 60 * 1000)
  // Active observation state per session
  const observedSessions = new Map<
    string,
    { chatId: string; listener: (event: unknown) => void }
  >()

  function flushBuffers(chatId: string): void {
    for (const [messageId, entry] of textBuffers) {
      if (entry.text.trim().length === 0) continue
      const card = buildFinalResponseCard(entry.text)
      feishuClient
        .sendMessage(chatId, {
          msg_type: "interactive",
          content: JSON.stringify(card),
        })
        .catch((err) => {
          logger.error(`Failed to send TUI message for ${messageId}: ${err}`)
        })
    }
    textBuffers.clear()
  }

  return {
    observe(sessionId: string, chatId: string): void {
      if (observedSessions.has(sessionId)) return
      const listener = (rawEvent: unknown): void => {
        const action = eventProcessor.processEvent(rawEvent)
        if (!action) return

        // Skip all TextDelta/SessionIdle for sessions handled by streaming bridge
        if (busySessions.has(action.sessionId)) return

        const messageId = extractMessageId(rawEvent)

        // Skip events belonging to Feishu-initiated messages
        if (messageId && knownMessageIds.has(messageId)) return

        switch (action.type) {
          case "TextDelta": {
            if (!messageId) break
            const current = textBuffers.get(messageId)
            const text = (current?.text ?? "") + action.text
            textBuffers.set(messageId, { text, lastUpdated: Date.now() })
            break
          }
          case "SessionIdle": {
            flushBuffers(chatId)
            break
          }
          case "QuestionAsked": {
            const cardKey = interactiveCardKey("question", action.requestId)
            if (seenInteractiveIds.has(cardKey)) break
            if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("question", action.requestId)) {
              break
            }
            logger.info(`Question event received in observer for chat ${chatId}, requestId=${action.requestId}`)
            const questionCard = buildQuestionCard(action)
            feishuClient
              .sendMessage(chatId, {
                msg_type: "interactive",
                content: JSON.stringify(questionCard),
              })
              .then((response) => {
                const messageId = extractFeishuMessageId(response)
                if (!messageId) {
                  deps.interactiveCardRegistry?.failDispatch("question", action.requestId)
                  return
                }
                seenInteractiveIds.add(cardKey)
                deps.interactiveCardRegistry?.track({
                  requestId: action.requestId,
                  kind: "question",
                  chatId,
                  messageId,
                })
              })
              .catch((err) => {
                deps.interactiveCardRegistry?.failDispatch("question", action.requestId)
                logger.warn(`Question card send failed (observer): ${err}`)
              })
            break
          }
          case "PermissionRequested": {
            const cardKey = interactiveCardKey("permission", action.requestId)
            if (seenInteractiveIds.has(cardKey)) break
            if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("permission", action.requestId)) {
              break
            }
            logger.info(`Permission event received in observer for chat ${chatId}, requestId=${action.requestId}`)
            const permissionCard = buildPermissionCard(action)
            feishuClient
              .sendMessage(chatId, {
                msg_type: "interactive",
                content: JSON.stringify(permissionCard),
              })
              .then((response) => {
                const messageId = extractFeishuMessageId(response)
                if (!messageId) {
                  deps.interactiveCardRegistry?.failDispatch("permission", action.requestId)
                  return
                }
                seenInteractiveIds.add(cardKey)
                deps.interactiveCardRegistry?.track({
                  requestId: action.requestId,
                  kind: "permission",
                  chatId,
                  messageId,
                })
              })
              .catch((err) => {
                deps.interactiveCardRegistry?.failDispatch("permission", action.requestId)
                logger.warn(`Permission card send failed (observer): ${err}`)
              })
            break
          }
          default:
            // ToolStateChange, SubtaskDiscovered — ignored
            break
        }
      }

      addListener(sessionId, listener)
      observedSessions.set(sessionId, { chatId, listener })
      logger.info(`Observing session ${sessionId} for chat ${chatId}`)
    },

    markOwned(messageId: string): void {
      knownMessageIds.add(messageId)
      // Drop any buffered text for this message
      textBuffers.delete(messageId)
    },

    markSessionBusy(sessionId: string): void {
      busySessions.add(sessionId)
    },

    markSessionFree(sessionId: string): void {
      busySessions.delete(sessionId)
      // Drop any text that may have been buffered before busy was set
      textBuffers.clear()
    },

    getChatForSession(sessionId: string): string | undefined {
      return observedSessions.get(sessionId)?.chatId
    },

    stop(): void {
      clearInterval(bufferCleanupTimer)
      for (const [sessionId, { listener }] of observedSessions) {
        removeListener(sessionId, listener)
      }
      observedSessions.clear()
      textBuffers.clear()
      knownMessageIds.clear()
      busySessions.clear()
      logger.info("Session observer stopped")
    },
  }
}
