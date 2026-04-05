import type { Part } from "@opencode-ai/sdk/v2"

import type { AgentErrorInfo } from "./types.js"

type ResponseEnvelope<TData, TError> = {
  data?: TData | null | undefined
  error?: TError | undefined
}

type ErrorWithMetadata = Error & {
  cause?: Error | { message?: string }
  code?: string
  status?: number
  statusCode?: number
}

export async function requireData<TData, TError>(
  label: string,
  promise: Promise<ResponseEnvelope<TData, TError>>,
): Promise<Exclude<TData, null | undefined>> {
  const response = await promise
  if (response.error) {
    throw new Error(`${label} failed: ${JSON.stringify(response.error)}`)
  }
  if (response.data == null) {
    throw new Error(`${label} failed: empty response data`)
  }
  return response.data as Exclude<TData, null | undefined>
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function formatError(error: Error | object | string | number | boolean | null | undefined) {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const errorWithMetadata = error as ErrorWithMetadata
  const details = [
    typeof errorWithMetadata.code === "string" && `code=${JSON.stringify(errorWithMetadata.code)}`,
    typeof errorWithMetadata.status === "number" && `status=${errorWithMetadata.status}`,
    typeof errorWithMetadata.statusCode === "number" && `statusCode=${errorWithMetadata.statusCode}`,
    errorWithMetadata.cause instanceof Error &&
      errorWithMetadata.cause.message &&
      `cause=${JSON.stringify(errorWithMetadata.cause.message)}`,
  ].filter((detail): detail is string => Boolean(detail))

  if (details.length === 0) {
    return `${error.name}: ${error.message}`
  }

  return `${error.name}: ${error.message} | ${details.join(", ")}`
}

export function extractTextFromParts(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
}

export function toErrorInfo(error: unknown): AgentErrorInfo {
  if (error instanceof Error) {
    const errorWithMetadata = error as ErrorWithMetadata
    const result: AgentErrorInfo = {
      name: error.name,
      message: error.message,
    }
    if (typeof errorWithMetadata.code === "string") {
      result.code = errorWithMetadata.code
    }
    if (typeof errorWithMetadata.status === "number") {
      result.status = errorWithMetadata.status
    }
    if (typeof errorWithMetadata.statusCode === "number") {
      result.statusCode = errorWithMetadata.statusCode
    }
    return result
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: unknown
      message?: unknown
      name?: unknown
      status?: unknown
      statusCode?: unknown
    }
    const result: AgentErrorInfo = {
      name: typeof candidate.name === "string" ? candidate.name : "Error",
      message: typeof candidate.message === "string" ? candidate.message : JSON.stringify(error),
    }
    if (typeof candidate.code === "string") {
      result.code = candidate.code
    }
    if (typeof candidate.status === "number") {
      result.status = candidate.status
    }
    if (typeof candidate.statusCode === "number") {
      result.statusCode = candidate.statusCode
    }
    return result
  }

  return {
    name: "Error",
    message: String(error),
  }
}

export function formatErrorInfo(error: AgentErrorInfo) {
  const details = [
    typeof error.code === "string" && `code=${JSON.stringify(error.code)}`,
    typeof error.status === "number" && `status=${error.status}`,
    typeof error.statusCode === "number" && `statusCode=${error.statusCode}`,
  ].filter((detail): detail is string => Boolean(detail))

  if (details.length === 0) {
    return `${error.name}: ${error.message}`
  }

  return `${error.name}: ${error.message} | ${details.join(", ")}`
}
