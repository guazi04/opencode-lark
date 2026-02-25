
import { describe, it, expect } from "vitest"
import {
  type EventListenerMap,
  addListener,
  removeListener,
} from "./event-listeners.js"

describe("event-listeners", () => {
  it("two listeners on same sessionId both receive events", () => {
    const map: EventListenerMap = new Map()
    const received1: unknown[] = []
    const received2: unknown[] = []
    const fn1 = (e: unknown) => received1.push(e)
    const fn2 = (e: unknown) => received2.push(e)

    addListener(map, "ses-1", fn1)
    addListener(map, "ses-1", fn2)

    const event = { type: "test" }
    for (const fn of map.get("ses-1")!) fn(event)

    expect(received1).toEqual([event])
    expect(received2).toEqual([event])
  })

  it("removing one listener doesn't affect the other", () => {
    const map: EventListenerMap = new Map()
    const received: unknown[] = []
    const fn1 = (e: unknown) => received.push(e)
    const fn2 = () => {}

    addListener(map, "ses-1", fn1)
    addListener(map, "ses-1", fn2)
    removeListener(map, "ses-1", fn2)

    expect(map.has("ses-1")).toBe(true)
    expect(map.get("ses-1")!.size).toBe(1)

    for (const fn of map.get("ses-1")!) fn({ x: 1 })
    expect(received).toEqual([{ x: 1 }])
  })

  it("removing last listener cleans up Set entry from Map", () => {
    const map: EventListenerMap = new Map()
    const fn = () => {}

    addListener(map, "ses-1", fn)
    expect(map.size).toBe(1)

    removeListener(map, "ses-1", fn)
    expect(map.size).toBe(0)
    expect(map.has("ses-1")).toBe(false)
  })

  it("addListener creates Set on first add", () => {
    const map: EventListenerMap = new Map()
    const fn = () => {}

    addListener(map, "ses-1", fn)
    expect(map.get("ses-1")).toBeInstanceOf(Set)
    expect(map.get("ses-1")!.has(fn)).toBe(true)
  })

  it("removeListener is a no-op for unknown session", () => {
    const map: EventListenerMap = new Map()
    removeListener(map, "nonexistent", () => {})
    expect(map.size).toBe(0)
  })
})
