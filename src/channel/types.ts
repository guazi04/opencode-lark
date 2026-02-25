/**
 * ChannelPlugin type definitions for opencode-lark
 * Defines the core plugin contract for channel integrations.
 * Inspired by openclaw but independently defined.
 */

// ── Core Type Aliases ──

/** Unique identifier for a channel provider (e.g., "feishu", "slack", "discord") */
export type ChannelId = string & { readonly __brand: "ChannelId" };

/**
 * Metadata describing a channel plugin
 */
export interface ChannelMeta {
  /** Unique channel identifier */
  id: ChannelId;
  /** Human-readable label (e.g., "Feishu") */
  label: string;
  /** Long-form description of the channel */
  description: string;
}

// ── Message Types ──

/**
 * Normalized representation of an inbound message from a channel
 */
export interface NormalizedMessage {
  /** Unique message ID in the channel */
  messageId: string;
  /** Sender's unique identifier */
  senderId: string;
  /** Human-readable sender name */
  senderName?: string;
  /** Message text content */
  text: string;
  /** Chat/thread/group identifier */
  chatId: string;
  /** Optional: unique identifier for a thread this message belongs to */
  threadId?: string;
  /** Unix timestamp when message was sent */
  timestamp: number;
  /** Optional: ID of a message this one replies to */
  replyToId?: string;
}

/**
 * Message prepared for sending to a channel
 */
export interface OutboundMessage {
  /** Target recipient/channel ID */
  target: string;
  /** Message text content */
  text: string;
  /** Optional: formatted card/rich content (channel-specific format) */
  card?: unknown;
  /** Optional: reply-to message ID */
  replyToId?: string;
  /** Optional: thread ID for threaded channels */
  threadId?: string;
}

/**
 * Destination specification for an outbound message
 */
export interface OutboundTarget {
  /** Target address (user ID, channel ID, etc.) */
  address: string;
  /** Optional: channel/group ID if different from address */
  channelId?: string;
  /** Optional: thread ID for threaded messaging */
  threadId?: string;
}

/**
 * Destination for streaming operations
 */
export interface StreamTarget {
  /** Target address for streaming updates */
  address: string;
  /** Optional: context metadata */
  context?: Record<string, unknown>;
}

/**
 * Active streaming session for coalesced updates
 */
export interface StreamingSession {
  /** Unique session identifier */
  sessionId: string;
  /** Target for this streaming session */
  target: StreamTarget;
  /** Accumulated updates pending send */
  pendingUpdates: string[];
  /** Timestamp when session was created */
  createdAt: number;
  /** Function to flush accumulated updates */
  flush: () => Promise<void>;
}

/**
 * Key identifying a thread for message threading operations
 */
export type ThreadKey = string & { readonly __brand: "ThreadKey" };

// ── Adapter Types ──

/**
 * Adapter for configuring channel accounts and resolving credentials
 */
export interface ChannelConfigAdapter {
  /**
   * List all configured account IDs for this channel
   */
  listAccountIds(): string[];

  /**
   * Resolve a channel account to its full configuration/credentials
   * @param id Account ID to resolve
   * @returns Resolved account object (channel-specific structure)
   */
  resolveAccount(id: string): unknown;
}

/**
 * Adapter for channel gateway connection lifecycle
 */
export interface ChannelGatewayAdapter {
  /**
   * Start a channel account connection
   * @param accountId Account ID to start
   * @param signal Abort signal to stop the operation
   */
  startAccount(accountId: string, signal: AbortSignal): Promise<void>;

  /**
   * Optional: Stop a channel account connection
   * @param accountId Account ID to stop
   */
  stopAccount?(accountId: string): Promise<void>;
}

/**
 * Adapter for message normalization and formatting between inbound/outbound
 */
export interface ChannelMessagingAdapter {
  /**
   * Normalize a raw channel message to standard format
   * @param raw Raw message object from channel provider
   * @returns Normalized message
   */
  normalizeInbound(raw: unknown): NormalizedMessage;

  /**
   * Format an outbound message to channel-specific format
   * @param msg Message to format
   * @returns Channel-specific message object
   */
  formatOutbound(msg: OutboundMessage): unknown;
}

/**
 * Adapter for sending messages to a channel
 */
export interface ChannelOutboundAdapter {
  /**
   * Send text message to a target
   * @param target Destination specification
   * @param text Message text to send
   */
  sendText(target: OutboundTarget, text: string): Promise<void>;

  /**
   * Optional: Send rich card/formatted message
   * @param target Destination specification
   * @param card Card object (channel-specific format)
   */
  sendCard?(target: OutboundTarget, card: unknown): Promise<void>;
}

/**
 * Adapter for streaming message updates with optional coalescing
 */
export interface ChannelStreamingAdapter {
  /**
   * Create a new streaming session for a target
   * @param target Target to stream to
   * @returns Active streaming session
   */
  createStreamingSession(target: StreamTarget): StreamingSession;

  /**
   * Optional: Coalesce multiple updates into a single message
   * @param updates Array of update strings
   * @param intervalMs Time window for coalescing
   * @returns Coalesced update string
   */
  coalesceUpdates?(updates: string[], intervalMs: number): string;
}

/**
 * Adapter for thread/conversation tracking
 */
export interface ChannelThreadingAdapter {
  /**
   * Resolve a thread key from an inbound message
   * @param inbound Normalized inbound message
   * @returns Unique thread key
   */
  resolveThread(inbound: NormalizedMessage): ThreadKey;

  /**
   * Map a thread key to a session ID
   * @param threadKey Thread key to map
   * @param sessionId Agent session ID
   */
  mapSession(threadKey: ThreadKey, sessionId: string): void;

  /**
   * Get the session ID for a thread
   * @param threadKey Thread key to look up
   * @returns Session ID if mapped, null otherwise
   */
  getSession(threadKey: ThreadKey): string | null;
}

// ── Plugin Root ──

/**
 * Main ChannelPlugin contract
 * Defines required and optional adapters for a channel integration
 */
export interface ChannelPlugin {
  /** Unique channel identifier */
  id: ChannelId;

  /** Channel metadata */
  meta: ChannelMeta;

  /** Configuration adapter (REQUIRED) */
  config: ChannelConfigAdapter;

  /** Gateway adapter for connection lifecycle (OPTIONAL) */
  gateway?: ChannelGatewayAdapter;

  /** Message normalization and formatting (OPTIONAL) */
  messaging?: ChannelMessagingAdapter;

  /** Outbound message sending (OPTIONAL) */
  outbound?: ChannelOutboundAdapter;

  /** Streaming update delivery (OPTIONAL) */
  streaming?: ChannelStreamingAdapter;

  /** Thread/conversation tracking (OPTIONAL) */
  threading?: ChannelThreadingAdapter;
}
