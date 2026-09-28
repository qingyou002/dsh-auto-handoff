import { MESSAGES, PHASE_LABELS } from './types.js';
/** The registered command name, without the leading slash. */
export const COMMAND_NAME = 'handoff';
/** Shared prefix of every "waiting for the step boundary" note (`TASK-PLAN.md` §14 行 5). */
const WAIT_PREFIX = '正在等待当前 Step 完成';
/** How many trailing progress lines `/handoff status` echoes. */
const STATUS_PROGRESS_LINES = 5;
/**
 * Register `/handoff`.
 *
 * @param registry - `ctx.commands`.
 * @param deps - the coordinator and the current settings.
 * @returns the registry's disposer.
 */
export function registerHandoffCommand(registry, deps) {
    const definition = {
        name: COMMAND_NAME,
        description: '把当前会话的任务与进度交接给同工作区的新会话，并继续未完成的任务。',
        input: { hint: '[status|cancel|retry]' },
        handler: (invocation) => handle(deps, invocation),
    };
    return registry.register(definition);
}
async function handle(deps, invocation) {
    const sessionId = String(invocation.agent.id);
    const argument = invocation.rawInput.trim();
    const sub = argument.length === 0 ? 'run' : argument.split(/\s+/)[0].toLowerCase();
    switch (sub) {
        case 'run':
            return render(await armWithAbort(deps.coordinator, sessionId, invocation.signal));
        case 'status':
            return renderStatus(deps, sessionId);
        case 'cancel':
            return render(deps.coordinator.cancel(sessionId));
        case 'retry':
            return render(await deps.coordinator.retry(sessionId));
        case 'help':
        case '?':
            return { kind: 'success', text: MESSAGES.usage() };
        default:
            return { kind: 'error', text: MESSAGES.unknownSubcommand(sub) };
    }
}
/**
 * Await the armed action, but hand the caller a placeholder if the dispatching
 * UI request is aborted first. The action itself is never cancelled here: an
 * aborted UI request must not tear down work the user just asked for.
 */
async function armWithAbort(coordinator, sessionId, signal) {
    const pending = coordinator.arm(sessionId, 'handoff', 'manual');
    if (signal.aborted) {
        void pending.catch(() => undefined);
        return { ok: true, text: '已受理会话迁移，正在后台执行；可用 /handoff status 查看进度。' };
    }
    const aborted = new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: true, text: '已受理会话迁移，正在后台执行；可用 /handoff status 查看进度。' }), { once: true });
    });
    return Promise.race([pending, aborted]);
}
function render(outcome) {
    return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text };
}
function renderStatus(deps, sessionId) {
    const status = deps.coordinator.status(sessionId);
    return { kind: 'success', text: renderStatusText(status, deps.settings(), deps.persistence()) };
}
/**
 * Render one session's status as a short, line-oriented block.
 *
 * Shared by `/handoff status`, the HTTP state route, and the settings card so
 * the three surfaces cannot drift.
 *
 * @param status - the detached status, or `undefined` when nothing was recorded.
 * @param settings - current settings, for the threshold display.
 * @param persistence - where settings are stored.
 * @returns the rendered block.
 */
export function renderStatusText(status, settings, persistence) {
    if (status === undefined) {
        const idle = '会话交接状态：空闲（本会话尚无记录）';
        // Coordinator state is process-local either way; only say so when the
        // deployment has no settings store to fall back on.
        return persistence === 'memory' ? [idle, MESSAGES.persistenceMemory()].join('\n') : idle;
    }
    const lines = [];
    lines.push(`会话交接状态：${PHASE_LABELS[status.phase]}`);
    // The recorded progress note already carries the elapsed minutes, so it wins
    // over the timeless fallback — same sentence as the card shows.
    const waitNote = status.progress.filter((line) => line.startsWith(WAIT_PREFIX)).pop();
    if (status.waitingForStep && waitNote === undefined) {
        lines.push(status.slowWarning ? `${WAIT_PREFIX}…（等待时间已偏久）` : `${WAIT_PREFIX}。`);
    }
    lines.push(`会话累计 Token：${status.tokens}（${status.tokenSource === 'exact' ? '精确' : status.tokenSource === 'estimated' ? '估算' : '不可用'}）`);
    lines.push(`阈值：自动迁移 ${settings.autoHandoffEnabled ? settings.autoHandoffThreshold : '未启用'} / ` +
        `自动压缩 ${settings.autoCompactEnabled ? settings.autoCompactThreshold : '未启用'}`);
    lines.push(`本会话自动动作：${status.autoActions}/${settings.maxAutoActionsPerSession}`);
    if (status.retired)
        lines.push('本会话已退休（迁移完成），不再处理新任务。');
    if (status.lastResult !== undefined) {
        lines.push(`最近一次动作：${status.lastResult.text}`);
    }
    if (status.failures.length > 0) {
        lines.push(`失败记录：${status.failures.join('；')}`);
    }
    if (status.progress.length > 0) {
        lines.push('进度：');
        for (const line of status.progress.slice(-STATUS_PROGRESS_LINES))
            lines.push(`  · ${line}`);
    }
    if (persistence === 'memory')
        lines.push(MESSAGES.settingsMemoryOnly());
    return lines.join('\n');
}
