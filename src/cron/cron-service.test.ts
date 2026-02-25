import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { parseSchedule, CronService } from "../cron/cron-service.js"
import type { CronServiceOptions } from "../cron/cron-service.js"
import { createMockLogger, createMockFeishuClient } from "../__tests__/setup.js"
import type { SessionManager } from "../session/session-manager.js"
import type { CronConfig } from "../utils/config.js"

function createMockSessionManager(): SessionManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue("session-123"),
    getSession: vi.fn().mockReturnValue(null),
    cleanup: vi.fn().mockReturnValue(0),
  }
}

function makeOptions(overrides: Partial<CronServiceOptions> = {}): CronServiceOptions {
  const config: CronConfig = {
    jobs: [
      { name: "test-job", schedule: "every 30m", prompt: "do something", chatId: "chat-1" },
    ],
  }
  return {
    config,
    sessionManager: createMockSessionManager(),
    feishuClient: createMockFeishuClient(),
    serverUrl: "http://127.0.0.1:4096",
    logger: createMockLogger(),
    ...overrides,
  }
}

describe("parseSchedule", () => {
  it("parses 'every Nm' format", () => {
    const result = parseSchedule("every 30m")
    expect(result).toEqual({ type: "interval", intervalMs: 30 * 60_000 })
  })

  it("parses 'every Nh' format", () => {
    const result = parseSchedule("every 2h")
    expect(result).toEqual({ type: "interval", intervalMs: 2 * 3_600_000 })
  })

  it("parses 'daily HH:MM' format", () => {
    const result = parseSchedule("daily 09:00")
    expect(result).toEqual({ type: "daily", hour: 9, minute: 0 })
  })

  it("parses daily with single-digit hour", () => {
    const result = parseSchedule("daily 9:30")
    expect(result).toEqual({ type: "daily", hour: 9, minute: 30 })
  })

  it("throws on invalid format", () => {
    expect(() => parseSchedule("weekly")).toThrow(/Invalid schedule format/)
  })

  it("throws on invalid daily time (hour > 23)", () => {
    expect(() => parseSchedule("daily 25:00")).toThrow(/invalid time/)
  })

  it("throws on invalid daily time (minute > 59)", () => {
    expect(() => parseSchedule("daily 09:61")).toThrow(/invalid time/)
  })

  it("is case-insensitive", () => {
    expect(parseSchedule("Every 5M")).toEqual({ type: "interval", intervalMs: 5 * 60_000 })
    expect(parseSchedule("DAILY 12:00")).toEqual({ type: "daily", hour: 12, minute: 0 })
  })

  it("handles whitespace", () => {
    expect(parseSchedule("  every 10m  ")).toEqual({ type: "interval", intervalMs: 10 * 60_000 })
  })
})

describe("CronService", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  it("start() creates interval timers for each job", () => {
    const options = makeOptions()
    const service = new CronService(options)

    service.start()
    expect(options.logger.info).toHaveBeenCalledWith(expect.stringContaining("started with 1 job"))

    service.stop()
    expect(options.logger.info).toHaveBeenCalledWith("Cron service stopped")
  })

  it("start() throws on invalid schedule before creating any timers", () => {
    const options = makeOptions({
      config: {
        jobs: [
          { name: "bad-job", schedule: "invalid format", prompt: "test", chatId: "chat-1" },
        ],
      },
    })
    const service = new CronService(options)

    expect(() => service.start()).toThrow(/Invalid schedule format/)
  })

  it("start() is idempotent (calling twice does not double timers)", () => {
    const options = makeOptions()
    const service = new CronService(options)

    service.start()
    service.start()

    const startCalls = (options.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("started"))
    expect(startCalls).toHaveLength(1)

    service.stop()
  })

  it("stop() clears all intervals", () => {
    const options = makeOptions()
    const service = new CronService(options)

    service.start()
    service.stop()

    expect(options.logger.info).toHaveBeenCalledWith("Cron service stopped")
  })

  it("stop() is idempotent", () => {
    const options = makeOptions()
    const service = new CronService(options)

    service.start()
    service.stop()
    service.stop()

    const stopCalls = (options.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("stopped"))
    expect(stopCalls).toHaveLength(1)
  })

  it("interval job fires executeJob at scheduled time", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    globalThis.fetch = mockFetch
    const options = makeOptions({
      config: {
        jobs: [
          { name: "interval-job", schedule: "every 1m", prompt: "test prompt", chatId: "chat-abc" },
        ],
      },
    })
    const service = new CronService(options)
    service.start()
    vi.advanceTimersByTime(60_000)
    await vi.advanceTimersByTimeAsync(100)
    expect(options.sessionManager.getOrCreate).toHaveBeenCalledWith("cron:interval-job")
    service.stop()
  })

  it("handles multiple jobs with different schedules", () => {
    const options = makeOptions({
      config: {
        jobs: [
          { name: "job-a", schedule: "every 5m", prompt: "a", chatId: "chat-1" },
          { name: "job-b", schedule: "every 1h", prompt: "b", chatId: "chat-2" },
          { name: "job-c", schedule: "daily 09:00", prompt: "c", chatId: "chat-3" },
        ],
      },
    })
    const service = new CronService(options)

    service.start()
    expect(options.logger.info).toHaveBeenCalledWith(expect.stringContaining("started with 3 job"))

    service.stop()
  })
})
