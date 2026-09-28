/**
 * The coordinator: one action per session, a phase machine, and the soft-stop
 * latch that keeps reconnaissance and execution apart.
 *
 * Everything it does is bookkeeping around two Harness facts:
 *
 * - a step can only be refused *before* it starts, from `agent/pre-step`;
 * - the current step only ends when the Harness ends it, so the plugin waits
 *   on `agent.whenIdle()` rather than cancelling anything.
 *
 * `TASK-PLAN.md` §7.1 (state machine), §7.3 (event subscriptions), §7.7
 * (user-message interaction), §8 (thresholds and re-arming), §14 (错误处理).
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { decidePreStep, StopLatch, waitForBoundary } from './graceful-stop.js'
import type { HandoffSettings } from './settings.js'
import { StateStore } from './state.js'
import { decideAutoAction, readCumulativeUsage, TokenTracker } from './token-threshold.js'
import {
  isActivePhase,
  MESSAGES,
  POST_SESSION_PHASES,
  PRE_SESSION_PHASES,
  toSessionStatus,
  type ActionRecord,
  type HandoffActionKind,
  type HandoffActionTrigger,
  type HandoffOutcome,
  type HandoffServices,
  type InheritanceRow,
  type MatchOutcome,
  type SessionRecord,
  type SessionStatus,
} from './types.js'

/** Event types that can move the cumulative token figure. */
const TOKEN_EVENT_TYPES = new Set<string>(['assistant/message', 'turn/end', 'compaction/end'])

/** Options for {@link Coordinator}. */
export interface CoordinatorOptions {
  services: HandoffServices
  /** Current settings; read fresh on every decision so changes apply live. */
  settings: () => HandoffSettings
  /** Boundary-wait poll interval; tests shrink it. */
  tickMs?: number
}

/** One `agent/pre-step` payload, narrowed to what the guard reads. */
export interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
}

/** The coordinator's soft-stop view of a proposed step. */
export type PreStepAnswer = { kind: 'reject' } | { kind: 'enter' }

/** The coordinator's one-action-per-session state machine. */
export class Coordinator {
  private readonly state = new StateStore()
  private readonly latch = new StopLatch()
  private readonly tracker = new TokenTracker()
  private readonly inflight = new Map<string, Promise<ActionRecord>>()
  private readonly controllers = new Map<string, AbortController>()
  private disposed = false

  constructor(private readonly options: CoordinatorOptions) {}

  /** The underlying record table; exposed for the status route and tests. */
  get records(): StateStore {
    return this.state
  }

  /** Whether the soft-stop latch is raised for one session. */
  isLatched(sessionId: string): boolean {
    return this.latch.isHeld(sessionId)
  }

  /** Number of raised latches; the unload test asserts this reaches zero. */
  get latchCount(): number {
    return this.latch.size
  }

  /** Number of live in-flight actions. */
  get inflightCount(): number {
    return this.inflight.size
  }

  /**
   * Arm one action for a session.
   *
   * Refuses when an action is already in flight, when compaction is requested
   * in a deployment without it, or when the session has no live agent — every
   * refusal carries a ready-to-print sentence rather than failing silently.
   *
   * @param sessionId - durable session id.
   * @param kind - `handoff` or `compact`.
   * @param trigger - `manual` (a command or route) or `threshold` (automation).
   * @returns the settled outcome, or the refusal.
   */
  async arm(
    sessionId: string,
    kind: HandoffActionKind,
    trigger: HandoffActionTrigger,
  ): Promise<MatchOutcome> {
    if (this.disposed) {
      return { ok: false, reason: 'disposed', text: '插件已卸载，无法执行迁移。' }
    }
    const existing = this.state.peek(sessionId)
    if (existing !== undefined && (existing.armed !== undefined || isActivePhase(existing.phase))) {
      return { ok: false, reason: 'in-flight', text: MESSAGES.alreadyInFlight(kind) }
    }
    // The agent comes first: compaction lives in the agent's own preset realm on
    // the Web surface, so the capability probe needs the agent to answer at all.
    const agent = this.options.services.agentOf(sessionId)
    if (agent === undefined) {
      return { ok: false, reason: 'no-agent', text: MESSAGES.noActiveSession() }
    }
    if (kind === 'compact' && !this.options.services.compactionAvailable(agent)) {
      return { ok: false, reason: 'compact-unsupported', text: MESSAGES.compactUnsupported() }
    }

    const record = this.state.get(sessionId)
    const now = this.options.services.now()
    record.armed = { kind, trigger, requestedAt: now }
    record.stopRequested = true
    record.stopRequestedAt = now
    record.cancelRequested = false
    record.atBoundary = false
    record.slowWarning = false
    record.failures = []
    record.newSessionId = undefined
    record.phase = 'PREPARING'
    record.actionDeadlineAt = now + this.options.settings().actionDeadlineMs
    // §8.4: whether a turn was actually soft-stopped decides whether a
    // successful compaction may start a fresh "continue" turn.
    record.softStoppedRunning = agent.status === 'running'
    this.latch.hold(sessionId)
    this.state.note(
      record,
      `已受理${kind === 'handoff' ? '会话迁移' : '自动压缩'}请求（${
        trigger === 'manual' ? '手动' : '阈值自动'
      }）。`,
    )

    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    const promise = this.runAction(record, agent, controller.signal)
    this.inflight.set(sessionId, promise)
    try {
      record.phase = 'WAITING_FOR_STEP_BOUNDARY'
      const action = await promise
      return { ok: action.outcome === 'completed', action, text: action.text }
    } finally {
      this.inflight.delete(sessionId)
      this.controllers.delete(sessionId)
    }
  }

  /**
   * Ask the in-flight action to stop at its next safe checkpoint.
   *
   * This never aborts a running step or tool call: it only flips a flag the
   * boundary wait and the action bodies poll.
   *
   * @param sessionId - durable session id.
   * @returns whether a cancellation request was accepted.
   */
  cancel(sessionId: string): MatchOutcome {
    const record = this.state.peek(sessionId)
    if (record === undefined || (record.armed === undefined && !isActivePhase(record.phase))) {
      return { ok: false, reason: 'nothing-to-cancel', text: MESSAGES.nothingToCancel() }
    }
    record.cancelRequested = true
    this.state.note(record, '已请求取消：将在当前 Step 完成后的安全检查点停止。')
    return { ok: true, text: '已请求取消：将在当前 Step 完成后的安全检查点停止。' }
  }

  /**
   * Re-arm the most recent failed action.
   *
   * @param sessionId - durable session id.
   * @returns the settled outcome, or the refusal.
   */
  async retry(sessionId: string): Promise<MatchOutcome> {
    const record = this.state.peek(sessionId)
    const last = record?.lastResult
    if (record === undefined || last === undefined || last.outcome === 'completed') {
      return { ok: false, reason: 'nothing-to-retry', text: MESSAGES.nothingToRetry() }
    }
    return this.arm(sessionId, last.kind, 'manual')
  }

  /** Detached status for one session, refreshing the token reading on demand. */
  status(sessionId: string): SessionStatus | undefined {
    const record = this.state.peek(sessionId)
    if (record === undefined) return undefined
    this.refreshReading(record)
    return toSessionStatus(record)
  }

  /** Detached status for every tracked session. */
  statuses(): SessionStatus[] {
    return this.state.all().map((record) => {
      this.refreshReading(record)
      return toSessionStatus(record)
    })
  }

  /**
   * The `agent/pre-step` guard.
   *
   * @param payload - the proposed step.
   * @param next - the waterfall continuation; called unchanged whenever the
   *   step is allowed to enter.
   * @returns `{ kind: 'reject' }` only when the latch is held and no human
   *   prompt was claimed.
   */
  async handlePreStep(
    payload: PreStepPayload,
    next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }>,
  ): Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }> {
    const record = this.state.peek(String(payload.agent.id))
    if (record === undefined || !record.stopRequested) return next()
    if (record.armed === undefined && !isActivePhase(record.phase)) {
      // A stale latch must never hold a session hostage.
      this.latch.release(record.sessionId)
      record.stopRequested = false
      return next()
    }

    const verdict = decidePreStep({ stopRequested: true, messages: payload.messages })
    if (!verdict.humanPrompt) {
      record.atBoundary = true
      return { kind: 'reject' }
    }

    return this.handleHumanPrompt(record, payload.messages, next)
  }

  private async handleHumanPrompt(
    record: SessionRecord,
    messages: readonly UserMessage[],
    next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }>,
  ): Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }> {
    const text = extractPromptText(messages)

    // Phase 2: the replacement session exists but the brief is still being
    // delivered. Re-route the text there instead of running it twice.
    if (POST_SESSION_PHASES.includes(record.phase) && record.newSessionId !== undefined) {
      if (text.length > 0 && this.options.services.deliver(record.newSessionId, text)) {
        this.state.note(record, MESSAGES.messageForwarded(record.newSessionId))
        return { kind: 'reject' }
      }
      this.state.note(record, '转投到新会话失败，消息留在原会话执行。')
      record.cancelRequested = true
      this.latch.release(record.sessionId)
      record.stopRequested = false
      return next()
    }

    // Phase 1: nothing was created yet. Abandon this migration, keep the
    // message in the original session.
    if (PRE_SESSION_PHASES.includes(record.phase)) {
      record.cancelRequested = true
      this.state.note(record, MESSAGES.cancelledByUserMessage())
      this.latch.release(record.sessionId)
      record.stopRequested = false
      return next()
    }

    // No action in flight: never hold a human prompt back.
    this.latch.release(record.sessionId)
    record.stopRequested = false
    return next()
  }

  /**
   * One durable `session/event` observation: watermark, refresh the reading,
   * and decide whether to arm an automatic action.
   *
   * @param session - the session whose log grew.
   * @param event - the appended event.
   */
  observe(session: Session, event: SessionEvent): void {
    if (this.disposed) return
    const sessionId = String(session.id)
    if (!this.tracker.observe(sessionId, Number(event.seq))) return
    if (!TOKEN_EVENT_TYPES.has(event.type as string)) return
    // Check the live capability before materializing any state, so observing a
    // detached session never grows the table.
    if (this.options.services.agentOf(sessionId) === undefined) return

    const record = this.state.get(sessionId)
    if (record.retired) return

    this.refreshReading(record, session)
    const decision = decideAutoAction({
      reading: record.lastReading,
      settings: this.options.settings(),
      record,
      hasPendingAction: isActivePhase(record.phase),
    })
    if (decision.kind === 'none') return
    void this.arm(sessionId, decision.kind, 'threshold')
  }

  /**
   * Record an `agent/status` transition (`TASK-PLAN.md` §14-14).
   *
   * @param sessionId - the agent's session id.
   * @param status - the status just entered.
   */
  noteAgentStatus(sessionId: string, status: 'idle' | 'running'): void {
    const record = this.state.peek(sessionId)
    if (record === undefined) return
    if (status === 'idle' && record.stopRequested) record.atBoundary = true
  }

  /**
   * Record an `agent/error` payload as a failure note (`TASK-PLAN.md` §14-6).
   *
   * @param sessionId - the agent's session id.
   * @param error - the failure, verbatim.
   */
  noteAgentError(sessionId: string, error: unknown): void {
    const record = this.state.peek(sessionId)
    if (record === undefined) return
    this.state.fail(record, MESSAGES.toolCallFailed(reasonOf(error)))
  }

  /** Drop every trace of one session (its agent or session was disposed). */
  releaseSession(sessionId: string): void {
    const record = this.state.peek(sessionId)
    if (record !== undefined) {
      this.latch.release(sessionId)
      record.stopRequested = false
      record.atBoundary = false
      record.armed = undefined
    }
    this.state.remove(sessionId)
    this.tracker.reset(sessionId)
  }

  /**
   * Tear the coordinator down: abort in-flight work, release every latch, and
   * wait for the outstanding promises to settle (`TASK-PLAN.md` §7.2 「卸载」).
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.controllers.values()) controller.abort()
    const pending = [...this.inflight.values()]
    this.inflight.clear()
    this.controllers.clear()
    await Promise.allSettled(pending)
    this.latch.clear()
    this.tracker.clear()
    this.state.clear()
  }

  private refreshReading(record: SessionRecord, session?: Session): void {
    const target = session ?? this.options.services.sessionOf(record.sessionId)
    if (target === undefined) return
    record.lastReading = readCumulativeUsage({
      projection: this.options.services.tokenUsage(target),
      measure: this.options.services.measure(target),
    })
  }

  private async runAction(
    record: SessionRecord,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<ActionRecord> {
    const services = this.options.services
    const settings = this.options.settings()
    const armed = record.armed ?? { kind: 'handoff' as const, trigger: 'manual' as const, requestedAt: services.now() }
    const startedAt = services.now()

    let outcome: HandoffOutcome = 'failed'
    let text = MESSAGES.failed('未知原因。')

    try {
      const boundary = await waitForBoundary(agent, {
        slowAfterMs: settings.stepWaitTimeoutMs,
        deadlineMs: settings.actionDeadlineMs,
        tickMs: this.options.tickMs,
        now: () => services.now(),
        signal,
        isCancelled: () => record.cancelRequested,
        onSlow: (elapsed) => {
          record.slowWarning = true
          this.state.note(record, MESSAGES.waitingForStep(Math.floor(elapsed / 60_000)))
        },
      })

      if (boundary === 'cancelled') {
        outcome = 'cancelled'
        text = MESSAGES.cancelled()
      } else if (boundary === 'deadline') {
        outcome = 'failed'
        text = MESSAGES.actionDeadline(Math.round(settings.actionDeadlineMs / 60_000))
        this.state.fail(record, text)
      } else {
        record.atBoundary = true
        this.state.note(record, MESSAGES.phaseSaving())
        const runInput = {
          record,
          agent,
          signal,
          note: (line: string) => this.state.note(record, line),
        }
        const result =
          armed.kind === 'handoff'
            ? await services.runMigration(runInput)
            : await services.runCompact(runInput)
        outcome = result.outcome
        text = result.text
        if (result.newSessionId !== undefined) record.newSessionId = result.newSessionId
      }
    } catch (error) {
      outcome = 'failed'
      text =
        armed.kind === 'handoff'
          ? MESSAGES.failed(reasonOf(error))
          : MESSAGES.compactFailed('unknown', reasonOf(error))
      this.state.fail(record, text)
    } finally {
      this.latch.release(record.sessionId)
      record.stopRequested = false
      record.atBoundary = false
      record.armed = undefined
      record.actionDeadlineAt = undefined
      record.phase = outcome === 'completed' ? 'COMPLETED' : outcome === 'cancelled' ? 'CANCELLED' : 'FAILED'
    }

    const finishedAt = services.now()
    const action: ActionRecord = {
      kind: armed.kind,
      trigger: armed.trigger,
      outcome,
      startedAt,
      finishedAt,
      text,
      tokens: record.lastReading.tokens,
    }
    if (record.newSessionId !== undefined) action.newSessionId = record.newSessionId
    const inheritance = readInheritance(record)
    if (inheritance !== undefined) action.inheritance = inheritance

    record.lastResult = action
    if (armed.trigger === 'threshold') record.autoActions += 1
    if (outcome === 'completed') {
      record.lastActionAtTokens = record.lastReading.tokens
      if (armed.kind === 'handoff') record.retired = true
    }
    this.state.note(record, text)
    return action
  }
}

function readInheritance(record: SessionRecord): InheritanceRow[] | undefined {
  const value = record.inheritanceRows
  return value === undefined ? undefined : [...value]
}

/** Join the text blocks of the human prompts in one claimed batch. */
export function extractPromptText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: string }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n\n').trim()
}

/** Render an unknown thrown value as one line. */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
