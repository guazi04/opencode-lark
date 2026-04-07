/**
 * Slash command handler for Feishu → opencode bridge.
 *
 * Intercepts messages starting with "/" and routes them to
 * the appropriate opencode API endpoint instead of sending
 * them as plain text to the AI agent.
 */

import type { SessionManager } from "../session/session-manager.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"

// ── Dependency injection interface ──

export interface CommandHandlerDeps {
  serverUrl: string
  sessionManager: SessionManager
  feishuClient: FeishuApiClient
  logger: Logger
}

// ── Types ──

export type CommandHandler = (
  feishuKey: string,
  chatId: string,
  messageId: string,
  commandText: string,
) => Promise<boolean>

interface Session {
  id: string
  title?: string
  time?: { created: number; updated: number }
  summary?: { additions: number; deletions: number; files: number }
}

// ── Card builders ──

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = Math.max(0, now - timestamp)
  const diffMin = Math.floor(diffMs / 60_000)

  if (diffMin < 1) return "刚刚"
  if (diffMin < 60) return `${diffMin}分钟前`

  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}小时前`

  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}天前`
}

function truncateTitle(title: string, maxChars = 30): string {
  const trimmed = title.trim()
  if (trimmed.length <= maxChars) return trimmed
  if (maxChars <= 3) return trimmed.slice(0, maxChars)
  return trimmed.slice(0, maxChars - 3) + "..."
}

function buildSessionsCard(sessions: Session[], currentSessionId?: string): Record<string, unknown> {
  const recentSessions = sessions.slice(0, 10)
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "📋 选择会话",
      },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: "**点击连接到对应会话：**",
      },
      ...recentSessions.map((s) => {
        const isCurrentSession = s.id === currentSessionId
        const title = s.title?.trim() ? truncateTitle(s.title) : "未命名会话"
        const relative = s.time?.updated
          ? formatRelativeTime(s.time.updated)
          : "未知时间"
        const filesSegment =
          typeof s.summary?.files === "number" ? `${s.summary.files}文件` : null

        const segments = [title, relative, filesSegment].filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        )
        const label = `${isCurrentSession ? "▶ " : ""}${segments.join(" · ")}`
        return {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: label,
              },
              value: { action: "command_execute", command: `/connect ${s.id}` },
            },
          ],
        }
      }),
    ],
  }
}

// ── Help card builder ──

function buildHelpCard(): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "⚡ 命令菜单",
      },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: "**选择要执行的命令：**",
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🆕 新建会话" },
            type: "primary",
            value: { action: "command_execute", command: "/new" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔌 连接会话" },
            value: { action: "command_execute", command: "/sessions" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🛑 中止任务" },
            type: "danger",
            value: { action: "command_execute", command: "/abort" },
          },
        ],
      },
    ],
  }
}

// ── Factory ──

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  const { serverUrl, sessionManager, feishuClient, logger } = deps

  async function replyText(
    _chatId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    await feishuClient.replyMessage(messageId, {
      msg_type: "text",
      content: JSON.stringify({ text }),
    })
  }

  async function handleNew(
    feishuKey: string,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    const resp = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Feishu chat ${feishuKey}` }),
    })

    if (!resp.ok) {
      throw new Error(`Failed to create session: HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as { id: string }
    sessionManager.deleteMapping(feishuKey)
    sessionManager.setMapping(feishuKey, data.id)
    logger.info(`/new: created session ${data.id}, bound ${feishuKey}`)
    await replyText(chatId, messageId, `已创建并切换到新会话: ${data.id}`)
  }

  async function handleAbort(
    feishuKey: string,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }

    const resp = await fetch(
      `${serverUrl}/session/${mapping.session_id}/abort`,
      { method: "POST" },
    )

    if (!resp.ok) {
      throw new Error(`Abort failed: HTTP ${resp.status}`)
    }

    logger.info(`/abort: aborted session ${mapping.session_id}`)
    await replyText(chatId, messageId, `已中止会话: ${mapping.session_id}`)
  }

  async function handleSessions(
    feishuKey: string,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    const resp = await fetch(`${serverUrl}/session`)
    if (!resp.ok) {
      throw new Error(`List sessions failed: HTTP ${resp.status}`)
    }

    let sessions = (await resp.json()) as Session[]
    if (sessions.length === 0) {
      await replyText(chatId, messageId, "暂无会话。")
      return
    }

    // Get current bound session for this chat
    const currentSessionId = await sessionManager.getExisting(feishuKey)

    if (currentSessionId) {
      // Check if it's already in the list
      const existingIndex = sessions.findIndex((s) => s.id === currentSessionId)
      if (existingIndex >= 0) {
        // Move it to top
        const current = sessions.splice(existingIndex, 1)[0]
        if (current) {
          sessions.unshift(current)
        }
      } else {
        // Not in API response at all — add it manually at top
        const now = Date.now()
        sessions.unshift({ id: currentSessionId, title: "当前会话", time: { created: now, updated: now } })
      }
    }

    const card = buildSessionsCard(sessions, currentSessionId)
    await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
  }

  async function handleConnect(
    feishuKey: string,
    chatId: string,
    messageId: string,
    targetSessionId: string,
  ): Promise<void> {
    // Validate session exists
    const checkResp = await fetch(`${serverUrl}/session/${targetSessionId}`)
    if (!checkResp.ok) {
      await replyText(chatId, messageId, "会话不存在。")
      return
    }

    // Unbind current mapping if exists
    sessionManager.deleteMapping(feishuKey)

    // Set new mapping
    const success = sessionManager.setMapping(feishuKey, targetSessionId)
    if (success) {
      logger.info(`/connect: bound ${feishuKey} to session ${targetSessionId}`)
      await replyText(chatId, messageId, `已连接到会话: ${targetSessionId}`)
    } else {
      throw new Error("Failed to set session mapping")
    }
  }

  async function handleHelp(
    _chatId: string,
    messageId: string,
  ): Promise<void> {
    const card = buildHelpCard()
    await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
  }

  return async function handleCommand(
    feishuKey: string,
    chatId: string,
    messageId: string,
    commandText: string,
  ): Promise<boolean> {
    const trimmed = commandText.trim()
    const parts = trimmed.split(/\s+/)
    const cmd = parts[0]?.toLowerCase()

    if (!cmd || !cmd.startsWith("/")) return false

    logger.info(`Slash command: ${cmd} from ${feishuKey}`)

    try {
      switch (cmd) {
        case "/new":
          await handleNew(feishuKey, chatId, messageId)
          return true

        case "/abort":
          await handleAbort(feishuKey, chatId, messageId)
          return true

        case "/sessions":
          await handleSessions(feishuKey, chatId, messageId)
          return true

        case "/connect": {
          const targetSessionId = parts[1]
          if (!targetSessionId) {
            await replyText(chatId, messageId, "用法: /connect {session_id}")
            return true
          }
          await handleConnect(feishuKey, chatId, messageId, targetSessionId)
          return true
        }
          
        // 为了将会话和模型绑定，否则飞书无法在创建新会话后正常和OpenCode通信
        // 飞书新会话操作第一步： / or /help or /new and /connect
        // 第二步：/bindmodel ses_29aaaaaaaaaa omlx.server/qwen3.5-9b
        case "/bindmodel": {
          let targetSessionId = parts[1]
          let modelId = parts[2]
          if (!targetSessionId || !modelId) {
            await replyText(chatId, messageId, "用法: /bindmodel {session_id} {model_id}")
            return true
          }
          const stripQuotes = (s: string) => s.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
          targetSessionId = stripQuotes(targetSessionId)
          modelId = stripQuotes(modelId)

          const { execSync } = await import('node:child_process')

          const command = `opencode -s ${JSON.stringify(targetSessionId)} -m ${JSON.stringify(modelId)} run ${JSON.stringify("a")}`
          logger.info(`Executing (sync): ${command}`)
          execSync(command, {
            timeout: 10000,
            cwd: process.env.OPENCODE_CWD || process.cwd(),
            env: process.env,
            stdio: 'inherit',  // 让命令的输出实时显示在控制台（可选）
          })
          await replyText(chatId, messageId, `✅ 已绑定模型 ${modelId} 到会话 ${targetSessionId}`)
          return true
        }
          
        case "/":
        case "/help":
          await handleHelp(chatId, messageId)
          return true

        default:
          return false
      }
    } catch (err) {
      logger.error(`Command ${cmd} failed: ${err}`)
      try {
        await replyText(chatId, messageId, `命令执行失败: ${err}`)
      } catch (replyErr) {
        logger.error(`Failed to send error reply: ${replyErr}`)
      }
      return true
    }
  }
}
