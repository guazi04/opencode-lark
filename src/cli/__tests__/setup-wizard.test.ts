import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import { CONFIG_DIR } from "../../utils/env-loader.js"

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { needsSetup } from "../setup-wizard.js"

describe("setup-wizard", () => {
  const mockExistsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>
  const mockReaddirSync = fs.readdirSync as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockExistsSync.mockClear()
    mockReaddirSync.mockClear()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns true when no env files, no config file, no env vars, and TTY is true", async () => {
    // CONFIG_DIR does not exist, no config files in cwd
    mockExistsSync.mockReturnValue(false)
    vi.stubEnv("FEISHU_APP_ID", "")
    vi.stubEnv("FEISHU_APP_SECRET", "")
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

    const result = await needsSetup()

    expect(result).toBe(true)
  })

  it("returns false when FEISHU_APP_ID and FEISHU_APP_SECRET are set", async () => {
    mockExistsSync.mockReturnValue(false)
    vi.stubEnv("FEISHU_APP_ID", "test_app_id")
    vi.stubEnv("FEISHU_APP_SECRET", "test_app_secret")
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

    const result = await needsSetup()

    expect(result).toBe(false)
  })

  it("returns false when a config file exists in cwd", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === CONFIG_DIR) return false // no env files dir
      return String(p).includes("opencode-lark.jsonc")
    })
    vi.stubEnv("FEISHU_APP_ID", "")
    vi.stubEnv("FEISHU_APP_SECRET", "")
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

    const result = await needsSetup()

    expect(result).toBe(false)
  })

  it("returns false when process.stdin.isTTY is false", async () => {
    mockExistsSync.mockReturnValue(false)
    vi.stubEnv("FEISHU_APP_ID", "")
    vi.stubEnv("FEISHU_APP_SECRET", "")
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })

    const result = await needsSetup()

    expect(result).toBe(false)
  })

  it("returns true when FEISHU_APP_ID is set but FEISHU_APP_SECRET is empty", async () => {
    mockExistsSync.mockReturnValue(false)
    vi.stubEnv("FEISHU_APP_ID", "test_app_id")
    vi.stubEnv("FEISHU_APP_SECRET", "")
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

    const result = await needsSetup()

    // One env var set but the other empty → setup is still needed
    expect(result).toBe(true)
  })

  it("returns true when FEISHU_APP_SECRET is set but FEISHU_APP_ID is empty", async () => {
    mockExistsSync.mockReturnValue(false)
    vi.stubEnv("FEISHU_APP_ID", "")
    vi.stubEnv("FEISHU_APP_SECRET", "test_app_secret")
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

    const result = await needsSetup()

    // One env var set but the other empty → setup is still needed
    expect(result).toBe(true)
  })

  it("returns false when process.stdin.isTTY is undefined", async () => {
    mockExistsSync.mockReturnValue(false)
    vi.stubEnv("FEISHU_APP_ID", "")
    vi.stubEnv("FEISHU_APP_SECRET", "")
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true })

    const result = await needsSetup()

    expect(result).toBe(false)
  })

  it("returns false when env files exist in CONFIG_DIR", async () => {
    // CONFIG_DIR exists and has .env files
    mockExistsSync.mockImplementation((p: string) => {
      return p === CONFIG_DIR
    })
    mockReaddirSync.mockReturnValue([".env.cli_abc123"])
    vi.stubEnv("FEISHU_APP_ID", "")
    vi.stubEnv("FEISHU_APP_SECRET", "")
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

    const result = await needsSetup()

    expect(result).toBe(false)
  })

  it("calls existsSync to check for config files", async () => {
    mockExistsSync.mockReturnValue(false)
    vi.stubEnv("FEISHU_APP_ID", "")
    vi.stubEnv("FEISHU_APP_SECRET", "")
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

    await needsSetup()

    // Should have checked CONFIG_DIR and config search paths
    expect(mockExistsSync).toHaveBeenCalled()
    expect(mockExistsSync.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})
