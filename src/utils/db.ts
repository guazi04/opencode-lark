/**
 * SQLite database initialization.
 * Creates data directory and opens a single database for session mappings.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import { createLogger } from "./logger.js"

const logger = createLogger("db")

export interface AppDatabase {
  sessions: Database.Database
  memory: Database.Database
  close(): void
}

export function initDatabase(dataDir: string): AppDatabase {
  // Ensure data directory exists
  const resolvedDir = path.resolve(dataDir)
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true })
    logger.info(`Created data directory: ${resolvedDir}`)
  }

  const sessionsDbPath = path.join(resolvedDir, "sessions.db")
  const sessionsDb = new Database(sessionsDbPath)

  // Enable WAL mode for better concurrent read performance
  sessionsDb.pragma("journal_mode = WAL")


  const memoryDbPath = path.join(resolvedDir, "memory.db")
  const memoryDb = new Database(memoryDbPath)
  memoryDb.pragma("journal_mode = WAL")
  logger.info(`Database initialized at ${sessionsDbPath}`)

  return {
    sessions: sessionsDb,
    memory: memoryDb,
    close() {
      sessionsDb.close()
      memoryDb.close()
      logger.info("Database connections closed")
    },
  }
}
