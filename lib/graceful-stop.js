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
export function isHumanPrompt(message) {
    return message.source.kind === 'user';
}
/** Whether any claimed message is a fresh human prompt. */
export function carriesHumanPrompt(messages) {
    return messages.some((message) => isHumanPrompt(message));
}
/**
 * Decide whether to refuse the proposed step.
 *
 * @param input - the latch state and the messages the loop claimed.
 * @returns the verdict; `human-prompt` always wins over `latch-held`.
 */
export function decidePreStep(input) {
    const humanPrompt = carriesHumanPrompt(input.messages);
    if (!input.stopRequested)
        return { reject: false, humanPrompt, reason: 'latch-clear' };
    if (humanPrompt)
        return { reject: false, humanPrompt, reason: 'human-prompt' };
    return { reject: true, humanPrompt, reason: 'latch-held' };
}
/**
 * Per-session soft-stop latches.
 *
 * The latch is the only shared state between the command that arms an action
 * and the pre-step listener that refuses steps; releasing it restores normal
 * operation immediately.
 */
export class StopLatch {
    held = new Set();
    /** Raise the latch for one session. */
    hold(sessionId) {
        this.held.add(sessionId);
    }
    /** Drop the latch for one session (idempotent). */
    release(sessionId) {
        this.held.delete(sessionId);
    }
    /** Whether the latch is currently raised. */
    isHeld(sessionId) {
        return this.held.has(sessionId);
    }
    /** Every session whose latch is raised. */
    heldIds() {
        return [...this.held];
    }
    /** Drop every latch (plugin teardown). */
    clear() {
        this.held.clear();
    }
    /** Number of raised latches; used by the unload test. */
    get size() {
        return this.held.size;
    }
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
export async function waitForBoundary(agent, options) {
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? 250;
    const started = now();
    let slowReported = false;
    // A rejection from whenIdle() still means "no further work is pending"; the
    // action itself decides what to do with a failed step (TASK-PLAN.md §7.2 #9).
    const idle = agent.whenIdle().then(() => 'boundary', () => 'boundary');
    const aborted = options.signal === undefined ? undefined : cancellation(options.signal);
    for (;;) {
        const racers = [
            idle,
            delay(tickMs).then(() => 'tick'),
        ];
        if (aborted !== undefined)
            racers.push(aborted);
        const winner = await Promise.race(racers);
        if (winner === 'boundary')
            return 'boundary';
        if (winner === 'cancelled')
            return 'cancelled';
        const elapsed = now() - started;
        if (options.signal?.aborted === true)
            return 'cancelled';
        if (options.isCancelled())
            return 'cancelled';
        if (elapsed >= options.deadlineMs)
            return 'deadline';
        if (!slowReported && elapsed >= options.slowAfterMs) {
            slowReported = true;
            options.onSlow(elapsed);
        }
    }
}
function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Never hold the process open just to poll a latch.
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            ;
            timer.unref();
        }
    });
}
/** Resolve `'cancelled'` when the signal aborts, now or later. */
function cancellation(signal) {
    if (signal.aborted)
        return Promise.resolve('cancelled');
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
    });
}
