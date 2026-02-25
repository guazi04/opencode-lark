export interface CardKitSchema {
  schema: "2.0"
  config: {
    streaming_mode: boolean
    summary: { content: string }
    streaming_config?: {
      print_frequency_ms: { default: number }
      print_step: { default: number }
    }
  }
  body: {
    elements: CardElement[]
  }
}

export interface CardElement {
  tag: string
  content: string
  element_id: string
}

export class CardKitError extends Error {
  code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = "CardKitError"
    this.code = code
  }
}

const DEFAULT_API_BASE = "https://open.feishu.cn/open-apis"

interface TokenState {
  token: string
  expiresAt: number
}

interface ApiResponse {
  code: number
  msg: string
  data?: Record<string, unknown>
}

export class CardKitClient {
  private readonly appId: string
  private readonly appSecret: string
  private readonly apiBase: string
  private tokenState: TokenState | null = null
  private refreshPromise: Promise<string> | null = null

  constructor(options: { appId: string; appSecret: string; apiBase?: string }) {
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE
  }

  async createCard(cardJson: CardKitSchema): Promise<string> {
    const res = await this.apiRequest("POST", "/cardkit/v1/cards", {
      type: "card_json",
      data: JSON.stringify(cardJson),
    })

    const cardId = res.data?.card_id
    if (typeof cardId !== "string") {
      throw new CardKitError(res.code, "Missing card_id in response")
    }
    return cardId
  }

  async updateElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    await this.apiRequest(
      "PUT",
      `/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
      { content, sequence, uuid: `s_${cardId}_${sequence}` },
    )
  }

  async closeStreaming(
    cardId: string,
    summary: string,
    sequence: number,
  ): Promise<void> {
    await this.apiRequest("PATCH", `/cardkit/v1/cards/${cardId}/settings`, {
      settings: JSON.stringify({
        config: { streaming_mode: false, summary: { content: summary } },
      }),
      sequence,
      uuid: `c_${cardId}_${sequence}`,
    })
  }

  private async getToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenState && this.tokenState.expiresAt - now > 300_000) {
      return this.tokenState.token
    }

    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.refreshToken()
    try {
      return await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async refreshToken(): Promise<string> {
    const res = await fetch(
      `${this.apiBase}/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      },
    )

    const data = (await res.json()) as {
      code: number
      msg: string
      tenant_access_token?: string
      expire?: number
    }

    if (data.code !== 0 || !data.tenant_access_token) {
      throw new CardKitError(data.code, `Token error: ${data.msg}`)
    }

    this.tokenState = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
    }
    return this.tokenState.token
  }

  private async apiRequest(
    method: string,
    urlPath: string,
    body: Record<string, unknown>,
    retryCount = 0,
  ): Promise<ApiResponse> {
    const token = await this.getToken()

    const res = await fetch(`${this.apiBase}${urlPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })

    const data = (await res.json()) as ApiResponse

    if (data.code === 99991663 && retryCount < 1) {
      this.tokenState = null
      return this.apiRequest(method, urlPath, body, retryCount + 1)
    }

    if (data.code !== 0) {
      throw new CardKitError(data.code, data.msg)
    }

    return data
  }
}
