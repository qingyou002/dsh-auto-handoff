import z from '@deepseek-ai/schemastery';
import { MESSAGES } from './types.js';
/** The one settings namespace this plugin owns. */
export const HANDOFF_NAMESPACE = 'dsh-auto-handoff';
/** Composition-entry defaults; also the memory-only fallback value. */
export const DEFAULT_HANDOFF_SETTINGS = {
    autoHandoffEnabled: false,
    autoHandoffThreshold: 2_000_000,
    autoCompactEnabled: false,
    autoCompactThreshold: 1_500_000,
    rearmDeltaTokens: 200_000,
    maxAutoActionsPerSession: 3,
    summaryMaxTokens: 4096,
    stepWaitTimeoutMs: 900_000,
    actionDeadlineMs: 1_800_000,
    openNewSessionOnHandoff: true,
};
/**
 * The settings schema. Every field carries a `default`, so an older stored
 * document missing a field resolves to the documented default rather than
 * failing validation (`TASK-PLAN.md` §9 「旧配置缺字段」).
 */
export const HandoffSettingsSchema = z.object({
    autoHandoffEnabled: z.boolean().default(DEFAULT_HANDOFF_SETTINGS.autoHandoffEnabled),
    autoHandoffThreshold: z.natural().default(DEFAULT_HANDOFF_SETTINGS.autoHandoffThreshold),
    autoCompactEnabled: z.boolean().default(DEFAULT_HANDOFF_SETTINGS.autoCompactEnabled),
    autoCompactThreshold: z.natural().default(DEFAULT_HANDOFF_SETTINGS.autoCompactThreshold),
    rearmDeltaTokens: z.natural().default(DEFAULT_HANDOFF_SETTINGS.rearmDeltaTokens),
    maxAutoActionsPerSession: z
        .number()
        .step(1)
        .min(1)
        .max(10)
        .default(DEFAULT_HANDOFF_SETTINGS.maxAutoActionsPerSession),
    summaryMaxTokens: z.number().step(1).min(256).default(DEFAULT_HANDOFF_SETTINGS.summaryMaxTokens),
    stepWaitTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_HANDOFF_SETTINGS.stepWaitTimeoutMs),
    actionDeadlineMs: z.number().step(1).min(1_000).default(DEFAULT_HANDOFF_SETTINGS.actionDeadlineMs),
    openNewSessionOnHandoff: z.boolean().default(DEFAULT_HANDOFF_SETTINGS.openNewSessionOnHandoff),
});
/** Smallest threshold worth accepting; below this the UI only warns. */
export const SMALL_THRESHOLD = 50_000;
/**
 * Cross-field rejection handed to the settings provider as `validate`.
 *
 * Ordering is rejected only when both automations are enabled: with one of them
 * switched off the ordering cannot produce an ambiguous decision, so it is
 * reported as a warning instead of blocking a save (`TASK-PLAN.md` §9).
 *
 * @param value - the resolved section, already schema-valid.
 * @throws {Error} when both thresholds are enabled and compact >= handoff.
 */
export function validateHandoffSettings(value) {
    if (value.autoCompactEnabled && value.autoHandoffEnabled) {
        if (value.autoCompactThreshold >= value.autoHandoffThreshold) {
            throw new Error(MESSAGES.thresholdOrder(value.autoCompactThreshold, value.autoHandoffThreshold));
        }
    }
}
/**
 * Non-blocking advisories surfaced by the card and `/handoff status`.
 *
 * @param value - any resolved settings value.
 * @returns one message per advisory, in a stable order.
 */
export function settingsWarnings(value) {
    const warnings = [];
    if (value.autoCompactThreshold >= value.autoHandoffThreshold) {
        warnings.push(MESSAGES.thresholdOrder(value.autoCompactThreshold, value.autoHandoffThreshold));
    }
    if (value.autoHandoffEnabled && value.autoHandoffThreshold < SMALL_THRESHOLD) {
        warnings.push(MESSAGES.thresholdSmall(value.autoHandoffThreshold));
    }
    if (value.autoCompactEnabled && value.autoCompactThreshold < SMALL_THRESHOLD) {
        warnings.push(MESSAGES.thresholdSmall(value.autoCompactThreshold));
    }
    return warnings;
}
/**
 * Resolve a raw settings document into a complete value.
 *
 * @param input - a stored section, a partial patch, or `undefined`.
 * @returns schema defaults merged with every recognized field of `input`.
 */
export function resolveHandoffSettings(input) {
    const candidate = input !== null && typeof input === 'object' ? input : {};
    return { ...DEFAULT_HANDOFF_SETTINGS, ...pickKnown(candidate) };
}
function pickKnown(raw) {
    const out = {};
    for (const key of Object.keys(DEFAULT_HANDOFF_SETTINGS)) {
        const value = raw[key];
        if (value === undefined)
            continue;
        const fallback = DEFAULT_HANDOFF_SETTINGS[key];
        if (typeof fallback === 'number') {
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
                ;
                out[key] = value;
            }
        }
        else if (typeof value === 'boolean') {
            ;
            out[key] = value;
        }
    }
    return out;
}
/**
 * Attach this plugin's settings section to an optional `settings` service.
 *
 * @param ctx - the plugin context.
 * @param entry - the composition-layer value used as the base and the fallback.
 * @param onSource - called whenever the authoritative value attaches, detaches, or changes.
 * @returns a handle exposing the current value and the persistence mode.
 */
export function installSettings(ctx, entry, onSource) {
    let source = () => entry;
    let persistence = 'memory';
    let disposed = false;
    const publish = () => {
        if (disposed)
            return;
        onSource(source());
    };
    const hooks = (assign) => ({
        setSource(current) {
            assign(current);
            persistence = 'host';
            publish();
        },
        onChange() {
            publish();
        },
        validate(value) {
            validateHandoffSettings(value);
        },
    });
    // `ctx.inject` never fires when no provider is present, so the plugin keeps
    // loading with the composition entry alone (TASK-PLAN.md §4.7).
    const fiber = ctx.inject(['settings'], (settingsCtx) => {
        try {
            settingsCtx.settings.installSection(ctx, HANDOFF_NAMESPACE, HandoffSettingsSchema, entry, hooks((thunk) => {
                source = thunk;
            }));
        }
        catch (error) {
            // A registration failure (bad namespace, rejected stored section) must not
            // take the plugin down: fall back to the composition entry.
            persistence = 'memory';
            source = () => entry;
            ctx.logger('dsh-auto-handoff').warn(`安装设置分区失败，改用组合层默认值：${error instanceof Error ? error.message : String(error)}`);
            publish();
        }
    });
    return {
        current: () => source(),
        persistence: () => persistence,
        dispose: () => {
            disposed = true;
            void Promise.resolve(fiber.dispose()).catch(() => undefined);
        },
    };
}
