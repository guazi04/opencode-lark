import { describe, it, expect } from "vitest"
import {
  EventProcessor,
  type ProcessedAction,
  type TextDelta,
  type ToolStateChange,
  type SubtaskDiscovered,
  type SessionIdle,
} from "./event-processor.js"

function makeProcessor(sessions: string[] = ["ses-1"]) {
  return new EventProcessor({ ownedSessions: new Set(sessions) })
}

describe("EventProcessor", () => {
  describe("TextDelta", () => {
    it("extracts text delta from message.part.updated (text part)", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "text",
            text: "Hello world",
          },
          delta: "world",
        },
      })

      expect(result).toEqual<TextDelta>({
        type: "TextDelta",
        sessionId: "ses-1",
        text: "world",
      })
    })

    it("returns null when delta is empty string", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "" },
          delta: "",
        },
      })

      expect(result).toBeNull()
    })

    it("returns null when delta is missing", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "hi" },
        },
      })

      expect(result).toBeNull()
    })
  })

  describe("TextDelta from message.part.delta", () => {
    it("extracts text delta from message.part.delta event", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses-1",
          messageID: "msg-1",
          partID: "prt-1",
          field: "text",
          delta: "pong ",
        },
      })

      expect(result).toEqual<TextDelta>({
        type: "TextDelta",
        sessionId: "ses-1",
        text: "pong ",
      })
    })

    it("returns null for non-text field deltas", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses-1",
          messageID: "msg-1",
          partID: "prt-1",
          field: "reasoning",
          delta: "thinking...",
        },
      })

      expect(result).toBeNull()
    })

    it("returns null for empty delta", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses-1",
          messageID: "msg-1",
          partID: "prt-1",
          field: "text",
          delta: "",
        },
      })

      expect(result).toBeNull()
    })

    it("returns null for unowned sessions", () => {
      const proc = makeProcessor(["ses-1"])
      const result = proc.processEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses-OTHER",
          messageID: "msg-1",
          partID: "prt-1",
          field: "text",
          delta: "hello",
        },
      })

      expect(result).toBeNull()
    })
  })

  describe("ToolStateChange", () => {
    it("extracts tool state change from message.part.updated (tool part)", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "running", input: {}, time: { start: 1 } },
          },
        },
      })

      expect(result).toEqual<ToolStateChange>({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "running",
        input: {},
      })
    })

    it("includes error field when tool state is error", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "edit",
            state: {
              status: "error",
              input: {},
              error: "permission denied",
              time: { start: 1, end: 2 },
            },
          },
        },
      })

      expect(result).toEqual<ToolStateChange>({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "edit",
        state: "error",
        input: {},
        error: "permission denied",
      })
    })

    it("extracts title from running state with title", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: { status: "running", input: {}, title: "Read src/index.ts" },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "read",
        state: "running",
        input: {},
        title: "Read src/index.ts",
      })
    })

    it("extracts title from completed state", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "completed", input: {}, output: "OK", title: "Run tests" },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "completed",
        input: {},
        output: "OK",
        title: "Run tests",
      })
    })

    it("has no title when running state lacks title field", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "running", input: {} },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "running",
        input: {},
      })
      // Specifically check title is NOT present
      expect(result).not.toHaveProperty("title")
    })

    it("has no title when state is pending", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: { status: "pending", raw: "{}" },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "read",
        state: "pending",
      })
      expect(result).not.toHaveProperty("title")
    })

    it("extracts input and output from completed tool state", () => {
      const proc = makeProcessor()
      const testInput = { filePath: "/path/to/file", limit: 100 }
      const testOutput = "File contents here"
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "completed",
              input: testInput,
              output: testOutput,
              title: "Read file",
            },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "read",
        state: "completed",
        input: testInput,
        output: testOutput,
        title: "Read file",
      })
    })

    it("extracts input but not output from running tool state", () => {
      const proc = makeProcessor()
      const testInput = { command: "echo hello" }
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "running",
              input: testInput,
              title: "Run command",
            },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "running",
        input: testInput,
        title: "Run command",
      })
      // Ensure output is not present
      expect(result).not.toHaveProperty("output")
    })

    it("handles events without input/output for backward compat", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "pending" },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "pending",
      })
      // Ensure neither input nor output is present
      expect(result).not.toHaveProperty("input")
      expect(result).not.toHaveProperty("output")
    })
  })

  describe("SubtaskDiscovered", () => {
    it("extracts subtask from message.part.updated (subtask part)", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "subtask",
            prompt: "Fix the tests",
            description: "Run and fix failing tests",
            agent: "build",
          },
        },
      })

      expect(result).toEqual<SubtaskDiscovered>({
        type: "SubtaskDiscovered",
        sessionId: "ses-1",
        prompt: "Fix the tests",
        description: "Run and fix failing tests",
        agent: "build",
      })
    })
  })


  describe("SessionIdle", () => {
    it("extracts SessionIdle from session.status with idle type", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "session.status",
        properties: {
          sessionID: "ses-1",
          status: { type: "idle" },
        },
      })

      expect(result).toEqual<SessionIdle>({
        type: "SessionIdle",
        sessionId: "ses-1",
      })
    })
  })

  describe("SessionIdle from session.idle event", () => {
    it("extracts SessionIdle from session.idle event type", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "session.idle",
        properties: {
          sessionID: "ses-1",
        },
      })

      expect(result).toEqual<SessionIdle>({
        type: "SessionIdle",
        sessionId: "ses-1",
      })
    })

    it("returns null for session.idle from unowned session", () => {
      const proc = makeProcessor(["ses-1"])
      const result = proc.processEvent({
        type: "session.idle",
        properties: {
          sessionID: "ses-OTHER",
        },
      })

      expect(result).toBeNull()
    })
  })

  describe("filtering and error handling", () => {
    it("returns null for unknown event types", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "file.edited",
        properties: { file: "foo.ts" },
      })

      expect(result).toBeNull()
    })

    it("returns null for events from unowned sessions", () => {
      const proc = makeProcessor(["ses-1"])
      const result = proc.processEvent({
        type: "session.status",
        properties: {
          sessionID: "ses-OTHER",
          status: { type: "busy" },
        },
      })

      expect(result).toBeNull()
    })

    it("returns null for malformed events (no crash)", () => {
      const proc = makeProcessor()

      expect(proc.processEvent(null)).toBeNull()
      expect(proc.processEvent(undefined)).toBeNull()
      expect(proc.processEvent(42)).toBeNull()
      expect(proc.processEvent("garbage")).toBeNull()
      expect(proc.processEvent({ type: "session.status" })).toBeNull()
      expect(proc.processEvent({ type: "message.part.updated" })).toBeNull()
      expect(
        proc.processEvent({
          type: "message.part.updated",
          properties: { part: null },
        }),
      ).toBeNull()
    })

    it("returns null for session.status with retry type", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "session.status",
        properties: {
          sessionID: "ses-1",
          status: { type: "retry", attempt: 1, message: "retrying", next: 5000 },
        },
      })

      expect(result).toBeNull()
    })

    it("returns null for unhandled part types (e.g. step-start)", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "step-start",
          },
        },
      })

      expect(result).toBeNull()
    })
  })
})
