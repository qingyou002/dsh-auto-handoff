import { MESSAGES } from './types.js';
/** Route prefix; distinct from every built-in route. */
export const ROUTE_PREFIX = '/dsh-auto-handoff';
/**
 * Build the state payload for one session.
 *
 * @param deps - coordinator, settings, and warnings accessors.
 * @param sessionId - the session the browser is showing.
 * @returns the payload; unknown sessions report `IDLE` rather than erroring,
 *   because a browser holding a stale id is not an error condition.
 */
export function statePayload(deps, sessionId) {
    const status = deps.coordinator.status(sessionId);
    const settings = deps.settings();
    const payload = {
        sessionId,
        phase: status?.phase ?? 'IDLE',
        phaseLabel: status?.phaseLabel ?? '空闲',
        waitingForStep: status?.waitingForStep ?? false,
        summarizing: status?.summarizing ?? false,
        creatingSession: status?.creatingSession ?? false,
        transferring: status?.transferring ?? false,
        waitingForCompact: status?.waitingForCompact ?? false,
        stopRequested: status?.stopRequested ?? false,
        atBoundary: status?.atBoundary ?? false,
        retired: status?.retired ?? false,
        slowWarning: status?.slowWarning ?? false,
        tokens: status?.tokens ?? 0,
        tokenSource: status?.tokenSource ?? 'unavailable',
        thresholds: { handoff: settings.autoHandoffThreshold, compact: settings.autoCompactThreshold },
        autoHandoffEnabled: settings.autoHandoffEnabled,
        autoCompactEnabled: settings.autoCompactEnabled,
        maxAutoActionsPerSession: settings.maxAutoActionsPerSession,
        rearmDeltaTokens: settings.rearmDeltaTokens,
        openNewSessionOnHandoff: settings.openNewSessionOnHandoff,
        autoActions: status?.autoActions ?? 0,
        persistence: deps.persistence(),
        progress: status?.progress ?? [],
        failures: status?.failures ?? [],
        warnings: deps.warnings(),
    };
    const newSessionId = status?.newSessionId;
    if (newSessionId !== undefined)
        payload.newSessionId = newSessionId;
    const lastResult = status?.lastResult;
    if (lastResult !== undefined)
        payload.lastResult = lastResult;
    return payload;
}
/**
 * Register the plugin's routes.
 *
 * @param webServer - `ctx.webServer`.
 * @param deps - coordinator and settings accessors.
 * @returns the route disposer.
 */
export function registerRoutes(webServer, deps) {
    return webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const action = url.pathname.slice(ROUTE_PREFIX.length) || '/';
            if (req.method === 'GET' && action === '/state') {
                sendJson(res, 200, statePayload(deps, url.searchParams.get('sessionId') ?? ''));
                return;
            }
            const post = req.method === 'POST' ? POST_ACTIONS[action] : undefined;
            if (post === undefined) {
                sendJson(res, 404, { ok: false, error: 'unknown route' });
                return;
            }
            if (!isLoopback(req)) {
                sendJson(res, 403, { ok: false, error: 'loopback only' });
                return;
            }
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
            if (sessionId.length === 0) {
                sendJson(res, 400, { ok: false, error: 'sessionId is required' });
                return;
            }
            const outcome = await post(deps.coordinator, sessionId);
            sendJson(res, 200, outcome.ok
                ? { ok: true, phase: deps.coordinator.status(sessionId)?.phase ?? 'IDLE', text: outcome.text }
                : { ok: false, error: outcome.text });
        },
    });
}
/** The three mutating actions, keyed by path suffix. */
const POST_ACTIONS = {
    '/handoff': (coordinator, sessionId) => coordinator.arm(sessionId, 'handoff', 'manual'),
    '/cancel': async (coordinator, sessionId) => coordinator.cancel(sessionId),
    '/retry': (coordinator, sessionId) => coordinator.retry(sessionId),
};
/**
 * Whether a request came from the loopback interface.
 *
 * @param req - the incoming request.
 * @returns `true` for `127.0.0.1`, `::1`, and their mapped forms.
 */
export function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? '';
    return (address === '127.0.0.1' ||
        address === '::1' ||
        address === '::ffff:127.0.0.1' ||
        address.startsWith('127.'));
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        if (size > 64 * 1024)
            return undefined;
        chunks.push(buffer);
    }
    if (size === 0)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** Write one JSON response with the full lifecycle owned here. */
export function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
    });
    res.end(body);
}
/** The message the card shows when no HTTP channel exists (`TASK-PLAN.md` §10.6). */
export const NO_CHANNEL_HINT = MESSAGES.stateChannelUnavailable();
