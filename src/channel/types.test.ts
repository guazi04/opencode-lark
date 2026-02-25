import { expectTypeOf } from "vitest";
import type {
  ChannelId,
  ChannelMeta,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  ChannelPlugin,
  NormalizedMessage,
  OutboundMessage,
  OutboundTarget,
  StreamTarget,
  StreamingSession,
  ThreadKey,
} from "./types.js";

describe("ChannelPlugin types", () => {
  it("ChannelId is a string brand", () => {
    const id: ChannelId = "feishu" as ChannelId;
    expectTypeOf(id).toBeString();
  });

  it("ChannelMeta has required fields", () => {
    const meta: ChannelMeta = {
      id: "feishu" as ChannelId,
      label: "Feishu",
      description: "Feishu messaging integration",
    };
    expectTypeOf(meta.id).toBeString();
    expectTypeOf(meta.label).toBeString();
    expectTypeOf(meta.description).toBeString();
  });

  it("NormalizedMessage has required and optional fields", () => {
    const msg: NormalizedMessage = {
      messageId: "msg1",
      senderId: "user1",
      text: "hello",
      chatId: "chat1",
      timestamp: Date.now(),
    };
    expectTypeOf(msg.messageId).toBeString();
    expectTypeOf(msg.senderName).toMatchTypeOf<string | undefined>();
    expectTypeOf(msg.threadId).toMatchTypeOf<string | undefined>();
    expectTypeOf(msg.replyToId).toMatchTypeOf<string | undefined>();
  });

  it("OutboundMessage has required and optional fields", () => {
    const msg: OutboundMessage = {
      target: "user1",
      text: "hello",
    };
    expectTypeOf(msg.card).toMatchTypeOf<unknown | undefined>();
    expectTypeOf(msg.replyToId).toMatchTypeOf<string | undefined>();
    expectTypeOf(msg.threadId).toMatchTypeOf<string | undefined>();
  });

  it("OutboundTarget specifies destination", () => {
    const target: OutboundTarget = {
      address: "user1",
    };
    expectTypeOf(target.channelId).toMatchTypeOf<string | undefined>();
    expectTypeOf(target.threadId).toMatchTypeOf<string | undefined>();
  });

  it("StreamTarget specifies streaming destination", () => {
    const target: StreamTarget = {
      address: "user1",
    };
    expectTypeOf(target.context).toMatchTypeOf<Record<string, unknown> | undefined>();
  });

  it("StreamingSession tracks active stream state", () => {
    const session: StreamingSession = {
      sessionId: "stream1",
      target: { address: "user1" },
      pendingUpdates: ["update1"],
      createdAt: Date.now(),
      flush: async () => {},
    };
    expectTypeOf(session.pendingUpdates).toBeArray();
    expectTypeOf(session.flush).toMatchTypeOf<() => Promise<void>>();
  });

  it("ThreadKey is a string brand", () => {
    const key: ThreadKey = "thread_key" as ThreadKey;
    expectTypeOf(key).toBeString();
  });

  it("ChannelConfigAdapter has required methods", () => {
    const adapter: ChannelConfigAdapter = {
      listAccountIds: () => [],
      resolveAccount: (id: string) => ({}),
    };
    expectTypeOf(adapter.listAccountIds).toMatchTypeOf<() => string[]>();
    expectTypeOf(adapter.resolveAccount).toMatchTypeOf<(id: string) => unknown>();
  });

  it("ChannelGatewayAdapter has startAccount required, stopAccount optional", () => {
    const adapter: ChannelGatewayAdapter = {
      startAccount: async (accountId: string, signal: AbortSignal) => {},
    };
    expectTypeOf(adapter.startAccount).toMatchTypeOf<
      (accountId: string, signal: AbortSignal) => Promise<void>
    >();
    expectTypeOf(adapter.stopAccount).toMatchTypeOf<
      | ((accountId: string) => Promise<void>)
      | undefined
    >();
  });

  it("ChannelMessagingAdapter has normalizeInbound and formatOutbound", () => {
    const adapter: ChannelMessagingAdapter = {
      normalizeInbound: (raw: unknown) => ({
        messageId: "1",
        senderId: "user1",
        text: "test",
        chatId: "chat1",
        timestamp: 0,
      }),
      formatOutbound: (msg: OutboundMessage) => ({}),
    };
    expectTypeOf(adapter.normalizeInbound).toMatchTypeOf<
      (raw: unknown) => NormalizedMessage
    >();
    expectTypeOf(adapter.formatOutbound).toMatchTypeOf<
      (msg: OutboundMessage) => unknown
    >();
  });

  it("ChannelOutboundAdapter has sendText required, sendCard optional", () => {
    const adapter: ChannelOutboundAdapter = {
      sendText: async (target: OutboundTarget, text: string) => {},
    };
    expectTypeOf(adapter.sendText).toMatchTypeOf<
      (target: OutboundTarget, text: string) => Promise<void>
    >();
    expectTypeOf(adapter.sendCard).toMatchTypeOf<
      | ((target: OutboundTarget, card: unknown) => Promise<void>)
      | undefined
    >();
  });

  it("ChannelStreamingAdapter has createStreamingSession required, coalesceUpdates optional", () => {
    const adapter: ChannelStreamingAdapter = {
      createStreamingSession: (target: StreamTarget) => ({
        sessionId: "s1",
        target,
        pendingUpdates: [],
        createdAt: 0,
        flush: async () => {},
      }),
    };
    expectTypeOf(adapter.createStreamingSession).toMatchTypeOf<
      (target: StreamTarget) => StreamingSession
    >();
    expectTypeOf(adapter.coalesceUpdates).toMatchTypeOf<
      | ((updates: string[], intervalMs: number) => string)
      | undefined
    >();
  });

  it("ChannelThreadingAdapter has all three methods required", () => {
    const adapter: ChannelThreadingAdapter = {
      resolveThread: (inbound: NormalizedMessage) => "thread_key" as ThreadKey,
      mapSession: (threadKey: ThreadKey, sessionId: string) => {},
      getSession: (threadKey: ThreadKey) => null,
    };
    expectTypeOf(adapter.resolveThread).toMatchTypeOf<
      (inbound: NormalizedMessage) => ThreadKey
    >();
    expectTypeOf(adapter.mapSession).toMatchTypeOf<
      (threadKey: ThreadKey, sessionId: string) => void
    >();
    expectTypeOf(adapter.getSession).toMatchTypeOf<
      (threadKey: ThreadKey) => string | null
    >();
  });

  it("ChannelPlugin requires id, meta, config", () => {
    const plugin: ChannelPlugin = {
      id: "feishu" as ChannelId,
      meta: {
        id: "feishu" as ChannelId,
        label: "Feishu",
        description: "Test",
      },
      config: {
        listAccountIds: () => [],
        resolveAccount: (id: string) => ({}),
      },
    };
    expectTypeOf(plugin.id).toBeString();
    expectTypeOf(plugin.meta).toMatchTypeOf<ChannelMeta>();
    expectTypeOf(plugin.config).toMatchTypeOf<ChannelConfigAdapter>();
  });

  it("ChannelPlugin has optional adapters", () => {
    const plugin: ChannelPlugin = {
      id: "feishu" as ChannelId,
      meta: {
        id: "feishu" as ChannelId,
        label: "Feishu",
        description: "Test",
      },
      config: {
        listAccountIds: () => [],
        resolveAccount: (id: string) => ({}),
      },
      gateway: undefined,
      messaging: undefined,
      outbound: undefined,
      streaming: undefined,
      threading: undefined,
    };
    expectTypeOf(plugin.gateway).toMatchTypeOf<ChannelGatewayAdapter | undefined>();
    expectTypeOf(plugin.messaging).toMatchTypeOf<ChannelMessagingAdapter | undefined>();
    expectTypeOf(plugin.outbound).toMatchTypeOf<ChannelOutboundAdapter | undefined>();
    expectTypeOf(plugin.streaming).toMatchTypeOf<ChannelStreamingAdapter | undefined>();
    expectTypeOf(plugin.threading).toMatchTypeOf<ChannelThreadingAdapter | undefined>();
  });

  it("ChannelPlugin accepts a fully implemented plugin", () => {
    const plugin: ChannelPlugin = {
      id: "feishu" as ChannelId,
      meta: {
        id: "feishu" as ChannelId,
        label: "Feishu",
        description: "Feishu integration",
      },
      config: {
        listAccountIds: () => ["account1"],
        resolveAccount: (id: string) => ({ token: "xyz" }),
      },
      gateway: {
        startAccount: async (accountId: string, signal: AbortSignal) => {
          console.log(`Starting ${accountId}`);
        },
        stopAccount: async (accountId: string) => {
          console.log(`Stopping ${accountId}`);
        },
      },
      messaging: {
        normalizeInbound: (raw: unknown) => ({
          messageId: "msg1",
          senderId: "user1",
          senderName: "User One",
          text: "hello",
          chatId: "chat1",
          threadId: "thread1",
          timestamp: Date.now(),
          replyToId: "msg0",
        }),
        formatOutbound: (msg: OutboundMessage) => ({
          content: msg.text,
        }),
      },
      outbound: {
        sendText: async (target: OutboundTarget, text: string) => {
          console.log(`Sending to ${target.address}: ${text}`);
        },
        sendCard: async (target: OutboundTarget, card: unknown) => {
          console.log(`Sending card to ${target.address}`);
        },
      },
      streaming: {
        createStreamingSession: (target: StreamTarget) => ({
          sessionId: "stream1",
          target,
          pendingUpdates: [],
          createdAt: Date.now(),
          flush: async () => {
            console.log("Flushing stream");
          },
        }),
        coalesceUpdates: (updates: string[], intervalMs: number) =>
          updates.join("\n"),
      },
      threading: {
        resolveThread: (inbound: NormalizedMessage) =>
          `thread_${inbound.chatId}` as ThreadKey,
        mapSession: (threadKey: ThreadKey, sessionId: string) => {
          console.log(`Mapped ${threadKey} to ${sessionId}`);
        },
        getSession: (threadKey: ThreadKey) => `session_${threadKey}`,
      },
    };
    expectTypeOf(plugin).toMatchTypeOf<ChannelPlugin>();
  });
});
