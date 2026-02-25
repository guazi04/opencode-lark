import type Database from "better-sqlite3"
import { createLogger } from "../utils/logger.js"

const logger = createLogger("memory-manager")

interface MemoryManagerOptions {
  db: Database.Database
}

export interface MemorySearchResult {
  session_id: string
  snippet: string
  rank: number
}

export interface MemoryManager {
  saveMemory(sessionId: string, content: string): void
  searchMemory(query: string, limit?: number): MemorySearchResult[]
}

export function createMemoryManager(options: MemoryManagerOptions): MemoryManager {
  const { db } = options

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      session_id,
      content,
      tokenize='unicode61'
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)

  const insertEntryStmt = db.prepare(
    "INSERT INTO memory_entries (session_id, content, created_at) VALUES (?, ?, ?)",
  )

  const insertFtsStmt = db.prepare(
    "INSERT INTO memory_fts (session_id, content) VALUES (?, ?)",
  )

  const searchStmt = db.prepare<[string, number], { session_id: string; snippet: string; rank: number }>(`
    SELECT session_id, snippet(memory_fts, 1, '<b>', '</b>', '...', 64) as snippet, rank
    FROM memory_fts
    WHERE memory_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `)

  return {
    saveMemory(sessionId, content) {
      try {
        insertEntryStmt.run(sessionId, content, Date.now())
        insertFtsStmt.run(sessionId, content)
        logger.debug(`Saved memory for session ${sessionId} (${content.length} chars)`)
      } catch (error) {
        logger.error(`Failed to save memory: ${error}`)
      }
    },

    searchMemory(query, limit = 5) {
      try {
        const ftsQuery = query
          .replace(/[^\w\u4e00-\u9fff\s]/g, "")
          .split(/\s+/)
          .filter(Boolean)
          .join(" OR ")

        if (!ftsQuery) return []

        return searchStmt.all(ftsQuery, limit)
      } catch (error) {
        logger.error(`Memory search failed: ${error}`)
        return []
      }
    },
  }
}
