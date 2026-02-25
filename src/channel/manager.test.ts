/**
 * Tests for ChannelManager — manages registered channel plugins and their lifecycles.
 */

import { vi, describe, it, expect, beforeEach } from "vitest"
import { ChannelManager } from "./manager.js"
import { createMockLogger } from "../__tests__/setup.js"
import type {
  ChannelPlugin,
  ChannelId,
  ChannelGatewayAdapter,
  ChannelConfigAdapter,
  ChannelMeta,
} from "./types.js"
import type { Logger } from "../utils/logger.js"

// ── Helpers ──

function makePlugin(
  id: string,
  gateway?: Partial<ChannelGatewayAdapter>,
): ChannelPlugin {
  const meta: ChannelMeta = {
    id: id as ChannelId,
    label: id,
    description: `${id} channel`,
  }
  const config: ChannelConfigAdapter = {
    listAccountIds: () => ["default"],
    resolveAccount: (accountId: string) => ({ accountId }),
  }
  const plugin: ChannelPlugin = {
    id: id as ChannelId,
    meta,
    config,
  }
  if (gateway) {
    plugin.gateway = {
      startAccount: gateway.startAccount ?? vi.fn().mockResolvedValue(undefined),
      ...(gateway.stopAccount !== undefined ? { stopAccount: gateway.stopAccount } : {}),
    }
  }
  return plugin
}

// ── Tests ──

describe("ChannelManager", () => {
  let logger: Logger
  let manager: ChannelManager

  beforeEach(() => {
    logger = createMockLogger()
    manager = new ChannelManager({ logger })
  })

  // ── register + getChannel ──

  it("registers a channel and retrieves it by id", () => {
    const plugin = makePlugin("feishu")
    manager.register(plugin)
    expect(manager.getChannel("feishu" as ChannelId)).toBe(plugin)
  })

  it("returns undefined for an unknown channel id", () => {
    expect(manager.getChannel("nonexistent" as ChannelId)).toBeUndefined()
  })

  // ── listChannels ──

  it("lists all registered channels", () => {
    const a = makePlugin("feishu")
    const b = makePlugin("slack")
    manager.register(a)
    manager.register(b)
    const list = manager.listChannels()
    expect(list).toHaveLength(2)
    expect(list).toContain(a)
    expect(list).toContain(b)
  })

  it("returns empty array when no channels registered", () => {
    expect(manager.listChannels()).toEqual([])
  })

  // ── startAll ──

  it("calls gateway.startAccount for each channel with gateway", async () => {
    const startA = vi.fn().mockResolvedValue(undefined)
    const startB = vi.fn().mockResolvedValue(undefined)
    manager.register(makePlugin("feishu", { startAccount: startA }))
    manager.register(makePlugin("slack", { startAccount: startB }))

    const ac = new AbortController()
    await manager.startAll(ac.signal)

    expect(startA).toHaveBeenCalledWith("default", ac.signal)
    expect(startB).toHaveBeenCalledWith("default", ac.signal)
  })

  it("skips channels without gateway gracefully", async () => {
    const start = vi.fn().mockResolvedValue(undefined)
    manager.register(makePlugin("no-gateway")) // no gateway
    manager.register(makePlugin("has-gateway", { startAccount: start }))

    const ac = new AbortController()
    await manager.startAll(ac.signal)

    expect(start).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalled()
  })

  it("one channel failing to start does not block others", async () => {
    const failStart = vi.fn().mockRejectedValue(new Error("connection refused"))
    const okStart = vi.fn().mockResolvedValue(undefined)
    manager.register(makePlugin("bad", { startAccount: failStart }))
    manager.register(makePlugin("good", { startAccount: okStart }))

    const ac = new AbortController()
    await manager.startAll(ac.signal)

    expect(failStart).toHaveBeenCalledTimes(1)
    expect(okStart).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })

  // ── stopAll ──

  it("calls gateway.stopAccount for each channel with gateway", async () => {
    const stopA = vi.fn().mockResolvedValue(undefined)
    const stopB = vi.fn().mockResolvedValue(undefined)
    manager.register(
      makePlugin("feishu", { startAccount: vi.fn(), stopAccount: stopA }),
    )
    manager.register(
      makePlugin("slack", { startAccount: vi.fn(), stopAccount: stopB }),
    )

    await manager.stopAll()

    expect(stopA).toHaveBeenCalledWith("default")
    expect(stopB).toHaveBeenCalledWith("default")
  })

  it("handles channels without stopAccount gracefully", async () => {
    // gateway exists but stopAccount is undefined (optional method)
    manager.register(makePlugin("feishu", { startAccount: vi.fn() }))
    manager.register(makePlugin("no-gateway")) // no gateway at all

    // should not throw
    await expect(manager.stopAll()).resolves.toBeUndefined()
  })

  it("one channel failing to stop does not block others", async () => {
    const failStop = vi.fn().mockRejectedValue(new Error("timeout"))
    const okStop = vi.fn().mockResolvedValue(undefined)
    manager.register(
      makePlugin("bad", { startAccount: vi.fn(), stopAccount: failStop }),
    )
    manager.register(
      makePlugin("good", { startAccount: vi.fn(), stopAccount: okStop }),
    )

    await manager.stopAll()

    expect(failStop).toHaveBeenCalledTimes(1)
    expect(okStop).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })
})