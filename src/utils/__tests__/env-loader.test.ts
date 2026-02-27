import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { loadEnvFile } from "../env-loader.js"

describe("env-loader", () => {
  let tempDir: string
  let tempEnvPath: string
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-loader-test-"))
    tempEnvPath = path.join(tempDir, ".env")
    // Save original env values for keys we'll be testing
    originalEnv.TEST_KEY = process.env.TEST_KEY
    originalEnv.TEST_KEY_2 = process.env.TEST_KEY_2
    originalEnv.QUOTED_KEY = process.env.QUOTED_KEY
    originalEnv.SINGLE_QUOTED = process.env.SINGLE_QUOTED
    originalEnv.MULTI_EQUAL = process.env.MULTI_EQUAL
    // Delete them from process.env so we start clean
    delete process.env.TEST_KEY
    delete process.env.TEST_KEY_2
    delete process.env.QUOTED_KEY
    delete process.env.SINGLE_QUOTED
    delete process.env.MULTI_EQUAL
  })

  afterEach(() => {
    // Restore original env values
    if (originalEnv.TEST_KEY === undefined) {
      delete process.env.TEST_KEY
    } else {
      process.env.TEST_KEY = originalEnv.TEST_KEY
    }
    if (originalEnv.TEST_KEY_2 === undefined) {
      delete process.env.TEST_KEY_2
    } else {
      process.env.TEST_KEY_2 = originalEnv.TEST_KEY_2
    }
    if (originalEnv.QUOTED_KEY === undefined) {
      delete process.env.QUOTED_KEY
    } else {
      process.env.QUOTED_KEY = originalEnv.QUOTED_KEY
    }
    if (originalEnv.SINGLE_QUOTED === undefined) {
      delete process.env.SINGLE_QUOTED
    } else {
      process.env.SINGLE_QUOTED = originalEnv.SINGLE_QUOTED
    }
    if (originalEnv.MULTI_EQUAL === undefined) {
      delete process.env.MULTI_EQUAL
    } else {
      process.env.MULTI_EQUAL = originalEnv.MULTI_EQUAL
    }
    // Clean up temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true })
    }
  })

  it("parses KEY=VALUE correctly", () => {
    fs.writeFileSync(tempEnvPath, "TEST_KEY=test_value\n")
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("test_value")
  })

  it("handles double-quoted values", () => {
    fs.writeFileSync(tempEnvPath, 'QUOTED_KEY="double quoted value"\n')
    loadEnvFile(tempEnvPath)
    expect(process.env.QUOTED_KEY).toBe("double quoted value")
  })

  it("handles single-quoted values", () => {
    fs.writeFileSync(tempEnvPath, "SINGLE_QUOTED='single quoted value'\n")
    loadEnvFile(tempEnvPath)
    expect(process.env.SINGLE_QUOTED).toBe("single quoted value")
  })

  it("skips comment lines starting with #", () => {
    fs.writeFileSync(
      tempEnvPath,
      `# This is a comment
TEST_KEY=value
# Another comment
`,
    )
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("value")
  })

  it("skips blank lines", () => {
    fs.writeFileSync(
      tempEnvPath,
      `
TEST_KEY=value

TEST_KEY_2=value2

`,
    )
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("value")
    expect(process.env.TEST_KEY_2).toBe("value2")
  })

  it("does NOT override existing process.env values", () => {
    process.env.TEST_KEY = "existing_value"
    fs.writeFileSync(tempEnvPath, "TEST_KEY=new_value\n")
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("existing_value")
  })

  it("no-ops gracefully when file doesn't exist", () => {
    const nonexistentPath = path.join(tempDir, "nonexistent.env")
    // Should not throw
    expect(() => {
      loadEnvFile(nonexistentPath)
    }).not.toThrow()
  })

  it("handles values with = signs in them", () => {
    fs.writeFileSync(tempEnvPath, "MULTI_EQUAL=a=b=c\n")
    loadEnvFile(tempEnvPath)
    expect(process.env.MULTI_EQUAL).toBe("a=b=c")
  })

  it("uses default .env path when no argument provided", () => {
    // This test verifies the function can handle missing file gracefully
    // We're not creating a .env file in the current directory
    expect(() => {
      loadEnvFile()
    }).not.toThrow()
  })

  it("strips leading/trailing whitespace from keys and values", () => {
    fs.writeFileSync(tempEnvPath, "  TEST_KEY  =  value_with_spaces  \n")
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe("value_with_spaces")
  })

  it("preserves quotes in unquoted values", () => {
    fs.writeFileSync(tempEnvPath, 'TEST_KEY=value "with" quotes\n')
    loadEnvFile(tempEnvPath)
    expect(process.env.TEST_KEY).toBe('value "with" quotes')
  })

  it("handles empty quoted values", () => {
    fs.writeFileSync(tempEnvPath, 'QUOTED_KEY=""\n')
    loadEnvFile(tempEnvPath)
    expect(process.env.QUOTED_KEY).toBe("")
  })
})
