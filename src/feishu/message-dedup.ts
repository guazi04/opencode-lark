/**
 * SQLite-backed message deduplication.
 * Caches event_id with a configurable TTL (default 60s).
 * Prevents processing the same Feishu event twice, surviving restarts.
 */

import { type Database, type Statement } from "bun:sqlite"
import { createLogger } from "../utils/logger.js"

const logger = createLogger("message-dedup")

interface MessageDedupOptions {
  db: Database
  ttlMs?: number
}

export class MessageDedup {
  private readonly db: Database
  private readonly ttlMs: number
  private readonly insertStmt: Statement
  private readonly checkStmt: Statement
  private readonly cleanupStmt: Statement
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: MessageDedupOptions) {
    this.db = options.db
    this.ttlMs = options.ttlMs ?? 60_000


    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_dedup (
        event_id   TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `)

    this.checkStmt = this.db.prepare(
      "SELECT event_id FROM message_dedup WHERE event_id = ?",
    )

    this.insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO message_dedup (event_id, created_at) VALUES (?, ?)",
    )

    this.cleanupStmt = this.db.prepare(
      "DELETE FROM message_dedup WHERE created_at < ?",
    )


    this.cleanupTimer = setInterval(() => this.evictExpired(), 30_000)

    logger.info(`MessageDedup initialized (TTL: ${this.ttlMs}ms)`)
  }

  /**
   * Returns true if this event_id has been seen within the TTL window.
   * If not seen, registers it and returns false.
   */
  isDuplicate(eventId: string): boolean {

    this.evictExpired()

    const existing = this.checkStmt.get(eventId)
    if (existing) {
      logger.debug(`Duplicate event: ${eventId}`)
      return true
    }

    this.insertStmt.run(eventId, Date.now())
    return false
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs
    const result = this.cleanupStmt.run(cutoff)
    if (result.changes > 0) {
      logger.debug(`Evicted ${result.changes} expired dedup entries`)
    }
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}
