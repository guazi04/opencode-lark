/**
 * Message debounce buffer.
 *
 * Collects consecutive messages from the same user+chat within a
 * configurable time window, then flushes them as a single batch.
 * This prevents Feishu's multi-message pattern (image + text sent
 * separately) from reaching opencode as fragmented requests.
 */

import type { Logger } from "../utils/logger.js"
import type { FeishuMessageEvent } from "../types.js"

// ── Types ──

export interface BufferedMessage {
  userText: string
  event: FeishuMessageEvent
  timestamp: number
}

export interface BatchContext {
  firstEvent: FeishuMessageEvent
  lastEvent: FeishuMessageEvent
  thinkingMessageId: string | null
  reactionId: string | null
  /** The message_id the reaction was added to (always the first message). */
  reactionMessageId: string | null
}

export type FlushCallback = (
  debounceKey: string,
  messages: BufferedMessage[],
  context: BatchContext,
) => Promise<void>

// ── Constants ──

const MAX_BATCH_SIZE = 20

// ── Class ──

export class MessageDebouncer {
  private readonly buffers = new Map<string, {
    messages: BufferedMessage[]
    context: BatchContext
    initResolve: (() => void) | null
    flushOnInit: boolean
  }>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly windowMs: number,
    private readonly onFlush: FlushCallback,
    private readonly logger: Logger,
  ) {}

  /**
   * Add a processed message to the debounce buffer.
   * Returns `true` if this is the first message for this key
   * (caller should send thinking indicator).
   */
  add(
    debounceKey: string,
    message: BufferedMessage,
    options?: { startTimer?: boolean },
  ): boolean {
    const shouldStartTimer = options?.startTimer !== false
    const existing = this.buffers.get(debounceKey)
    const isFirst = !existing
    const isInitializing = existing?.initResolve !== undefined && existing.initResolve !== null

    if (existing) {
      existing.messages.push(message)
      existing.context.lastEvent = message.event
    } else {
      this.buffers.set(debounceKey, {
        messages: [message],
        context: {
          firstEvent: message.event,
          lastEvent: message.event,
          thinkingMessageId: null,
          reactionId: null,
          reactionMessageId: null,
        },
        initResolve: null,
        flushOnInit: false,
      })
    }

    // If the first message is still initializing (async context setup),
    // only buffer — don't start/reset the timer. The timer will start
    // when resolveInit() is called after context is ready.
    if (isInitializing) {
      // Still enforce the batch size cap even during init
      const buffer = this.buffers.get(debounceKey)
      if (buffer && buffer.messages.length >= MAX_BATCH_SIZE) {
        buffer.initResolve = null
        this.flush(debounceKey)
      }
      return isFirst
    }

    // Reset timer (only if this add() is supposed to manage the timer)
    if (shouldStartTimer) {
      const existingTimer = this.timers.get(debounceKey)
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer)
      }

      // Force-flush if we hit the batch size cap
      const buffer = this.buffers.get(debounceKey)
      if (buffer && buffer.messages.length >= MAX_BATCH_SIZE) {
        this.flush(debounceKey)
        return isFirst
      }

      this.resetTimer(debounceKey)
    } else {
      // startTimer=false: don't touch existing timer, but still enforce batch cap
      const buffer = this.buffers.get(debounceKey)
      if (buffer && buffer.messages.length >= MAX_BATCH_SIZE) {
        this.flush(debounceKey)
        return isFirst
      }
    }

    return isFirst
  }

  /**
   * Update batch context after async operations complete
   * (e.g., after thinking indicator is sent).
   */
  updateContext(
    debounceKey: string,
    updates: Partial<BatchContext>,
  ): void {
    const buffer = this.buffers.get(debounceKey)
    if (!buffer) return

    if (updates.thinkingMessageId !== undefined) {
      buffer.context.thinkingMessageId = updates.thinkingMessageId
    }
    if (updates.reactionId !== undefined) {
      buffer.context.reactionId = updates.reactionId
    }
    if (updates.firstEvent !== undefined) {
      buffer.context.firstEvent = updates.firstEvent
    }
    if (updates.lastEvent !== undefined) {
      buffer.context.lastEvent = updates.lastEvent
    }
    if (updates.reactionMessageId !== undefined) {
      buffer.context.reactionMessageId = updates.reactionMessageId
    }
  }

  /**
   * Mark a debounceKey as "initializing". While initializing,
   * subsequent `add()` calls will buffer messages but NOT start
   * or reset the timer. Call `resolveInit()` once async context
   * setup (reaction, thinking card) is complete.
   */
  setInitializing(debounceKey: string): void {
    const buffer = this.buffers.get(debounceKey)
    if (!buffer) return
    buffer.initResolve = () => { /* resolved via resolveInit */ }
  }

  /**
   * Resolve initialization for a debounceKey.
   * If flushOnInit was set (text arrived during init), flush immediately.
   * Otherwise start the debounce timer.
   * Any messages buffered during init will be included in the batch.
   */
  resolveInit(debounceKey: string): void {
    const buffer = this.buffers.get(debounceKey)
    if (!buffer) return
    const shouldFlush = buffer.flushOnInit
    buffer.initResolve = null
    buffer.flushOnInit = false
    if (shouldFlush) {
      this.flush(debounceKey)
    } else {
      this.resetTimer(debounceKey)
    }
  }

  /**
   * Mark a debounceKey so that resolveInit() will flush immediately
   * instead of starting the timer. Used when text arrives during init
   * (text = "done" signal, but context isn't ready yet).
   */
  markFlushOnInit(debounceKey: string): void {
    const buffer = this.buffers.get(debounceKey)
    if (!buffer) return
    buffer.flushOnInit = true
  }

  /**
   * Check if a debounceKey is currently initializing.
   */
  isInitializing(debounceKey: string): boolean {
    const buffer = this.buffers.get(debounceKey)
    return buffer?.initResolve !== undefined && buffer?.initResolve !== null
  }

  /**
   * Start (or restart) the debounce timer for a key.
   * Call after `add({ startTimer: false })` + `updateContext()`
   * to avoid the timer firing before context is ready.
   */
  resetTimer(debounceKey: string): void {
    const existingTimer = this.timers.get(debounceKey)
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer)
    }

    // Only set timer if buffer still exists (not already flushed)
    if (!this.buffers.has(debounceKey)) return

    const timer = setTimeout(() => {
      this.flush(debounceKey)
    }, this.windowMs)
    this.timers.set(debounceKey, timer)
  }

  /**
   * Immediately flush a specific key.
   */
  flush(debounceKey: string): void {
    const timer = this.timers.get(debounceKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(debounceKey)
    }

    const buffer = this.buffers.get(debounceKey)
    if (!buffer) return

    this.buffers.delete(debounceKey)

    this.onFlush(debounceKey, buffer.messages, buffer.context).catch((err) => {
      this.logger.error(`Debounce flush failed for ${debounceKey}: ${err}`)
    })
  }

  /**
   * Clean up all timers. If flushRemaining=true, flush
   * all pending batches before clearing.
   */
  dispose(flushRemaining = false): void {
    if (flushRemaining) {
      const keys = [...this.buffers.keys()]
      for (const key of keys) {
        this.flush(key)
      }
    } else {
      for (const timer of this.timers.values()) {
        clearTimeout(timer)
      }
      this.timers.clear()
      this.buffers.clear()
    }
  }

  /** Number of keys with pending messages. */
  get pendingCount(): number {
    return this.buffers.size
  }

  /** Check if there are pending messages for a key. */
  hasPending(debounceKey: string): boolean {
    return this.buffers.has(debounceKey)
  }
}
