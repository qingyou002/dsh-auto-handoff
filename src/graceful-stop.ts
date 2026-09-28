/**
 * Soft stop: hold the next step back, and never touch work already running.
 *
 * The whole mechanism is one latch plus `agent.whenIdle()`. Nothing here calls
 * `agent.cancel()`; the current step — including any in-flight tool call and
 * the file or terminal work under it — is allowed to finish and commit
 * normally. Only the *next* step is refused, by returning `{ kind: 'reject' }`
 * from the `agent/pre-step` waterfall, which closes the turn with
 * `reason: 'blocked'` (`TASK-PLAN.md` §7.1–§7.2).
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Anything carrying a message source; narrowed for test doubles. */
export type SourcedMessage = Pick<UserMessage, 'source'>

/**
 * Whether one claimed message is a fresh human prompt.
 *
 * A browser submission is `source.kind === 'user'` (the `user-rpc` variant);
 * an injected context is `'plugin'`, a goal continuation round is `'goal'`,
 * and model/tool traffic is `'model'`/`'tool'`. Rejecting a step discards the
 * messages it claimed, so this is the guard that keeps a human prompt from
 * being swallowed (`TASK-PLAN.md` §7.2 「人类提示守卫」).
 *
 * @param message - one message about to enter the proposed step.
 * @returns `true` when refusing the step would lose human input.
 */
export function isHumanPrompt(message: SourcedMessage): boolean {
  return (message.source as { kind?: string }).kind === 'user'
}

/** Whether any claimed message is a fresh human prompt. */
export function carriesHumanPrompt(messages: readonly SourcedMessage[]): boolean {
  return messages.some((message) => isHumanPrompt(message))
}

/** The pre-step guard's verdict. */
export interface PreStepVerdict {
  /** Return `{ kind: 'reject' }` instead of `next()`. */
  reject: boolean
  /** Whether a human prompt was found in the claimed batch. */
  humanPrompt: boolean
  reason: 'latch-held' | 'human-prompt' | 'latch-clear'
}

/**
 * Decide whether to refuse the proposed step.
 *
 * @param input - the latch state and the messages the loop claimed.
 * @returns the verdict; `human-prompt` always wins over `latch-held`.
 */
export function decidePreStep(input: {
  stopRequested: boolean
  messages: readonly SourcedMessage[]
}): PreStepVerdict {
  const humanPrompt = carriesHumanPrompt(input.messages)
  if (!input.stopRequested) return { reject: false, humanPrompt, reason: 'latch-clear' }
  if (humanPrompt) return { reject: false, humanPrompt, reason: 'human-prompt' }
  return { reject: true, humanPrompt, reason: 'latch-held' }
}

/**
 * Per-session soft-stop latches.
 *
 * The latch is the only shared state between the command that arms an action
 * and the pre-step listener that refuses steps; releasing it restores normal
 * operation immediately.
 */
export class StopLatch {
  private readonly held = new Set<string>()

  /** Raise the latch for one session. */
  hold(sessionId: string): void {
    this.held.add(sessionId)
  }

  /** Drop the latch for one session (idempotent). */
  release(sessionId: string): void {
    this.held.delete(sessionId)
  }

  /** Whether the latch is currently raised. */
  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId)
  }

  /** Every session whose latch is raised. */
  heldIds(): string[] {
    return [...this.held]
  }

  /** Drop every latch (plugin teardown). */
  clear(): void {
    this.held.clear()
  }

  /** Number of raised latches; used by the unload test. */
  get size(): number {
    return this.held.size
  }
}

/** Outcome of waiting for the step boundary. */
export type BoundaryOutcome = 'boundary' | 'deadline' | 'cancelled'

/** Options for {@link waitForBoundary}. */
export interface BoundaryWaitOptions {
  /** Elapsed time after which the wait is reported as slow — never aborts. */
  slowAfterMs: number
  /** Elapsed time after which the wait gives up by releasing the latch. */
  deadlineMs: number
  /** Polled between ticks; a cancel releases the latch and stops the action. */
  isCancelled(): boolean
  /** Plugin teardown signal; an aborted wait ends immediately. */
  signal?: AbortSignal
  /** Called once when the wait crosses `slowAfterMs`. */
  onSlow(elapsedMs: number): void
  /** Poll interval; tests shrink it. Defaults to 250 ms. */
  tickMs?: number
  /** Clock; tests inject a deterministic one. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Wait for the agent to reach quiescence without disturbing it.
 *
 * The wait is bounded twice: `slowAfterMs` only emits a status line (the
 * contract is "keep waiting, tell the user"), while `deadlineMs` is the global
 * backstop that gives up and releases the latch (`TASK-PLAN.md` §7.2).
 *
 * @param agent - the live agent; only `whenIdle` is used.
 * @param options - timings, cancellation poll, and clock.
 * @returns why the wait ended.
 */
export async function waitForBoundary(
  agent: Pick<Agent, 'whenIdle'>,
  options: BoundaryWaitOptions,
): Promise<BoundaryOutcome> {
  const now = options.now ?? Date.now
  const tickMs = options.tickMs ?? 250
  const started = now()
  let slowReported = false

  // A rejection from whenIdle() still means "no further work is pending"; the
  // action itself decides what to do with a failed step (TASK-PLAN.md §7.2 #9).
  const idle = agent.whenIdle().then(
    () => 'boundary' as const,
    () => 'boundary' as const,
  )
  const aborted = options.signal === undefined ? undefined : cancellation(options.signal)

  for (;;) {
    const racers: Promise<'boundary' | 'tick' | 'cancelled'>[] = [
      idle,
      delay(tickMs).then(() => 'tick' as const),
    ]
    if (aborted !== undefined) racers.push(aborted)
    const winner = await Promise.race(racers)
    if (winner === 'boundary') return 'boundary'
    if (winner === 'cancelled') return 'cancelled'

    const elapsed = now() - started
    if (options.signal?.aborted === true) return 'cancelled'
    if (options.isCancelled()) return 'cancelled'
    if (elapsed >= options.deadlineMs) return 'deadline'
    if (!slowReported && elapsed >= options.slowAfterMs) {
      slowReported = true
      options.onSlow(elapsed)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never hold the process open just to poll a latch.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as { unref(): void }).unref()
    }
  })
}

/** Resolve `'cancelled'` when the signal aborts, now or later. */
function cancellation(signal: AbortSignal): Promise<'cancelled'> {
  if (signal.aborted) return Promise.resolve('cancelled')
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
  })
}
