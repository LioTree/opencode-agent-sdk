# opencode-agent-sdk

High-level agent runtime for `@opencode-ai/sdk/v2`.

This package wraps OpenCode's lower-level session and SSE APIs with a more agent-oriented model:

- declare agents once
- create reusable sessions
- call `query()` / `receiveResponse()` or `run()`
- consume normalized text, tool-call, status, error, and final-result events

It is inspired by the usability level of Claude's agent SDK, but it does not try to be API-compatible 1:1.

## Config behavior

This SDK follows OpenCode's normal config resolution and adds programmatic overrides on top.

- OpenCode still loads its normal config chain such as global config, project config, `.opencode/`, and managed config
- if `OPENCODE_CONFIG_CONTENT` is already present in the parent process, this SDK inherits and merges it by default
- options passed to `createAgentRuntime()` are applied as inline runtime overrides on top of the inherited config

In practice, the resolved precedence for config passed through this SDK is:

1. existing `OPENCODE_CONFIG_CONTENT` from the parent environment
2. `options.config`
3. SDK-managed overrides such as `agents`, `mcp`, `permission`, and `model`

Pass `rawConfigContent` if you want to override the inherited inline config content explicitly.

## Why

`@opencode-ai/sdk` is a solid transport/client layer, but most applications still need to rebuild the same higher-level pieces:

- session lifecycle helpers
- per-turn completion handling
- stream filtering by session
- message delta vs snapshot reconciliation
- tool call lifecycle normalization
- final assistant message lookup

`@liontree/opencode-agent-sdk` packages those concerns into a reusable runtime.

## Installation

```bash
npm install @liontree/opencode-agent-sdk
```

This package declares `@opencode-ai/sdk` and `opencode-ai` as dependencies, so you do not need to install them separately.

## Requirements

- a working OpenCode provider/auth setup available through normal OpenCode config resolution or inline config passed to this SDK

## Quick Start

```bash
npm install @liontree/opencode-agent-sdk
```

```ts
import { createAgentRuntime } from "@liontree/opencode-agent-sdk"

const runtime = await createAgentRuntime({
  directory: "/app",
  model: "openai/gpt-5.4",
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

This example assumes your OpenCode provider/auth configuration is already available through OpenCode's normal config resolution, for example:

- `~/.config/opencode/opencode.json`
- `opencode.json` in the project
- environment variables consumed by your provider config
- existing `OPENCODE_CONFIG_CONTENT`

If you want to provide inline config explicitly, pass `rawConfigContent` or `config`.

```ts
const runtime = await createAgentRuntime({
  directory: "/app",
  rawConfigContent: JSON.stringify({
    provider: {
      openai: {
        options: {
          apiKey: "{env:OPENAI_API_KEY}",
        },
      },
    },
  }),
  agents: {
    researcher: {
      prompt: "You are a focused research agent.",
    },
  },
})
```

If you only need the final answer instead of a streamed event loop, use `run()`:

```ts
const result = await session.run("Summarize the current repository")

console.log(result.text)
```

## Main API

### `createAgentRuntime(options)`

Creates a managed OpenCode runtime and injects:

- agent prompts
- optional default model
- optional MCP config
- optional permission config
- optional extra config merged with inherited inline config

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
