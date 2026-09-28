import { registerHandoffCommand } from './command.js';
import { createCompactRunner } from './compact-handler.js';
import { Coordinator } from './coordinator.js';
import { buildBriefMessage, createMigrationRunner } from './session-migration.js';
import { registerRoutes } from './routes.js';
import { DEFAULT_HANDOFF_SETTINGS, installSettings, settingsWarnings, } from './settings.js';
/** Loader diagnostic name; matches the `cordis.patch.yml` row id. */
export const name = 'dsh-auto-handoff';
/** The one hard dependency: without a command registry there is no `/handoff`. */
export const inject = ['commands'];
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
function serviceReader(ctx, serviceName) {
    return () => {
        const getter = ctx.get;
        const value = getter.call(ctx, serviceName);
        return value === undefined || value === null ? undefined : value;
    };
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
function forAgent(presetsOf, agent, name, hostOf) {
    try {
        const scoped = presetsOf()?.serviceFor?.(agent, name);
        if (scoped !== undefined && scoped !== null)
            return scoped;
    }
    catch {
        // A preset that cannot answer must not take the host fallback down with it.
    }
    return hostOf();
}
/**
 * Wire the plugin into one Cordis context.
 *
 * @param ctx - the plugin context; `ctx.commands` is guaranteed by `inject`.
 */
export function apply(ctx) {
    const logger = ctx.logger('dsh-auto-handoff');
    // Live readers, one per optional service. Nothing here is a snapshot: see the
    // module header for why a snapshot is fatal on a concurrently composed tree.
    const agentsOf = serviceReader(ctx, 'agents');
    const sessionsOf = serviceReader(ctx, 'sessions');
    const projectionsOf = serviceReader(ctx, 'sessionProjections');
    const tokenMeterOf = serviceReader(ctx, 'tokenMeter');
    const sessionControllerOf = serviceReader(ctx, 'sessionController');
    const llmOf = serviceReader(ctx, 'llm');
    const compactionOf = serviceReader(ctx, 'compaction');
    const permissionPresetsOf = serviceReader(ctx, 'permissionPresets');
    const approvalOf = serviceReader(ctx, 'approval');
    const planModeOf = serviceReader(ctx, 'planMode');
    const agentPresetsOf = serviceReader(ctx, 'agentPresets');
    const agentDefaultModelOf = serviceReader(ctx, 'agentDefaultModel');
    const workspaceRegistryOf = serviceReader(ctx, 'workspaceRegistry');
    /** The plan-mode service one agent may use, preset realm first. */
    const resolvePlanMode = (agent) => forAgent(agentPresetsOf, agent, 'planMode', planModeOf);
    /** The compaction service one agent may use, preset realm first. */
    const resolveCompaction = (agent) => forAgent(agentPresetsOf, agent, 'compaction', compactionOf);
    // ---- settings ------------------------------------------------------------
    let currentSettings = DEFAULT_HANDOFF_SETTINGS;
    const settingsHandle = installSettings(ctx, DEFAULT_HANDOFF_SETTINGS, (value) => {
        currentSettings = value;
    });
    // ---- lookups -------------------------------------------------------------
    const agentOf = (sessionId) => agentsOf()?.get(sessionId);
    const sessionOf = (sessionId) => {
        const agent = agentOf(sessionId);
        if (agent !== undefined)
            return agent.session;
        return sessionsOf()?.get(sessionId);
    };
    const tokenUsage = (session) => {
        const state = projectionsOf()?.stateOf(session, 'tokenUsage');
        return state === undefined ? undefined : state;
    };
    const measure = (session) => tokenMeterOf()?.measure(session);
    const deliver = (sessionId, text) => {
        const agent = agentOf(sessionId);
        if (agent === undefined) {
            logger.warn(`无法投递消息：会话 ${sessionId} 没有活动 Agent。`);
            return false;
        }
        try {
            agent.followup(buildBriefMessage(text));
            return true;
        }
        catch (error) {
            logger.warn(`投递消息到会话 ${sessionId} 失败：${describe(error)}`);
            return false;
        }
    };
    const compactionViewFor = (agent) => {
        const engine = resolveCompaction(agent);
        return engine === undefined
            ? undefined
            : { compactNow: (target, signal) => engine.compactNow(target, signal) };
    };
    const migrationServices = {
        // Getters, not fields: this object is built during `apply()`, long before a
        // late-published service can answer. Each view is a local with an explicit
        // type because TypeScript does not contextually type a getter's value.
        get sessionController() {
            const service = sessionControllerOf();
            if (service === undefined)
                return undefined;
            const view = {
                create: (request) => service.create(request),
                selectModel: (request) => service.selectModel(request),
            };
            return view;
        },
        get llm() {
            const service = llmOf();
            if (service === undefined)
                return undefined;
            const view = { stream: (options) => service.stream(options) };
            return view;
        },
        planModeFor: (agent) => {
            const service = resolvePlanMode(agent);
            if (service === undefined)
                return undefined;
            const view = {
                get: (target) => service.get(target),
                set: (target, active) => service.set(target, active),
            };
            return view;
        },
        get permissionPresets() {
            const service = permissionPresetsOf();
            if (service === undefined)
                return undefined;
            const view = {
                current: (session) => service.current(session),
                set: (session, preset) => service.set(session, preset),
            };
            return view;
        },
        get approval() {
            const service = approvalOf();
            if (service === undefined)
                return undefined;
            const view = {
                overrideOf: (session) => service.overrideOf(session),
                setPolicy: (agent, policy) => service.setPolicy(agent, policy),
            };
            return view;
        },
        get agentPresets() {
            const service = agentPresetsOf();
            if (service === undefined)
                return undefined;
            const view = {
                composedPreset: (agentCtx) => service.composedPreset(agentCtx),
            };
            return view;
        },
        get agentDefaultModel() {
            const service = agentDefaultModelOf();
            if (service === undefined)
                return undefined;
            const view = { currentSelection: () => service.currentSelection() };
            return view;
        },
        get workspaceRegistry() {
            const service = workspaceRegistryOf();
            if (service === undefined)
                return undefined;
            const view = {
                resolveByPath: async (path) => {
                    const workspace = await service.resolveByPath(path);
                    if (workspace === undefined)
                        return undefined;
                    const entity = {
                        id: workspace.id,
                        title: workspace.title,
                        path: workspace.path,
                        attachSession: (sessionId) => workspace.attachSession(sessionId),
                    };
                    return entity;
                },
            };
            return view;
        },
    };
    // ---- coordinator ---------------------------------------------------------
    // The two action bodies are installed after the object exists, because each
    // closes over the service bundle that carries it.
    const services = {
        now: () => Date.now(),
        log: (level, message) => {
            if (level === 'warn')
                logger.warn(message);
            else
                logger.info(message);
        },
        agentOf,
        sessionOf,
        tokenUsage,
        measure,
        deliver,
        persistence: () => settingsHandle.persistence(),
        compactionAvailable: (agent) => agent === undefined ? compactionOf() !== undefined : resolveCompaction(agent) !== undefined,
        runMigration: async (_input) => {
            throw new Error('迁移执行器尚未装配。');
        },
        runCompact: async (_input) => {
            throw new Error('压缩执行器尚未装配。');
        },
    };
    services.runMigration = createMigrationRunner(services, migrationServices, () => currentSettings);
    services.runCompact = createCompactRunner(services, compactionViewFor, () => currentSettings);
    const coordinator = new Coordinator({ services, settings: () => currentSettings });
    // ---- command -------------------------------------------------------------
    ctx.effect(() => registerHandoffCommand(ctx.commands, {
        coordinator,
        settings: () => currentSettings,
        persistence: () => settingsHandle.persistence(),
    }), 'dsh-auto-handoff: /handoff');
    // ---- event subscriptions -------------------------------------------------
    ctx.effect(() => {
        const offPreStep = ctx.on('agent/pre-step', (payload, next) => coordinator.handlePreStep(payload, next));
        const offStatus = ctx.on('agent/status', (payload) => {
            coordinator.noteAgentStatus(String(payload.agent.id), payload.status);
        });
        const offError = ctx.on('agent/error', (payload) => {
            coordinator.noteAgentError(String(payload.agent.id), payload.error);
        });
        const offSession = ctx.on('session/event', (session, event) => {
            coordinator.observe(session, event);
        });
        const offAgentDisposed = ctx.on('agent/disposed', (payload) => {
            coordinator.releaseSession(String(payload.agent.id));
        });
        const offSessionDisposed = ctx.on('session/disposed', (session) => {
            coordinator.releaseSession(String(session.id));
        });
        return () => {
            offPreStep();
            offStatus();
            offError();
            offSession();
            offAgentDisposed();
            offSessionDisposed();
        };
    }, 'dsh-auto-handoff: listeners');
    // ---- HTTP state channel --------------------------------------------------
    // `ctx.inject` keeps the plugin loadable on a deployment without a web
    // server; the card then degrades to settings-only (TASK-PLAN.md §10.6).
    ctx.inject(['webServer'], (webCtx) => {
        const webServerOf = serviceReader(webCtx, 'webServer');
        const webServer = webServerOf();
        if (webServer === undefined)
            return;
        webCtx.effect(() => registerRoutes(webServer, {
            coordinator,
            settings: () => currentSettings,
            persistence: () => settingsHandle.persistence(),
            warnings: () => settingsWarnings(currentSettings),
        }), 'dsh-auto-handoff: routes');
    });
    // ---- teardown ------------------------------------------------------------
    ctx.effect(() => () => {
        void coordinator.dispose().catch((error) => {
            logger.warn(`卸载清理失败：${describe(error)}`);
        });
        settingsHandle.dispose();
    }, 'dsh-auto-handoff: teardown');
}
function describe(error) {
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
export default { name, inject, apply };
