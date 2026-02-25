/**
 * Tests for BaseChannelPlugin abstract base class.
 * TDD: tests written first, implementation follows.
 */

import { describe, it, expect, vi } from "vitest"
import { BaseChannelPlugin } from "./base-plugin.js"
import type {
  ChannelId,
  ChannelMeta,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  NormalizedMessage,
  ThreadKey,
} from "./types.js"

// ── Concrete test subclass with minimal overrides ──

class TestPlugin extends BaseChannelPlugin {
  id = "test" as ChannelId
  meta: ChannelMeta = {
    id: "test" as ChannelId,
    label: "Test Channel",
    description: "A test channel plugin",
  }
  config: ChannelConfigAdapter = {
    listAccountIds: () => ["acct-1"],
    resolveAccount: (id: string) => ({ id, token: "secret" }),
  }
}

// ── Helper: create a NormalizedMessage ──

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "msg-1",
    senderId: "user-1",
    text: "hello",
    chatId: "chat-1",
    timestamp: Date.now(),
    ...overrides,
  }
}

describe("BaseChannelPlugin", () => {
  describe("concrete subclass instantiation", () => {
    it("creates a concrete subclass with minimal overrides", () => {
      const plugin = new TestPlugin()
      expect(plugin.id).toBe("test")
      expect(plugin.meta.label).toBe("Test Channel")
      expect(plugin.config.listAccountIds()).toEqual(["acct-1"])
    })
  })

  describe("optional adapters default to undefined", () => {
    it("gateway is undefined by default", () => {
      const plugin = new TestPlugin()
      expect(plugin.gateway).toBeUndefined()
    })

    it("messaging is undefined by default", () => {
      const plugin = new TestPlugin()
      expect(plugin.messaging).toBeUndefined()
    })

    it("outbound is undefined by default", () => {
      const plugin = new TestPlugin()
      expect(plugin.outbound).toBeUndefined()
    })

    it("streaming is undefined by default", () => {
      const plugin = new TestPlugin()
      expect(plugin.streaming).toBeUndefined()
    })
  })

  describe("threading adapter defaults", () => {
    it("provides a threading adapter by default", () => {
      const plugin = new TestPlugin()
      expect(plugin.threading).toBeDefined()
    })

    it("resolveThread returns chatId as ThreadKey for p2p (no threadId)", () => {
      const plugin = new TestPlugin()
      const msg = makeMessage({ chatId: "chat-abc" })
      const key = plugin.threading!.resolveThread(msg)
      expect(key).toBe("chat-abc")
    })

    it("resolveThread returns chatId:threadId as ThreadKey for group messages", () => {
      const plugin = new TestPlugin()
      const msg = makeMessage({ chatId: "chat-abc", threadId: "thread-xyz" })
      const key = plugin.threading!.resolveThread(msg)
      expect(key).toBe("chat-abc:thread-xyz")
    })

    it("mapSession stores and getSession retrieves the session ID", () => {
      const plugin = new TestPlugin()
      const threadKey = "chat-abc" as ThreadKey
      plugin.threading!.mapSession(threadKey, "session-1")
      expect(plugin.threading!.getSession(threadKey)).toBe("session-1")
    })

    it("getSession returns null for unmapped thread key", () => {
      const plugin = new TestPlugin()
      const threadKey = "unknown" as ThreadKey
      expect(plugin.threading!.getSession(threadKey)).toBeNull()
    })

    it("mapSession overwrites previous session for same thread key", () => {
      const plugin = new TestPlugin()
      const threadKey = "chat-abc" as ThreadKey
      plugin.threading!.mapSession(threadKey, "session-1")
      plugin.threading!.mapSession(threadKey, "session-2")
      expect(plugin.threading!.getSession(threadKey)).toBe("session-2")
    })
  })

  describe("gateway template method", () => {
    it("subclass can provide a gateway adapter", async () => {
      const startFn = vi.fn().mockResolvedValue(undefined)
      class GatewayPlugin extends TestPlugin {
        override gateway: ChannelGatewayAdapter = {
          startAccount: startFn,
        }
      }
      const plugin = new GatewayPlugin()
      const controller = new AbortController()
      await plugin.gateway!.startAccount("acct-1", controller.signal)
      expect(startFn).toHaveBeenCalledWith("acct-1", controller.signal)
    })
  })

  describe("ChannelPlugin interface compliance", () => {
    it("satisfies ChannelPlugin interface shape", () => {
      const plugin = new TestPlugin()
      // Required fields exist
      expect(plugin.id).toBeDefined()
      expect(plugin.meta).toBeDefined()
      expect(plugin.config).toBeDefined()
      // Has threading from base
      expect(plugin.threading).toBeDefined()
      // Optional adapters are undefined
      expect(plugin.gateway).toBeUndefined()
      expect(plugin.messaging).toBeUndefined()
      expect(plugin.outbound).toBeUndefined()
      expect(plugin.streaming).toBeUndefined()
    })
  })
})
