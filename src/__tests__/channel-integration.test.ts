/**
 * Integration tests for the ChannelPlugin abstraction.
 * Proves that non-Feishu channels work with ChannelManager.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { ChannelManager } from "../channel/manager.js"
import { MockPlugin } from "../channel/mock/mock-plugin.js"
import type { ChannelId, OutboundTarget, NormalizedMessage, ThreadKey } from "../channel/types.js"
import { createMockLogger } from "./setup.js"

describe("Channel integration", () => {
  let manager: ChannelManager
  let mockPlugin: MockPlugin
  let mockPlugin2: MockPlugin

  beforeEach(() => {
    manager = new ChannelManager({ logger: createMockLogger() })
    mockPlugin = new MockPlugin()
    // Second mock acting as a different channel ("mock2")
    mockPlugin2 = new MockPlugin()
    ;(mockPlugin2 as any).id = "mock2" as ChannelId
    mockPlugin2.meta = {
      id: "mock2" as ChannelId,
      label: "Mock Channel 2",
      description: "Second mock channel for integration testing",
    }
  })

  describe("ChannelManager with multiple channels", () => {
    it("registers and lists multiple channels", () => {
      manager.register(mockPlugin)
      manager.register(mockPlugin2)

      const channels = manager.listChannels()
      expect(channels).toHaveLength(2)
      expect(channels.map((c) => c.id)).toContain("mock" as ChannelId)
      expect(channels.map((c) => c.id)).toContain("mock2" as ChannelId)
    })

    it("retrieves channels by id via getChannel", () => {
      manager.register(mockPlugin)
      manager.register(mockPlugin2)

      expect(manager.getChannel("mock" as ChannelId)).toBe(mockPlugin)
      expect(manager.getChannel("mock2" as ChannelId)).toBe(mockPlugin2)
      expect(manager.getChannel("nonexistent" as ChannelId)).toBeUndefined()
    })

    it("startAll starts all gateways", async () => {
      manager.register(mockPlugin)
      manager.register(mockPlugin2)

      const ac = new AbortController()
      await manager.startAll(ac.signal)

      expect(mockPlugin.startedAccounts).toEqual(["default"])
      expect(mockPlugin2.startedAccounts).toEqual(["default"])
    })

    it("stopAll stops all gateways", async () => {
      manager.register(mockPlugin)
      manager.register(mockPlugin2)

      const ac = new AbortController()
      await manager.startAll(ac.signal)
      await manager.stopAll()

      // No error thrown — stopAccount is a no-op in mock
      expect(mockPlugin.startedAccounts).toEqual(["default"])
    })
  })

  describe("MockPlugin outbound", () => {
    it("records messages sent via sendText", async () => {
      const target: OutboundTarget = { address: "user-123" }
      await mockPlugin.outbound!.sendText(target, "Hello from mock")
      await mockPlugin.outbound!.sendText(target, "Second message")

      expect(mockPlugin.sentMessages).toHaveLength(2)
      expect(mockPlugin.sentMessages[0]).toEqual({
        target: { address: "user-123" },
        text: "Hello from mock",
      })
      expect(mockPlugin.sentMessages[1]).toEqual({
        target: { address: "user-123" },
        text: "Second message",
      })
    })

    it("isolates messages between plugin instances", async () => {
      const target1: OutboundTarget = { address: "user-1" }
      const target2: OutboundTarget = { address: "user-2" }

      await mockPlugin.outbound!.sendText(target1, "msg1")
      await mockPlugin2.outbound!.sendText(target2, "msg2")

      expect(mockPlugin.sentMessages).toHaveLength(1)
      expect(mockPlugin.sentMessages[0]!.text).toBe("msg1")
      expect(mockPlugin2.sentMessages).toHaveLength(1)
      expect(mockPlugin2.sentMessages[0]!.text).toBe("msg2")
    })
  })

  describe("MockPlugin config", () => {
    it("lists account IDs", () => {
      expect(mockPlugin.config.listAccountIds()).toEqual(["test-acct"])
    })

    it("resolves account", () => {
      const account = mockPlugin.config.resolveAccount("test-acct")
      expect(account).toEqual({ id: "test-acct", type: "mock" })
    })
  })

  describe("MockPlugin threading (inherited from BaseChannelPlugin)", () => {
    it("resolves thread key from message without threadId", () => {
      const msg: NormalizedMessage = {
        messageId: "m1",
        senderId: "s1",
        text: "hello",
        chatId: "chat-abc",
        timestamp: Date.now(),
      }
      const key = mockPlugin.threading.resolveThread(msg)
      expect(key).toBe("chat-abc")
    })

    it("resolves thread key from message with threadId", () => {
      const msg: NormalizedMessage = {
        messageId: "m2",
        senderId: "s1",
        text: "reply",
        chatId: "chat-abc",
        threadId: "t42",
        timestamp: Date.now(),
      }
      const key = mockPlugin.threading.resolveThread(msg)
      expect(key).toBe("chat-abc:t42")
    })

    it("maps and retrieves sessions", () => {
      const threadKey = "chat-abc:t42" as ThreadKey

      expect(mockPlugin.threading.getSession(threadKey)).toBeNull()

      mockPlugin.threading.mapSession(threadKey, "session-1")
      expect(mockPlugin.threading.getSession(threadKey)).toBe("session-1")
    })
  })

  describe("End-to-end message flow through plugin abstraction", () => {
    it("handles message flow: start → resolve thread → send outbound", async () => {
      manager.register(mockPlugin)

      // 1. Start the channel
      const ac = new AbortController()
      await manager.startAll(ac.signal)
      expect(mockPlugin.startedAccounts).toEqual(["default"])

      // 2. Simulate inbound message → resolve thread
      const inbound: NormalizedMessage = {
        messageId: "msg-001",
        senderId: "user-456",
        text: "Hi bot!",
        chatId: "chat-789",
        timestamp: Date.now(),
      }
      const threadKey = mockPlugin.threading.resolveThread(inbound)
      expect(threadKey).toBe("chat-789")

      // 3. Map session for thread
      mockPlugin.threading.mapSession(threadKey, "agent-session-42")
      expect(mockPlugin.threading.getSession(threadKey)).toBe("agent-session-42")

      // 4. Send response through outbound
      const channel = manager.getChannel("mock" as ChannelId)!
      await channel.outbound!.sendText({ address: inbound.chatId }, "Hello human!")

      // 5. Verify message was recorded
      expect(mockPlugin.sentMessages).toHaveLength(1)
      expect(mockPlugin.sentMessages[0]).toEqual({
        target: { address: "chat-789" },
        text: "Hello human!",
      })
    })
  })
})