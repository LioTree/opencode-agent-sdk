# opencode-agent-sdk

High-level agent runtime for `@opencode-ai/sdk/v2`.

This package wraps OpenCode's lower-level session and SSE APIs with a more agent-oriented model:

- declare agents once
- create reusable sessions
- call `query()` / `receiveResponse()` or `run()`
- consume normalized text, tool-call, status, error, and final-result events

It is inspired by the usability level of Claude's agent SDK, but it does not try to be API-compatible 1:1.

## Why

`@opencode-ai/sdk` is a solid transport/client layer, but most applications still need to rebuild the same higher-level pieces:

- session lifecycle helpers
- per-turn completion handling
- stream filtering by session
- message delta vs snapshot reconciliation
- tool call lifecycle normalization
- final assistant message lookup

`opencode-agent-sdk` packages those concerns into a reusable runtime.

## Installation

```bash
npm install @opencode-ai/sdk opencode-ai
```

If you publish this package, install it as well:

```bash
npm install opencode-agent-sdk
```

## Quick Start

```ts
import { createAgentRuntime } from "opencode-agent-sdk"

const runtime = await createAgentRuntime({
  directory: "/app",
  model: "openai/gpt-4.1",
  permission: {
    "*": "allow",
  },
  mcp: {
    terminal: {
      type: "remote",
      url: "http://127.0.0.1:8000/mcp",
      oauth: false,
      timeout: 3600000,
    },
  },
  agents: {
    fuzzer: {
      description: "Expert in AFL++ fuzzing workflows.",
      prompt: "You are the fuzzing agent...",
    },
  },
})

const session = await runtime.createSession({ agent: "fuzzer" })

await session.query("Start fuzzing target libpng")

for await (const event of session.receiveResponse()) {
  switch (event.type) {
    case "status":
      console.log("status:", event.status)
      break
    case "text":
      process.stdout.write(event.text)
      break
    case "tool_call":
      console.log("tool:", event.toolName, event.status)
      break
    case "error":
      console.error("error:", event.error)
      break
    case "result":
      console.log("final text:\n", event.result.text)
      break
  }
}

await runtime.dispose()
```

## Main API

### `createAgentRuntime(options)`

Creates a managed OpenCode runtime and injects:

- agent prompts
- optional default model
- optional MCP config
- optional permission config
- optional extra config merged with `rawConfigContent`

### `runtime.createSession({ agent, model })`

Creates a reusable OpenCode session and returns an `OpencodeAgentSession`.

### `session.query(prompt, options)`

Starts one turn on the session.

### `session.receiveResponse()`

Consumes the active turn as an async stream of normalized events:

- `status`
- `text`
- `tool_call`
- `error`
- `result`

`receiveResponse()` is single-consumer per turn.

### `session.run(prompt, options)`

Convenience helper that internally calls `query()` and consumes the response stream until a final result is available.

### `session.abort()` / `session.interrupt()`

Both currently map to OpenCode's session abort behavior.

## Event Model

### `status`

Emitted on deduplicated session status transitions such as `busy` and `idle`.

### `text`

Emitted for assistant text updates.

- `format: "delta"` means incremental text
- `format: "snapshot"` means the full part text was emitted to recover from a missing delta or stream correction

### `tool_call`

Emitted when a tool part changes lifecycle state.

### `error`

Emitted for prompt failures, session errors, SSE errors, or shutdown problems.

### `result`

Emitted exactly once when the final assistant message can be resolved.

## Notes

- This SDK is higher-level than raw OpenCode, not a workflow engine.
- It does not implement multi-agent orchestration for you.
- It does not aim for complete Claude SDK compatibility.
- Model resolution order is: per-call override -> session default -> agent default -> runtime default -> OpenCode config.
