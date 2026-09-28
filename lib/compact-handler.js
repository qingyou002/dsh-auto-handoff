import { MESSAGES, } from './types.js';
/** Retries allowed for a `busy` compaction failure (`TASK-PLAN.md` §8.5). */
export const COMPACT_MAX_RETRIES = 3;
/** Base backoff between `busy` retries. */
export const COMPACT_RETRY_BACKOFF_MS = 250;
/**
 * The message that resumes work after a compaction that soft-stopped a running
 * turn. It is only ever sent in that case (`TASK-PLAN.md` §8.4): sending it
 * into an already-idle session would open a brand-new turn out of nowhere and
 * risk a compact → continue → handoff → compact loop.
 */
export const CONTINUE_PROMPT = '继续任务';
/** Read one compaction failure's stable code, if it carries one. */
export function compactionErrorCode(error) {
    if (error === null || typeof error !== 'object')
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
/** Read one compaction failure's message. */
export function compactionErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
/** Build the compact action body bound to one set of services. */
export function createCompactRunner(services, compaction, settings) {
    return async (input) => runCompact(services, compaction, settings, input);
}
/**
 * Perform one automatic compaction.
 *
 * @param services - coordinator services (delivery, clock, capability probe).
 * @param compaction - resolves an agent's compaction service, or `undefined`.
 *   It is per agent on purpose: the engine a Web session may use is the one its
 *   own agent preset mounted behind an `isolate` realm, not a host-plane row.
 * @param settings - current settings.
 * @param input - the record, the live agent, the abort signal, and a note sink.
 * @returns the settled action record; never throws.
 */
export async function runCompact(services, compaction, settings, input) {
    const { record, agent, signal, note } = input;
    const startedAt = services.now();
    const maxRetries = COMPACT_MAX_RETRIES;
    void settings;
    const finish = (outcome, text) => ({
        kind: 'compact',
        trigger: record.armed?.trigger ?? 'manual',
        outcome,
        startedAt,
        finishedAt: services.now(),
        text,
        tokens: record.lastReading.tokens,
    });
    const engine = compaction(agent);
    if (engine === undefined)
        return finish('failed', MESSAGES.compactUnsupported());
    record.phase = 'WAITING_FOR_COMPACT';
    note(MESSAGES.phaseWaitingCompact());
    let busyAttempts = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        if (record.cancelRequested)
            return finish('cancelled', MESSAGES.cancelled());
        // Re-establish the safe point: the engine claims the idle phase
        // synchronously and throws when the agent is active.
        await waitIdle(agent);
        if (record.cancelRequested)
            return finish('cancelled', MESSAGES.cancelled());
        try {
            const result = await engine.compactNow(agent, signal);
            if (result === null) {
                return finish('completed', '没有可安全压缩的有用范围，本次自动压缩未做改动。');
            }
            const shadowed = result.shadowedTokenCount ?? 0;
            const continued = await maybeContinue(services, record, note);
            return finish('completed', `自动压缩完成（压缩掉约 ${shadowed} token）。${continued ? '已发送「继续任务」恢复执行。' : '会话原为空闲，未自动开启新的 turn。'}`);
        }
        catch (error) {
            const code = compactionErrorCode(error);
            const message = compactionErrorMessage(error);
            if (code === 'busy' && attempt < maxRetries) {
                busyAttempts += 1;
                note(`自动压缩遇到忙碌状态（第 ${attempt} 次），稍后重试。`);
                await backoff(attempt);
                continue;
            }
            if (code === 'busy') {
                busyAttempts += 1;
                void busyAttempts;
                return finish('failed', MESSAGES.compactRetriesExhausted(maxRetries));
            }
            return finish('failed', MESSAGES.compactFailed(code ?? 'unknown', message));
        }
    }
    return finish('failed', MESSAGES.compactRetriesExhausted(maxRetries));
}
async function maybeContinue(services, record, note) {
    if (record.softStoppedRunning !== true)
        return false;
    const delivered = services.deliver(record.sessionId, CONTINUE_PROMPT);
    if (!delivered) {
        note('压缩已完成，但「继续任务」未能投递；会话保持在空闲状态。');
        return false;
    }
    return true;
}
/** Wait for quiescence; a rejection still means no work is pending. */
function waitIdle(agent) {
    return agent.whenIdle().then(() => undefined, () => undefined);
}
function backoff(attempt) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, COMPACT_RETRY_BACKOFF_MS * attempt);
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            ;
            timer.unref();
        }
    });
}
