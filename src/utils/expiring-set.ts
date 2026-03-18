/**
 * Generic TTL-based Set replacement.
 * Items automatically expire after a configurable time-to-live.
 * A periodic cleanup interval evicts expired entries proactively.
 */

import { createLogger } from "./logger.js"

const logger = createLogger("expiring-set")

export class ExpiringSet<T> {
  private readonly data = new Map<T, number>()
  private readonly ttlMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(ttlMs: number, cleanupIntervalMs: number) {
    this.ttlMs = ttlMs
    this.cleanupTimer = setInterval(() => this.evictExpired(), cleanupIntervalMs)
  }

  /** Add an item with the current timestamp. */
  add(item: T): void {
    this.data.set(item, Date.now())
  }

  /** Check existence — expired items are treated as not existing. */
  has(item: T): boolean {
    const timestamp = this.data.get(item)
    if (timestamp === undefined) return false
    if (Date.now() - timestamp > this.ttlMs) {
      this.data.delete(item)
      return false
    }
    return true
  }

  /** Manually delete an item. */
  delete(item: T): boolean {
    return this.data.delete(item)
  }

  /** O(n) — iterates all entries to exclude expired. Avoid in hot paths. */
  get size(): number {
    const now = Date.now()
    let count = 0
    for (const timestamp of this.data.values()) {
      if (now - timestamp <= this.ttlMs) count++
    }
    return count
  }

  /** Stop the cleanup interval timer. */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /** Clear all entries (matching native Set interface). */
  clear(): void {
    this.data.clear()
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs
    let evicted = 0
    for (const [item, timestamp] of this.data) {
      if (timestamp < cutoff) {
        this.data.delete(item)
        evicted++
      }
    }
    if (evicted > 0) {
      logger.debug(`Evicted ${evicted} expired entries from ExpiringSet`)
    }
  }
}
