import { createAgentRuntime } from "../src/index.js"

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
    researcher: {
      prompt: "You are a focused research agent. Investigate the problem and explain your conclusions clearly.",
    },
  },
})

try {
  const session = await runtime.createSession({ agent: "researcher" })
  await session.query("Explain the main tradeoffs of session-first vs agent-first SDK design.")

  for await (const event of session.receiveResponse()) {
    if (event.type === "text") {
      process.stdout.write(event.text)
    }
    if (event.type === "tool_call") {
      console.log(`\n[tool] ${event.toolName} ${event.status}`)
    }
    if (event.type === "result") {
      console.log(`\n\nFinal text:\n${event.result.text}`)
    }
  }
} finally {
  await runtime.dispose()
}
