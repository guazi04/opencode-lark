import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { CardKitClient, CardKitError } from "./cardkit-client.js"
import type { CardKitSchema } from "./cardkit-client.js"

// ── Helpers ──

function tokenResponse(token = "test-token", expire = 7200) {
  return { code: 0, msg: "ok", tenant_access_token: token, expire }
}

function okResponse(data?: Record<string, unknown>) {
  return { code: 0, msg: "ok", data }
}

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response
}

const sampleCard: CardKitSchema = {
  schema: "2.0",
  config: {
    streaming_mode: true,
    summary: { content: "[Generating...]" },
    streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 2 } },
  },
  body: {
    elements: [{ tag: "markdown", content: "⏳ Thinking...", element_id: "content" }],
  },
}

// ── Tests ──

describe("CardKitClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let client: CardKitClient
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    mockFetch = vi.fn()
    globalThis.fetch = mockFetch as typeof fetch
    client = new CardKitClient({ appId: "app-id", appSecret: "app-secret" })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function queueResponses(...bodies: unknown[]) {
    for (const body of bodies) {
      mockFetch.mockResolvedValueOnce(jsonResponse(body))
    }
  }

  // ── createCard ──

  it("createCard posts to correct URL and returns cardId", async () => {
    queueResponses(tokenResponse(), okResponse({ card_id: "card-123" }))

    const cardId = await client.createCard(sampleCard)

    expect(cardId).toBe("card-123")

    expect(mockFetch.mock.calls[0]![0]).toBe(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    )

    const [url, init] = mockFetch.mock.calls[1]!
    expect(url).toBe("https://open.feishu.cn/open-apis/cardkit/v1/cards")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Bearer test-token")

    const body = JSON.parse(init.body as string)
    expect(body.type).toBe("card_json")
    expect(JSON.parse(body.data)).toEqual(sampleCard)
  })

  // ── updateElement ──

  it("updateElement sends PUT with correct path and params", async () => {
    queueResponses(tokenResponse(), okResponse())

    await client.updateElement("card-123", "content", "Hello world", 5)

    const [url, init] = mockFetch.mock.calls[1]!
    expect(url).toBe(
      "https://open.feishu.cn/open-apis/cardkit/v1/cards/card-123/elements/content/content",
    )
    expect(init.method).toBe("PUT")

    const body = JSON.parse(init.body as string)
    expect(body.content).toBe("Hello world")
    expect(body.sequence).toBe(5)
    expect(body.uuid).toBe("s_card-123_5")
  })

  // ── closeStreaming ──

  it("closeStreaming sends PATCH with correct settings", async () => {
    queueResponses(tokenResponse(), okResponse())

    await client.closeStreaming("card-123", "Summary text", 10)

    const [url, init] = mockFetch.mock.calls[1]!
    expect(url).toBe("https://open.feishu.cn/open-apis/cardkit/v1/cards/card-123/settings")
    expect(init.method).toBe("PATCH")

    const body = JSON.parse(init.body as string)
    expect(body.sequence).toBe(10)
    expect(body.uuid).toBe("c_card-123_10")

    const settings = JSON.parse(body.settings)
    expect(settings.config.streaming_mode).toBe(false)
    expect(settings.config.summary.content).toBe("Summary text")
  })

  // ── Error handling ──

  it("throws CardKitError on non-zero response code", async () => {
    queueResponses(tokenResponse(), { code: 230001, msg: "Card creation failed" })

    try {
      await client.createCard(sampleCard)
      expect.fail("Should have thrown CardKitError")
    } catch (err) {
      expect(err).toBeInstanceOf(CardKitError)
      expect((err as CardKitError).code).toBe(230001)
      expect((err as CardKitError).message).toBe("Card creation failed")
    }
  })

  // ── Token refresh on 401/expired ──

  it("retries with fresh token on 99991663 (token expired)", async () => {
    queueResponses(
      tokenResponse("expired-token"),
      { code: 99991663, msg: "token expired" },
      tokenResponse("fresh-token"),
      okResponse({ card_id: "card-456" }),
    )

    const cardId = await client.createCard(sampleCard)

    expect(cardId).toBe("card-456")
    expect(mockFetch).toHaveBeenCalledTimes(4)

    const retryInit = mockFetch.mock.calls[3]![1]
    expect(retryInit.headers.Authorization).toBe("Bearer fresh-token")
  })

  // ── Sequence number correctness ──

  it("passes sequence number correctly in update and close", async () => {
    queueResponses(tokenResponse(), okResponse())
    await client.updateElement("card-1", "el-1", "text", 42)

    const updateBody = JSON.parse(mockFetch.mock.calls[1]![1].body as string)
    expect(updateBody.sequence).toBe(42)
    expect(updateBody.uuid).toBe("s_card-1_42")

    queueResponses(okResponse())
    await client.closeStreaming("card-1", "Done", 99)

    const closeBody = JSON.parse(mockFetch.mock.calls[2]![1].body as string)
    expect(closeBody.sequence).toBe(99)
    expect(closeBody.uuid).toBe("c_card-1_99")
  })

  // ── Custom apiBase ──

  it("uses custom apiBase when provided", async () => {
    const customClient = new CardKitClient({
      appId: "app-id",
      appSecret: "app-secret",
      apiBase: "https://custom.api.com/open-apis",
    })

    queueResponses(tokenResponse(), okResponse({ card_id: "card-789" }))
    await customClient.createCard(sampleCard)

    expect(mockFetch.mock.calls[0]![0]).toBe(
      "https://custom.api.com/open-apis/auth/v3/tenant_access_token/internal",
    )
    expect(mockFetch.mock.calls[1]![0]).toBe(
      "https://custom.api.com/open-apis/cardkit/v1/cards",
    )
  })

  // ── Token caching ──

  it("caches token across multiple calls", async () => {
    queueResponses(tokenResponse(), okResponse({ card_id: "c1" }), okResponse({ card_id: "c2" }))

    await client.createCard(sampleCard)
    await client.createCard(sampleCard)

    expect(mockFetch).toHaveBeenCalledTimes(3)
  })
})
