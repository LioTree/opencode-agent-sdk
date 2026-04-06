import type { AgentDefinition, JsonObject, JsonValue, ModelReference, ModelSpec } from "./types.js"

export type PlainObject = JsonObject

type BuildRuntimeConfigOptions = {
  agents: Record<string, AgentDefinition>
  config?: PlainObject
  mcp?: PlainObject
  model?: ModelReference
  permission?: PlainObject
  rawConfigContent?: string
}

const INLINE_CONFIG_ENV_VAR = "OPENCODE_CONFIG_CONTENT"

export function isPlainObject(value: JsonValue | object): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function deepMergeConfig(base: PlainObject, overlay: PlainObject): PlainObject {
  const result: PlainObject = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key]
    if (existing && isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMergeConfig(existing, value)
      continue
    }
    result[key] = value
  }
  return result
}

export function parseRuntimeConfigContent(raw?: string): PlainObject {
  if (!raw || !raw.trim()) {
    return {}
  }

  const parsed = JSON.parse(raw) as JsonValue
  if (!isPlainObject(parsed)) {
    throw new Error("rawConfigContent must be a JSON object")
  }

  return parsed
}

export function resolveInlineConfigContent(raw?: string) {
  if (typeof raw === "string") {
    return raw
  }

  return process.env[INLINE_CONFIG_ENV_VAR]
}

export function normalizeModelReference(model: ModelReference): ModelSpec {
  if (typeof model !== "string") {
    return model
  }

  const splitIndex = model.indexOf("/")
  if (splitIndex <= 0 || splitIndex === model.length - 1) {
    throw new Error(`Invalid model reference: ${model}`)
  }

  return {
    providerID: model.slice(0, splitIndex).trim(),
    modelID: model.slice(splitIndex + 1).trim(),
  }
}

export function parseModelSpec(raw?: string): ModelSpec | undefined {
  if (!raw || !raw.includes("/")) {
    return undefined
  }

  const splitIndex = raw.indexOf("/")
  const providerID = raw.slice(0, splitIndex).trim()
  const modelID = raw.slice(splitIndex + 1).trim()
  if (!providerID || !modelID) {
    return undefined
  }

  return { providerID, modelID }
}

function toModelString(model: ModelReference) {
  const normalized = normalizeModelReference(model)
  return `${normalized.providerID}/${normalized.modelID}`
}

function buildAgentConfig(agents: Record<string, AgentDefinition>): PlainObject {
  const entries = Object.entries(agents).map(([name, definition]) => {
    const config: PlainObject = {
      mode: definition.mode ?? "primary",
      prompt: definition.prompt,
    }
    return [name, config] as const
  })

  return Object.fromEntries(entries)
}

export function buildRuntimeConfig({
  agents,
  config,
  mcp,
  model,
  permission,
  rawConfigContent,
}: BuildRuntimeConfigOptions): PlainObject {
  const inheritedInlineConfig = parseRuntimeConfigContent(resolveInlineConfigContent(rawConfigContent))
  const optionConfig = config ?? {}

  const managedConfig: PlainObject = {
    agent: buildAgentConfig(agents),
  }

  if (mcp) {
    managedConfig.mcp = mcp
  }

  if (permission) {
    managedConfig.permission = permission
  }

  if (model) {
    managedConfig.model = toModelString(model)
  }

  return deepMergeConfig(deepMergeConfig(inheritedInlineConfig, optionConfig), managedConfig)
}
