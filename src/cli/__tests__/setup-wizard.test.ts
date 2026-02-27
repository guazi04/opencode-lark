import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import { needsSetup } from "../setup-wizard.js"

// Mock fs.existsSync
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}))

describe("setup-wizard", () => {
  const mockExistsSync = fs.existsSync as any

  beforeEach(() => {
    // Reset all mocks before each test
    mockExistsSync.mockClear()
    // Unstub any previously stubbed env vars
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns true when no config file exists, no env vars, and TTY is true", async () => {
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

  it("returns false when a config file exists", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path.includes("opencode-lark.jsonc")
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

  it("checks all config search paths", async () => {
    mockExistsSync.mockReturnValue(false)
    vi.stubEnv("FEISHU_APP_ID", "")
    vi.stubEnv("FEISHU_APP_SECRET", "")
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })

    await needsSetup()

    // Should have checked each config path
    expect(mockExistsSync).toHaveBeenCalled()
    expect(mockExistsSync.mock.calls.length).toBeGreaterThanOrEqual(4)
  })
})
