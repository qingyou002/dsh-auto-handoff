/**
 * Test doubles for the Harness seams `dsh-auto-handoff` reads.
 *
 * Deliberately small: every fake is a plain object with the exact members the
 * plugin calls, cast once at the boundary. The one assertion that matters most
 * lives here too — {@link TestAgent.cancel} is a spy, and every integration
 * test ends by asserting it was never called (`TASK-PLAN.md` §11.1).
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { vi, type Mock } from 'vitest'
import type { HandoffServices, UsageBuckets } from '../src/types.js'

/** A driveable agent double. */
export class TestAgent {
  readonly id: string
  session: Session
  status: 'idle' | 'running' = 'idle'
  options: { provider?: string; model?: string; reasoningEffort?: string }
  ctx: Context
  /** Hard-interrupt spy. The whole point of the plugin is that this stays at 0. */
  readonly cancel: Mock = vi.fn()
  /** Messages delivered into this agent, in order. */
  readonly delivered: UserMessage[] = []
  readonly steered: UserMessage[] = []
  readonly injected: UserMessage[] = []
  readonly maintenanceCalls: number[] = []

  private idleWaiters: (() => void)[] = []

  constructor(options: {
    id?: string
    session?: Session
    status?: 'idle' | 'running'
    provider?: string
    model?: string
    ctx?: Context
  } = {}) {
    this.id = options.id ?? 'session-1'
    this.session = options.session ?? createTestSession(this.id)
    this.status = options.status ?? 'idle'
    this.options = {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
    }
    this.ctx = options.ctx ?? new Context()
  }

  /** Resolve once the agent reaches quiescence. */
  whenIdle(): Promise<void> {
    if (this.status === 'idle') return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /** Enter a turn without finishing it. */
  startStep(): void {
    this.status = 'running'
  }

  /** Finish the current step, letting `whenIdle()` resolve. */
  finishStep(): void {
    this.status = 'idle'
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  followup(message: UserMessage): void {
    this.delivered.push(message)
    if (this.status === 'idle') this.status = 'running'
  }

  steer(message: UserMessage): void {
    this.steered.push(message)
  }

  inject(message: UserMessage): void {
    this.injected.push(message)
  }

  send(): void {
    /* unused by the plugin */
  }

  /** Narrow to the Harness `Agent` type at the boundary. */
  asAgent(): Agent {
    return this as unknown as Agent
  }
}

/** Create a detached but fully functional Harness session. */
export function createTestSession(id = 'session-1', cwd?: string): Session {
  const session = Session.create(SessionId(id))
  if (cwd !== undefined) {
    // `header` is readonly on the live object; tests that need a cwd build the
    // session through a store, which is what the migration path reads anyway.
    ;(session as unknown as { header: { cwd?: string } }).header = { ...session.header, cwd }
  }
  return session
}

/** Append one human `user/message` surface node. */
export function appendUserMessage(session: Session, text: string, _id?: string): UserMessage {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  session.append('user/message', message, { surfaceOp: 'append' })
  return message
}

/** Append one model-authored assistant message with an empty stream. */
export function appendAssistantMessage(session: Session, text: string, turn = 1, step = 1): void {
  session.append(
    'assistant/message',
    {
      turn,
      step,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test', model: 'test-model' },
      }),
      stream: [],
    },
    { surfaceOp: 'append' },
  )
}

/** Append one `tool/call`. */
export function appendToolCall(
  session: Session,
  name: string,
  args: Record<string, unknown>,
  turn = 1,
  step = 1,
): void {
  session.append('tool/call', {
    turn,
    step,
    callId: `call-${session.seq}` as never,
    name,
    arguments: JSON.stringify(args),
  })
}

/** Open a turn and a step so `isMigratable` sees real activity. */
export function openTurn(session: Session, turn = 1, step = 1): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
}

/** The mutable world the coordinator reads. */
export interface FakeWorld {
  services: HandoffServices
  agents: Map<string, TestAgent>
  sessions: Map<string, Session>
  /** Cumulative usage reported for every session, when set. */
  usage: UsageBuckets | undefined
  /** Heuristic measurement reported for every session, when set. */
  measured: number | undefined
  /** Delivered plugin messages, keyed by session id. */
  deliveries: Map<string, string[]>
  /** Replacements for the two action bodies. */
  migration: HandoffServices['runMigration']
  compact: HandoffServices['runCompact']
  compactionAvailable: boolean
  now: () => number
}

/** Build a world with optional overrides. */
export function createWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  const agents = overrides.agents ?? new Map<string, TestAgent>()
  const sessions = overrides.sessions ?? new Map<string, Session>()
  const deliveries = overrides.deliveries ?? new Map<string, string[]>()

  const world: FakeWorld = {
    agents,
    sessions,
    deliveries,
    usage: overrides.usage,
    measured: overrides.measured,
    compactionAvailable: overrides.compactionAvailable ?? false,
    now: overrides.now ?? (() => Date.now()),
    migration:
      overrides.migration ??
      (async () => ({
        kind: 'handoff',
        trigger: 'manual',
        outcome: 'completed',
        startedAt: 0,
        finishedAt: 0,
        text: '已完成会话迁移。',
      })),
    compact:
      overrides.compact ??
      (async () => ({
        kind: 'compact',
        trigger: 'manual',
        outcome: 'completed',
        startedAt: 0,
        finishedAt: 0,
        text: '自动压缩完成。',
      })),
    services: undefined as unknown as HandoffServices,
  }

  world.services = {
    now: () => world.now(),
    log: () => undefined,
    agentOf: (sessionId) => agents.get(sessionId)?.asAgent(),
    sessionOf: (sessionId) => agents.get(sessionId)?.session ?? sessions.get(sessionId),
    tokenUsage: () => (world.usage === undefined ? undefined : { totals: world.usage }),
    measure: () => (world.measured === undefined ? undefined : { totalTokens: world.measured }),
    deliver: (sessionId, text) => {
      const agent = agents.get(sessionId)
      if (agent === undefined) return false
      const list = deliveries.get(sessionId) ?? []
      list.push(text)
      deliveries.set(sessionId, list)
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'dsh-auto-handoff' },
        }),
      )
      return true
    },
    persistence: () => 'memory',
    compactionAvailable: () => world.compactionAvailable,
    runMigration: (input) => world.migration(input),
    runCompact: (input) => world.compact(input),
  }
  return world
}

/** Register an agent plus its session in a world. */
export function addAgent(world: FakeWorld, agent: TestAgent): TestAgent {
  world.agents.set(agent.id, agent)
  world.sessions.set(agent.id, agent.session)
  return agent
}

/** Collect the text of a message. */
export function messageText(message: Message): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/** A minimal event sequence for threshold evaluation. */
export function fakeEvent(seq: number, type = 'assistant/message'): SessionEvent {
  return { type, seq, time: 0, data: {} } as unknown as SessionEvent
}
