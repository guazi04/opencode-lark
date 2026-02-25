/**
 * Example test to verify vitest setup works correctly.
 */

import { describe, it, expect } from "vitest"
import { createMockLogger, createMockDb, createMockFetch, createMockFeishuClient } from "./setup.js"

describe("Test Setup", () => {
  it("should have vitest available", () => {
    expect(true).toBe(true)
  })

  it("should create a mock logger", () => {
    const logger = createMockLogger()
    expect(logger.info).toBeDefined()
    expect(logger.warn).toBeDefined()
    expect(logger.error).toBeDefined()
    expect(logger.debug).toBeDefined()
  })

  it("should create a mock database", () => {
    const db = createMockDb()
    expect(db.sessions).toBeDefined()
    expect(db.memory).toBeDefined()
    expect(db.close).toBeDefined()
    db.close()
  })

  it("should create a mock fetch function", () => {
    const mockFetch = createMockFetch()
    expect(mockFetch).toBeDefined()
    mockFetch({ url: "test" })
    expect(mockFetch).toHaveBeenCalled()
  })

  it("should create a mock Feishu API client", () => {
    const client = createMockFeishuClient()
    expect(client.sendMessage).toBeDefined()
    expect(client.replyMessage).toBeDefined()
    expect(client.updateMessage).toBeDefined()
  })
})
