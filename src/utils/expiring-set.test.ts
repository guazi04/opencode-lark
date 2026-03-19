import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ExpiringSet } from "./expiring-set.js"

describe("ExpiringSet", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("add() and has() work for non-expired items", () => {
    const set = new ExpiringSet<string>(60_000, 30_000)
    set.add("a")
    set.add("b")

    expect(set.has("a")).toBe(true)
    expect(set.has("b")).toBe(true)
    expect(set.has("c")).toBe(false)

    set.close()
  })

  it("has() returns false for expired items", () => {
    const set = new ExpiringSet<string>(1_000, 60_000)
    set.add("x")

    expect(set.has("x")).toBe(true)

    // Advance past TTL
    vi.advanceTimersByTime(1_001)

    expect(set.has("x")).toBe(false)

    set.close()
  })

  it("delete() removes an item", () => {
    const set = new ExpiringSet<string>(60_000, 30_000)
    set.add("a")
    expect(set.has("a")).toBe(true)

    const deleted = set.delete("a")
    expect(deleted).toBe(true)
    expect(set.has("a")).toBe(false)

    // Deleting non-existent returns false
    expect(set.delete("z")).toBe(false)

    set.close()
  })

  it("countAlive() returns count of non-expired entries", () => {
    const set = new ExpiringSet<string>(1_000, 60_000)
    set.add("a")
    set.add("b")
    set.add("c")

    expect(set.countAlive()).toBe(3)

    // Advance past TTL
    vi.advanceTimersByTime(1_001)

    expect(set.countAlive()).toBe(0)

    set.close()
  })

  it("countAlive() excludes expired items even when mixed with fresh ones", () => {
    const set = new ExpiringSet<string>(2_000, 60_000)
    set.add("old")

    vi.advanceTimersByTime(1_500)
    set.add("new")

    // "old" has 500ms left, "new" is fresh
    expect(set.countAlive()).toBe(2)

    vi.advanceTimersByTime(600)
    // "old" is now expired (2100ms), "new" has 1400ms left
    expect(set.countAlive()).toBe(1)

    set.close()
  })

  it("cleanup interval evicts expired entries proactively", () => {
    const set = new ExpiringSet<string>(1_000, 500)
    set.add("a")
    set.add("b")

    // Advance past TTL + past cleanup interval
    vi.advanceTimersByTime(1_500)

    // After cleanup runs, the internal map should be cleaned
    set.add("c")
    expect(set.countAlive()).toBe(1) // only "c" remains

    set.close()
  })

  it("close() stops the cleanup interval", () => {
    const set = new ExpiringSet<string>(1_000, 500)
    set.add("a")
    set.close()

    // Even after advancing, close prevents further cleanup
    // (we can't directly observe the interval, but close should not throw)
    vi.advanceTimersByTime(5_000)

    // Item is still logically expired via has()
    expect(set.has("a")).toBe(false)
  })

  it("re-adding an item refreshes its timestamp", () => {
    const set = new ExpiringSet<string>(2_000, 60_000)
    set.add("a")

    vi.advanceTimersByTime(1_500)
    // Re-add to refresh
    set.add("a")

    vi.advanceTimersByTime(1_000)
    // 1000ms since refresh, still within TTL
    expect(set.has("a")).toBe(true)

    vi.advanceTimersByTime(1_100)
    // Now 2100ms since refresh, expired
    expect(set.has("a")).toBe(false)

    set.close()
  })

  it("works with non-string types", () => {
    const set = new ExpiringSet<number>(60_000, 30_000)
    set.add(42)
    set.add(100)

    expect(set.has(42)).toBe(true)
    expect(set.has(99)).toBe(false)
    expect(set.countAlive()).toBe(2)

    set.close()
  })
})
