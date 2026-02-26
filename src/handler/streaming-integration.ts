
import type { CardKitClient } from "../feishu/cardkit-client.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { EventProcessor } from "../streaming/event-processor.js"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { addListener, removeListener } from "../utils/event-listeners.js"
import { StreamingCardSession } from "../streaming/streaming-card.js"

// ── Types ──

export interface StreamingBridgeDeps {
  cardkitClient: CardKitClient
  feishuClient: FeishuApiClient
  subAgentTracker: SubAgentTracker
  logger: Logger
}

export interface StreamingBridge {
  handleMessage(
    chatId: string,
    sessionId: string,
    eventListeners: EventListenerMap,
    eventProcessor: EventProcessor,
    sendMessage: () => Promise<string>,
    onComplete: (text: string) => void,
    messageId: string,
    reactionId: string | null,
  ): Promise<void>
}

// ── Constants ──


const FIRST_EVENT_TIMEOUT_MS = 15_000

// ── Factory ──

export function createStreamingBridge(
  deps: StreamingBridgeDeps,
): StreamingBridge {
  const { cardkitClient, feishuClient, subAgentTracker, logger } = deps

  return {
    async handleMessage(
      chatId: string,
      sessionId: string,
      eventListeners: EventListenerMap,
      eventProcessor: EventProcessor,
      sendMessage: () => Promise<string>,
      onComplete: (text: string) => void,
      messageId: string,
      reactionId: string | null,
    ): Promise<void> {
      let card: StreamingCardSession | null = null
      let cardStartPromise: Promise<void> | null = null

      const ensureCard = (): void => {
        if (card || cardStartPromise) return
        card = new StreamingCardSession({
          cardkitClient,
          feishuClient,
          chatId,
        })
        cardStartPromise = card.start().then(() => {
          logger.info(
            `Streaming card started for session ${sessionId} in chat ${chatId}`,
          )
        })
      }

      return new Promise<void>((resolve, reject) => {
        let textBuffer = ""
        let gotFirstEvent = false
        let settled = false
        let syncResponseBody = ""
        // Helper: send text reply and clean up reaction
        const sendFinalResponse = async (text: string): Promise<void> => {
          await feishuClient.replyMessage(messageId, {
            msg_type: "text",
            content: JSON.stringify({ text }),
          })
          if (reactionId) {
            try {
              await feishuClient.deleteReaction(messageId, reactionId)
            } catch (err) {
              logger.warn(`deleteReaction failed: ${err}`)
            }
          }
        }

        // Named listener reference — stored for removeListener calls
        const myListener = (rawEvent: unknown): void => {
          const action = eventProcessor.processEvent(rawEvent)
          if (!action) return
          if (action.sessionId !== sessionId) return

          gotFirstEvent = true

          switch (action.type) {
            case "TextDelta": {
              textBuffer += action.text
              if (textBuffer.length > 102_400) {
                textBuffer = textBuffer.slice(0, 102_400) + "\n\n…(内容过长，已截断)"
              }
              break
            }



            case "ToolStateChange":
              ensureCard()
              if (cardStartPromise) {
                cardStartPromise.then(() => {
                  card!
                    .setToolStatus(
                      action.toolName,
                      action.state as "running" | "completed" | "error",
                      action.title,
                    )
                    .catch((err) => {
                      logger.warn(`setToolStatus failed: ${err}`)
                    })
                }).catch((err) => {
                  logger.warn(`card start for tool failed: ${err}`)
                })
              }
              break

            case "SubtaskDiscovered": {
              subAgentTracker
                .onSubtaskDiscovered(action)
                .then((tracked) => {
                  const childSessionId = tracked.childSessionId ?? action.sessionId
                  // Build and send a separate card for this sub-agent
                  const cardData = buildSubAgentNotificationCard(
                    action.description,
                    action.agent ?? "sub-agent",
                    childSessionId,
                  )
                  return feishuClient.sendMessage(chatId, {
                    msg_type: "interactive",
                    content: JSON.stringify({ type: "card", data: cardData }),
                  })
                })
                .catch((err) => {
                  logger.warn(`SubtaskDiscovered handling failed: ${err}`)
                })
              break
            }

            case "SessionIdle": {
              if (settled) return
              settled = true
              clearTimeout(firstEventTimer)
              removeListener(eventListeners, sessionId, myListener)
              const responseText = textBuffer.trim() || "（无回复）"
              const closeCard = card
                ? (cardStartPromise ?? Promise.resolve()).then(() => card!.close())
                : Promise.resolve()
              closeCard
                .then(async () => {
                  try {
                    await sendFinalResponse(responseText)
                  } catch (err) {
                    logger.warn(`sendFinalResponse failed: ${err}`)
                  }
                  onComplete(responseText)
                  resolve()
                })
                .catch(async (err) => {
                  logger.warn(`card.close() failed: ${err}`)
                  try {
                    await sendFinalResponse(responseText)
                  } catch (replyErr) {
                    logger.warn(`sendFinalResponse failed after card.close error: ${replyErr}`)
                  }
                  onComplete(responseText)
                  resolve()
                })
              break
            }

            default:
              break
          }
        }

        const firstEventTimer = setTimeout(async () => {
          if (gotFirstEvent || settled) return
          settled = true
          removeListener(eventListeners, sessionId, myListener)
          logger.warn(
            `No SSE events received within ${FIRST_EVENT_TIMEOUT_MS}ms for ${sessionId}, falling back to sync response`,
          )
          const fallbackText = parseSyncResponse(syncResponseBody, logger)
          try {
            if (card) await card.close(fallbackText)
          } catch (err) {
            logger.warn(`card.close() in timeout fallback failed: ${err}`)
          }
          // Send fallback text as reply
          try {
            await sendFinalResponse(fallbackText)
          } catch (err) {
            logger.warn(`sendFinalResponse in timeout fallback failed: ${err}`)
          }
          onComplete(fallbackText)
          resolve()
        }, FIRST_EVENT_TIMEOUT_MS)

        // Register event listener BEFORE the POST to avoid race condition
        addListener(eventListeners, sessionId, myListener)


        sendMessage()
          .then((responseBody) => {
            syncResponseBody = responseBody
            logger.info(
              `POST completed for session ${sessionId} (${responseBody.length} bytes)`,
            )
          })
          .catch((err) => {
            if (settled) return
            settled = true
            clearTimeout(firstEventTimer)
            removeListener(eventListeners, sessionId, myListener)
            if (card) card.close().catch(() => {})
            reject(err)
          })
      })
    },
  }
}

// ── Helpers ──

function parseSyncResponse(rawText: string, logger: Logger): string {
  if (!rawText.trim()) return "（无回复）"
  try {
    const data = JSON.parse(rawText) as {
      parts?: Array<{ type: string; text?: string }>
    }
    return (
      data.parts
        ?.filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim() || "（无回复）"
    )
  } catch (e) {
    logger.warn(`Failed to parse sync response: ${e}`)
    return rawText.trim() || "（无回复）"
  }
}

function buildSubAgentNotificationCard(
  description: string,
  agent: string,
  childSessionId: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🤖 ${agent}` },
      template: "indigo",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: description },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔍 View Details" },
            type: "primary",
            value: { action: "view_subagent", childSessionId },
          },
        ],
      },
    ],
  }
}
