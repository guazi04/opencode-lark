// ═══════════════════════════════════════════
// Interactive Poller
// Polls opencode for pending questions/permissions
// as a reliable fallback when SSE events don't arrive.
// ═══════════════════════════════════════════

import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import type { QuestionAsked, PermissionRequested } from "../streaming/event-processor.js"
import { buildQuestionCard, buildPermissionCard } from "./streaming-integration.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractivePollerDeps {
  serverUrl: string
  feishuClient: Pick<FeishuApiClient, "sendMessage">
  logger: Logger
  getChatForSession: (sessionId: string) => string | undefined
  /** Shared dedup set — IDs added here are also checked by SSE handlers */
  seenInteractiveIds: Set<string>
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
      await Promise.all([pollQuestions(), pollPermissions()])
    } catch {
      // Individual poll methods handle their own errors
    }
  }

  async function pollQuestions(): Promise<void> {
    let resp: Response
    try {
      resp = await fetch(`${serverUrl}/question`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      return // Network error, will retry next interval
    }
    if (!resp.ok) return

    let questions: unknown
    try {
      questions = await resp.json()
    } catch {
      return
    }
    if (!Array.isArray(questions)) return

    for (const q of questions as PendingQuestion[]) {
      if (!q.id || !q.sessionID || !Array.isArray(q.questions)) continue
      if (seenInteractiveIds.has(q.id)) continue
      seenInteractiveIds.add(q.id)

      const chatId = getChatForSession(q.sessionID)
      if (!chatId) continue

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
        .catch((err) => {
          logger.warn(`Poller question card send failed: ${err}`)
        })
    }
  }

  async function pollPermissions(): Promise<void> {
    let resp: Response
    try {
      resp = await fetch(`${serverUrl}/permission`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      return
    }
    if (!resp.ok) return

    let permissions: unknown
    try {
      permissions = await resp.json()
    } catch {
      return
    }
    if (!Array.isArray(permissions)) return

    for (const p of permissions as PendingPermission[]) {
      if (!p.id || !p.sessionID) continue
      if (seenInteractiveIds.has(p.id)) continue
      seenInteractiveIds.add(p.id)

      const chatId = getChatForSession(p.sessionID)
      if (!chatId) continue

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
        .catch((err) => {
          logger.warn(`Poller permission card send failed: ${err}`)
        })
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
