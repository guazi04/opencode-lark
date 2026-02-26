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
  }
}
