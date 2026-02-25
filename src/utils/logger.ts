/**
 * Structured logger with namespace support.
 */

type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getConfiguredLevel(): LogLevel {
  const env = process.env["OHMYOPENCLAW_LOG_LEVEL"]
  if (env && env in LOG_LEVELS) return env as LogLevel
  return "info"
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export function createLogger(namespace: string): Logger {
  const minLevel = LOG_LEVELS[getConfiguredLevel()]
  const prefix = `[${namespace}]`

  function log(level: LogLevel, message: string, args: unknown[]) {
    if (LOG_LEVELS[level] < minLevel) return
    const timestamp = new Date().toISOString()
    const tag = `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix}`
    if (args.length > 0) {
      console[level === "debug" ? "log" : level](`${tag} ${message}`, ...args)
    } else {
      console[level === "debug" ? "log" : level](`${tag} ${message}`)
    }
  }

  return {
    debug: (msg, ...a) => log("debug", msg, a),
    info: (msg, ...a) => log("info", msg, a),
    warn: (msg, ...a) => log("warn", msg, a),
    error: (msg, ...a) => log("error", msg, a),
  }
}
