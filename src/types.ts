import type { Agent as OpencodeAgent, Message, Part, ToolState } from "@opencode-ai/sdk/v2"

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonArray | JsonObject | JsonPrimitive
export type JsonArray = JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export type ModelSpec = {
  modelID: string
  providerID: string
}

export type ModelReference = ModelSpec | `${string}/${string}`

export type AgentMode = "all" | "primary" | "subagent"

export type AgentDefinition = {
  description?: string
  model?: ModelReference
  mode?: AgentMode
  permission?: JsonObject
  prompt: string
}

export type AgentRuntimeOptions = {
  agents?: Record<string, AgentDefinition>
  config?: JsonObject
  directory: string
  hostname?: string
  mcp?: JsonObject
  model?: ModelReference
  permission?: JsonObject
  port?: number
  rawConfigContent?: string
  serverUrl?: string
  timeoutMs?: number
}

export type AgentSessionOptions = {
  agent?: string
  model?: ModelReference
}

export type AgentQueryOptions = AgentSessionOptions & {
  includeSubagents?: boolean
  variant?: string
}

export type AgentRunOptions = AgentQueryOptions

export type AgentRuntimeRunOptions = {
  agent: string
  model?: ModelReference
  prompt: string
  variant?: string
}

export type ResumeAgentOptions = AgentSessionOptions & {
  includeSubagents?: boolean
  prompt?: string
  sessionID: string
  variant?: string
}

export type AgentErrorInfo = {
  code?: string
  message: string
  name: string
  status?: number
  statusCode?: number
}

export type AgentEventSource = {
  agentLabel: string
  agentType: string
  chain: string[]
  chainText: string
  depth: number
  parentSessionID: string | null
  rootSessionID: string
  sessionID: string
  sourceToolCallID: string | null
  taskID: string | null
}

export type RuntimeAgentInfo = Pick<OpencodeAgent, "color" | "description" | "hidden" | "mode" | "name" | "native" | "steps"> & {
  model?: ModelSpec
}

export type AgentStatusEvent = {
  agent: string
  sessionID: string
  status: string
  source: AgentEventSource
  type: "status"
}

export type AgentTextEvent = {
  agent: string
  format: "delta" | "snapshot"
  messageID: string
  partID: string
  sessionID: string
  source: AgentEventSource
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
  source: AgentEventSource
  status: ToolState["status"]
  title?: string
  toolName: string
  type: "tool_call"
}

export type AgentErrorEvent = {
  agent: string
  error: AgentErrorInfo
  sessionID: string
  source: AgentEventSource
  type: "error"
}

export type AgentTurnResult = {
  agent: string
  error: AgentErrorInfo | null
  info: Message | null
  messageID: string | null
  parts: Part[]
  sessionID: string
  source: AgentEventSource
  text: string
}

export type AgentResultEvent = {
  agent: string
  result: AgentTurnResult
  sessionID: string
  source: AgentEventSource
  type: "result"
}

export type AgentResponseEvent =
  | AgentErrorEvent
  | AgentResultEvent
  | AgentStatusEvent
  | AgentTextEvent
  | AgentToolCallEvent
