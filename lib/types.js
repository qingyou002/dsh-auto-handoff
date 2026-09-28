/** Phases that mean "an action is in flight for this session". */
export const ACTIVE_PHASES = [
    'PREPARING',
    'WAITING_FOR_STEP_BOUNDARY',
    'SUMMARIZING',
    'CREATING_SESSION',
    'TRANSFERRING',
    'WAITING_FOR_COMPACT',
];
/** Whether a phase denotes an in-flight action. */
export function isActivePhase(phase) {
    return ACTIVE_PHASES.includes(phase);
}
/**
 * Phases before the replacement session exists. A user message arriving here
 * cancels the migration instead of being transferred (`TASK-PLAN.md` §7.7).
 */
export const PRE_SESSION_PHASES = [
    'PREPARING',
    'WAITING_FOR_STEP_BOUNDARY',
    'SUMMARIZING',
];
/**
 * Phases after the replacement session exists but before the brief is fully
 * delivered. A user message arriving here is re-delivered to the new session.
 */
export const POST_SESSION_PHASES = ['CREATING_SESSION', 'TRANSFERRING'];
/** Short human-readable label per phase, used by `/handoff status` and the card. */
export const PHASE_LABELS = {
    IDLE: '空闲',
    PREPARING: '准备中',
    WAITING_FOR_STEP_BOUNDARY: '等待当前 Step 完成',
    SUMMARIZING: '正在生成任务摘要',
    CREATING_SESSION: '正在创建新会话',
    TRANSFERRING: '正在发送迁移摘要',
    WAITING_FOR_COMPACT: '正在等待 compact',
    COMPLETED: '已完成',
    FAILED: '已失败',
    CANCELLED: '已取消',
};
/** Build the initial record for one session. */
export function createSessionRecord(sessionId) {
    return {
        sessionId,
        phase: 'IDLE',
        stopRequested: false,
        atBoundary: false,
        retired: false,
        autoActions: 0,
        lastActionAtTokens: null,
        lastReading: { tokens: 0, source: 'unavailable' },
        slowWarning: false,
        cancelRequested: false,
        failures: [],
        progress: [],
    };
}
/** Project one record into the detached status payload. */
export function toSessionStatus(record) {
    const status = {
        sessionId: record.sessionId,
        phase: record.phase,
        phaseLabel: PHASE_LABELS[record.phase],
        waitingForStep: record.phase === 'WAITING_FOR_STEP_BOUNDARY',
        summarizing: record.phase === 'SUMMARIZING',
        creatingSession: record.phase === 'CREATING_SESSION',
        transferring: record.phase === 'TRANSFERRING',
        waitingForCompact: record.phase === 'WAITING_FOR_COMPACT',
        stopRequested: record.stopRequested,
        atBoundary: record.atBoundary,
        retired: record.retired,
        tokens: record.lastReading.tokens,
        tokenSource: record.lastReading.source,
        autoActions: record.autoActions,
        slowWarning: record.slowWarning,
        failures: [...record.failures],
        progress: [...record.progress],
    };
    if (record.lastResult !== undefined)
        status.lastResult = record.lastResult;
    const newSessionId = record.lastResult?.newSessionId;
    if (newSessionId !== undefined)
        status.newSessionId = newSessionId;
    return status;
}
/**
 * Every user-visible string this plugin emits (`TASK-PLAN.md` §14).
 *
 * Each entry is a function so the message table stays the single place a
 * wording change lands, and so tests can assert on the same table the runtime
 * prints.
 */
export const MESSAGES = {
    /** §14-1 */
    noActiveSession: () => '当前没有可迁移的活动会话。',
    /** §14-2 */
    cannotReadHistory: (reason) => `无法读取当前会话历史：${reason}；已保留原会话。`,
    /** §14-3 */
    tokensUnavailable: () => '无法获取 Token 统计，自动迁移/压缩已停用。',
    /** §14-4 */
    tokensEstimated: () => 'Token 为估算值（适配器未上报用量）。',
    /** §14-5 */
    waitingForStep: (minutes) => `正在等待当前 Step 完成…（已等待 ${minutes} 分钟）`,
    /** §14-6 */
    toolCallFailed: (reason) => `当前 Tool Call 失败：${reason}；已记录，继续迁移流程。`,
    /** §14-7 */
    summaryFailed: (reason) => `生成任务摘要失败：${reason}；已放弃迁移，原会话保持不变。`,
    /** §14-8 */
    summaryEmpty: () => '摘要为空，已放弃迁移。',
    /** §14-9 */
    createSessionFailed: (reason) => `创建新会话失败：${reason}；原会话可用，可稍后重试 /handoff。`,
    /** §14-10 */
    inheritanceReport: (inherited, skipped) => `已继承：${inherited.length > 0 ? inherited.join('、') : '（无）'}；未继承：${skipped.length > 0 ? skipped.join('、') : '（无）'}。`,
    /** §14-11 */
    deliverFailed: (sessionId) => `摘要未能发送到新会话，新会话已创建：${sessionId}，可手动继续。`,
    /** §14-12 */
    compactUnsupported: () => '本部署未安装 compaction，自动压缩不可用。',
    /** §14-13 */
    compactFailed: (code, message) => `自动压缩失败（${code}）：${message}`,
    /** §14-13 retry exhaustion */
    compactRetriesExhausted: (attempts) => `自动压缩连续 ${attempts} 次因忙碌失败，已放弃；原会话保持不变。`,
    /** §14-14 */
    agentStateChanged: () => '会话状态已变化，正在重新判定…',
    /** §14-17 (pre-session phases) */
    cancelledByUserMessage: () => '检测到新消息：已取消迁移，消息留在原会话继续执行。',
    /** §14-17 (post-session phases) */
    messageForwarded: (sessionId) => `检测到新消息：已转投到新会话 ${sessionId}。`,
    /** §14-18 */
    alreadyInFlight: (kind) => `该会话已有${kind === 'handoff' ? '迁移' : '压缩'}在进行中。`,
    /** §14-18 */
    nothingToCancel: () => '该会话当前没有可取消的迁移或压缩。',
    /** §14-18 */
    nothingToRetry: () => '该会话没有可重试的失败动作。',
    /** Automation disabled */
    autoDisabled: () => '自动迁移与自动压缩均已关闭；手动 /handoff 仍可用。',
    /** Automation budget exhausted */
    autoBudgetExhausted: (limit) => `该会话的自动动作已达上限（${limit} 次），不再自动触发；可手动 /handoff。`,
    /** Action deadline (§7.2) */
    actionDeadline: (minutes) => `动作超过总时限（${minutes} 分钟），已释放停止闩锁、恢复会话运行；本次标记失败。`,
    /** Thresholds out of order */
    thresholdOrder: (compact, handoff) => `自动压缩阈值（${compact}）必须小于自动迁移阈值（${handoff}）。`,
    /** Small threshold warning */
    thresholdSmall: (value) => `阈值 ${value} 偏小，可能导致频繁自动动作。`,
    /** Settings service absent */
    settingsMemoryOnly: () => '设置服务不可用：本次会话内有效，重启后恢复默认。',
    /** State channel absent */
    stateChannelUnavailable: () => '状态通道不可用（本部署未安装 webServer）。',
    /** Persistence note */
    persistenceMemory: () => '内存态：重启后闩锁与最近结果丢失，设置与已创建会话不受影响。',
    /** §15 status lines */
    phaseSaving: () => '当前 Step 已完成，正在保存状态…',
    phaseSummarizing: () => '正在生成任务摘要…',
    phaseCreating: () => '正在创建新会话…',
    phaseTransferring: () => '正在发送迁移摘要…',
    phaseWaitingCompact: () => '正在等待 compact…',
    completed: (sessionId) => `已完成会话迁移：新会话 ${sessionId}。`,
    failed: (reason) => `会话迁移失败：${reason}`,
    cancelled: () => '已取消会话迁移。',
    /** Command usage */
    usage: () => [
        '用法：',
        '  /handoff            立即把当前会话迁移到同工作区的新会话',
        '  /handoff status     查看当前会话的迁移/压缩状态',
        '  /handoff cancel     取消正在进行的迁移或压缩',
        '  /handoff retry      重试最近一次失败的迁移',
    ].join('\n'),
    unknownSubcommand: (name) => `未知的子命令：${name}\n${MESSAGES.usage()}`,
};
