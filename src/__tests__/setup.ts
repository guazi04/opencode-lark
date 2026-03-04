/**
 * Shared test utilities and mock factories.
 */

import { vi } from "vitest"
import type { Logger } from "../utils/logger.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { AppDatabase } from "../utils/db.js"


/**
 * Creates a mock Logger with all methods stubbed as vi.fn()
 */
export function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

/**
 * Creates an in-memory SQLite database for testing.
 */
export function createMockDb(): AppDatabase {
  const mockDb = {
    prepare: () => ({ run: () => ({}), get: () => null, all: () => [] }),
    pragma: () => {},
    close: () => {},
  }
  return {
    sessions: mockDb as any,
    memory: mockDb as any,
    close() {
      mockDb.close()
    },
  }
}
/**
 * Creates a mock fetch function that can be configured per test.
 */
export function createMockFetch() {
  return vi.fn()
}

/**
 * Creates a mock FeishuApiClient with all methods stubbed as vi.fn()
 */
export function createMockFeishuClient(): FeishuApiClient {
  return {
    sendMessage: vi.fn(),
    replyMessage: vi.fn(),
    updateMessage: vi.fn(),
    addReaction: vi.fn(),
    deleteReaction: vi.fn(),
    getMessage: vi.fn().mockResolvedValue({ code: 0, msg: "ok", data: { items: [] } }),
    downloadResource: vi.fn().mockResolvedValue({ data: Buffer.from("mock-data"), filename: undefined }),
  }
}

/**
 * Polls `fn` until it stops throwing, compatible with both vitest and bun test.
 * Drop-in replacement for `vi.waitFor()` which is unavailable in Bun's runner.
 * Uses setImmediate to yield — immune to fake timers.
 */
export async function waitFor(
  fn: () => void | Promise<void>,
  { timeout = 5000, maxAttempts = 500 }: { timeout?: number, maxAttempts?: number } = {},
): Promise<void> {
  const start = Date.now()
  let lastErr: unknown
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fn()
      return
    } catch (err) {
      lastErr = err
      // Yield via setImmediate (not affected by fake timers)
      await new Promise(r => setImmediate(r))
      if (Date.now() - start > timeout) break
    }
  }
  throw lastErr
}
