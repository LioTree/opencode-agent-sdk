import {
  createOpencode,
  type Event,
  type EventMessagePartDelta,
  type EventMessagePartUpdated,
  type EventMessageUpdated,
  type EventSessionError,
  type EventSessionIdle,
  type EventSessionStatus,
  type Message,
  type OpencodeClient,
  type Part,
  type Session,
  type ToolPart,
  type ToolState,
} from "@opencode-ai/sdk/v2"

import { buildRuntimeConfig, normalizeModelReference, parseModelSpec } from "./config.js"
import type {
  AgentDefinition,
  AgentErrorInfo,
  AgentQueryOptions,
  AgentResponseEvent,
  AgentRunOptions,
  AgentRuntimeOptions,
  AgentRuntimeRunOptions,
  AgentSessionOptions,
  AgentTextEvent,
  AgentToolCallEvent,
  AgentTurnResult,
  ModelReference,
  ModelSpec,
} from "./types.js"
import { delay, extractTextFromParts, formatErrorInfo, requireData, toErrorInfo } from "./utils.js"

type ManagedServer = {
  close: () => void
}

type SessionEvent =
  | EventMessagePartDelta
  | EventMessagePartUpdated
  | EventMessageUpdated
  | EventSessionError
  | EventSessionIdle
  | EventSessionStatus

type EventSubscription = {
  abort: () => void
  signal: AbortSignal
  stream: AsyncGenerator<SessionEvent, void, unknown>
}

type IdleGate = {
  mark: () => void
  signal: Promise<void>
}

type TurnContext = {
  assistantMessageIDs: Set<string>
  idleGate: IdleGate
  lastStatus: string
  latestAssistantMessageID: string | null
  sawBusy: boolean
  textByPartID: Map<string, string>
  toolStatusByPartID: Map<string, ToolState["status"]>
}

const POST_IDLE_EVENT_DRAIN_MS = 300
const EVENT_STREAM_SHUTDOWN_TIMEOUT_MS = 2000

function isSessionEvent(event: Event): event is SessionEvent {
  return (
    event.type === "message.part.updated" ||
    event.type === "message.part.delta" ||
    event.type === "message.updated" ||
    event.type === "session.status" ||
    event.type === "session.idle" ||
    event.type === "session.error"
  )
}

function getEventSessionID(event: SessionEvent) {
  switch (event.type) {
    case "message.part.updated":
      return event.properties.part.sessionID
    case "message.part.delta":
      return event.properties.sessionID
    case "message.updated":
      return event.properties.info.sessionID
    case "session.status":
      return event.properties.sessionID
    case "session.idle":
      return event.properties.sessionID
    case "session.error":
      return event.properties.sessionID
  }
}

function createIdleGate(): IdleGate {
  let resolved = false
  let resolveSignal = () => {}
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve
  })

  return {
    signal,
    mark() {
      if (!resolved) {
        resolved = true
        resolveSignal()
      }
    },
  }
}

function createTurnContext(): TurnContext {
  return {
    assistantMessageIDs: new Set<string>(),
    idleGate: createIdleGate(),
    lastStatus: "",
    latestAssistantMessageID: null,
    sawBusy: false,
    textByPartID: new Map<string, string>(),
    toolStatusByPartID: new Map<string, ToolState["status"]>(),
  }
}

function getAssistantMessageError(info: Message | null): AgentErrorInfo | null {
  if (!info || info.role !== "assistant" || !info.error) {
    return null
  }
  return toErrorInfo(info.error)
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private closed = false
  private failure: Error | null = null
  private readonly values: T[] = []
  private readonly waiters: Array<{
    reject: (error: Error) => void
    resolve: (result: IteratorResult<T>) => void
  }> = []

  push(value: T) {
    if (this.closed || this.failure) {
      return
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return
    }

    this.values.push(value)
  }

  close() {
    if (this.closed || this.failure) {
      return
    }
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error) {
    if (this.closed || this.failure) {
      return
    }
    this.failure = error
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error)
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift()
      return Promise.resolve({ value: value as T, done: false })
    }

    if (this.failure) {
      return Promise.reject(this.failure)
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true })
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    }
  }
}

class ActiveTurn {
  private claimed = false
  private finalResult: AgentTurnResult | null = null
  private readonly queue = new AsyncEventQueue<AgentResponseEvent>()
  private readonly worker: Promise<void>

  constructor(
    private readonly args: {
      agent: string
      client: OpencodeClient
      directory: string
      model: ModelSpec
      prompt: string
      sessionID: string
    },
  ) {
    this.worker = this.run()
  }

  async *consume(): AsyncGenerator<AgentResponseEvent, void, unknown> {
    if (this.claimed) {
      throw new Error("receiveResponse() can only be consumed once per query()")
    }
    this.claimed = true

    for await (const event of this.queue) {
      yield event
    }
  }

  getResult() {
    return this.finalResult
  }

  private emit(event: AgentResponseEvent) {
    this.queue.push(event)
  }

  private emitError(error: unknown) {
    this.emit({
      type: "error",
      agent: this.args.agent,
      sessionID: this.args.sessionID,
      error: toErrorInfo(error),
    })
  }

  private markIdleIfReady(context: TurnContext) {
    if (context.sawBusy || context.latestAssistantMessageID !== null) {
      context.idleGate.mark()
    }
  }

  private emitStatus(context: TurnContext, status: string) {
    if (!status || status === context.lastStatus) {
      return
    }

    context.lastStatus = status
    this.emit({
      type: "status",
      agent: this.args.agent,
      sessionID: this.args.sessionID,
      status,
    })
  }

  private emitTextEvent(event: Omit<AgentTextEvent, "agent" | "sessionID" | "type">) {
    this.emit({
      type: "text",
      agent: this.args.agent,
      sessionID: this.args.sessionID,
      ...event,
    })
  }

  private emitToolCallEvent(event: Omit<AgentToolCallEvent, "agent" | "sessionID" | "type">) {
    this.emit({
      type: "tool_call",
      agent: this.args.agent,
      sessionID: this.args.sessionID,
      ...event,
    })
  }

  private handleMessagePartDelta(event: EventMessagePartDelta, context: TurnContext) {
    if (event.properties.field !== "text" || !event.properties.delta) {
      return
    }

    const previous = context.textByPartID.get(event.properties.partID) ?? ""
    context.textByPartID.set(event.properties.partID, `${previous}${event.properties.delta}`)
    this.emitTextEvent({
      format: "delta",
      messageID: event.properties.messageID,
      partID: event.properties.partID,
      text: event.properties.delta,
    })
  }

  private handleTextPartUpdated(part: Extract<Part, { type: "text" }>, context: TurnContext) {
    const previous = context.textByPartID.get(part.id) ?? ""
    let format: AgentTextEvent["format"] | null = null
    let text = ""

    if (part.text.length > previous.length && part.text.startsWith(previous)) {
      text = part.text.slice(previous.length)
      format = text ? "delta" : null
    } else if (part.text !== previous) {
      text = part.text
      format = "snapshot"
    }

    context.textByPartID.set(part.id, part.text)
    if (!format || !text) {
      return
    }

    this.emitTextEvent({
      format,
      messageID: part.messageID,
      partID: part.id,
      text,
    })
  }

  private handleToolPartUpdated(part: ToolPart, context: TurnContext) {
    const status = part.state.status
    if (context.toolStatusByPartID.get(part.id) === status) {
      return
    }

    context.toolStatusByPartID.set(part.id, status)
    const event: Omit<AgentToolCallEvent, "agent" | "sessionID" | "type"> = {
      attachments: 0,
      callID: part.callID,
      input: part.state.input,
      messageID: part.messageID,
      partID: part.id,
      status,
      toolName: part.tool,
    }

    if (part.state.status === "running" && part.state.title) {
      event.title = part.state.title
    }

    if (part.state.status === "completed") {
      event.attachments = part.state.attachments?.length ?? 0
      event.output = part.state.output
      event.title = part.state.title
    }

    if (part.state.status === "error") {
      event.error = part.state.error
    }

    this.emitToolCallEvent({
      ...event,
    })
  }

  private handleSessionEvent(event: SessionEvent, context: TurnContext) {
    switch (event.type) {
      case "session.status":
        if (event.properties.status.type === "busy") {
          context.sawBusy = true
        }
        if (event.properties.status.type === "idle") {
          this.markIdleIfReady(context)
        }
        this.emitStatus(context, event.properties.status.type)
        return
      case "session.idle":
        this.markIdleIfReady(context)
        this.emitStatus(context, "idle")
        return
      case "session.error":
        this.emitError(event.properties.error)
        return
      case "message.updated":
        if (event.properties.info.role === "assistant") {
          context.assistantMessageIDs.add(event.properties.info.id)
          context.latestAssistantMessageID = event.properties.info.id
        }
        return
      case "message.part.delta":
        if (context.assistantMessageIDs.has(event.properties.messageID)) {
          this.handleMessagePartDelta(event, context)
        }
        return
      case "message.part.updated":
        if (!context.assistantMessageIDs.has(event.properties.part.messageID)) {
          return
        }
        if (event.properties.part.type === "text") {
          this.handleTextPartUpdated(event.properties.part, context)
          return
        }
        if (event.properties.part.type === "tool") {
          this.handleToolPartUpdated(event.properties.part, context)
        }
        return
    }
  }

  private async subscribeToEvents(): Promise<EventSubscription> {
    const controller = new AbortController()
    const subscription = (await this.args.client.event.subscribe(
      { directory: this.args.directory },
      {
        signal: controller.signal,
        onSseError: (error) => {
          if (!controller.signal.aborted) {
            this.emitError(error)
          }
        },
      },
    )) as {
      stream: AsyncGenerator<Event, void, unknown>
    }

    const stream = (async function* () {
      for await (const event of subscription.stream) {
        if (isSessionEvent(event)) {
          yield event
        }
      }
    })()

    return {
      abort: () => {
        controller.abort()
      },
      signal: controller.signal,
      stream,
    }
  }

  private async resolveLatestAssistantMessage(sessionID: string, preferredMessageID: string | null): Promise<{
    info: Message | null
    parts: Part[]
  }> {
    if (preferredMessageID) {
      const message = await requireData(
        "session.message",
        this.args.client.session.message({
          sessionID,
          messageID: preferredMessageID,
          directory: this.args.directory,
        }),
      )
      return {
        info: message.info ?? null,
        parts: message.parts ?? [],
      }
    }

    const messages = await requireData(
      "session.messages",
      this.args.client.session.messages({
        sessionID,
        directory: this.args.directory,
      }),
    )

    const latestAssistant = [...messages].reverse().find((entry) => entry.info.role === "assistant")
    if (!latestAssistant) {
      return {
        info: null,
        parts: [],
      }
    }

    return {
      info: latestAssistant.info ?? null,
      parts: latestAssistant.parts ?? [],
    }
  }

  private async run() {
    const context = createTurnContext()
    const events = await this.subscribeToEvents()

    const consumeTask = (async () => {
      try {
        for await (const event of events.stream) {
          if (getEventSessionID(event) !== this.args.sessionID) {
            continue
          }
          this.handleSessionEvent(event, context)
        }
      } catch (error) {
        if (!events.signal.aborted) {
          this.emitError(error)
        }
      }
    })()

    let turnError: AgentErrorInfo | null = null
    try {
      const response = await this.args.client.session.promptAsync({
        sessionID: this.args.sessionID,
        directory: this.args.directory,
        agent: this.args.agent,
        model: {
          providerID: this.args.model.providerID,
          modelID: this.args.model.modelID,
        },
        parts: [{ type: "text", text: this.args.prompt }],
      })

      if (response.error) {
        throw new Error(`session.promptAsync failed: ${JSON.stringify(response.error)}`)
      }

      await context.idleGate.signal
    } catch (error) {
      turnError = toErrorInfo(error)
      this.emit({
        type: "error",
        agent: this.args.agent,
        sessionID: this.args.sessionID,
        error: turnError,
      })
    } finally {
      await delay(POST_IDLE_EVENT_DRAIN_MS)
      events.abort()

      let shutdownTimer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          consumeTask,
          new Promise<never>((_, reject) => {
            shutdownTimer = setTimeout(() => {
              reject(new Error("Timed out shutting down session event stream after abort"))
            }, EVENT_STREAM_SHUTDOWN_TIMEOUT_MS)
          }),
        ])
      } catch (error) {
        const shutdownError = toErrorInfo(error)
        turnError ??= shutdownError
        this.emit({
          type: "error",
          agent: this.args.agent,
          sessionID: this.args.sessionID,
          error: shutdownError,
        })
      } finally {
        if (shutdownTimer) {
          clearTimeout(shutdownTimer)
        }
      }
    }

    try {
      const resolved = await this.resolveLatestAssistantMessage(this.args.sessionID, context.latestAssistantMessageID)
      const result: AgentTurnResult = {
        agent: this.args.agent,
        error: turnError ?? getAssistantMessageError(resolved.info),
        info: resolved.info,
        messageID: resolved.info?.id ?? context.latestAssistantMessageID,
        parts: resolved.parts,
        sessionID: this.args.sessionID,
        text: extractTextFromParts(resolved.parts),
      }

      if (result.info || result.parts.length > 0 || result.error) {
        this.finalResult = result
        this.emit({
          type: "result",
          agent: this.args.agent,
          sessionID: this.args.sessionID,
          result,
        })
      }
    } catch (error) {
      const resolveError = toErrorInfo(error)
      this.emit({
        type: "error",
        agent: this.args.agent,
        sessionID: this.args.sessionID,
        error: resolveError,
      })
    } finally {
      this.queue.close()
    }
  }
}

export class OpencodeAgentSession {
  private activeTurn: ActiveTurn | null = null
  private startingTurn = false

  constructor(
    private readonly runtime: OpencodeAgentRuntime,
    readonly id: string,
    private readonly defaultAgent?: string,
    private readonly defaultModel?: ModelReference,
  ) {}

  private assertAvailable() {
    if (this.startingTurn || this.activeTurn) {
      throw new Error("A turn is already active for this session")
    }
  }

  async query(prompt: string, options: AgentQueryOptions = {}) {
    this.assertAvailable()
    this.startingTurn = true
    try {
      const agent = options.agent ?? this.defaultAgent
      if (!agent) {
        throw new Error("No agent selected. Pass agent to createSession(), query(), or run().")
      }

      const model = await this.runtime.resolveModel(agent, options.model ?? this.defaultModel)
      this.activeTurn = new ActiveTurn({
        agent,
        client: this.runtime.client,
        directory: this.runtime.directory,
        model,
        prompt,
        sessionID: this.id,
      })
    } finally {
      this.startingTurn = false
    }
  }

  async *receiveResponse(): AsyncGenerator<AgentResponseEvent, void, unknown> {
    const turn = this.activeTurn
    if (!turn) {
      throw new Error("No active turn. Call query() first.")
    }

    try {
      for await (const event of turn.consume()) {
        yield event
      }
    } finally {
      if (this.activeTurn === turn) {
        this.activeTurn = null
      }
    }
  }

  async run(prompt: string, options: AgentRunOptions = {}) {
    await this.query(prompt, options)

    let lastError: AgentErrorInfo | null = null
    let result: AgentTurnResult | null = null

    for await (const event of this.receiveResponse()) {
      if (event.type === "error") {
        lastError = event.error
      }
      if (event.type === "result") {
        result = event.result
      }
    }

    if (result) {
      return result
    }

    if (lastError) {
      throw new Error(formatErrorInfo(lastError))
    }

    throw new Error("Agent turn completed without a final result")
  }

  async abort() {
    await requireData(
      "session.abort",
      this.runtime.client.session.abort({
        sessionID: this.id,
        directory: this.runtime.directory,
      }),
    )
  }

  async interrupt() {
    await this.abort()
  }
}

export class OpencodeAgentRuntime {
  private disposed = false
  private readonly agentDefinitions: ReadonlyMap<string, AgentDefinition>

  constructor(
    readonly client: OpencodeClient,
    readonly directory: string,
    agents: Record<string, AgentDefinition>,
    private readonly managedServer?: ManagedServer,
    private readonly defaultModel?: ModelReference,
  ) {
    this.agentDefinitions = new Map(Object.entries(agents))
  }

  async dispose() {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.managedServer?.close()
  }

  getAgent(name: string) {
    const agent = this.agentDefinitions.get(name)
    if (!agent) {
      throw new Error(`Unknown agent '${name}'`)
    }
    return agent
  }

  async resolveModel(agentName: string, override?: ModelReference): Promise<ModelSpec> {
    const agentModel = this.getAgent(agentName).model
    const selected = override ?? agentModel ?? this.defaultModel
    if (selected) {
      return normalizeModelReference(selected)
    }

    const config = await requireData(
      "config.get",
      this.client.config.get({
        directory: this.directory,
      }),
    )

    const resolved = parseModelSpec(config.model)
    if (!resolved) {
      throw new Error("Unable to resolve model from OpenCode config. Set runtime.model or configure a default model in OpenCode.")
    }

    return resolved
  }

  async createSession(options: AgentSessionOptions = {}) {
    if (this.disposed) {
      throw new Error("Runtime has been disposed")
    }

    const session = await requireData(
      "session.create",
      this.client.session.create({
        directory: this.directory,
      }),
    )

    return new OpencodeAgentSession(this, session.id, options.agent, options.model)
  }

  async run(options: AgentRuntimeRunOptions) {
    const sessionOptions: AgentSessionOptions = {
      agent: options.agent,
      ...(options.model ? { model: options.model } : {}),
    }
    const session = await this.createSession(sessionOptions)
    return session.run(options.prompt)
  }
}

export async function createAgentRuntime(options: AgentRuntimeOptions) {
  const runtimeConfig = buildRuntimeConfig({
    agents: options.agents,
    ...(options.config ? { config: options.config } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.permission ? { permission: options.permission } : {}),
    ...(options.rawConfigContent ? { rawConfigContent: options.rawConfigContent } : {}),
  })

  const { client, server } = await createOpencode({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    timeout: options.timeoutMs ?? 15000,
    config: runtimeConfig,
  })

  return new OpencodeAgentRuntime(client, options.directory, options.agents, server, options.model)
}

export type { Session }
