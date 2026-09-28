/**
 * Cumulative tokens for a usage bucket set.
 *
 * @param buckets - the projection's `totals`, or a partial object.
 * @returns the exact sum of the four buckets, `0` when the set is absent.
 */
export function sumBuckets(buckets) {
    if (buckets === undefined)
        return 0;
    return ((buckets.uncachedInputTokens ?? 0) +
        (buckets.outputTokens ?? 0) +
        (buckets.cacheReadTokens ?? 0) +
        (buckets.cacheWriteTokens ?? 0));
}
/**
 * Read the session's cumulative token usage.
 *
 * Precedence (`TASK-PLAN.md` §4.5):
 * 1. A non-zero projection sum is **exact** — the adapter reported usage.
 * 2. Otherwise a non-zero `tokenMeter.measure()` total is **estimated**.
 * 3. Otherwise the reading is **unavailable** and automation stays off.
 *
 * @param input - the available readers.
 * @returns the reading, tagged with its source.
 */
export function readCumulativeUsage(input) {
    const totals = input.projection?.totals;
    const exact = sumBuckets(totals);
    if (exact > 0) {
        const reading = { tokens: exact, source: 'exact' };
        if (totals !== undefined) {
            reading.buckets = {
                uncachedInputTokens: totals.uncachedInputTokens ?? 0,
                outputTokens: totals.outputTokens ?? 0,
                cacheReadTokens: totals.cacheReadTokens ?? 0,
                cacheWriteTokens: totals.cacheWriteTokens ?? 0,
            };
        }
        return reading;
    }
    const measured = input.measure?.totalTokens ?? 0;
    if (measured > 0) {
        return {
            tokens: measured,
            source: 'estimated',
            detail: '适配器未上报用量，使用 tokenMeter.measure 的启发式估算。',
        };
    }
    return {
        tokens: 0,
        source: 'unavailable',
        detail: 'tokenUsage 投影与 tokenMeter 均未提供可用数值。',
    };
}
/**
 * Decide whether the current cumulative reading should arm an action.
 *
 * Ordering rules (`TASK-PLAN.md` §8.2 / §8.3):
 * - `handoff` wins when both thresholds are met;
 * - a session with an action already armed or in flight yields `none`;
 * - a retired session never arms anything;
 * - the per-session budget caps automatic actions;
 * - a new arm needs `cumulative >= lastActionAtTokens + rearmDeltaTokens`.
 *
 * @param input - reading, settings, and the session's current automation state.
 * @returns the action to arm, or `none` with a machine-readable reason.
 */
export function decideAutoAction(input) {
    const { reading, settings, record } = input;
    if (record.retired)
        return { kind: 'none', reason: 'retired' };
    if (reading.source === 'unavailable')
        return { kind: 'none', reason: 'tokens-unavailable' };
    if (input.hasPendingAction || record.armed !== undefined) {
        return { kind: 'none', reason: 'action-in-flight' };
    }
    if (record.autoActions >= settings.maxAutoActionsPerSession) {
        return { kind: 'none', reason: 'budget-exhausted' };
    }
    if (record.lastActionAtTokens !== null &&
        reading.tokens < record.lastActionAtTokens + settings.rearmDeltaTokens) {
        return { kind: 'none', reason: 'not-rearmed' };
    }
    if (!settings.autoHandoffEnabled && !settings.autoCompactEnabled) {
        return { kind: 'none', reason: 'automation-disabled' };
    }
    const handoffDue = settings.autoHandoffEnabled && reading.tokens >= settings.autoHandoffThreshold;
    if (handoffDue)
        return { kind: 'handoff', reason: 'handoff-threshold' };
    const compactDue = settings.autoCompactEnabled && reading.tokens >= settings.autoCompactThreshold;
    if (compactDue)
        return { kind: 'compact', reason: 'compact-threshold' };
    return { kind: 'none', reason: 'below-threshold' };
}
/**
 * Per-session event watermarks.
 *
 * `session/event` fires for every durable append; a threshold evaluation must
 * not run twice for the same log position (`TASK-PLAN.md` §7.3 「带水位去重」).
 */
export class TokenTracker {
    watermarks = new Map();
    /**
     * Record one observed log position.
     *
     * @param sessionId - the session whose log grew.
     * @param seq - the appended event's sequence number.
     * @returns `true` when this position is new for the session.
     */
    observe(sessionId, seq) {
        const previous = this.watermarks.get(sessionId);
        if (previous !== undefined && seq <= previous)
            return false;
        this.watermarks.set(sessionId, seq);
        return true;
    }
    /** Current watermark for one session, or `-1` when nothing was observed. */
    watermark(sessionId) {
        return this.watermarks.get(sessionId) ?? -1;
    }
    /** Forget one session (its agent or session was disposed). */
    reset(sessionId) {
        this.watermarks.delete(sessionId);
    }
    /** Forget every session (plugin teardown). */
    clear() {
        this.watermarks.clear();
    }
    /** Number of tracked sessions; used by the unload test. */
    get size() {
        return this.watermarks.size;
    }
}
/**
 * Fraction of a threshold already consumed, clamped to `[0, 1]`.
 *
 * @param tokens - current cumulative tokens.
 * @param threshold - the threshold being displayed.
 * @returns the progress fraction; `0` when the threshold is not positive.
 */
export function thresholdProgress(tokens, threshold) {
    if (!Number.isFinite(threshold) || threshold <= 0)
        return 0;
    return Math.min(1, Math.max(0, tokens / threshold));
}
