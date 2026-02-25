import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { HeartbeatService } from "../cron/heartbeat.js"
import type { HeartbeatOptions } from "../cron/heartbeat.js"
import { createMockLogger, createMockFeishuClient } from "../__tests__/setup.js"

function makeOptions(overrides: Partial<HeartbeatOptions> = {}): HeartbeatOptions {
  return {
    intervalMs: 1000,
    serverUrl: "http://127.0.0.1:4096",
    logger: createMockLogger(),
    ...overrides,
  }
}

describe("HeartbeatService", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  it("start() begins interval with configured intervalMs", () => {
    const options = makeOptions()
    const service = new HeartbeatService(options)

    service.start()

    expect(options.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Heartbeat service started (interval: 1000ms)"),
    )

    service.stop()
    expect(options.logger.info).toHaveBeenCalledWith("Heartbeat service stopped")
  })

  it("start() is idempotent", () => {
    const options = makeOptions()
    const service = new HeartbeatService(options)

    service.start()
    service.start()

    const startCalls = (options.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("started"))
    expect(startCalls).toHaveLength(1)

    service.stop()
  })

  it("stop() is idempotent", () => {
    const options = makeOptions()
    const service = new HeartbeatService(options)

    service.start()
    service.stop()
    service.stop()

    const stopCalls = (options.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("stopped"))
    expect(stopCalls).toHaveLength(1)
  })

  it("tick() logs success on healthy server response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = mockFetch

    const options = makeOptions({ intervalMs: 100 })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(10)

    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:4096/session/status")
    expect(options.logger.info).toHaveBeenCalledWith("Server healthy")

    service.stop()
  })

  it("tick() logs error and does not alert when feishuClient is undefined", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    globalThis.fetch = mockFetch

    const options = makeOptions({ intervalMs: 100, feishuClient: undefined })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(10)

    expect(options.logger.error).toHaveBeenCalledWith(
      "Server health check failed with HTTP 500",
    )

    service.stop()
  })

  it("tick() logs error and sends alert on failed response with statusChatId", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502 })
    globalThis.fetch = mockFetch

    const feishuClient = createMockFeishuClient()
    const options = makeOptions({
      intervalMs: 100,
      feishuClient,
      statusChatId: "chat-123",
    })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(10)

    expect(options.logger.error).toHaveBeenCalledWith(
      "Server health check failed with HTTP 502",
    )
    expect(feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-123",
      expect.objectContaining({
        msg_type: "text",
      }),
    )

    service.stop()
  })

  it("tick() handles fetch network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"))
    globalThis.fetch = mockFetch

    const options = makeOptions({ intervalMs: 100 })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(10)

    expect(options.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Server health check failed: Network timeout"),
    )

    service.stop()
  })

  it("tick() sends alert on network error with statusChatId", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    globalThis.fetch = mockFetch

    const feishuClient = createMockFeishuClient()
    const options = makeOptions({
      intervalMs: 100,
      feishuClient,
      statusChatId: "chat-456",
    })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(10)

    expect(feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-456",
      expect.objectContaining({
        msg_type: "text",
      }),
    )

    service.stop()
  })

  it("getStats() returns successCount and failCount", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 500 })
    globalThis.fetch = mockFetch

    const options = makeOptions({ intervalMs: 100 })
    const service = new HeartbeatService(options)

    service.start()
    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(10)

    let stats = service.getStats()
    expect(stats.successCount).toBe(1)
    expect(stats.failCount).toBe(0)

    vi.advanceTimersByTime(100)
    await vi.advanceTimersByTimeAsync(10)

    stats = service.getStats()
    expect(stats.successCount).toBe(1)
    expect(stats.failCount).toBe(1)

    service.stop()
  })
})
