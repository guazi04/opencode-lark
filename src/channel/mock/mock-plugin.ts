/**
 * MockPlugin — minimal channel plugin for testing the ChannelPlugin abstraction.
 * Uses an in-memory message queue to record sent messages.
 * NOT for production use.
 */

import { BaseChannelPlugin } from "../base-plugin.js"
import type {
  ChannelId,
  ChannelMeta,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  OutboundTarget,
} from "../types.js"

export interface MockSentMessage {
  target: OutboundTarget
  text: string
}

export class MockPlugin extends BaseChannelPlugin {
  override id = "mock" as ChannelId
  override meta: ChannelMeta = {
    id: "mock" as ChannelId,
    label: "Mock Channel",
    description: "In-memory mock channel for testing",
  }

  /** Public record of all messages sent through outbound */
  readonly sentMessages: MockSentMessage[] = []

  /** Track gateway startAccount calls */
  readonly startedAccounts: string[] = []

  override config: ChannelConfigAdapter
  override gateway: ChannelGatewayAdapter
  override outbound: ChannelOutboundAdapter

  constructor() {
    super()

    this.config = {
      listAccountIds: () => ["test-acct"],
      resolveAccount: (id: string) => ({ id, type: "mock" }),
    }

    this.gateway = {
      startAccount: async (accountId: string, _signal: AbortSignal): Promise<void> => {
        this.startedAccounts.push(accountId)
      },
      stopAccount: async (accountId: string): Promise<void> => {
        // no-op for mock
      },
    }

    this.outbound = {
      sendText: async (target: OutboundTarget, text: string): Promise<void> => {
        this.sentMessages.push({ target, text })
      },
    }
  }
}