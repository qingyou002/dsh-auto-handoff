/**
 * Session migration: create the replacement session, inherit what can be
 * inherited, and hand it the brief (`TASK-PLAN.md` §7.5).
 *
 * Three rules shape this file:
 *
 * - every inheritance step is read → write → report, and a step that cannot be
 *   performed is *listed*, never silently skipped;
 * - a failure before `create()` leaves no session behind — the original stays
 *   exactly as it was;
 * - a failure after `create()` still reports the new session id, because
 *   pretending the migration did not happen would strand a session the user
 *   cannot see.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
// Loads the `model/selection` event vocabulary into `SessionEventMap`.
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { HandoffSettings } from './settings.js'
import {
  buildSummaryInput,
  generateSummary,
  readLastStep,
  readSessionFacts,
  sanitizeBrief,
  SUMMARY_MAX_MESSAGES,
  type SummaryFacts,
} from './session-summary.js'
import {
  MESSAGES,
  type ActionRecord,
  type ActionRunInput,
  type AgentPresetsView,
  type ApprovalView,
  type DefaultModelView,
  type HandoffServices,
  type InheritanceRow,
  type LlmView,
  type PermissionPresetsView,
  type PlanModeView,
  type SessionControllerView,
  type WorkspaceRegistryView,
  type WorkspaceView,
} from './types.js'

/** Resolved model route used for the summarizing call. */
export interface ResolvedRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Retained so the api-session-controller type import is a documented dependency. */
export type ModelSelectionShape = Pick<ModelSelection, 'provider' | 'model'>

/** Optional services the migration consults; each may be absent. */
export interface MigrationServices {
  sessionController: SessionControllerView | undefined
  llm: LlmView | undefined
  /**
   * Resolve the plan-mode service for one agent: the instance its own agent
   * preset mounted behind an `isolate` realm first, then the host plane.
   * `undefined` when neither plane provides one.
   *
   * It is a resolver rather than a view because a preset realm is per agent, so
   * the source agent and the freshly created one may each resolve differently.
   */
  planModeFor(agent: Agent): PlanModeView | undefined
  permissionPresets: PermissionPresetsView | undefined
  approval: ApprovalView | undefined
  agentPresets: AgentPresetsView | undefined
  agentDefaultModel: DefaultModelView | undefined
  /**
   * Workspace membership for the session this migration creates.
   *
   * `sessionController.create()` accounts a new session in a workspace only when
   * the request names a `workspaceId`; a create by `cwd` alone is invisible to
   * every project group in the Web browser. Optional because a deployment may
   * mount no registry at all — then the session is simply ungrouped, which the
   * report states rather than hides.
   */
  workspaceRegistry: WorkspaceRegistryView | undefined
}

/** The plugin id stamped on every message this plugin injects. */
export const PLUGIN_ID = 'dsh-auto-handoff'

/** How many times to poll for a freshly created session. */
const SESSION_LOOKUP_ATTEMPTS = 40
/** Delay between session polls. */
const SESSION_LOOKUP_DELAY_MS = 25

/**
 * Resolve the model route a session is currently using.
 *
 * Order (`TASK-PLAN.md` §7.4): the newest `model/selection` in the durable log,
 * then the folded request header, then the live agent's options, then the
 * deployment default. Returns `undefined` when nothing can answer, which the
 * caller turns into a real failure rather than a guess.
 *
 * @param session - the original session.
 * @param agent - its live agent.
 * @param fallback - `ctx.agentDefaultModel`, when mounted.
 * @returns the resolved route, or `undefined`.
 */
export function resolveRoute(
  session: Session,
  agent: Agent,
  fallback: DefaultModelView | undefined,
): ResolvedRoute | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || (event.type as string) !== 'model/selection') continue
    const selection = event.data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return withEffort({ provider: selection.provider, model: selection.model }, selection.reasoningEffort)
    }
  }

  const header = session.requestHeader()
  if (header !== undefined) {
    const config = header.config as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof config.provider === 'string' && typeof config.model === 'string') {
      return withEffort({ provider: config.provider, model: config.model }, config.reasoningEffort)
    }
  }

  const options = agent.options
  if (typeof options.provider === 'string' && typeof options.model === 'string') {
    return withEffort(
      { provider: options.provider, model: options.model },
      options.reasoningEffort as unknown,
    )
  }

  if (fallback !== undefined) {
    const selection = fallback.currentSelection()
    if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return withEffort(
        { provider: selection.provider, model: selection.model },
        selection.reasoningEffort,
      )
    }
  }

  return undefined
}

function withEffort(route: ResolvedRoute, effort: unknown): ResolvedRoute {
  return typeof effort === 'string' ? { ...route, reasoningEffort: effort } : route
}

/**
 * Whether a session has anything worth migrating.
 *
 * An empty or message-less session must never spawn a replacement
 * (`TASK-PLAN.md` §7.6 「无活动会话 / 空白会话」).
 *
 * @param messages - `session.deriveMessages()`.
 * @param events - the durable log.
 * @returns `true` when at least one human prompt or one turn exists.
 */
export function isMigratable(
  messages: readonly Message[],
  events: readonly SessionEvent[],
): boolean {
  const hasHuman = messages.some((message) => (message.source as { kind?: string }).kind === 'user')
  const hasTurn = events.some(
    (event) => event.type === 'turn/start' || event.type === 'assistant/message',
  )
  return hasHuman || hasTurn
}

/** Build the migration action body bound to one set of services. */
export function createMigrationRunner(
  services: HandoffServices,
  extra: MigrationServices,
  settings: () => HandoffSettings,
): (input: ActionRunInput) => Promise<ActionRecord> {
  return async (input) => runMigration(services, extra, settings(), input)
}

/**
 * Perform one migration.
 *
 * @param services - coordinator services (lookups, delivery, clock).
 * @param extra - optional capability services.
 * @param settings - current settings, read once per migration.
 * @param input - the record, the live agent, the abort signal, and a note sink.
 * @returns the settled action record; never throws.
 */
export async function runMigration(
  services: HandoffServices,
  extra: MigrationServices,
  settings: HandoffSettings,
  input: ActionRunInput,
): Promise<ActionRecord> {
  const { record, agent, note } = input
  const startedAt = services.now()
  const session = services.sessionOf(record.sessionId) ?? agent.session

  const finish = (outcome: ActionRecord['outcome'], text: string): ActionRecord => {
    const action: ActionRecord = {
      kind: 'handoff',
      trigger: record.armed?.trigger ?? 'manual',
      outcome,
      startedAt,
      finishedAt: services.now(),
      text,
      tokens: record.lastReading.tokens,
    }
    if (record.newSessionId !== undefined) action.newSessionId = record.newSessionId
    if (record.inheritanceRows !== undefined) action.inheritance = [...record.inheritanceRows]
    return action
  }

  if (extra.sessionController === undefined) {
    return finish('failed', MESSAGES.createSessionFailed('本部署未安装 sessionController。'))
  }

  let messages: Message[]
  let events: readonly SessionEvent[]
  try {
    messages = session.deriveMessages()
    events = session.snapshotEvents()
  } catch (error) {
    return finish('failed', MESSAGES.cannotReadHistory(reasonOf(error)))
  }

  if (!isMigratable(messages, events)) return finish('failed', MESSAGES.noActiveSession())

  const route = resolveRoute(session, agent, extra.agentDefaultModel)
  const transcript = buildSummaryInput(messages)
  const facts = buildFacts(extra, session, agent, route, messages, transcript.length)

  if (record.cancelRequested) return finish('cancelled', MESSAGES.cancelled())

  // ---- Summarize -----------------------------------------------------------
  record.phase = 'SUMMARIZING'
  note(MESSAGES.phaseSummarizing())
  if (extra.llm === undefined) {
    return finish('failed', MESSAGES.summaryFailed('本部署未安装 llm 服务。'))
  }
  if (route === undefined) {
    return finish('failed', MESSAGES.summaryFailed('无法解析当前会话使用的模型路由。'))
  }
  const llm = extra.llm

  let brief: string
  try {
    const generated = await generateSummary({
      stream: (options) => llm.stream(options),
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: settings.summaryMaxTokens,
      sessionId: record.sessionId,
      signal: input.signal,
      transcript,
      facts,
    })
    brief = generated.text
  } catch (error) {
    return finish('failed', MESSAGES.summaryFailed(reasonOf(error)))
  }

  if (brief.trim().length === 0) return finish('failed', MESSAGES.summaryEmpty())
  if (record.cancelRequested) return finish('cancelled', MESSAGES.cancelled())

  // ---- Create --------------------------------------------------------------
  record.phase = 'CREATING_SESSION'
  note(MESSAGES.phaseCreating())
  const rows: InheritanceRow[] = []

  const cwd = session.header.cwd ?? process.cwd()
  rows.push(
    session.header.cwd === undefined
      ? {
          name: '工作区 / cwd',
          status: 'fallback',
          detail: `原会话未记录 cwd，已回退到进程工作目录 ${cwd}。`,
        }
      : { name: '工作区 / cwd', status: 'inherited', detail: cwd },
  )

  const preset = readAgentPreset(session, agent, extra)
  rows.push(
    preset === undefined
      ? { name: 'Agent preset', status: 'skipped', detail: '原会话未记录 preset，使用部署默认。' }
      : { name: 'Agent preset', status: 'inherited', detail: preset },
  )

  let newSessionId: string
  try {
    const created = await extra.sessionController.create(
      preset === undefined ? { cwd } : { cwd, agentPreset: preset },
    )
    newSessionId = created.sessionId
    record.newSessionId = newSessionId
  } catch (error) {
    return finish('failed', MESSAGES.createSessionFailed(reasonOf(error)))
  }

  // ---- Inherit -------------------------------------------------------------
  await attachWorkspace(extra, newSessionId, cwd, rows)
  await inheritRoute(extra, newSessionId, route, rows)
  const newSession = await waitForSession(services, newSessionId)
  const newAgent = services.agentOf(newSessionId)
  inheritPermission(extra, session, newSession, newAgent, rows)
  inheritPlanMode(extra, agent, newAgent, rows)
  record.inheritanceRows = rows

  if (record.cancelRequested) {
    return finish('cancelled', `已取消会话迁移；新会话 ${newSessionId} 已创建但未收到摘要。`)
  }

  // ---- Transfer ------------------------------------------------------------
  record.phase = 'TRANSFERRING'
  note(MESSAGES.phaseTransferring())
  if (!services.deliver(newSessionId, sanitizeBrief(brief))) {
    return finish('failed', MESSAGES.deliverFailed(newSessionId))
  }

  const inherited = rows.filter((row) => row.status === 'inherited').map((row) => row.name)
  const skipped = rows
    .filter((row) => row.status !== 'inherited')
    .map((row) => `${row.name}（${row.detail}）`)
  return finish(
    'completed',
    `${MESSAGES.completed(newSessionId)}\n${MESSAGES.inheritanceReport(inherited, skipped)}`,
  )
}

function buildFacts(
  extra: MigrationServices,
  session: Session,
  agent: Agent,
  route: ResolvedRoute | undefined,
  messages: readonly Message[],
  transcriptSize: number,
): SummaryFacts {
  const base = readSessionFacts({
    session,
    route,
    planModeActive: readPlanMode(extra, agent),
    permissionPreset: readPermissionPreset(extra, session),
    approvalPolicy: readApprovalPolicy(extra, session),
  })
  const lastStep = readLastStep(session.snapshotEvents())
  const facts: SummaryFacts = {
    ...base,
    failures: [],
    transcriptSize,
    truncated: messages.length > transcriptSize,
  }
  if (lastStep !== undefined) facts.lastStep = lastStep
  return facts
}

function readPlanMode(extra: MigrationServices, agent: Agent): boolean {
  try {
    return extra.planModeFor(agent)?.get(agent).active ?? false
  } catch {
    return false
  }
}

function readPermissionPreset(extra: MigrationServices, session: Session): string | undefined {
  try {
    return extra.permissionPresets?.current(session)
  } catch {
    return undefined
  }
}

function readApprovalPolicy(extra: MigrationServices, session: Session): string | undefined {
  try {
    return extra.approval?.overrideOf(session)
  } catch {
    return undefined
  }
}

function readAgentPreset(session: Session, agent: Agent, extra: MigrationServices): string | undefined {
  if (session.header.agentPreset !== undefined) return session.header.agentPreset
  try {
    return extra.agentPresets?.composedPreset(agent.ctx)
  } catch {
    return undefined
  }
}

/**
 * Account the fresh session in the workspace that owns its directory.
 *
 * This is a *visibility* step, not a copy of state: the Web browser groups
 * sessions strictly by `Workspace.sessionIds`, and
 * `sessionController.create()` only attaches when the request carries a
 * `workspaceId` — which this migration cannot use, because the host rejects a
 * request that carries both the id and a `cwd`, and the `cwd` is the fact worth
 * inheriting. So the session is created by `cwd` and attached here.
 *
 * Attaching is deliberately separate from creating and best-effort: an attach
 * failure must not turn a session that already exists into a reported creation
 * failure, and it must not leave the user without the session id.
 *
 * @param extra - optional capability services.
 * @param newSessionId - the session just created.
 * @param cwd - the directory the session was created in.
 * @param rows - inheritance report sink.
 */
async function attachWorkspace(
  extra: MigrationServices,
  newSessionId: string,
  cwd: string,
  rows: InheritanceRow[],
): Promise<void> {
  const registry = extra.workspaceRegistry
  if (registry === undefined) {
    rows.push({ name: '工作区归属', status: 'skipped', detail: '本部署未安装 workspaceRegistry。' })
    return
  }
  let workspace: WorkspaceView | undefined
  try {
    workspace = await registry.resolveByPath(cwd)
  } catch (error) {
    rows.push({ name: '工作区归属', status: 'skipped', detail: `目录无法解析：${reasonOf(error)}` })
    return
  }
  if (workspace === undefined) {
    // Nothing to attach to. The workspace registry is the only supported way in,
    // and registering one on the user's behalf would silently reorder their
    // sidebar, so the new session stays ungrouped — exactly where an ungrouped
    // source session already is — and the report says so.
    rows.push({
      name: '工作区归属',
      status: 'fallback',
      detail: `${cwd} 未注册为工作区，新会话不会出现在任何项目分组下（相当于「未分组」）。`,
    })
    return
  }
  try {
    await workspace.attachSession(newSessionId)
    rows.push({
      name: '工作区归属',
      status: 'inherited',
      detail: `${workspace.title}（${workspace.path}）`,
    })
  } catch (error) {
    rows.push({
      name: '工作区归属',
      status: 'skipped',
      detail: `新会话已创建，但未能附加到工作区 ${workspace.title}：${reasonOf(error)}`,
    })
  }
}

async function inheritRoute(
  extra: MigrationServices,
  newSessionId: string,
  route: ResolvedRoute,
  rows: InheritanceRow[],
): Promise<void> {
  if (extra.sessionController === undefined) return
  try {
    await extra.sessionController.selectModel({
      sessionId: newSessionId,
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    })
    rows.push({
      name: '模型',
      status: 'inherited',
      detail: `${route.provider}/${route.model}${
        route.reasoningEffort === undefined ? '' : ` (${route.reasoningEffort})`
      }`,
    })
  } catch (error) {
    rows.push({ name: '模型', status: 'skipped', detail: `写入失败：${reasonOf(error)}` })
  }
}

function inheritPermission(
  extra: MigrationServices,
  source: Session,
  target: Session | undefined,
  targetAgent: Agent | undefined,
  rows: InheritanceRow[],
): void {
  if (extra.permissionPresets === undefined) {
    rows.push({ name: '权限控制', status: 'skipped', detail: '本部署未安装 permissionPresets。' })
    return
  }
  let preset: string
  try {
    preset = extra.permissionPresets.current(source)
  } catch (error) {
    rows.push({ name: '权限控制', status: 'skipped', detail: `读取失败：${reasonOf(error)}` })
    return
  }
  if (preset === 'custom') {
    // `custom` has no preset name to replay; carry the approval policy only
    // (`TASK-PLAN.md` §16 L6).
    if (targetAgent === undefined || extra.approval === undefined) {
      rows.push({ name: '权限控制', status: 'skipped', detail: '原会话为 custom，且无法整体继承。' })
      return
    }
    const policy = readApprovalPolicy(extra, source) === 'never' ? 'never' : 'ask'
    try {
      extra.approval.setPolicy(targetAgent, policy)
      rows.push({
        name: '权限控制',
        status: 'fallback',
        detail: `原会话为 custom，已继承审批策略 ${policy}；sandbox 档位未继承。`,
      })
    } catch (error) {
      rows.push({ name: '权限控制', status: 'skipped', detail: `写入失败：${reasonOf(error)}` })
    }
    return
  }
  if (target === undefined) {
    rows.push({ name: '权限控制', status: 'skipped', detail: '新会话尚未就绪。' })
    return
  }
  try {
    extra.permissionPresets.set(target, preset)
    rows.push({ name: '权限控制', status: 'inherited', detail: preset })
  } catch (error) {
    rows.push({ name: '权限控制', status: 'skipped', detail: `写入失败：${reasonOf(error)}` })
  }
}

function inheritPlanMode(
  extra: MigrationServices,
  sourceAgent: Agent,
  targetAgent: Agent | undefined,
  rows: InheritanceRow[],
): void {
  // Resolved per agent: on the Web surface each agent's preset mounts its own
  // plan-mode instance behind an `isolate` realm, so the source and the new
  // session are two different services.
  const source = extra.planModeFor(sourceAgent)
  if (source === undefined) {
    rows.push({ name: 'Plan 模式', status: 'skipped', detail: '本部署未安装 planMode。' })
    return
  }
  if (targetAgent === undefined) {
    rows.push({ name: 'Plan 模式', status: 'skipped', detail: '新会话尚未就绪。' })
    return
  }
  const target = extra.planModeFor(targetAgent)
  if (target === undefined) {
    rows.push({
      name: 'Plan 模式',
      status: 'skipped',
      detail: '新会话的 agent preset 未挂载 planMode。',
    })
    return
  }
  let active: boolean
  try {
    active = source.get(sourceAgent).active
  } catch (error) {
    rows.push({ name: 'Plan 模式', status: 'skipped', detail: `读取失败：${reasonOf(error)}` })
    return
  }
  try {
    target.set(targetAgent, active)
    rows.push({
      name: 'Plan 模式',
      status: 'inherited',
      detail: active ? '已开启' : '未开启（保持一致）',
    })
  } catch (error) {
    rows.push({ name: 'Plan 模式', status: 'skipped', detail: `写入失败：${reasonOf(error)}` })
  }
}

async function waitForSession(
  services: HandoffServices,
  sessionId: string,
): Promise<Session | undefined> {
  for (let attempt = 0; attempt < SESSION_LOOKUP_ATTEMPTS; attempt += 1) {
    const session = services.sessionOf(sessionId)
    if (session !== undefined) return session
    await new Promise((resolve) => setTimeout(resolve, SESSION_LOOKUP_DELAY_MS))
  }
  return undefined
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Build the plugin-sourced message a brief is delivered as. */
export function buildBriefMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  })
}
