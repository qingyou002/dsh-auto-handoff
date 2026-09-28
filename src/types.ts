/**
 * Shared vocabulary for `dsh-auto-handoff`: lifecycle phases, action kinds and
 * records, the per-session coordinator record, and the single table of
 * user-visible strings (`TASK-PLAN.md` §14).
 *
 * Nothing in this module touches the Harness: every value is a plain data shape
 * so the phase machine, the threshold logic, and the command renderer can be
 * unit-tested without a Cordis context. The dependency-injection interfaces at
 * the end of the file name live Harness types only so the coordinator can be
 * handed a test double with a single cast.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, Message, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Which automation an armed action performs. */
export type HandoffActionKind = 'handoff' | 'compact'

/** Why an action was armed. */
export type HandoffActionTrigger = 'manual' | 'threshold'

/** Terminal outcome of one action attempt. */
export type HandoffOutcome = 'completed' | 'failed' | 'cancelled'

/**
 * Migration phase (`TASK-PLAN.md` §7.7). `IDLE` is the no-action-at-rest state;
 * every other value maps 1:1 onto the phases `PLAN.md` §11 enumerates, plus the
 * compact-specific `WAITING_FOR_COMPACT` sub-state.
 */
export type HandoffPhase =
  | 'IDLE'
  | 'PREPARING'
  | 'WAITING_FOR_STEP_BOUNDARY'
  | 'SUMMARIZING'
  | 'CREATING_SESSION'
  | 'TRANSFERRING'
  | 'WAITING_FOR_COMPACT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

/** Phases that mean "an action is in flight for this session". */
export const ACTIVE_PHASES: readonly HandoffPhase[] = [
  'PREPARING',
  'WAITING_FOR_STEP_BOUNDARY',
  'SUMMARIZING',
  'CREATING_SESSION',
  'TRANSFERRING',
  'WAITING_FOR_COMPACT',
]

/** Whether a phase denotes an in-flight action. */
export function isActivePhase(phase: HandoffPhase): boolean {
  return ACTIVE_PHASES.includes(phase)
}

/**
 * Phases before the replacement session exists. A user message arriving here
 * cancels the migration instead of being transferred (`TASK-PLAN.md` §7.7).
 */
export const PRE_SESSION_PHASES: readonly HandoffPhase[] = [
  'PREPARING',
  'WAITING_FOR_STEP_BOUNDARY',
  'SUMMARIZING',
]

/**
 * Phases after the replacement session exists but before the brief is fully
 * delivered. A user message arriving here is re-delivered to the new session.
 */
export const POST_SESSION_PHASES: readonly HandoffPhase[] = ['CREATING_SESSION', 'TRANSFERRING']

/** Short human-readable label per phase, used by `/handoff status` and the card. */
export const PHASE_LABELS: Readonly<Record<HandoffPhase, string>> = {
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
}

/** Where the cumulative token figure came from. */
export type TokenSource = 'exact' | 'estimated' | 'unavailable'

/** The four disjoint usage buckets the durable projection accumulates. */
export interface UsageBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** One reading of the session's cumulative token usage. */
export interface TokenReading {
  /** Cumulative tokens, or `0` when unavailable. */
  tokens: number
  source: TokenSource
  /** Four-bucket detail when the durable projection supplied it. */
  buckets?: UsageBuckets
  /** Why the reading is estimated or unavailable. */
  detail?: string
}

/** One row of the configuration-inheritance report (`TASK-PLAN.md` §7.5). */
export interface InheritanceRow {
  /** Configuration name, e.g. `工作区 / cwd`. */
  name: string
  status: 'inherited' | 'fallback' | 'skipped'
  /** Value actually applied, or the reason it was not. */
  detail: string
}

/** Result of one completed or failed action, as shown to the user. */
export interface ActionRecord {
  kind: HandoffActionKind
  trigger: HandoffActionTrigger
  outcome: HandoffOutcome
  /** Epoch ms. */
  startedAt: number
  /** Epoch ms. */
  finishedAt: number
  /** The rendered user-facing sentence. */
  text: string
  /** Present when a replacement session was created, whatever the outcome. */
  newSessionId?: string
  /** Cumulative tokens observed when the action finished. */
  tokens?: number
  /** Per-item inheritance report, handoff only. */
  inheritance?: InheritanceRow[]
}

/** The single armed action a session may carry. */
export interface ArmedAction {
  kind: HandoffActionKind
  trigger: HandoffActionTrigger
  requestedAt: number
  /** Set once the boundary is reached and the action body has started. */
  startedAt?: number
}

/** Per-session coordinator state. Purely in-memory (`TASK-PLAN.md` §16 L4). */
export interface SessionRecord {
  sessionId: string
  phase: HandoffPhase
  /** The soft-stop latch: the next step must not start. */
  stopRequested: boolean
  stopRequestedAt?: number
  /** True once the agent went idle with the latch still held. */
  atBoundary: boolean
  /** The action waiting for the boundary, if any. */
  armed?: ArmedAction
  /** `retired` sessions keep their log but take no further automated action. */
  retired: boolean
  /** How many automatic actions this session has already run. */
  autoActions: number
  /** Cumulative tokens at the last *successful* action; the re-arm baseline. */
  lastActionAtTokens: number | null
  /** Latest cumulative reading, cached for `/handoff status` and the card. */
  lastReading: TokenReading
  /** Set once the wait for the step boundary exceeded `stepWaitTimeoutMs`. */
  slowWarning: boolean
  /** Hard wall-clock deadline for the in-flight action. */
  actionDeadlineAt?: number
  /** A user asked to cancel; honoured at the next checkpoint. */
  cancelRequested: boolean
  /** True when the agent was mid-turn when this action was armed (§8.4). */
  softStoppedRunning?: boolean
  /** Replacement session id, set as soon as `create()` returns. */
  newSessionId?: string
  /** Per-item inheritance report written by the migration body. */
  inheritanceRows?: InheritanceRow[]
  /** Failure notes collected while the action was in flight. */
  failures: string[]
  /** Human-readable progress lines, newest last. */
  progress: string[]
  /** Most recent settled action. */
  lastResult?: ActionRecord
}

/** Build the initial record for one session. */
export function createSessionRecord(sessionId: string): SessionRecord {
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
  }
}

/** Everything a status view needs, detached from the live record. */
export interface SessionStatus {
  sessionId: string
  phase: HandoffPhase
  phaseLabel: string
  waitingForStep: boolean
  summarizing: boolean
  creatingSession: boolean
  transferring: boolean
  waitingForCompact: boolean
  stopRequested: boolean
  atBoundary: boolean
  retired: boolean
  tokens: number
  tokenSource: TokenSource
  autoActions: number
  slowWarning: boolean
  failures: readonly string[]
  progress: readonly string[]
  lastResult?: ActionRecord
  newSessionId?: string
}

/** Project one record into the detached status payload. */
export function toSessionStatus(record: SessionRecord): SessionStatus {
  const status: SessionStatus = {
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
  }
  if (record.lastResult !== undefined) status.lastResult = record.lastResult
  const newSessionId = record.lastResult?.newSessionId
  if (newSessionId !== undefined) status.newSessionId = newSessionId
  return status
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
  cannotReadHistory: (reason: string) => `无法读取当前会话历史：${reason}；已保留原会话。`,
  /** §14-3 */
  tokensUnavailable: () => '无法获取 Token 统计，自动迁移/压缩已停用。',
  /** §14-4 */
  tokensEstimated: () => 'Token 为估算值（适配器未上报用量）。',
  /** §14-5 */
  waitingForStep: (minutes: number) => `正在等待当前 Step 完成…（已等待 ${minutes} 分钟）`,
  /** §14-6 */
  toolCallFailed: (reason: string) => `当前 Tool Call 失败：${reason}；已记录，继续迁移流程。`,
  /** §14-7 */
  summaryFailed: (reason: string) => `生成任务摘要失败：${reason}；已放弃迁移，原会话保持不变。`,
  /** §14-8 */
  summaryEmpty: () => '摘要为空，已放弃迁移。',
  /** §14-9 */
  createSessionFailed: (reason: string) =>
    `创建新会话失败：${reason}；原会话可用，可稍后重试 /handoff。`,
  /** §14-10 */
  inheritanceReport: (inherited: readonly string[], skipped: readonly string[]) =>
    `已继承：${inherited.length > 0 ? inherited.join('、') : '（无）'}；未继承：${
      skipped.length > 0 ? skipped.join('、') : '（无）'
    }。`,
  /** §14-11 */
  deliverFailed: (sessionId: string) =>
    `摘要未能发送到新会话，新会话已创建：${sessionId}，可手动继续。`,
  /** §14-12 */
  compactUnsupported: () => '本部署未安装 compaction，自动压缩不可用。',
  /** §14-13 */
  compactFailed: (code: string, message: string) => `自动压缩失败（${code}）：${message}`,
  /** §14-13 retry exhaustion */
  compactRetriesExhausted: (attempts: number) =>
    `自动压缩连续 ${attempts} 次因忙碌失败，已放弃；原会话保持不变。`,
  /** §14-14 */
  agentStateChanged: () => '会话状态已变化，正在重新判定…',
  /** §14-17 (pre-session phases) */
  cancelledByUserMessage: () => '检测到新消息：已取消迁移，消息留在原会话继续执行。',
  /** §14-17 (post-session phases) */
  messageForwarded: (sessionId: string) => `检测到新消息：已转投到新会话 ${sessionId}。`,
  /** §14-18 */
  alreadyInFlight: (kind: HandoffActionKind) =>
    `该会话已有${kind === 'handoff' ? '迁移' : '压缩'}在进行中。`,
  /** §14-18 */
  nothingToCancel: () => '该会话当前没有可取消的迁移或压缩。',
  /** §14-18 */
  nothingToRetry: () => '该会话没有可重试的失败动作。',
  /** Automation disabled */
  autoDisabled: () => '自动迁移与自动压缩均已关闭；手动 /handoff 仍可用。',
  /** Automation budget exhausted */
  autoBudgetExhausted: (limit: number) =>
    `该会话的自动动作已达上限（${limit} 次），不再自动触发；可手动 /handoff。`,
  /** Action deadline (§7.2) */
  actionDeadline: (minutes: number) =>
    `动作超过总时限（${minutes} 分钟），已释放停止闩锁、恢复会话运行；本次标记失败。`,
  /** Thresholds out of order */
  thresholdOrder: (compact: number, handoff: number) =>
    `自动压缩阈值（${compact}）必须小于自动迁移阈值（${handoff}）。`,
  /** Small threshold warning */
  thresholdSmall: (value: number) => `阈值 ${value} 偏小，可能导致频繁自动动作。`,
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
  completed: (sessionId: string) => `已完成会话迁移：新会话 ${sessionId}。`,
  failed: (reason: string) => `会话迁移失败：${reason}`,
  cancelled: () => '已取消会话迁移。',
  /** Command usage */
  usage: () =>
    [
      '用法：',
      '  /handoff            立即把当前会话迁移到同工作区的新会话',
      '  /handoff status     查看当前会话的迁移/压缩状态',
      '  /handoff cancel     取消正在进行的迁移或压缩',
      '  /handoff retry      重试最近一次失败的迁移',
    ].join('\n'),
  unknownSubcommand: (name: string) => `未知的子命令：${name}\n${MESSAGES.usage()}`,
} as const

/**
 * The three Harness services the coordinator needs, narrowed to the exact
 * members it calls.
 *
 * Every member is a thunk or a lookup so a test can swap the whole world
 * without a Cordis context; the production implementation in `src/index.ts`
 * closes over the real context.
 */
export interface HandoffServices {
  /** Epoch milliseconds. Injected so phase deadlines are deterministic in tests. */
  now(): number
  /** Contained diagnostic log. */
  log(level: 'info' | 'warn', message: string): void
  /** Live agent for a durable session id. */
  agentOf(sessionId: string): Agent | undefined
  /** Live session for a durable session id (works while the agent is detached). */
  sessionOf(sessionId: string): Session | undefined
  /** `sessionProjections.stateOf(session, 'tokenUsage')`, when mounted. */
  tokenUsage(session: Session): { totals?: Partial<UsageBuckets> } | undefined
  /** `tokenMeter.measure(session)`, when mounted. */
  measure(session: Session): { totalTokens: number } | undefined
  /**
   * Deliver plugin-sourced text into a live session as an ordinary follow-up
   * turn. Returns `false` when the session has no live agent.
   */
  deliver(sessionId: string, text: string): boolean
  /** Whether a settings provider is attached. */
  persistence(): 'host' | 'memory'
  /**
   * Whether a compaction service is mounted for this agent: the instance its own
   * agent preset mounted behind an `isolate` realm first, then the host plane.
   *
   * The agent is required because the Web surface disables the host
   * `compaction-basic` row and lets each preset mount its own — a per-agent
   * realm has no process-wide answer. Omitting it asks the host plane alone.
   */
  compactionAvailable(agent?: Agent): boolean
  /** The handoff action body: summarize, create, inherit, transfer. */
  runMigration(input: ActionRunInput): Promise<ActionRecord>
  /** The compact action body: bounded retry around the compaction engine. */
  runCompact(input: ActionRunInput): Promise<ActionRecord>
}

/** One action body invocation: the record, the live agent, and the abort signal. */
export interface ActionRunInput {
  record: SessionRecord
  agent: Agent
  signal: AbortSignal
  /** Append one progress line to the session record. */
  note(line: string): void
}

/**
 * `ctx.sessionController`, narrowed to the two calls the migration needs.
 *
 * `selectModel` takes plain strings where the real service takes branded ids;
 * `src/index.ts` bridges the two in one documented place.
 */
export interface SessionControllerView {
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  selectModel(request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<unknown>
}

/**
 * `ctx.workspaceRegistry`, narrowed to the membership lookup the migration needs.
 *
 * A session only reaches the Web browser's project groups through its workspace
 * record: `Workspace.sessionIds` is what the browser groups by, and it is a
 * filtered *account*, never a cwd-derived search
 * (`dsh-workspace`: `record.sessionIds.filter(id => sessionPath(id) === path)`).
 * `sessionController.create()` attaches a new session to a workspace only when
 * the request carries `workspaceId`; a create by `cwd` alone therefore produces
 * a session that no workspace accounts for. That is exactly what the migration
 * used to do, so the replacement session existed but never appeared under the
 * project it belonged to.
 */
export interface WorkspaceRegistryView {
  /**
   * The workspace owning one already-existing directory.
   *
   * @param path - fully qualified directory spelling.
   * @returns the owning record, or `undefined` when the directory is not a
   *   registered workspace. Rejects when the path cannot be resolved at all.
   */
  resolveByPath(path: string): Promise<WorkspaceView | undefined>
}

/** One durable workspace record, narrowed to identity, label, and attachment. */
export interface WorkspaceView {
  readonly id: string
  readonly title: string
  readonly path: string
  /**
   * Account one session in this workspace; validates the session's stored cwd
   * against the workspace path and rejects on a mismatch.
   *
   * @param sessionId - the session to account.
   */
  attachSession(sessionId: string): Promise<void>
}

/** `ctx.llm`, narrowed to the streaming call the summarizer makes. */
export interface LlmView {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** `ctx.planMode`, narrowed. */
export interface PlanModeView {
  get(agent: Agent): { active: boolean; pending?: boolean }
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
}

/** `ctx.permissionPresets`, narrowed. */
export interface PermissionPresetsView {
  current(session: Session): string
  set(session: Session, name: string): void
}

/** `ctx.approval`, narrowed. */
export interface ApprovalView {
  overrideOf(session: Session): 'ask' | 'never' | undefined
  setPolicy(agent: Agent, policy: 'ask' | 'never'): void
}

/** `ctx.agentPresets`, narrowed. */
export interface AgentPresetsView {
  composedPreset(agentCtx: Context): string | undefined
}

/** `ctx.agentDefaultModel`, narrowed. */
export interface DefaultModelView {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/**
 * `ctx.compaction`, narrowed to the one call this plugin makes.
 *
 * The real `compactNow` returns `CompactionResult | null` and throws
 * `ManualCompactionError`; a test double only needs the same shape.
 */
export interface CompactionView {
  compactNow(agent: Agent, signal: AbortSignal): Promise<{ shadowedTokenCount?: number } | null>
}

/** Structural alias for the Cordis context consumed by {@link AgentPresetsView}. */
export type Context = import('@deepseek-ai/cordis').Context

/** What the coordinator reports back to a command or route caller. */
export interface MatchOutcome {
  ok: boolean
  /** The settled record, present whenever the action actually ran. */
  action?: ActionRecord
  /** Machine-readable rejection reason when nothing ran. */
  reason?: string
  /** Ready-to-print sentence. */
  text: string
}

/** A handoff brief delivered to a fresh session. */
export interface BriefDelivery {
  sessionId: string
  message: UserMessage
}

/** Structural helper re-exported for tests that build a message double. */
export type SummaryMessages = readonly Message[]

/** Structural helper re-exported for tests that build a stream double. */
export type SummaryChunk = StreamChunk

/** Structural helper re-exported for tests that build a log double. */
export type SummaryEvent = SessionEvent
