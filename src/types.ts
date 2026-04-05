import type { Message, Part, ToolState } from "@opencode-ai/sdk/v2"

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonArray | JsonObject | JsonPrimitive
export type JsonArray = JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export type ModelSpec = {
  modelID: string
  providerID: string
}

export type ModelReference = ModelSpec | `${string}/${string}`

export type AgentDefinition = {
  description?: string
  model?: ModelReference
  mode?: string
  prompt: string
}

export type AgentRuntimeOptions = {
  agents: Record<string, AgentDefinition>
  config?: JsonObject
  directory: string
  hostname?: string
  mcp?: JsonObject
  model?: ModelReference
  permission?: JsonObject
  port?: number
  rawConfigContent?: string
  timeoutMs?: number
}

export type AgentSessionOptions = {
  agent?: string
  model?: ModelReference
}

export type AgentQueryOptions = AgentSessionOptions
export type AgentRunOptions = AgentSessionOptions

export type AgentRuntimeRunOptions = {
  agent: string
  model?: ModelReference
  prompt: string
}

export type AgentErrorInfo = {
  code?: string
  message: string
  name: string
  status?: number
  statusCode?: number
}

export type AgentStatusEvent = {
  agent: string
  sessionID: string
  status: string
  type: "status"
}

export type AgentTextEvent = {
  agent: string
  format: "delta" | "snapshot"
  messageID: string
  partID: string
  sessionID: string
  text: string
  type: "text"
}

export type AgentToolCallEvent = {
  agent: string
  attachments: number
  callID: string
  error?: string
  input?: unknown
  messageID: string
  output?: string
  partID: string
  sessionID: string
  status: ToolState["status"]
  title?: string
  toolName: string
  type: "tool_call"
}

export type AgentErrorEvent = {
  agent: string
  error: AgentErrorInfo
  sessionID: string
  type: "error"
}

export type AgentTurnResult = {
  agent: string
  error: AgentErrorInfo | null
  info: Message | null
  messageID: string | null
  parts: Part[]
  sessionID: string
  text: string
}

export type AgentResultEvent = {
  agent: string
  result: AgentTurnResult
  sessionID: string
  type: "result"
}

export type AgentResponseEvent =
  | AgentErrorEvent
  | AgentResultEvent
  | AgentStatusEvent
  | AgentTextEvent
  | AgentToolCallEvent
