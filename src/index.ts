/**
 * Host half of `dsh-auto-handoff`.
 *
 * This file is the only place that touches the live Cordis context: it reads
 * the optional services, builds the narrow views the rest of the plugin is
 * written against, wires the settings bridge, and subscribes to the four events
 * the coordinator observes. Every subscription is registered through
 * `ctx.effect`, so unloading the plugin releases the latches, the timers, and
 * the listeners together (`TASK-PLAN.md` §5.3, §7.2, §7.3).
 *
 * Every optional service is read through a *getter*, never snapshotted at
 * `apply()` time. The Loader composes sibling entries concurrently
 * (`cordis-plugin-loader/src/config/group.ts`), and a row that injects services
 * stays `PENDING` until its own dependencies are up, so a service this plugin
 * reads is frequently published *after* `apply()` returns — `sessionController`
 * (ten injected services) is the extreme case. A one-shot `ctx.get` therefore
 * latched `undefined` for the life of the process and reported a perfectly
 * healthy deployment as "本部署未安装 sessionController".
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { registerHandoffCommand } from './command.js'
import { createCompactRunner } from './compact-handler.js'
import { Coordinator } from './coordinator.js'
import { buildBriefMessage, createMigrationRunner, type MigrationServices } from './session-migration.js'
import { registerRoutes } from './routes.js'
import {
  DEFAULT_HANDOFF_SETTINGS,
  installSettings,
  settingsWarnings,
  type HandoffSettings,
} from './settings.js'
import type {
  ActionRunInput,
  ActionRecord,
  AgentPresetsView,
  ApprovalView,
  CompactionView,
  DefaultModelView,
  HandoffServices,
  LlmView,
  PermissionPresetsView,
  PlanModeView,
  SessionControllerView,
  UsageBuckets,
  WorkspaceRegistryView,
  WorkspaceView,
} from './types.js'

/** Loader diagnostic name; matches the `cordis.patch.yml` row id. */
export const name = 'dsh-auto-handoff'

/** The one hard dependency: without a command registry there is no `/handoff`. */
export const inject = ['commands']

// ---------------------------------------------------------------------------
// Narrow structural views of the optional services. Each is declared with the
// smallest possible signature; `unknown` parameters are deliberate, because the
// plugin never inspects a service argument it does not itself construct.
// ---------------------------------------------------------------------------

interface RawAgentRegistry {
  get(id: unknown): Agent | undefined
  list(): Agent[]
}

interface RawSessionStore {
  get(id: unknown): Session | undefined
}

interface RawProjections {
  stateOf(session: Session, key: string): unknown
}

interface RawTokenMeter {
  measure(session: Session): { totalTokens: number } | undefined
}

interface RawSessionController {
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  selectModel(request: unknown): Promise<unknown>
}

interface RawLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

interface RawCompaction {
  compactNow(agent: Agent, signal: AbortSignal): Promise<{ shadowedTokenCount?: number } | null>
}

interface RawPermissionPresets {
  current(session: Session): string
  set(session: Session, name: string): void
}

interface RawApproval {
  overrideOf(session: Session): 'ask' | 'never' | undefined
  setPolicy(agent: Agent, policy: 'ask' | 'never'): void
}

interface RawPlanMode {
  get(agent: Agent): { active: boolean; pending?: boolean }
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
}

interface RawAgentPresets {
  composedPreset(agentCtx: Context): string | undefined
  /**
   * One agent's instance of a service its preset mounted behind an `isolate`
   * realm, or `undefined` when that preset mounts none.
   *
   * A preset's realm is invisible outside the group that declares it —
   * including to a host row — so this is the only read path for a service the
   * Web surface moved off the host plane. Optional because a deployment may
   * predate it.
   */
  serviceFor?(agent: Agent, name: string): unknown
}

interface RawDefaultModel {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

interface RawWorkspaceRegistry {
  resolveByPath(path: string): Promise<RawWorkspace | undefined>
}

interface RawWorkspace {
  id: string
  title: string
  path: string
  attachSession(sessionId: string): Promise<void>
}

interface RawWebServer {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

/**
 * Build a live reader for one optional service.
 *
 * The returned getter re-reads `ctx.get` on every call, so a service published
 * after `apply()` is still found. Never call it during `apply()` and store the
 * result: that is the bug this helper exists to prevent.
 *
 * @param ctx - the plugin context.
 * @param serviceName - the Cordis service name.
 * @returns a getter for the service, or `undefined` while it is unpublished.
 */
function serviceReader<T>(ctx: Context, serviceName: string): () => T | undefined {
  return () => {
    const getter = (ctx as unknown as { get(name: string, strict?: boolean): unknown }).get
    const value = getter.call(ctx, serviceName)
    return value === undefined || value === null ? undefined : (value as T)
  }
}

/**
 * Resolve one service for one agent: the instance its own agent preset mounted
 * behind an `isolate` realm first, then the host plane.
 *
 * The Web surface disables the host `plan-mode` and `compaction-basic` rows and
 * lets each agent preset mount them instead (`dsh-web-app/cordis.patch.yml`),
 * and a preset realm is invisible to every row outside its group. The
 * documented read path for that case is `agentPresets.serviceFor(agent, name)`;
 * the host reader stays as the fallback for surfaces that keep the host rows.
 *
 * @param presetsOf - live reader for `ctx.agentPresets`.
 * @param agent - the agent whose composition to look inside.
 * @param name - the service name as a preset's own rows resolve it.
 * @param hostOf - live reader for the host-plane service.
 * @returns the live instance, or `undefined` when neither plane provides one.
 */
function forAgent<T>(
  presetsOf: () => RawAgentPresets | undefined,
  agent: Agent,
  name: string,
  hostOf: () => T | undefined,
): T | undefined {
  try {
    const scoped = presetsOf()?.serviceFor?.(agent, name)
    if (scoped !== undefined && scoped !== null) return scoped as T
  } catch {
    // A preset that cannot answer must not take the host fallback down with it.
  }
  return hostOf()
}

/**
 * Wire the plugin into one Cordis context.
 *
 * @param ctx - the plugin context; `ctx.commands` is guaranteed by `inject`.
 */
export function apply(ctx: Context): void {
  const logger = ctx.logger('dsh-auto-handoff')

  // Live readers, one per optional service. Nothing here is a snapshot: see the
  // module header for why a snapshot is fatal on a concurrently composed tree.
  const agentsOf = serviceReader<RawAgentRegistry>(ctx, 'agents')
  const sessionsOf = serviceReader<RawSessionStore>(ctx, 'sessions')
  const projectionsOf = serviceReader<RawProjections>(ctx, 'sessionProjections')
  const tokenMeterOf = serviceReader<RawTokenMeter>(ctx, 'tokenMeter')
  const sessionControllerOf = serviceReader<RawSessionController>(ctx, 'sessionController')
  const llmOf = serviceReader<RawLlm>(ctx, 'llm')
  const compactionOf = serviceReader<RawCompaction>(ctx, 'compaction')
  const permissionPresetsOf = serviceReader<RawPermissionPresets>(ctx, 'permissionPresets')
  const approvalOf = serviceReader<RawApproval>(ctx, 'approval')
  const planModeOf = serviceReader<RawPlanMode>(ctx, 'planMode')
  const agentPresetsOf = serviceReader<RawAgentPresets>(ctx, 'agentPresets')
  const agentDefaultModelOf = serviceReader<RawDefaultModel>(ctx, 'agentDefaultModel')
  const workspaceRegistryOf = serviceReader<RawWorkspaceRegistry>(ctx, 'workspaceRegistry')

  /** The plan-mode service one agent may use, preset realm first. */
  const resolvePlanMode = (agent: Agent): RawPlanMode | undefined =>
    forAgent(agentPresetsOf, agent, 'planMode', planModeOf)
  /** The compaction service one agent may use, preset realm first. */
  const resolveCompaction = (agent: Agent): RawCompaction | undefined =>
    forAgent(agentPresetsOf, agent, 'compaction', compactionOf)

  // ---- settings ------------------------------------------------------------
  let currentSettings: HandoffSettings = DEFAULT_HANDOFF_SETTINGS
  const settingsHandle = installSettings(ctx, DEFAULT_HANDOFF_SETTINGS, (value) => {
    currentSettings = value
  })

  // ---- lookups -------------------------------------------------------------
  const agentOf = (sessionId: string): Agent | undefined => agentsOf()?.get(sessionId)
  const sessionOf = (sessionId: string): Session | undefined => {
    const agent = agentOf(sessionId)
    if (agent !== undefined) return agent.session
    return sessionsOf()?.get(sessionId)
  }
  const tokenUsage = (session: Session): { totals?: Partial<UsageBuckets> } | undefined => {
    const state = projectionsOf()?.stateOf(session, 'tokenUsage')
    return state === undefined ? undefined : (state as { totals?: Partial<UsageBuckets> })
  }
  const measure = (session: Session): { totalTokens: number } | undefined =>
    tokenMeterOf()?.measure(session)
  const deliver = (sessionId: string, text: string): boolean => {
    const agent = agentOf(sessionId)
    if (agent === undefined) {
      logger.warn(`无法投递消息：会话 ${sessionId} 没有活动 Agent。`)
      return false
    }
    try {
      agent.followup(buildBriefMessage(text))
      return true
    } catch (error) {
      logger.warn(`投递消息到会话 ${sessionId} 失败：${describe(error)}`)
      return false
    }
  }

  const compactionViewFor = (agent: Agent): CompactionView | undefined => {
    const engine = resolveCompaction(agent)
    return engine === undefined
      ? undefined
      : { compactNow: (target, signal) => engine.compactNow(target, signal) }
  }

  const migrationServices: MigrationServices = {
    // Getters, not fields: this object is built during `apply()`, long before a
    // late-published service can answer. Each view is a local with an explicit
    // type because TypeScript does not contextually type a getter's value.
    get sessionController(): SessionControllerView | undefined {
      const service = sessionControllerOf()
      if (service === undefined) return undefined
      const view: SessionControllerView = {
        create: (request) => service.create(request),
        selectModel: (request) => service.selectModel(request),
      }
      return view
    },
    get llm(): LlmView | undefined {
      const service = llmOf()
      if (service === undefined) return undefined
      const view: LlmView = { stream: (options) => service.stream(options) }
      return view
    },
    planModeFor: (agent) => {
      const service = resolvePlanMode(agent)
      if (service === undefined) return undefined
      const view: PlanModeView = {
        get: (target) => service.get(target),
        set: (target, active) => service.set(target, active),
      }
      return view
    },
    get permissionPresets(): PermissionPresetsView | undefined {
      const service = permissionPresetsOf()
      if (service === undefined) return undefined
      const view: PermissionPresetsView = {
        current: (session) => service.current(session),
        set: (session, preset) => service.set(session, preset),
      }
      return view
    },
    get approval(): ApprovalView | undefined {
      const service = approvalOf()
      if (service === undefined) return undefined
      const view: ApprovalView = {
        overrideOf: (session) => service.overrideOf(session),
        setPolicy: (agent, policy) => service.setPolicy(agent, policy),
      }
      return view
    },
    get agentPresets(): AgentPresetsView | undefined {
      const service = agentPresetsOf()
      if (service === undefined) return undefined
      const view: AgentPresetsView = {
        composedPreset: (agentCtx) => service.composedPreset(agentCtx),
      }
      return view
    },
    get agentDefaultModel(): DefaultModelView | undefined {
      const service = agentDefaultModelOf()
      if (service === undefined) return undefined
      const view: DefaultModelView = { currentSelection: () => service.currentSelection() }
      return view
    },
    get workspaceRegistry(): WorkspaceRegistryView | undefined {
      const service = workspaceRegistryOf()
      if (service === undefined) return undefined
      const view: WorkspaceRegistryView = {
        resolveByPath: async (path) => {
          const workspace = await service.resolveByPath(path)
          if (workspace === undefined) return undefined
          const entity: WorkspaceView = {
            id: workspace.id,
            title: workspace.title,
            path: workspace.path,
            attachSession: (sessionId) => workspace.attachSession(sessionId),
          }
          return entity
        },
      }
      return view
    },
  }

  // ---- coordinator ---------------------------------------------------------
  // The two action bodies are installed after the object exists, because each
  // closes over the service bundle that carries it.
  const services: HandoffServices = {
    now: () => Date.now(),
    log: (level, message) => {
      if (level === 'warn') logger.warn(message)
      else logger.info(message)
    },
    agentOf,
    sessionOf,
    tokenUsage,
    measure,
    deliver,
    persistence: () => settingsHandle.persistence(),
    compactionAvailable: (agent) =>
      agent === undefined ? compactionOf() !== undefined : resolveCompaction(agent) !== undefined,
    runMigration: async (_input: ActionRunInput): Promise<ActionRecord> => {
      throw new Error('迁移执行器尚未装配。')
    },
    runCompact: async (_input: ActionRunInput): Promise<ActionRecord> => {
      throw new Error('压缩执行器尚未装配。')
    },
  }
  services.runMigration = createMigrationRunner(services, migrationServices, () => currentSettings)
  services.runCompact = createCompactRunner(services, compactionViewFor, () => currentSettings)

  const coordinator = new Coordinator({ services, settings: () => currentSettings })

  // ---- command -------------------------------------------------------------
  ctx.effect(
    () =>
      registerHandoffCommand(ctx.commands, {
        coordinator,
        settings: () => currentSettings,
        persistence: () => settingsHandle.persistence(),
      }),
    'dsh-auto-handoff: /handoff',
  )

  // ---- event subscriptions -------------------------------------------------
  ctx.effect(() => {
    const offPreStep = ctx.on('agent/pre-step', (payload, next) =>
      coordinator.handlePreStep(payload, next),
    )
    const offStatus = ctx.on('agent/status', (payload) => {
      coordinator.noteAgentStatus(String(payload.agent.id), payload.status)
    })
    const offError = ctx.on('agent/error', (payload) => {
      coordinator.noteAgentError(String(payload.agent.id), payload.error)
    })
    const offSession = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      coordinator.observe(session, event)
    })
    const offAgentDisposed = ctx.on('agent/disposed', (payload) => {
      coordinator.releaseSession(String(payload.agent.id))
    })
    const offSessionDisposed = ctx.on('session/disposed', (session: Session) => {
      coordinator.releaseSession(String(session.id))
    })
    return () => {
      offPreStep()
      offStatus()
      offError()
      offSession()
      offAgentDisposed()
      offSessionDisposed()
    }
  }, 'dsh-auto-handoff: listeners')

  // ---- HTTP state channel --------------------------------------------------
  // `ctx.inject` keeps the plugin loadable on a deployment without a web
  // server; the card then degrades to settings-only (TASK-PLAN.md §10.6).
  ctx.inject(['webServer'], (webCtx) => {
    const webServerOf = serviceReader<RawWebServer>(webCtx, 'webServer')
    const webServer = webServerOf()
    if (webServer === undefined) return
    webCtx.effect(
      () =>
        registerRoutes(
          webServer as unknown as Parameters<typeof registerRoutes>[0],
          {
            coordinator,
            settings: () => currentSettings,
            persistence: () => settingsHandle.persistence(),
            warnings: () => settingsWarnings(currentSettings),
          },
        ),
      'dsh-auto-handoff: routes',
    )
  })

  // ---- teardown ------------------------------------------------------------
  ctx.effect(
    () => () => {
      void coordinator.dispose().catch((error: unknown) => {
        logger.warn(`卸载清理失败：${describe(error)}`)
      })
      settingsHandle.dispose()
    },
    'dsh-auto-handoff: teardown',
  )
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export default { name, inject, apply }
