import {
  createOpencode,
  createOpencodeClient,
  type Event,
  type EventMessagePartDelta,
  type EventMessagePartUpdated,
  type EventMessageUpdated,
  type EventSessionCreated,
  type EventSessionError,
  type EventSessionIdle,
  type EventSessionStatus,
  type EventSessionUpdated,
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
  AgentEventSource,
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
  ResumeAgentOptions,
  RuntimeAgentInfo,
} from "./types.js"
import { delay, extractTextFromParts, formatErrorInfo, requireData, toErrorInfo } from "./utils.js"

type ManagedServer = {
  close: () => void
}

type SessionEvent =
  | EventMessagePartDelta
  | EventMessagePartUpdated
  | EventMessageUpdated
  | EventSessionCreated
  | EventSessionError
  | EventSessionIdle
  | EventSessionStatus
  | EventSessionUpdated

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
  hasAssistantMessage: boolean
  idleGate: IdleGate
  lastStatusBySessionID: Map<string, string>
  latestRootAssistantMessageID: string | null
  sawBusy: boolean
  textByPartID: Map<string, string>
  trackedSessionIDs: Set<string>
  toolStatusByPartID: Map<string, ToolState["status"]>
}

type SessionNode = {
  agentType: string | null
  parentSessionID: string | null
  sessionID: string
  sourceToolCallID: string | null
  title: string | null
}

const POST_IDLE_EVENT_DRAIN_MS = 300
const EVENT_STREAM_SHUTDOWN_TIMEOUT_MS = 2000

function isSessionEvent(event: Event): event is SessionEvent {
  return (
    event.type === "message.part.updated" ||
    event.type === "message.part.delta" ||
    event.type === "message.updated" ||
    event.type === "session.created" ||
    event.type === "session.status" ||
    event.type === "session.idle" ||
    event.type === "session.error" ||
    event.type === "session.updated"
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
    case "session.created":
      return event.properties.info.id
    case "session.status":
      return event.properties.sessionID
    case "session.idle":
      return event.properties.sessionID
    case "session.error":
      return event.properties.sessionID
    case "session.updated":
      return event.properties.info.id
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

function getRecordString(value: unknown, key: string) {
  if (!isRecord(value)) {
    return null
  }

  const candidate = value[key]
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null
}

function parseSubagentFromTitle(title: string | null | undefined) {
  if (!title) {
    return null
  }

  const match = /\(@([^()]+) subagent\)$/.exec(title.trim())
  return match?.[1] ?? null
}

function compareSessionNodes(a: SessionNode, b: SessionNode, sessionInfoCache: ReadonlyMap<string, Session>) {
  const aCreated = sessionInfoCache.get(a.sessionID)?.time.created ?? Number.MAX_SAFE_INTEGER
  const bCreated = sessionInfoCache.get(b.sessionID)?.time.created ?? Number.MAX_SAFE_INTEGER
  if (aCreated !== bCreated) {
    return aCreated - bCreated
  }
  return a.sessionID.localeCompare(b.sessionID)
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

function createTurnContext(rootSessionID: string): TurnContext {
  return {
    assistantMessageIDs: new Set<string>(),
    hasAssistantMessage: false,
    idleGate: createIdleGate(),
    lastStatusBySessionID: new Map<string, string>([[rootSessionID, "pending"]]),
    latestRootAssistantMessageID: null,
    sawBusy: false,
    textByPartID: new Map<string, string>(),
    trackedSessionIDs: new Set<string>([rootSessionID]),
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
      includeSubagents: boolean
      model: ModelSpec
      prompt: string
      runtime: OpencodeAgentRuntime
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

  private getEventSource(sessionID: string, fallbackAgentType?: string) {
    const rootFallback = sessionID === this.args.sessionID ? this.args.agent : undefined
    return this.args.runtime.getKnownEventSource(sessionID, fallbackAgentType ?? rootFallback)
  }

  private emitError(error: unknown, sessionID = this.args.sessionID, fallbackAgentType?: string) {
    const source = this.getEventSource(sessionID, fallbackAgentType)
    this.emit({
      type: "error",
      agent: source.agentType,
      sessionID,
      source,
      error: toErrorInfo(error),
    })
  }

  private markIdleIfReady(context: TurnContext) {
    if (context.sawBusy || context.hasAssistantMessage) {
      if (this.args.includeSubagents) {
        for (const sessionID of context.trackedSessionIDs) {
          if (context.lastStatusBySessionID.get(sessionID) !== "idle") {
            return
          }
        }
      }
      context.idleGate.mark()
    }
  }

  private emitStatus(sessionID: string, context: TurnContext, status: string, fallbackAgentType?: string) {
    const previous = context.lastStatusBySessionID.get(sessionID) ?? ""
    if (!status || status === previous) {
      return
    }

    context.lastStatusBySessionID.set(sessionID, status)
    const source = this.getEventSource(sessionID, fallbackAgentType)
    this.emit({
      type: "status",
      agent: source.agentType,
      sessionID,
      source,
      status,
    })
  }

  private emitTextEvent(sessionID: string, event: Omit<AgentTextEvent, "agent" | "sessionID" | "source" | "type">) {
    const source = this.getEventSource(sessionID)
    this.emit({
      type: "text",
      agent: source.agentType,
      sessionID,
      source,
      ...event,
    })
  }

  private emitToolCallEvent(
    sessionID: string,
    event: Omit<AgentToolCallEvent, "agent" | "sessionID" | "source" | "type">,
  ) {
    const source = this.getEventSource(sessionID)
    this.emit({
      type: "tool_call",
      agent: source.agentType,
      sessionID,
      source,
      ...event,
    })
  }

  private handleMessagePartDelta(event: EventMessagePartDelta, context: TurnContext) {
    if (event.properties.field !== "text" || !event.properties.delta) {
      return
    }

    const previous = context.textByPartID.get(event.properties.partID) ?? ""
    context.textByPartID.set(event.properties.partID, `${previous}${event.properties.delta}`)
    this.emitTextEvent(event.properties.sessionID, {
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

    this.emitTextEvent(part.sessionID, {
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
    const event: Omit<AgentToolCallEvent, "agent" | "sessionID" | "source" | "type"> = {
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

    this.emitToolCallEvent(part.sessionID, {
      ...event,
    })
  }

  private extractTaskChildSessionID(part: ToolPart) {
    if (part.tool !== "task") {
      return null
    }

    const metadata = "metadata" in part.state ? part.state.metadata : undefined
    return getRecordString(metadata, "sessionId") ?? getRecordString(part.state.input, "task_id")
  }

  private extractTaskAgentType(part: ToolPart) {
    if (part.tool !== "task") {
      return null
    }
    return getRecordString(part.state.input, "subagent_type")
  }

  private trackDiscoveredSessions(event: SessionEvent, context: TurnContext) {
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        this.args.runtime.trackSessionInfo(event.properties.info)
        if (
          this.args.includeSubagents &&
          event.properties.info.parentID &&
          context.trackedSessionIDs.has(event.properties.info.parentID)
        ) {
          context.trackedSessionIDs.add(event.properties.info.id)
          if (!context.lastStatusBySessionID.has(event.properties.info.id)) {
            context.lastStatusBySessionID.set(event.properties.info.id, "pending")
          }
        }
        return
      }
      case "message.updated":
        this.args.runtime.trackSessionAgentType(event.properties.info.sessionID, event.properties.info.agent)
        return
      case "message.part.updated": {
        if (!this.args.includeSubagents || event.properties.part.type !== "tool") {
          return
        }

        const part = event.properties.part
        if (!context.trackedSessionIDs.has(part.sessionID)) {
          return
        }

        const childSessionID = this.extractTaskChildSessionID(part)
        if (!childSessionID) {
          return
        }

        this.args.runtime.trackTaskSessionLink({
          agentType: this.extractTaskAgentType(part),
          childSessionID,
          parentSessionID: part.sessionID,
          sourceToolCallID: part.callID,
        })
        context.trackedSessionIDs.add(childSessionID)
        if (!context.lastStatusBySessionID.has(childSessionID)) {
          context.lastStatusBySessionID.set(childSessionID, "pending")
        }
        return
      }
      default:
        return
    }
  }

  private handleSessionEvent(event: SessionEvent, context: TurnContext) {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        return
      case "session.status":
        if (event.properties.status.type === "busy") {
          context.sawBusy = true
        }
        this.emitStatus(event.properties.sessionID, context, event.properties.status.type)
        if (event.properties.status.type === "idle") {
          this.markIdleIfReady(context)
        }
        return
      case "session.idle":
        this.markIdleIfReady(context)
        this.emitStatus(event.properties.sessionID, context, "idle")
        return
      case "session.error":
        this.emitError(event.properties.error, event.properties.sessionID)
        return
      case "message.updated":
        if (event.properties.info.role === "assistant") {
          context.assistantMessageIDs.add(event.properties.info.id)
          context.hasAssistantMessage = true
          if (event.properties.info.sessionID === this.args.sessionID) {
            context.latestRootAssistantMessageID = event.properties.info.id
          }
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
    await this.args.runtime.primeSessionLineage(this.args.sessionID, this.args.agent)
    const context = createTurnContext(this.args.sessionID)
    const events = await this.subscribeToEvents()

    const consumeTask = (async () => {
      try {
        for await (const event of events.stream) {
          this.trackDiscoveredSessions(event, context)
          const sessionID = getEventSessionID(event)
          if (!sessionID || !context.trackedSessionIDs.has(sessionID)) {
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
      this.emitError(turnError)
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
        this.emitError(shutdownError)
      } finally {
        if (shutdownTimer) {
          clearTimeout(shutdownTimer)
        }
      }
    }

    try {
      const resolved = await this.resolveLatestAssistantMessage(this.args.sessionID, context.latestRootAssistantMessageID)
      const source = this.getEventSource(this.args.sessionID, this.args.agent)
      const result: AgentTurnResult = {
        agent: source.agentType,
        error: turnError ?? getAssistantMessageError(resolved.info),
        info: resolved.info,
        messageID: resolved.info?.id ?? context.latestRootAssistantMessageID,
        parts: resolved.parts,
        sessionID: this.args.sessionID,
        source,
        text: extractTextFromParts(resolved.parts),
      }

      if (result.info || result.parts.length > 0 || result.error) {
        this.finalResult = result
        this.emit({
          type: "result",
          agent: source.agentType,
          sessionID: this.args.sessionID,
          source,
          result,
        })
      }
    } catch (error) {
      this.emitError(toErrorInfo(error))
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

      this.runtime.trackSessionAgentType(this.id, agent, true)
      const model = await this.runtime.resolveModel(agent, options.model ?? this.defaultModel)
      this.activeTurn = new ActiveTurn({
        agent,
        client: this.runtime.client,
        directory: this.runtime.directory,
        includeSubagents: options.includeSubagents ?? false,
        model,
        prompt,
        runtime: this.runtime,
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

  async runAgent(prompt: string, options: AgentRunOptions = {}) {
    return this.run(prompt, options)
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
  private runtimeAgentsPromise: Promise<RuntimeAgentInfo[]> | null = null
  private readonly sessionInfoCache = new Map<string, Session>()
  private readonly sessionNodeCache = new Map<string, SessionNode>()

  constructor(
    readonly client: OpencodeClient,
    readonly directory: string,
    agents: Record<string, AgentDefinition>,
    private readonly managedServer?: ManagedServer,
    private readonly defaultModel?: ModelReference,
  ) {
    this.agentDefinitions = new Map(Object.entries(agents))
  }

  private getSessionNode(sessionID: string) {
    let node = this.sessionNodeCache.get(sessionID)
    if (!node) {
      node = {
        agentType: null,
        parentSessionID: null,
        sessionID,
        sourceToolCallID: null,
        title: null,
      }
      this.sessionNodeCache.set(sessionID, node)
    }
    return node
  }

  private getSiblingOrdinal(node: SessionNode) {
    if (!node.parentSessionID || !node.agentType) {
      return null
    }

    const siblings = [...this.sessionNodeCache.values()]
      .filter((candidate) => candidate.parentSessionID === node.parentSessionID && candidate.agentType === node.agentType)
      .sort((left, right) => compareSessionNodes(left, right, this.sessionInfoCache))

    const index = siblings.findIndex((candidate) => candidate.sessionID === node.sessionID)
    return index >= 0 ? index + 1 : null
  }

  trackSessionInfo(session: Session) {
    this.sessionInfoCache.set(session.id, session)
    const node = this.getSessionNode(session.id)
    node.parentSessionID = session.parentID ?? null
    node.title = session.title

    const titleAgent = parseSubagentFromTitle(session.title)
    if (titleAgent && !node.agentType) {
      node.agentType = titleAgent
    }
  }

  trackSessionAgentType(sessionID: string, agentType: string, force = false) {
    if (!agentType) {
      return
    }
    const node = this.getSessionNode(sessionID)
    if (force || !node.agentType) {
      node.agentType = agentType
    }
  }

  trackTaskSessionLink(input: {
    agentType: string | null
    childSessionID: string
    parentSessionID: string
    sourceToolCallID: string | null
  }) {
    const node = this.getSessionNode(input.childSessionID)
    if (!node.parentSessionID) {
      node.parentSessionID = input.parentSessionID
    }
    if (!node.sourceToolCallID && input.sourceToolCallID) {
      node.sourceToolCallID = input.sourceToolCallID
    }
    if (!node.agentType && input.agentType) {
      node.agentType = input.agentType
    }
  }

  async getSessionInfo(sessionID: string) {
    const cached = this.sessionInfoCache.get(sessionID)
    if (cached) {
      return cached
    }

    const session = await requireData(
      "session.get",
      this.client.session.get({
        sessionID,
        directory: this.directory,
      }),
    )
    this.trackSessionInfo(session)
    return session
  }

  async ensureSessionAgentType(sessionID: string, fallbackAgentType?: string) {
    const node = this.getSessionNode(sessionID)
    if (node.agentType) {
      return node.agentType
    }

    const titleAgent = parseSubagentFromTitle(node.title)
    if (titleAgent) {
      node.agentType = titleAgent
      return node.agentType
    }

    try {
      const messages = await requireData(
        "session.messages",
        this.client.session.messages({
          sessionID,
          directory: this.directory,
        }),
      )
      const messageWithAgent = [...messages]
        .reverse()
        .find((entry) => typeof entry.info.agent === "string" && entry.info.agent.length > 0)
      if (messageWithAgent?.info.agent) {
        node.agentType = messageWithAgent.info.agent
        return node.agentType
      }
    } catch {
      // Ignore cache warm-up failures and fall back below.
    }

    if (fallbackAgentType) {
      node.agentType = fallbackAgentType
      return node.agentType
    }

    return null
  }

  async primeSessionLineage(sessionID: string, fallbackAgentType?: string) {
    let currentSessionID: string | null = sessionID
    while (currentSessionID) {
      const session = await this.getSessionInfo(currentSessionID)
      await this.ensureSessionAgentType(currentSessionID, currentSessionID === sessionID ? fallbackAgentType : undefined)
      currentSessionID = session.parentID ?? null
    }
  }

  getKnownEventSource(sessionID: string, fallbackAgentType?: string): AgentEventSource {
    const leaf = this.getSessionNode(sessionID)
    if (!leaf.agentType && fallbackAgentType) {
      leaf.agentType = fallbackAgentType
    }

    const lineage: SessionNode[] = []
    const seen = new Set<string>()
    let cursor: SessionNode | undefined = leaf

    while (cursor && !seen.has(cursor.sessionID)) {
      lineage.push(cursor)
      seen.add(cursor.sessionID)
      cursor = cursor.parentSessionID ? this.sessionNodeCache.get(cursor.parentSessionID) : undefined
    }

    const ordered = lineage.reverse()
    const chain = ordered.map((node, index) => {
      const agentType = node.agentType ?? (node.sessionID === sessionID ? fallbackAgentType : undefined) ?? "unknown"
      if (index === 0) {
        return agentType
      }

      const ordinal = this.getSiblingOrdinal(node)
      return ordinal ? `${agentType}#${ordinal}` : agentType
    })

    const agentType = leaf.agentType ?? fallbackAgentType ?? "unknown"
    return {
      agentLabel: chain[chain.length - 1] ?? agentType,
      agentType,
      chain,
      chainText: chain.join(" -> "),
      depth: Math.max(chain.length - 1, 0),
      parentSessionID: leaf.parentSessionID,
      rootSessionID: ordered[0]?.sessionID ?? sessionID,
      sessionID,
      sourceToolCallID: leaf.sourceToolCallID,
      taskID: leaf.parentSessionID ? sessionID : null,
    }
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

  async listAgents(): Promise<RuntimeAgentInfo[]> {
    if (!this.runtimeAgentsPromise) {
      this.runtimeAgentsPromise = requireData(
        "app.agents",
        this.client.app.agents({
          directory: this.directory,
        }),
      ).then((agents) =>
        agents.map((agent) => {
          const info: RuntimeAgentInfo = {
            mode: agent.mode,
            name: agent.name,
          }

          if (agent.color) {
            info.color = agent.color
          }
          if (agent.description) {
            info.description = agent.description
          }
          if (typeof agent.hidden === "boolean") {
            info.hidden = agent.hidden
          }
          if (agent.model) {
            info.model = {
              modelID: agent.model.modelID,
              providerID: agent.model.providerID,
            }
          }
          if (typeof agent.native === "boolean") {
            info.native = agent.native
          }
          if (typeof agent.steps === "number") {
            info.steps = agent.steps
          }

          return info
        }),
      )
    }

    return this.runtimeAgentsPromise
  }

  private async getRuntimeAgentInfo(name: string) {
    const agents = await this.listAgents()
    return agents.find((agent) => agent.name === name) ?? null
  }

  async resolveModel(agentName: string, override?: ModelReference): Promise<ModelSpec> {
    const configuredModel = this.agentDefinitions.get(agentName)?.model
    const runtimeModel = (await this.getRuntimeAgentInfo(agentName))?.model
    const selected = override ?? configuredModel ?? runtimeModel ?? this.defaultModel
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

  async openSession(sessionID: string, options: AgentSessionOptions = {}) {
    const session = await this.getSessionInfo(sessionID)
    await this.primeSessionLineage(sessionID, options.agent)
    const defaultAgent = (await this.ensureSessionAgentType(
      sessionID,
      options.agent ?? parseSubagentFromTitle(session.title) ?? undefined,
    )) ?? undefined

    return new OpencodeAgentSession(this, sessionID, defaultAgent, options.model)
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

    this.trackSessionInfo(session)
    if (options.agent) {
      this.trackSessionAgentType(session.id, options.agent)
    }

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

  async runAgent(options: AgentRuntimeRunOptions) {
    return this.run(options)
  }

  async resumeAgent(options: ResumeAgentOptions) {
    const session = await this.openSession(options.sessionID, {
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.model ? { model: options.model } : {}),
    })
    if (options.prompt) {
      await session.query(options.prompt, {
        ...(options.agent ? { agent: options.agent } : {}),
        ...(typeof options.includeSubagents === "boolean" ? { includeSubagents: options.includeSubagents } : {}),
        ...(options.model ? { model: options.model } : {}),
      })
    }
    return session
  }
}

export async function createAgentRuntime(options: AgentRuntimeOptions) {
  const agents = options.agents ?? {}
  if (options.serverUrl) {
    if (typeof options.hostname === "string" || typeof options.port === "number" || typeof options.timeoutMs === "number") {
      throw new Error("serverUrl cannot be combined with hostname, port, or timeoutMs")
    }

    const client = createOpencodeClient({
      baseUrl: options.serverUrl,
      directory: options.directory,
    })

    return new OpencodeAgentRuntime(client, options.directory, agents, undefined, options.model)
  }

  const runtimeConfig = buildRuntimeConfig({
    agents,
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

  return new OpencodeAgentRuntime(client, options.directory, agents, server, options.model)
}

export type { Session }
