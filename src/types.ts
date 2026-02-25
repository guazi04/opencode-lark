/**
 * Shared type definitions for opencode-lark
 */

// ── Feishu Webhook Event Types ──

export interface FeishuMessageEvent {
  event_id: string
  event_type: string
  chat_id: string
  chat_type: "p2p" | "group"
  message_id: string
  root_id?: string
  parent_id?: string
  sender: FeishuSender
  message: FeishuMessageContent
}

export interface FeishuSender {
  sender_id: { open_id: string; user_id?: string }
  sender_type: string
  tenant_key: string
}

export interface FeishuMessageContent {
  message_type: string
  content: string
}

export interface FeishuCardAction {
  action: {
    tag: string
    value: Record<string, string>
  }
  open_message_id: string
  open_chat_id: string
  operator: { open_id: string }
}

// ── Feishu API Types ──

export interface FeishuMessageBody {
  msg_type: "text" | "interactive" | "image" | "file"
  content: string
}

export interface FeishuApiResponse {
  code: number
  msg: string
  data?: Record<string, unknown>
}

// ── Session Types ──

export interface SessionMapping {
  feishu_key: string
  session_id: string
  agent: string
  created_at: number
  last_active: number
  is_bound?: number
}
