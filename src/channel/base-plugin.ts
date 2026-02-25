/**
 * Abstract base class implementing common ChannelPlugin patterns.
 * Provides default threading adapter and leaves required fields abstract.
 */

import type {
  ChannelPlugin,
  ChannelId,
  ChannelMeta,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  NormalizedMessage,
  ThreadKey,
} from "./types.js"

/**
 * BaseChannelPlugin — abstract base for channel integrations.
 *
 * Subclasses MUST provide:
 *   - id: ChannelId
 *   - meta: ChannelMeta
 *   - config: ChannelConfigAdapter
 *
 * Provides default implementations for:
 *   - threading: resolveThread, mapSession, getSession
 *
 * Optional adapters (gateway, messaging, outbound, streaming)
 * default to undefined — subclasses override as needed.
 */
export abstract class BaseChannelPlugin implements ChannelPlugin {
  abstract id: ChannelId
  abstract meta: ChannelMeta
  abstract config: ChannelConfigAdapter

  // Optional adapters — subclasses override as needed
  gateway?: ChannelGatewayAdapter
  messaging?: ChannelMessagingAdapter
  outbound?: ChannelOutboundAdapter
  streaming?: ChannelStreamingAdapter

  // Default threading adapter backed by an internal Map
  private readonly _threadSessionMap = new Map<ThreadKey, string>()

  threading: ChannelThreadingAdapter = {
    resolveThread: (inbound: NormalizedMessage): ThreadKey => {
      if (inbound.threadId) {
        return `${inbound.chatId}:${inbound.threadId}` as ThreadKey
      }
      return inbound.chatId as ThreadKey
    },

    mapSession: (threadKey: ThreadKey, sessionId: string): void => {
      this._threadSessionMap.set(threadKey, sessionId)
    },

    getSession: (threadKey: ThreadKey): string | null => {
      return this._threadSessionMap.get(threadKey) ?? null
    },
  }
}
