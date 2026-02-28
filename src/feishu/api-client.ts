/**
 * Feishu Open Platform REST API client.
 * Handles tenant_access_token lifecycle and core messaging APIs.
 */

import { createLogger } from "../utils/logger.js"
import type { FeishuMessageBody, FeishuApiResponse } from "../types.js"

const logger = createLogger("feishu-api")

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis"

interface FeishuApiClientOptions {
  appId: string
  appSecret: string
}

interface TokenState {
  token: string
  expiresAt: number
}

export interface FeishuApiClient {
  sendMessage(chatId: string, body: FeishuMessageBody): Promise<FeishuApiResponse>
  replyMessage(messageId: string, body: FeishuMessageBody): Promise<FeishuApiResponse>
  updateMessage(messageId: string, content: string): Promise<FeishuApiResponse>
  addReaction(messageId: string, emojiType: string): Promise<FeishuApiResponse>
  deleteReaction(messageId: string, reactionId: string): Promise<FeishuApiResponse>
  getMessage(messageId: string): Promise<FeishuApiResponse>
}

export function createFeishuApiClient(options: FeishuApiClientOptions): FeishuApiClient {
  const { appId, appSecret } = options
  let tokenState: TokenState | null = null
  let refreshPromise: Promise<string> | null = null

  async function getToken(): Promise<string> {
    const now = Date.now()

    // Token still valid (refresh 5 min early)
    if (tokenState && tokenState.expiresAt - now > 300_000) {
      return tokenState.token
    }

    // Deduplicate concurrent refresh calls
    if (refreshPromise) {
      return refreshPromise
    }

    refreshPromise = refreshToken()
    try {
      return await refreshPromise
    } finally {
      refreshPromise = null
    }
  }

  async function refreshToken(): Promise<string> {
    logger.info("Refreshing tenant_access_token...")

    const response = await fetch(
      `${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    )

    const data = (await response.json()) as {
      code: number
      msg: string
      tenant_access_token: string
      expire: number
    }

    if (data.code !== 0) {
      throw new Error(`Failed to get tenant_access_token: ${data.msg}`)
    }

    tokenState = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + data.expire * 1000,
    }

    logger.info(`Token refreshed, expires in ${data.expire}s`)
    return tokenState.token
  }

  async function apiRequest(
    method: string,
    urlPath: string,
    body?: Record<string, unknown>,
    retryCount = 0,
  ): Promise<FeishuApiResponse> {
    const token = await getToken()

    const response = await fetch(`${FEISHU_BASE_URL}${urlPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    const data = (await response.json()) as FeishuApiResponse

    // Token expired — refresh and retry once
    if (data.code === 99991663 && retryCount < 1) {
      tokenState = null
      return apiRequest(method, urlPath, body, retryCount + 1)
    }

    if (data.code !== 0) {
      logger.error(`Feishu API error [${urlPath}]: ${data.code} - ${data.msg}`)
    }

    return data
  }

  return {
    async sendMessage(chatId, body) {
      return apiRequest("POST", "/im/v1/messages?receive_id_type=chat_id", {
        receive_id: chatId,
        msg_type: body.msg_type,
        content: body.content,
      })
    },

    async replyMessage(messageId, body) {
      return apiRequest("POST", `/im/v1/messages/${messageId}/reply`, {
        msg_type: body.msg_type,
        content: body.content,
      })
    },

    async updateMessage(messageId, content) {
      return apiRequest("PATCH", `/im/v1/messages/${messageId}`, {
        content,
      })
    },


    async addReaction(messageId, emojiType) {
      return apiRequest("POST", `/im/v1/messages/${messageId}/reactions`, {
        reaction_type: { emoji_type: emojiType },
      })
    },

    async deleteReaction(messageId, reactionId) {
      return apiRequest("DELETE", `/im/v1/messages/${messageId}/reactions/${reactionId}`)
    },

    async getMessage(messageId) {
      return apiRequest("GET", `/im/v1/messages/${messageId}`)
    },
  }
}
