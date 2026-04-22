// ═══════════════════════════════════════════
// Interactive Poller
// Polls opencode for pending questions/permissions
// as a reliable fallback when SSE events don't arrive.
// ═══════════════════════════════════════════

import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import type { QuestionAsked, PermissionRequested } from "../streaming/event-processor.js"
import { buildQuestionCard, buildPermissionCard } from "./streaming-integration.js"
import type { ExpiringSet } from "../utils/expiring-set.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import {
  extractFeishuMessageId,
  interactiveCardKey,
} from "../feishu/interactive-card-registry.js"
import {
  buildAnsweredPermissionCard,
  buildAnsweredQuestionCard,
} from "../feishu/interactive-card-response.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractivePollerDeps {
  serverUrl: string
  feishuClient: Pick<FeishuApiClient, "sendMessage" | "updateMessage">
  logger: Logger
  getChatForSession: (sessionId: string) => string | undefined
  /** Shared dedup set — IDs added here are also checked by SSE handlers */
  seenInteractiveIds: ExpiringSet<string>
  interactiveCardRegistry?: InteractiveCardRegistry
}

export interface InteractivePoller {
  start(): void
  stop(): void
}

/** Shape returned by GET /question */
interface PendingQuestion {
  id: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
}

/** Shape returned by GET /permission */
interface PendingPermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000
const FETCH_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInteractivePoller(
  deps: InteractivePollerDeps,
): InteractivePoller {
  const { serverUrl, feishuClient, logger, getChatForSession, seenInteractiveIds } = deps
  let timer: ReturnType<typeof setInterval> | null = null

  async function poll(): Promise<void> {
    try {
      const [pendingQuestions, pendingPermissions] = await Promise.all([
        pollQuestions(),
        pollPermissions(),
      ])
      await resolveAnsweredCards(pendingQuestions, pendingPermissions)
    } catch {
      // Individual poll methods handle their own errors
    }
  }

  async function pollQuestions(): Promise<Set<string> | null> {
    let resp: Response
    try {
      resp = await fetch(`${serverUrl}/question`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      return null
    }
    if (!resp.ok) return null

    let questions: unknown
    try {
      questions = await resp.json()
    } catch {
      return null
    }
    if (!Array.isArray(questions)) return null

    const pendingIds = new Set<string>()

    for (const q of questions as PendingQuestion[]) {
      if (!q.id || !q.sessionID || !Array.isArray(q.questions)) continue
      pendingIds.add(q.id)
      const cardKey = interactiveCardKey("question", q.id)
      if (seenInteractiveIds.has(cardKey)) continue

      const chatId = getChatForSession(q.sessionID)
      if (!chatId) continue
      if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("question", q.id)) continue

      logger.info(
        `Poller: pending question ${q.id} for session ${q.sessionID}`,
      )

      const action: QuestionAsked = {
        type: "QuestionAsked",
        sessionId: q.sessionID,
        requestId: q.id,
        questions: q.questions,
      }
      const card = buildQuestionCard(action)
      feishuClient
        .sendMessage(chatId, {
          msg_type: "interactive",
          content: JSON.stringify(card),
        })
        .then((response) => {
          const messageId = extractFeishuMessageId(response)
          if (!messageId) {
            deps.interactiveCardRegistry?.failDispatch("question", q.id)
            return
          }
          seenInteractiveIds.add(cardKey)
          deps.interactiveCardRegistry?.track({
            requestId: q.id,
            kind: "question",
            chatId,
            messageId,
          })
        })
        .catch((err) => {
          deps.interactiveCardRegistry?.failDispatch("question", q.id)
          logger.warn(`Poller question card send failed: ${err}`)
        })
    }

    return pendingIds
  }

  async function pollPermissions(): Promise<Set<string> | null> {
    let resp: Response
    try {
      resp = await fetch(`${serverUrl}/permission`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      return null
    }
    if (!resp.ok) return null

    let permissions: unknown
    try {
      permissions = await resp.json()
    } catch {
      return null
    }
    if (!Array.isArray(permissions)) return null

    const pendingIds = new Set<string>()

    for (const p of permissions as PendingPermission[]) {
      if (!p.id || !p.sessionID) continue
      pendingIds.add(p.id)
      const cardKey = interactiveCardKey("permission", p.id)
      if (seenInteractiveIds.has(cardKey)) continue

      const chatId = getChatForSession(p.sessionID)
      if (!chatId) continue
      if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("permission", p.id)) continue

      logger.info(
        `Poller: pending permission ${p.id} for session ${p.sessionID}`,
      )

      const patternList = Array.isArray(p.patterns)
        ? p.patterns.filter((s): s is string => typeof s === "string")
        : []

      const action: PermissionRequested = {
        type: "PermissionRequested",
        sessionId: p.sessionID,
        requestId: p.id,
        permissionType: p.permission ?? "unknown",
        title: patternList.length > 0 ? patternList.join(", ") : (p.permission ?? "Permission"),
        metadata: p.metadata ?? {},
      }
      const card = buildPermissionCard(action)
      feishuClient
        .sendMessage(chatId, {
          msg_type: "interactive",
          content: JSON.stringify(card),
        })
        .then((response) => {
          const messageId = extractFeishuMessageId(response)
          if (!messageId) {
            deps.interactiveCardRegistry?.failDispatch("permission", p.id)
            return
          }
          seenInteractiveIds.add(cardKey)
          deps.interactiveCardRegistry?.track({
            requestId: p.id,
            kind: "permission",
            chatId,
            messageId,
          })
        })
        .catch((err) => {
          deps.interactiveCardRegistry?.failDispatch("permission", p.id)
          logger.warn(`Poller permission card send failed: ${err}`)
        })
    }

    return pendingIds
  }

  async function resolveAnsweredCards(
    pendingQuestions: Set<string> | null,
    pendingPermissions: Set<string> | null,
  ): Promise<void> {
    const trackedCards = deps.interactiveCardRegistry?.list() ?? []
    if (trackedCards.length === 0) return

    for (const card of trackedCards) {
      if (card.state !== "sent") continue
      if (card.kind === "question") {
        if (!pendingQuestions || pendingQuestions.has(card.requestId)) continue
      } else if (!pendingPermissions || pendingPermissions.has(card.requestId)) {
        continue
      }

      const resolvedCard = card.kind === "question"
        ? buildAnsweredQuestionCard()
        : buildAnsweredPermissionCard()

      try {
        const response = await feishuClient.updateMessage(
          card.messageId,
          JSON.stringify(resolvedCard),
        )
        if (response.code === 0) {
          deps.interactiveCardRegistry?.untrack(card.kind, card.requestId)
          logger.info(
            `Poller: marked ${card.kind} ${card.requestId} as answered in TUI`,
          )
        }
      } catch (err) {
        logger.warn(
          `Poller ${card.kind} card update failed for ${card.requestId}: ${err}`,
        )
      }
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        poll()
      }, POLL_INTERVAL_MS)
      logger.info(`Interactive poller started (interval=${POLL_INTERVAL_MS}ms)`)
      // Run first poll immediately
      poll()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      logger.info("Interactive poller stopped")
    },
  }
}
