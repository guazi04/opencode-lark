/**
 * Tests for FeishuPlugin — channel adapter wrapping existing Feishu modules.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { FeishuPlugin } from "./feishu-plugin.js"
import type { ChannelId, NormalizedMessage, ThreadKey } from "../types.js"
import type { AppConfig } from "../../utils/config.js"
import type { FeishuApiClient } from "../../feishu/api-client.js"
import type { CardKitClient } from "../../feishu/cardkit-client.js"
import type { Logger } from "../../utils/logger.js"
import { createMockLogger, createMockFeishuClient } from "../../__tests__/setup.js"
import type { FeishuMessageEvent } from "../../types.js"

// ── Helpers ──

function makeConfig(): AppConfig {
  return {
    feishu: {
      appId: "cli_test123",
      appSecret: "secret456",
      verificationToken: "",
      webhookPort: 3000,
    },
    defaultAgent: "sisyphus",
    dataDir: "./data",
  }
}

function makeMockCardKitClient(): CardKitClient {
  return {
    createCard: vi.fn().mockResolvedValue("card_123"),
    updateElement: vi.fn().mockResolvedValue(undefined),
    closeStreaming: vi.fn().mockResolvedValue(undefined),
  } as unknown as CardKitClient
}

function makeFeishuPlugin(overrides?: {
  appConfig?: AppConfig
  feishuClient?: FeishuApiClient
  cardkitClient?: CardKitClient
  logger?: Logger
}) {
  return new FeishuPlugin({
    appConfig: overrides?.appConfig ?? makeConfig(),
    feishuClient: overrides?.feishuClient ?? createMockFeishuClient(),
    cardkitClient: overrides?.cardkitClient ?? makeMockCardKitClient(),
    logger: overrides?.logger ?? createMockLogger(),
  })
}

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: "msg_001",
    senderId: "user_001",
    senderName: "Test User",
    text: "Hello",
    chatId: "chat_001",
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeFeishuEvent(overrides?: Partial<FeishuMessageEvent>): FeishuMessageEvent {
  return {
    event_id: "evt_001",
    event_type: "im.message.receive_v1",
    chat_id: "chat_001",
    chat_type: "p2p",
    message_id: "msg_001",
    sender: {
      sender_id: { open_id: "ou_user001" },
      sender_type: "user",
      tenant_key: "tenant_001",
    },
    message: {
      message_type: "text",
      content: JSON.stringify({ text: "Hello" }),
    },
    ...overrides,
  }
}

// ── Tests ──

describe("FeishuPlugin", () => {
  let plugin: FeishuPlugin

  beforeEach(() => {
    plugin = makeFeishuPlugin()
  })

  // ── Identity ──

  describe("identity", () => {
    it("has id 'feishu'", () => {
      expect(plugin.id).toBe("feishu")
    })

    it("has correct meta", () => {
      expect(plugin.meta).toEqual({
        id: "feishu",
        label: "Feishu",
        description: "飞书 channel integration",
      })
    })
  })

  // ── Config Adapter ──

  describe("config adapter", () => {
    it("listAccountIds returns ['default']", () => {
      expect(plugin.config.listAccountIds()).toEqual(["default"])
    })

    it("resolveAccount returns the AppConfig", () => {
      const config = makeConfig()
      const p = makeFeishuPlugin({ appConfig: config })
      expect(p.config.resolveAccount("default")).toBe(config)
    })
  })

  // ── Messaging Adapter ──

  describe("messaging adapter", () => {
    it("normalizeInbound converts FeishuMessageEvent to NormalizedMessage", () => {
      const event = makeFeishuEvent()
      const msg = plugin.messaging!.normalizeInbound(event)

      expect(msg.messageId).toBe("msg_001")
      expect(msg.senderId).toBe("ou_user001")
      expect(msg.text).toBe("Hello")
      expect(msg.chatId).toBe("chat_001")
      expect(msg.timestamp).toBeGreaterThan(0)
    })

    it("normalizeInbound extracts root_id as threadId for group chat", () => {
      const event = makeFeishuEvent({
        chat_type: "group",
        root_id: "root_msg_001",
      })
      const msg = plugin.messaging!.normalizeInbound(event)

      expect(msg.threadId).toBe("root_msg_001")
    })

    it("normalizeInbound handles plain text content (non-JSON)", () => {
      const event = makeFeishuEvent({
        message: { message_type: "text", content: "plain text" },
      })
      const msg = plugin.messaging!.normalizeInbound(event)

      expect(msg.text).toBe("plain text")
    })

    it("formatOutbound returns a card structure", () => {
      const result = plugin.messaging!.formatOutbound({
        target: "chat_001",
        text: "Hello world",
      })

      expect(result).toBeDefined()
      expect(typeof result).toBe("object")
    })
  })

  // ── Outbound Adapter ──

  describe("outbound adapter", () => {
    it("sendText calls feishuClient.sendMessage", async () => {
      const feishuClient = createMockFeishuClient()
      const p = makeFeishuPlugin({ feishuClient })

      await p.outbound!.sendText(
        { address: "chat_001" },
        "Hello",
      )

      expect(feishuClient.sendMessage).toHaveBeenCalledWith(
        "chat_001",
        expect.objectContaining({ msg_type: "text" }),
      )
    })

    it("sendCard calls feishuClient.sendMessage with interactive type", async () => {
      const feishuClient = createMockFeishuClient()
      const p = makeFeishuPlugin({ feishuClient })

      const card = { some: "card" }
      await p.outbound!.sendCard!(
        { address: "chat_001" },
        card,
      )

      expect(feishuClient.sendMessage).toHaveBeenCalledWith(
        "chat_001",
        expect.objectContaining({ msg_type: "interactive" }),
      )
    })
  })

  // ── Streaming Adapter ──

  describe("streaming adapter", () => {
    it("createStreamingSession returns a StreamingSession", () => {
      const session = plugin.streaming!.createStreamingSession({
        address: "chat_001",
      })

      expect(session).toBeDefined()
      expect(session.target.address).toBe("chat_001")
      expect(typeof session.flush).toBe("function")
      expect(session.sessionId).toBeTruthy()
    })
  })

  // ── Threading Adapter (Feishu-specific override) ──

  describe("threading adapter", () => {
    it("p2p chat uses chatId only", () => {
      const msg = makeMessage({ chatId: "chat_abc", threadId: undefined })
      const key = plugin.threading.resolveThread(msg)

      expect(key).toBe("chat_abc")
    })

    it("group chat with root_id uses chatId:rootId (threadId = rootId)", () => {
      const msg = makeMessage({
        chatId: "chat_abc",
        threadId: "root_msg_123",
      })
      const key = plugin.threading.resolveThread(msg)

      expect(key).toBe("chat_abc:root_msg_123")
    })

    it("group chat without root_id uses chatId:messageId (threadId = messageId)", () => {
      // In Feishu, when there's no root_id in group chat,
      // normalizeInbound sets threadId = message_id
      // so resolveThread produces chatId:messageId
      const msg = makeMessage({
        chatId: "chat_abc",
        threadId: "msg_001",
      })
      const key = plugin.threading.resolveThread(msg)

      expect(key).toBe("chat_abc:msg_001")
    })

    it("matches existing feishu_key logic from index.ts", () => {
      // Simulate: p2p → chatId
      const p2pEvent = makeFeishuEvent({ chat_type: "p2p", chat_id: "c1" })
      const p2pMsg = plugin.messaging!.normalizeInbound(p2pEvent)
      expect(plugin.threading.resolveThread(p2pMsg)).toBe("c1")

      // Simulate: group with root_id → chatId:rootId
      const groupWithRoot = makeFeishuEvent({
        chat_type: "group",
        chat_id: "c2",
        root_id: "root_99",
        message_id: "msg_99",
      })
      const groupMsg1 = plugin.messaging!.normalizeInbound(groupWithRoot)
      expect(plugin.threading.resolveThread(groupMsg1)).toBe("c2:root_99")

      // Simulate: group without root_id → chatId:messageId
      const groupNoRoot = makeFeishuEvent({
        chat_type: "group",
        chat_id: "c3",
        message_id: "msg_55",
      })
      const groupMsg2 = plugin.messaging!.normalizeInbound(groupNoRoot)
      expect(plugin.threading.resolveThread(groupMsg2)).toBe("c3:msg_55")
    })

    it("mapSession and getSession work correctly", () => {
      const key = "chat_abc:root_123" as ThreadKey
      expect(plugin.threading.getSession(key)).toBeNull()

      plugin.threading.mapSession(key, "session_xyz")
      expect(plugin.threading.getSession(key)).toBe("session_xyz")
    })
  })

  // ── Gateway Adapter ──

  describe("gateway adapter", () => {
    it("is defined", () => {
      expect(plugin.gateway).toBeDefined()
      expect(typeof plugin.gateway!.startAccount).toBe("function")
    })
  })

  // ── Implements ChannelPlugin ──

  describe("interface compliance", () => {
    it("implements all 6 adapters", () => {
      expect(plugin.config).toBeDefined()
      expect(plugin.gateway).toBeDefined()
      expect(plugin.messaging).toBeDefined()
      expect(plugin.outbound).toBeDefined()
      expect(plugin.streaming).toBeDefined()
      expect(plugin.threading).toBeDefined()
    })
  })
})