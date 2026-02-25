/**
 * ChannelManager — manages registered channel plugins and their lifecycles.
 * Provides register, startAll, stopAll, getChannel, listChannels.
 */

import type { ChannelPlugin, ChannelId } from "./types.js"
import type { Logger } from "../utils/logger.js"

export interface ChannelManagerOptions {
  logger: Logger
}

export class ChannelManager {
  private readonly channels = new Map<ChannelId, ChannelPlugin>()
  private readonly logger: Logger

  constructor(options: ChannelManagerOptions) {
    this.logger = options.logger
  }

  /**
   * Register a channel plugin by its id.
   */
  register(plugin: ChannelPlugin): void {
    this.channels.set(plugin.id, plugin)
    this.logger.info(`Channel registered: ${plugin.id}`)
  }

  /**
   * Start all registered channels that have a gateway adapter.
   * Error isolation: one channel failing does not prevent others from starting.
   */
  async startAll(signal: AbortSignal): Promise<void> {
    for (const plugin of this.channels.values()) {
      if (!plugin.gateway) {
        this.logger.info(`Channel ${plugin.id} has no gateway, skipping start`)
        continue
      }
      try {
        await plugin.gateway.startAccount("default", signal)
        this.logger.info(`Channel ${plugin.id} started`)
      } catch (err) {
        this.logger.error(`Channel ${plugin.id} failed to start`, err)
      }
    }
  }

  /**
   * Stop all registered channels that have a gateway adapter.
   * Error isolation: one channel failing does not prevent others from stopping.
   */
  async stopAll(): Promise<void> {
    for (const plugin of this.channels.values()) {
      if (!plugin.gateway?.stopAccount) {
        continue
      }
      try {
        await plugin.gateway.stopAccount("default")
        this.logger.info(`Channel ${plugin.id} stopped`)
      } catch (err) {
        this.logger.error(`Channel ${plugin.id} failed to stop`, err)
      }
    }
  }

  /**
   * Get a channel plugin by id.
   */
  getChannel(id: ChannelId): ChannelPlugin | undefined {
    return this.channels.get(id)
  }

  /**
   * List all registered channel plugins.
   */
  listChannels(): ChannelPlugin[] {
    return [...this.channels.values()]
  }
}