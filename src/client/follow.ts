/**
 * The always-on browser follower: when the Host reports that a migration
 * finished for the session on screen, re-read the list and switch to the new
 * session (`TASK-PLAN.md` §10.4).
 *
 * Two facts shape this module, both learned from a real `/handoff` run whose new
 * session the user could not find:
 *
 * 1. The switch cannot live in the settings card. It used to: the card polled
 *    the Host state channel and called `sessions.open()`. But the card only
 *    exists while the settings tab is mounted, and `/handoff` is normally typed
 *    in the chat — so the watcher was not running at all and the migration
 *    completed with no navigation. `apply()` starts this follower instead, so it
 *    is live for every page.
 *
 * 2. A freshly created session is announced to the browser as *blank*: the Host
 *    emits `api-session/added` with the summary it has at `session/created`
 *    time, when the log holds nothing but its header, and the client's list
 *    store has no later event that clears that bit — only a list re-read does
 *    (`applySessionListMetadata` clears `blank` on `turn/start`, and the client
 *    forwards neither that event nor a re-pull). The workspace browser hides
 *    blank rows unless they are the current selection, so `refresh()` is what
 *    makes the new session visible at all, and `open()` alone would switch to a
 *    row the sidebar still refuses to show.
 *
 * The baseline rule keeps the follower from hijacking a page load: a target that
 * is already recorded the first time a session is observed is history, not news.
 * Only a transition from "no new session" to "new session" switches away.
 */
import { ROUTE_PREFIX, type SessionsLike, type StatePayload } from './protocol.js'

/** How often the Host state channel is polled. */
export const DEFAULT_FOLLOW_INTERVAL_MS = 2_000

/**
 * How many polls one target gets before the follower gives up.
 *
 * The guard exists for the honest case where the brief never starts a turn: the
 * row then stays blank, the sidebar keeps hiding it, and retrying forever would
 * only re-pull the whole list every two seconds.
 */
export const DEFAULT_FOLLOW_ATTEMPTS = 12

/** Inputs for {@link startHandoffFollower}. */
export interface FollowOptions {
  /** Live `ctx.sessions`; `undefined` when the service is absent. */
  sessions: SessionsLike | undefined
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl: typeof fetch | undefined
  /** Poll interval in ms; defaults to {@link DEFAULT_FOLLOW_INTERVAL_MS}. */
  intervalMs?: number
  /** Attempts per target; defaults to {@link DEFAULT_FOLLOW_ATTEMPTS}. */
  maxAttempts?: number
  /** Contained diagnostic sink; the follower never throws into the page. */
  onError?: (message: string) => void
}

/** Handle returned by {@link startHandoffFollower}. */
export interface FollowHandle {
  /** Stop polling and release the timer. */
  stop(): void
}

/**
 * Start watching for completed migrations.
 *
 * @param options - the sessions service, a fetch implementation, and test seams.
 * @returns a handle whose `stop()` releases the interval.
 */
export function startHandoffFollower(options: FollowOptions): FollowHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_FOLLOW_INTERVAL_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_FOLLOW_ATTEMPTS
  /**
   * Last target *concluded* per session, so "already there" never switches.
   *
   * A target is only recorded here once it has been opened, deliberately
   * skipped, or given up on. Recording it any earlier would make the retry path
   * below unreachable: the very next poll would compare equal and return before
   * re-reading the list.
   */
  const observed = new Map<string, string | undefined>()
  /** Targets already acted on, or given up on. */
  const settled = new Set<string>()
  const attempts = new Map<string, number>()
  let stopped = false
  let inFlight = false

  const report = (error: unknown): void => {
    options.onError?.(error instanceof Error ? error.message : String(error))
  }

  const tick = async (): Promise<void> => {
    const sessions = options.sessions
    const fetchImpl = options.fetchImpl
    if (stopped || inFlight || sessions === undefined || fetchImpl === undefined) return

    const current = sessions.list.getSnapshot().current
    if (current === undefined || current.length === 0) return

    inFlight = true
    try {
      const response = await fetchImpl(
        `${ROUTE_PREFIX}/state?sessionId=${encodeURIComponent(current)}`,
        { headers: { accept: 'application/json' } },
      )
      if (!response.ok) return
      const state = (await response.json()) as StatePayload

      const target = state.newSessionId
      if (!observed.has(current)) {
        // First sighting of this session: the target it already carries predates
        // this page, so it is context for the user, not a reason to navigate.
        observed.set(current, target)
        if (target !== undefined) settled.add(target)
        return
      }
      if (observed.get(current) === target) return
      if (target === undefined) {
        // The record carries no replacement session (yet, or any more). Nothing
        // to navigate to, and the session may still gain one — remember only
        // the absence.
        observed.set(current, target)
        return
      }
      if (state.openNewSessionOnHandoff !== true) {
        // The user turned the switch off: the target is news, but not for us.
        observed.set(current, target)
        return
      }
      if (settled.has(target)) {
        observed.set(current, target)
        return
      }

      const attempt = (attempts.get(target) ?? 0) + 1
      attempts.set(target, attempt)
      if (attempt > maxAttempts) {
        settled.add(target)
        observed.set(current, target)
        return
      }

      await sessions.refresh()
      const row = sessions.list.getSnapshot().byId?.[target]
      // Not listed yet, or still blank: the sidebar would not show it, so wait
      // for the next poll instead of switching to an invisible session. The
      // target stays unrecorded so that next poll really does retry.
      if (row === undefined || row.blank === true) return
      // The page may have been disposed while the list was re-read; a stopped
      // follower must not navigate.
      if (stopped) return

      settled.add(target)
      observed.set(current, target)
      sessions.open(target)
    } catch (error) {
      report(error)
    } finally {
      inFlight = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
