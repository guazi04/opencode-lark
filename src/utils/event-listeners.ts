/**
 * Event listener registry — supports multiple listeners per session.
 *
 * Each sessionId maps to a Set of listener functions.
 * This allows both streaming-bridge and session-observer to
 * coexist on the same session without stomping each other.
 */

export type EventListenerFn = (event: unknown) => void

export type EventListenerMap = Map<string, Set<EventListenerFn>>

export function addListener(
  map: EventListenerMap,
  sessionId: string,
  fn: EventListenerFn,
): void {
  if (!map.has(sessionId)) map.set(sessionId, new Set())
  map.get(sessionId)!.add(fn)
}

export function removeListener(
  map: EventListenerMap,
  sessionId: string,
  fn: EventListenerFn,
): void {
  const set = map.get(sessionId)
  if (set) {
    set.delete(fn)
    if (set.size === 0) map.delete(sessionId)
  }
}
