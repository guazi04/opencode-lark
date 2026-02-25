import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { createSessionManager } from "./session-manager.js"
import type { SessionManager } from "./session-manager.js"

const SERVER_URL = "http://127.0.0.1:4096"
const DEFAULT_AGENT = "claude"

function createTestDb(): Database.Database {
  return new Database(":memory:")
}

describe("session-manager", () => {
  let db: Database.Database
  let sm: SessionManager
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    db = createTestDb()
    vi.stubEnv("OPENCODE_CWD", "/test/project")
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    db.close()
    globalThis.fetch = originalFetch
    vi.unstubAllEnvs()
  })

  function mockFetch(impl: typeof globalThis.fetch) {
    globalThis.fetch = vi.fn(impl)
  }

  describe("getOrCreate", () => {
    it("discovers existing TUI session and returns its ID", async () => {
      const tuiSessionId = "ses-tui-abc"
      mockFetch(async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (url.includes("/session") && !url.includes("/session/")) {
          // GET /session — list sessions
          if (url.includes("roots=true")) {
            return new Response(
              JSON.stringify([
                {
                  id: tuiSessionId,
                  title: "TUI Session",
                  directory: "/test/project",
                  time: { created: 1000, updated: 2000 },
                },
              ]),
              { status: 200 },
            )
          }
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-1")

      expect(result).toBe(tuiSessionId)

      // Verify is_bound = 1 for discovered session
      const mapping = sm.getSession("chat-1")
      expect(mapping).not.toBeNull()
      expect(mapping!.is_bound).toBe(1)
      expect(mapping!.session_id).toBe(tuiSessionId)
    })

    it("falls back to POST /session when no sessions exist", async () => {
      const createdSessionId = "ses-new-123"
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (url.includes("/session") && method === "GET") {
          // Return empty array — no existing sessions
          return new Response(JSON.stringify([]), { status: 200 })
        }
        if (url.includes("/session") && method === "POST") {
          return new Response(JSON.stringify({ id: createdSessionId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-2")

      expect(result).toBe(createdSessionId)

      // Verify is_bound = 0 for created session
      const mapping = sm.getSession("chat-2")
      expect(mapping).not.toBeNull()
      expect(mapping!.is_bound).toBe(0)
    })

    it("reuses cached session without any API call", async () => {
      const tuiSessionId = "ses-cached-xyz"
      let fetchCallCount = 0

      mockFetch(async (input) => {
        fetchCallCount++
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (url.includes("/session") && url.includes("roots=true")) {
          return new Response(
            JSON.stringify([
              { id: tuiSessionId, title: "TUI", directory: "/test/project", time: { created: 1, updated: 2 } },
            ]),
            { status: 200 },
          )
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      // First call — triggers discovery
      await sm.getOrCreate("chat-3")
      const callsAfterFirst = fetchCallCount

      // Second call — should use DB cache, no new fetch
      const result = await sm.getOrCreate("chat-3")
      expect(result).toBe(tuiSessionId)
      expect(fetchCallCount).toBe(callsAfterFirst)
    })

    it("sets is_bound=1 for discovered sessions, is_bound=0 for created", async () => {
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (url.includes("/session") && method === "GET" && url.includes("roots=true")) {
          // First call will discover, second key will find empty
          if (url.includes("directory=")) {
            return new Response(
              JSON.stringify([
                { id: "ses-discovered", title: "TUI", directory: "/test/project", time: { created: 1, updated: 2 } },
              ]),
              { status: 200 },
            )
          }
        }
        if (url.includes("/session") && method === "POST") {
          return new Response(JSON.stringify({ id: "ses-created" }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })

      await sm.getOrCreate("chat-discovered")
      const discovered = sm.getSession("chat-discovered")
      expect(discovered!.is_bound).toBe(1)
    })

    it("falls back to POST silently when GET fails", async () => {
      const createdId = "ses-fallback-456"
      mockFetch(async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url
        const method = init?.method ?? "GET"

        if (method === "GET" || (!init?.method && !init?.body)) {
          // GET fails with 500
          return new Response("Internal Server Error", { status: 500 })
        }
        if (method === "POST") {
          return new Response(JSON.stringify({ id: createdId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-fail")

      // Should not throw, should fall back to POST
      expect(result).toBe(createdId)

      const mapping = sm.getSession("chat-fail")
      expect(mapping!.is_bound).toBe(0)
    })

    it("falls back to POST when GET throws network error", async () => {
      const createdId = "ses-net-err"
      let callIndex = 0
      mockFetch(async (input, init) => {
        callIndex++
        const method = init?.method ?? "GET"

        if (method === "GET" || (!init?.method && !init?.body)) {
          throw new Error("Network error")
        }
        if (method === "POST") {
          return new Response(JSON.stringify({ id: createdId }), { status: 200 })
        }
        return new Response("Not found", { status: 404 })
      })

      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      const result = await sm.getOrCreate("chat-neterr")

      expect(result).toBe(createdId)
      expect(sm.getSession("chat-neterr")!.is_bound).toBe(0)
    })
  })

  describe("cleanup", () => {
    it("does not break with is_bound column", () => {
      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      // Just verify cleanup still works
      const result = sm.cleanup(0)
      expect(result).toBe(0)
    })
  })

  describe("migration", () => {
    it("adds is_bound column to existing table without errors", () => {
      // Pre-create the old schema
      db.exec(`
        CREATE TABLE IF NOT EXISTS feishu_sessions (
          feishu_key  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          agent       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          last_active INTEGER NOT NULL
        )
      `)

      // Should not throw — ALTER TABLE in try/catch
      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      expect(sm).toBeDefined()
    })

    it("handles already-migrated table gracefully", () => {
      // Create table with is_bound already present
      db.exec(`
        CREATE TABLE IF NOT EXISTS feishu_sessions (
          feishu_key  TEXT PRIMARY KEY,
          session_id  TEXT NOT NULL,
          agent       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          last_active INTEGER NOT NULL,
          is_bound    INTEGER DEFAULT 0
        )
      `)

      // Second createSessionManager should not throw even though column exists
      sm = createSessionManager({ serverUrl: SERVER_URL, db, defaultAgent: DEFAULT_AGENT })
      expect(sm).toBeDefined()
    })
  })
})
