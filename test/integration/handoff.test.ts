/**
 * Integration matrix IT-01 … IT-14 (`TASK-PLAN.md` §11.3).
 *
 * These drive the real `Coordinator`, the real `runMigration`, the real
 * `runCompact`, and the real `/handoff` command against fake Harness services.
 * The one assertion repeated everywhere is that `agent.cancel()` is never
 * called: the plugin may refuse the next step, but it must never interrupt work
 * that is already running.
 */
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHandoffCommand, type CommandRegistry } from '../../src/command.js'
import { createCompactRunner } from '../../src/compact-handler.js'
import { Coordinator, extractPromptText } from '../../src/coordinator.js'
import { DEFAULT_HANDOFF_SETTINGS, type HandoffSettings } from '../../src/settings.js'
import {
  createMigrationRunner,
  runMigration,
  type MigrationServices,
} from '../../src/session-migration.js'
import type {
  ActionRecord,
  AgentPresetsView,
  ApprovalView,
  CompactionView,
  DefaultModelView,
  LlmView,
  PermissionPresetsView,
  PlanModeView,
  SessionControllerView,
  WorkspaceRegistryView,
  WorkspaceView,
} from '../../src/types.js'
import {
  addAgent,
  appendUserMessage,
  createTestSession,
  createWorld,
  openTurn,
  TestAgent,
  type FakeWorld,
} from '../harness.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CreatedSession {
  request: { cwd?: string; agentPreset?: string }
  sessionId: string
}

interface Integrated {
  world: FakeWorld
  coordinator: Coordinator
  settings: HandoffSettings
  setSettings(patch: Partial<HandoffSettings>): void
  created: CreatedSession[]
  selects: { sessionId: string; provider: string; model: string }[]
  prompts: string[]
  permission: Map<string, string>
  approval: Map<string, 'ask' | 'never'>
  plan: Map<string, boolean>
  /** Workspace membership handle: the owning record, the ids attached, failure switches. */
  workspaces: {
    attached: string[]
    owner: WorkspaceView | undefined
    failResolve: boolean
    failAttach: boolean
  }
  agent: TestAgent
  /** Number of summary sections the fake model returns. */
  setSummarySections(sections: Record<string, string>): void
  failSummary: boolean
  failCreate: boolean
  failDelivery: boolean
}

function streamJson(text: string): AsyncGenerator<StreamChunk> {
  return (async function* generate() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  })()
}

function createIntegrated(options: { cwd?: string; preset?: string } = {}): Integrated {
  const world = createWorld()
  const session = createTestSession('session-1', options.cwd ?? 'E:\\project')
  const agent = addAgent(world, new TestAgent({ id: 'session-1', session }))
  if (options.preset !== undefined) {
    ;(session as unknown as { header: { agentPreset?: string } }).header = {
      ...session.header,
      agentPreset: options.preset,
    }
  }
  openTurn(session)
  appendUserMessage(session, '请完成 dsh-auto-handoff 插件')
  session.append('model/selection', {
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
  } as never)

  const created: CreatedSession[] = []
  const selects: { sessionId: string; provider: string; model: string }[] = []
  let counter = 0

  const state = {
    settings: { ...DEFAULT_HANDOFF_SETTINGS },
    summarySections: { goal: '完成交接插件', next: '补齐 README' } as Record<string, string>,
    failSummary: false,
    failCreate: false,
    failDelivery: false,
    prompts: [] as string[],
  }

  const sessionController: SessionControllerView = {
    create: async (request) => {
      if (state.failCreate) throw new Error('create exploded')
      const sessionId = `session-new-${++counter}`
      created.push({ request, sessionId })
      const child = createTestSession(sessionId, request.cwd)
      addAgent(world, new TestAgent({ id: sessionId, session: child }))
      return { sessionId }
    },
    selectModel: async (request) => {
      selects.push({ sessionId: request.sessionId, provider: request.provider, model: request.model })
    },
  }

  const llm: LlmView = {
    stream: (generateOptions: GenerateOptions) => {
      const message = generateOptions.messages[0] as { content: { type: string; text?: string }[] }
      state.prompts.push(message.content.map((block) => block.text ?? '').join(''))
      if (state.failSummary) throw new Error('llm exploded')
      return streamJson(JSON.stringify(state.summarySections))
    },
  }

  const permission = new Map<string, string>([['session-1', 'accept-edits']])
  const approval = new Map<string, 'ask' | 'never'>([['session-1', 'never']])
  const plan = new Map<string, boolean>([['session-1', true]])

  const permissionPresets: PermissionPresetsView = {
    current: (target) => permission.get(String(target.id)) ?? 'default',
    set: (target, name) => {
      permission.set(String(target.id), name)
    },
  }
  const approvalView: ApprovalView = {
    overrideOf: (target) => approval.get(String(target.id)),
    setPolicy: (target, policy) => {
      approval.set(String(target.id), policy)
    },
  }
  const planMode: PlanModeView = {
    get: (target) => ({ active: plan.get(String(target.id)) ?? false }),
    set: (target, active) => {
      plan.set(String(target.id), active)
      return 'committed'
    },
  }
  const agentPresets: AgentPresetsView = { composedPreset: () => 'default-preset' }
  const agentDefaultModel: DefaultModelView = {
    currentSelection: () => ({ provider: 'fallback', model: 'fallback-model' }),
  }

  // The workspace registry owns `E:\project`, which is exactly what an ordinary
  // Web deployment looks like for a session the browser can reach at all. Tests
  // mutate this handle to exercise the ungrouped and failing paths.
  const attached: string[] = []
  const workspaces: {
    attached: string[]
    owner: WorkspaceView | undefined
    failResolve: boolean
    failAttach: boolean
  } = {
    attached,
    owner: {
      id: 'ws-1',
      title: 'project',
      path: options.cwd ?? 'E:\\project',
      attachSession: async (sessionId) => {
        attached.push(sessionId)
      },
    },
    failResolve: false,
    failAttach: false,
  }
  const workspaceRegistry: WorkspaceRegistryView = {
    resolveByPath: async () => {
      if (workspaces.failResolve) throw new Error('realpath exploded')
      const owner = workspaces.owner
      if (owner === undefined) return undefined
      return workspaces.failAttach
        ? { ...owner, attachSession: async () => Promise.reject(new Error('attach exploded')) }
        : owner
    },
  }

  const extra: MigrationServices = {
    sessionController,
    llm,
    planModeFor: () => planMode,
    permissionPresets,
    approval: approvalView,
    agentPresets,
    agentDefaultModel,
    workspaceRegistry,
  }

  world.migration = createMigrationRunner(world.services, extra, () => state.settings)
  world.compact = createCompactRunner(world.services, () => undefined, () => state.settings)

  // Delivery can be made to fail on demand without touching the coordinator.
  if (true) {
    const originalDeliver = world.services.deliver
    world.services.deliver = (sessionId, text) => {
      if (state.failDelivery) return false
      return originalDeliver(sessionId, text)
    }
  }

  const coordinator = new Coordinator({
    services: world.services,
    settings: () => state.settings,
    tickMs: 1,
  })

  return {
    world,
    coordinator,
    get settings() {
      return state.settings
    },
    setSettings: (patch) => {
      state.settings = { ...state.settings, ...patch }
    },
    created,
    selects,
    get prompts() {
      return state.prompts
    },
    permission,
    approval,
    plan,
    workspaces,
    agent,
    setSummarySections: (sections) => {
      state.summarySections = sections
    },
    get failSummary() {
      return state.failSummary
    },
    set failSummary(value: boolean) {
      state.failSummary = value
    },
    get failCreate() {
      return state.failCreate
    },
    set failCreate(value: boolean) {
      state.failCreate = value
    },
    get failDelivery() {
      return state.failDelivery
    },
    set failDelivery(value: boolean) {
      state.failDelivery = value
    },
  }
}

function createCommandRegistry(): { registry: CommandRegistry; invoke: (rawInput: string, agentId?: string) => Promise<unknown> } {
  const handlers = new Map<string, (invocation: unknown) => unknown>()
  const registry: CommandRegistry = {
    register: (definition) => {
      handlers.set(definition.name, definition.handler as (invocation: unknown) => unknown)
      return () => handlers.delete(definition.name)
    },
  }
  return {
    registry,
    invoke: async (rawInput: string, agentId = 'session-1') => {
      const handler = handlers.get('handoff')
      if (handler === undefined) throw new Error('handoff command was not registered')
      return handler({
        commandId: 'cmd-1',
        agent: { id: agentId },
        rawInput,
        attachments: [],
        signal: new AbortController().signal,
      })
    },
  }
}

/** Start a turn so the soft stop has something to wait for. */
function startRunningStep(agent: TestAgent): void {
  agent.startStep()
}

let fixture: Integrated

beforeEach(() => {
  fixture = createIntegrated()
})

describe('integration (IT)', () => {
  it('IT-01 manual /handoff migrates end to end', async () => {
    const { registry, invoke } = createCommandRegistry()
    registerHandoffCommand(registry, {
      coordinator: fixture.coordinator,
      settings: () => fixture.settings,
      persistence: () => 'memory',
    })

    const result = (await invoke('')) as { kind: string; text: string }

    expect(result.kind).toBe('success')
    expect(result.text).toContain('已完成会话迁移')
    expect(result.text).toContain('session-new-1')
    expect(fixture.created).toHaveLength(1)
    expect(fixture.world.deliveries.get('session-new-1')?.[0]).toContain('# 任务迁移摘要')
    expect(fixture.coordinator.isLatched('session-1')).toBe(false)
    expect(fixture.agent.cancel).not.toHaveBeenCalled()
  })

  it('IT-02 arms a handoff automatically once the threshold is met', async () => {
    fixture.setSettings({ autoHandoffEnabled: true, autoHandoffThreshold: 2_000_000 })
    fixture.world.usage = {
      uncachedInputTokens: 2_500_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }

    fixture.coordinator.observe(fixture.agent.session, {
      type: 'assistant/message',
      seq: 10,
      time: 0,
      data: {},
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fixture.created).toHaveLength(1)
    const record = fixture.coordinator.records.get('session-1')
    expect(record.autoActions).toBe(1)
    expect(record.retired).toBe(true)
    expect(fixture.agent.cancel).not.toHaveBeenCalled()
  })

  it('IT-03 arms a compaction automatically once the compact threshold is met', async () => {
    const compactNow = vi.fn().mockResolvedValue({ shadowedTokenCount: 999 })
    const engine: CompactionView = { compactNow }
    fixture.world.compactionAvailable = true
    fixture.world.compact = createCompactRunner(
      fixture.world.services,
      () => engine,
      () => fixture.settings,
    )
    fixture.setSettings({
      autoCompactEnabled: true,
      autoCompactThreshold: 1_500_000,
      autoHandoffEnabled: false,
    })
    fixture.world.usage = {
      uncachedInputTokens: 1_600_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }

    fixture.coordinator.observe(fixture.agent.session, {
      type: 'assistant/message',
      seq: 11,
      time: 0,
      data: {},
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(compactNow).toHaveBeenCalledTimes(1)
    expect(fixture.coordinator.records.get('session-1').phase).toBe('COMPLETED')
    expect(fixture.agent.cancel).not.toHaveBeenCalled()
  })

  it('IT-04 sends 继续任务 only for a compaction that soft-stopped a running turn', async () => {
    const engine: CompactionView = { compactNow: vi.fn().mockResolvedValue({ shadowedTokenCount: 5 }) }
    fixture.world.compactionAvailable = true
    fixture.world.compact = createCompactRunner(fixture.world.services, () => engine, () => fixture.settings)

    // Idle session: no continuation turn may be opened.
    await fixture.coordinator.arm('session-1', 'compact', 'manual')
    expect(fixture.world.deliveries.get('session-1')).toBeUndefined()

    // Running session: the soft stop happened, so work resumes.
    startRunningStep(fixture.agent)
    const pending = fixture.coordinator.arm('session-1', 'compact', 'manual')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fixture.coordinator.isLatched('session-1')).toBe(true)
    fixture.agent.finishStep()
    await pending
    expect(fixture.world.deliveries.get('session-1')).toEqual(['继续任务'])
    expect(fixture.agent.cancel).not.toHaveBeenCalled()
  })

  it('IT-05/06 do not act while the current step is still running', async () => {
    startRunningStep(fixture.agent)
    let finished = false
    const pending = fixture.coordinator.arm('session-1', 'handoff', 'manual').then((outcome) => {
      finished = true
      return outcome
    })

    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(finished).toBe(false)
    expect(fixture.created).toHaveLength(0)
    expect(fixture.coordinator.isLatched('session-1')).toBe(true)

    fixture.agent.finishStep()
    await pending
    expect(finished).toBe(true)
    expect(fixture.created).toHaveLength(1)
  })

  it('IT-07 never hard-interrupts an in-flight tool call', async () => {
    startRunningStep(fixture.agent)
    const pending = fixture.coordinator.arm('session-1', 'handoff', 'manual')
    await new Promise((resolve) => setTimeout(resolve, 10))
    fixture.coordinator.cancel('session-1')
    fixture.agent.finishStep()
    await pending

    expect(fixture.agent.cancel).not.toHaveBeenCalled()
  })

  it('IT-08 creates a new session in the same workspace and delivers the brief', async () => {
    await fixture.coordinator.arm('session-1', 'handoff', 'manual')

    expect(fixture.created[0]?.request.cwd).toBe('E:\\project')
    const brief = fixture.world.deliveries.get('session-new-1')?.[0] ?? ''
    expect(brief).toContain('## 总体目标')
    expect(brief).toContain('完成交接插件')
    expect(brief).toContain('## 给新会话的指令')
  })

  it('IT-08b accounts the new session in the workspace that owns its cwd', async () => {
    const outcome = await fixture.coordinator.arm('session-1', 'handoff', 'manual')

    expect(outcome.ok).toBe(true)
    // The browser groups strictly by `Workspace.sessionIds`, and a create by cwd
    // alone leaves the session accounted by nobody — so the migration attaches
    // it explicitly, after the create.
    expect(fixture.workspaces.attached).toEqual(['session-new-1'])

    const row = (outcome.action?.inheritance ?? []).find((entry) => entry.name === '工作区归属')
    expect(row?.status).toBe('inherited')
    expect(row?.detail).toContain('project')
    expect(row?.detail).toContain('E:\\project')
  })

  it('IT-08c reports an ungrouped session when the directory owns no workspace', async () => {
    fixture.workspaces.owner = undefined

    const outcome = await fixture.coordinator.arm('session-1', 'handoff', 'manual')

    // An unregistered directory is a sidebar limit, not a migration failure:
    // the session exists, the brief arrived, and the row says so.
    expect(outcome.ok).toBe(true)
    expect(outcome.action?.outcome).toBe('completed')
    expect(fixture.workspaces.attached).toEqual([])
    expect(fixture.world.deliveries.get('session-new-1')?.[0]).toContain('# 任务迁移摘要')

    const row = (outcome.action?.inheritance ?? []).find((entry) => entry.name === '工作区归属')
    expect(row?.status).toBe('fallback')
    expect(row?.detail).toContain('未注册为工作区')
  })

  it('IT-08d never lets a workspace failure discard a session that already exists', async () => {
    fixture.workspaces.failResolve = true
    const unresolvable = await fixture.coordinator.arm('session-1', 'handoff', 'manual')

    expect(unresolvable.ok).toBe(true)
    expect(unresolvable.action?.outcome).toBe('completed')
    expect(unresolvable.action?.newSessionId).toBe('session-new-1')
    const resolveRow = (unresolvable.action?.inheritance ?? []).find(
      (entry) => entry.name === '工作区归属',
    )
    expect(resolveRow?.status).toBe('skipped')
    expect(resolveRow?.detail).toContain('目录无法解析')

    // Same invariant for an attach that rejects after `create()` returned: the
    // session is reported as created, and the brief is still delivered.
    const rejecting = createIntegrated()
    rejecting.workspaces.failAttach = true
    const failedAttach = await rejecting.coordinator.arm('session-1', 'handoff', 'manual')

    expect(failedAttach.ok).toBe(true)
    expect(failedAttach.action?.outcome).toBe('completed')
    expect(failedAttach.action?.newSessionId).toBe('session-new-1')
    expect(rejecting.workspaces.attached).toEqual([])
    expect(rejecting.world.deliveries.get('session-new-1')?.[0]).toContain('# 任务迁移摘要')
    const attachRow = (failedAttach.action?.inheritance ?? []).find(
      (entry) => entry.name === '工作区归属',
    )
    expect(attachRow?.status).toBe('skipped')
    expect(attachRow?.detail).toContain('attach exploded')
  })

  it('IT-09 inherits cwd and agent preset', async () => {
    const presetFixture = createIntegrated({ preset: 'review-preset' })
    const outcome = await presetFixture.coordinator.arm('session-1', 'handoff', 'manual')

    expect(presetFixture.created[0]?.request).toEqual({
      cwd: 'E:\\project',
      agentPreset: 'review-preset',
    })
    expect(outcome.action?.inheritance?.some((row) => row.name === 'Agent preset')).toBe(true)
  })

  it('IT-10a/b/c inherit mode, model, and permissions, and report each result', async () => {
    const outcome = await fixture.coordinator.arm('session-1', 'handoff', 'manual')
    const rows = outcome.action?.inheritance ?? []
    const byName = new Map(rows.map((row) => [row.name, row]))

    expect(byName.get('模型')?.status).toBe('inherited')
    expect(fixture.selects[0]).toMatchObject({
      sessionId: 'session-new-1',
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    expect(byName.get('权限控制')?.status).toBe('inherited')
    expect(fixture.permission.get('session-new-1')).toBe('accept-edits')
    expect(byName.get('Plan 模式')?.detail).toContain('已开启')
    expect(fixture.plan.get('session-new-1')).toBe(true)
  })

  it('IT-10 degradation: a custom preset and missing services are reported, not hidden', async () => {
    const custom = createIntegrated()
    custom.permission.set('session-1', 'custom')
    const outcome = await custom.coordinator.arm('session-1', 'handoff', 'manual')
    const rows = outcome.action?.inheritance ?? []

    const permission = rows.find((row) => row.name === '权限控制')
    expect(permission?.status).toBe('fallback')
    expect(permission?.detail).toContain('custom')
    expect(custom.approval.get('session-new-1')).toBe('never')

    // No permissionPresets service at all: the row is skipped with a reason.
    const bare = createIntegrated()
    const bareWorld = bare.world
    const session = bareWorld.sessions.get('session-1')
    expect(session).toBeDefined()
    const action = await runMigration(
      bareWorld.services,
      {
        sessionController: {
          create: async () => ({ sessionId: 'session-bare' }),
          selectModel: async () => undefined,
        },
        llm: { stream: () => streamJson('{"goal":"g"}') },
        planModeFor: () => undefined,
        permissionPresets: undefined,
        approval: undefined,
        agentPresets: undefined,
        agentDefaultModel: undefined,
        workspaceRegistry: undefined,
      },
      DEFAULT_HANDOFF_SETTINGS,
      {
        record: bare.coordinator.records.get('session-1'),
        agent: bare.agent.asAgent(),
        signal: new AbortController().signal,
        note: () => undefined,
      },
    )
    const skipped = (action.inheritance ?? []).filter((row) => row.status === 'skipped')
    expect(skipped.some((row) => row.name === '权限控制')).toBe(true)
    expect(skipped.some((row) => row.name === 'Plan 模式')).toBe(true)
    expect(skipped.some((row) => row.name === '工作区归属')).toBe(true)
  })

  it('IT-11 prefers handoff when both thresholds are met', async () => {
    const engine: CompactionView = { compactNow: vi.fn().mockResolvedValue({ shadowedTokenCount: 1 }) }
    fixture.world.compactionAvailable = true
    fixture.world.compact = createCompactRunner(fixture.world.services, () => engine, () => fixture.settings)
    fixture.setSettings({
      autoHandoffEnabled: true,
      autoCompactEnabled: true,
      autoHandoffThreshold: 2_000_000,
      autoCompactThreshold: 1_000_000,
    })
    fixture.world.usage = {
      uncachedInputTokens: 3_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }

    fixture.coordinator.observe(fixture.agent.session, {
      type: 'assistant/message',
      seq: 12,
      time: 0,
      data: {},
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fixture.created).toHaveLength(1)
    expect(engine.compactNow).not.toHaveBeenCalled()
  })

  it('IT-12 leaves the original session fully usable after a migration failure', async () => {
    fixture.failSummary = true

    const outcome = await fixture.coordinator.arm('session-1', 'handoff', 'manual')

    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('生成任务摘要失败')
    expect(fixture.created).toHaveLength(0)
    const record = fixture.coordinator.records.get('session-1')
    expect(record.phase).toBe('FAILED')
    expect(record.armed).toBeUndefined()
    expect(record.stopRequested).toBe(false)
    expect(fixture.coordinator.isLatched('session-1')).toBe(false)
    expect(record.lastActionAtTokens).toBeNull()

    // And the session can migrate again once the cause is gone.
    fixture.failSummary = false
    const retried = await fixture.coordinator.retry('session-1')
    expect(retried.ok).toBe(true)
  })

  it('IT-12b reports a created-but-undelivered session instead of pretending success', async () => {
    fixture.failDelivery = true

    const outcome = await fixture.coordinator.arm('session-1', 'handoff', 'manual')

    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('session-new-1')
    expect(fixture.world.deliveries.get('session-new-1')).toBeUndefined()
  })

  it('IT-13 does not repeat an action or loop forever', async () => {
    fixture.setSettings({
      autoHandoffEnabled: true,
      autoHandoffThreshold: 1_000_000,
      maxAutoActionsPerSession: 2,
      rearmDeltaTokens: 100_000,
    })
    fixture.world.usage = {
      uncachedInputTokens: 1_200_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }

    // A flood of threshold-crossing events must produce exactly one action:
    // the session is retired by the successful handoff.
    for (let seq = 1; seq <= 20; seq += 1) {
      fixture.coordinator.observe(fixture.agent.session, {
        type: 'assistant/message',
        seq,
        time: 0,
        data: {},
      } as never)
    }
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(fixture.created).toHaveLength(1)
    expect(fixture.coordinator.records.get('session-1').autoActions).toBe(1)
  })

  it('IT-13b stops at maxAutoActionsPerSession when actions fail', async () => {
    fixture.failSummary = true
    fixture.setSettings({
      autoHandoffEnabled: true,
      autoHandoffThreshold: 1_000,
      maxAutoActionsPerSession: 2,
      rearmDeltaTokens: 0,
    })
    fixture.world.usage = {
      uncachedInputTokens: 5_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }

    for (let seq = 1; seq <= 6; seq += 1) {
      fixture.coordinator.observe(fixture.agent.session, {
        type: 'assistant/message',
        seq,
        time: 0,
        data: {},
      } as never)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(fixture.coordinator.records.get('session-1').autoActions).toBe(2)
    expect(fixture.created).toHaveLength(0)
  })

  it('IT-14a abandons the migration when the user speaks before a session exists', async () => {
    startRunningStep(fixture.agent)
    const pending = fixture.coordinator.arm('session-1', 'handoff', 'manual')
    await new Promise((resolve) => setTimeout(resolve, 10))

    const human = createUserMessage({
      content: [{ type: 'text', text: '等一下，先不要迁移' }],
      source: { kind: 'user' },
    })
    const decision = await fixture.coordinator.handlePreStep(
      { agent: fixture.agent.asAgent(), messages: [human], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [human] }),
    )

    // The message is let through, and the migration gives up.
    expect(decision.kind).toBe('enter')
    fixture.agent.finishStep()
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    expect(fixture.created).toHaveLength(0)
    expect(fixture.coordinator.records.get('session-1').phase).toBe('CANCELLED')
    expect(fixture.coordinator.isLatched('session-1')).toBe(false)
  })

  it('IT-14b forwards the user message once a replacement session exists', async () => {
    const record = fixture.coordinator.records.get('session-1')
    record.stopRequested = true
    record.armed = { kind: 'handoff', trigger: 'manual', requestedAt: 0 }
    record.phase = 'TRANSFERRING'
    record.newSessionId = 'session-1'
    fixture.coordinator.records.get('session-1')

    const human = createUserMessage({
      content: [{ type: 'text', text: '顺便加上单元测试' }],
      source: { kind: 'user' },
    })
    const decision = await fixture.coordinator.handlePreStep(
      { agent: fixture.agent.asAgent(), messages: [human], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [human] }),
    )

    expect(decision.kind).toBe('reject')
    expect(fixture.world.deliveries.get('session-1')).toEqual(['顺便加上单元测试'])
    expect(extractPromptText([human])).toBe('顺便加上单元测试')
  })

  it('IT-14c never holds a human prompt back when no action is in flight', async () => {
    const human = createUserMessage({
      content: [{ type: 'text', text: '普通消息' }],
      source: { kind: 'user' },
    })
    const record = fixture.coordinator.records.get('session-1')
    record.stopRequested = true

    const decision = await fixture.coordinator.handlePreStep(
      { agent: fixture.agent.asAgent(), messages: [human], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [human] }),
    )

    expect(decision.kind).toBe('enter')
    expect(fixture.coordinator.isLatched('session-1')).toBe(false)
  })

  it('blocks the next step with a reject decision while the latch is held', async () => {
    startRunningStep(fixture.agent)
    const pending = fixture.coordinator.arm('session-1', 'handoff', 'manual')
    await new Promise((resolve) => setTimeout(resolve, 10))

    const pluginMessage = createUserMessage({
      content: [{ type: 'text', text: '内部注入' }],
      source: { kind: 'plugin', plugin: 'other' },
    })
    const decision = await fixture.coordinator.handlePreStep(
      { agent: fixture.agent.asAgent(), messages: [pluginMessage], turn: 1, step: 2 },
      async () => ({ kind: 'enter', messages: [pluginMessage] }),
    )

    expect(decision.kind).toBe('reject')
    fixture.agent.finishStep()
    await pending
  })

  it('reports a summary failure without creating anything, and surfaces the reason', async () => {
    const world = fixture.world
    const agent = fixture.agent
    const record = fixture.coordinator.records.get('session-1')
    const action: ActionRecord = await runMigration(
      world.services,
      {
        sessionController: {
          create: async () => ({ sessionId: 'never' }),
          selectModel: async () => undefined,
        },
        llm: undefined,
        planModeFor: () => undefined,
        permissionPresets: undefined,
        approval: undefined,
        agentPresets: undefined,
        agentDefaultModel: undefined,
        workspaceRegistry: undefined,
      },
      DEFAULT_HANDOFF_SETTINGS,
      {
        record,
        agent: agent.asAgent(),
        signal: new AbortController().signal,
        note: () => undefined,
      },
    )

    expect(action.outcome).toBe('failed')
    expect(action.text).toContain('未安装 llm 服务')
  })

  it('refuses to migrate an empty session', async () => {
    const emptyWorld = createWorld()
    const emptySession = createTestSession('empty')
    const emptyAgent = addAgent(emptyWorld, new TestAgent({ id: 'empty', session: emptySession }))
    const coordinator = new Coordinator({
      services: emptyWorld.services,
      settings: () => DEFAULT_HANDOFF_SETTINGS,
      tickMs: 1,
    })
    const created: string[] = []
    emptyWorld.migration = createMigrationRunner(
      emptyWorld.services,
      {
        sessionController: {
          create: async () => {
            created.push('x')
            return { sessionId: 'nope' }
          },
          selectModel: async () => undefined,
        },
        llm: { stream: () => streamJson('{"goal":"g"}') },
        planModeFor: () => undefined,
        permissionPresets: undefined,
        approval: undefined,
        agentPresets: undefined,
        agentDefaultModel: undefined,
        workspaceRegistry: undefined,
      },
      () => DEFAULT_HANDOFF_SETTINGS,
    )

    const outcome = await coordinator.arm('empty', 'handoff', 'manual')

    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('当前没有可迁移的活动会话')
    expect(created).toHaveLength(0)
    expect(emptyAgent.cancel).not.toHaveBeenCalled()
  })
})
