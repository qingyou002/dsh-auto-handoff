/**
 * Browser follower (`src/client/follow.ts`).
 *
 * These tests exist because the switch after a `/handoff` is the part of the
 * browser half that no component owns: it must run for the whole page, and it
 * must never navigate to a session the sidebar is still hiding. The Host channel
 * is stubbed, so the matrix below is exactly the decision table the follower
 * implements — including the two states that made a real migration look like a
 * no-op: a target that was already recorded before the page loaded (history, not
 * news), and a freshly created row the Host still calls `blank` (invisible until
 * the list is re-read).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FOLLOW_ATTEMPTS,
  DEFAULT_FOLLOW_INTERVAL_MS,
  startHandoffFollower,
  type FollowHandle,
} from '../../src/client/follow.js'
import type { SessionsLike, StatePayload } from '../../src/client/protocol.js'

const INTERVAL = DEFAULT_FOLLOW_INTERVAL_MS

interface SessionWorld {
  /** The session on screen, as the client's list snapshot reports it. */
  current: string | undefined
  /** Row metadata keyed by session id; a missing id means "not listed yet". */
  rows: Record<string, { blank?: boolean } | undefined>
  /** Ordered call log, so `refresh()`-before-`open()` is observable. */
  calls: string[]
  refreshes: number
  opens: string[]
  sessions: SessionsLike
}

function createSessions(current: string | undefined = 'session-1'): SessionWorld {
  const world: SessionWorld = {
    current,
    rows: {},
    calls: [],
    refreshes: 0,
    opens: [],
    sessions: undefined as unknown as SessionsLike,
  }
  world.sessions = {
    list: {
      getSnapshot: () => ({ current: world.current, byId: world.rows as Record<string, { blank?: boolean }> }),
    },
    refresh: async () => {
      world.refreshes += 1
      world.calls.push('refresh')
    },
    open: (id: string) => {
      world.opens.push(id)
      world.calls.push(`open:${id}`)
    },
  }
  return world
}

/** A completable state payload; every field the wire shape requires is present. */
function payload(patch: Partial<StatePayload> = {}): StatePayload {
  return {
    sessionId: 'session-1',
    phase: 'IDLE',
    phaseLabel: '空闲',
    waitingForStep: false,
    summarizing: false,
    creatingSession: false,
    transferring: false,
    waitingForCompact: false,
    stopRequested: false,
    atBoundary: false,
    retired: false,
    slowWarning: false,
    tokens: 0,
    tokenSource: 'unavailable',
    thresholds: { handoff: 1_000_000, compact: 500_000 },
    autoHandoffEnabled: true,
    autoCompactEnabled: true,
    maxAutoActionsPerSession: 2,
    rearmDeltaTokens: 100_000,
    openNewSessionOnHandoff: true,
    autoActions: 0,
    persistence: 'memory',
    progress: [],
    failures: [],
    warnings: [],
    ...patch,
  }
}

/** The mutable Host stub: what the next poll returns, and how it behaves. */
interface HostStub {
  state: StatePayload
  /** When set, the poll rejects with this error instead of answering. */
  throws: Error | undefined
  /** When set, the poll answers `ok: false`. */
  notOk: boolean
  urls: string[]
  fetchImpl: typeof fetch
}

function createHost(initial: StatePayload = payload()): HostStub {
  const host: HostStub = {
    state: initial,
    throws: undefined,
    notOk: false,
    urls: [],
    fetchImpl: undefined as unknown as typeof fetch,
  }
  host.fetchImpl = (async (input: unknown) => {
    host.urls.push(String(input))
    if (host.throws !== undefined) throw host.throws
    if (host.notOk) return { ok: false, status: 503, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => host.state }
  }) as unknown as typeof fetch
  return host
}

/**
 * Let the follower's promise chain advance without moving the clock.
 *
 * The first poll runs on `start()`, so it is already awaiting the stubbed fetch
 * by the time `startHandoffFollower` returns; a handful of microtask turns
 * settles it.
 */
async function flush(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}

/** Fire exactly one interval poll and settle its chain. */
async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(INTERVAL)
}

let world: SessionWorld
let host: HostStub
let follower: FollowHandle | undefined
let errors: string[]

/**
 * Start the follower and settle its immediate poll.
 *
 * @param options - overrides for the attempt cap and the switch setting.
 */
async function start(options: { maxAttempts?: number; openNewSessionOnHandoff?: boolean } = {}): Promise<void> {
  if (options.openNewSessionOnHandoff === false) {
    host.state = { ...host.state, openNewSessionOnHandoff: false }
  }
  follower = startHandoffFollower({
    sessions: world.sessions,
    fetchImpl: host.fetchImpl,
    intervalMs: INTERVAL,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    onError: (message) => errors.push(message),
  })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  world = createSessions()
  host = createHost(payload({ newSessionId: undefined }))
  errors = []
  follower = undefined
})

afterEach(() => {
  follower?.stop()
  vi.useRealTimers()
})

describe('handoff follower', () => {
  it('polls the Host state channel for the session on screen', async () => {
    await start()

    expect(host.urls).toEqual(['/dsh-auto-handoff/state?sessionId=session-1'])
  })

  it('does not switch to a target that was already recorded when the page loaded', async () => {
    host.state = payload({ newSessionId: 'session-new' })
    world.rows['session-new'] = { blank: false }

    await start()
    await poll()
    await poll()

    // History, not news: opening the page must not hijack it to an old
    // migration's session.
    expect(world.opens).toEqual([])
    expect(world.refreshes).toBe(0)
  })

  it('switches on an undefined → target transition, re-reading the list first', async () => {
    await start()

    host.state = payload({ newSessionId: 'session-new' })
    world.rows['session-new'] = { blank: false }
    await poll()

    // `refresh()` is what clears the Host's blank bit; `open()` a session the
    // sidebar still hides would land the user on an invisible row.
    expect(world.calls).toEqual(['refresh', 'open:session-new'])
    expect(world.opens).toEqual(['session-new'])
  })

  it('waits while the new row is still blank, then switches once it is visible', async () => {
    await start()

    host.state = payload({ newSessionId: 'session-new' })
    world.rows['session-new'] = { blank: true }
    await poll()

    expect(world.refreshes).toBe(1)
    expect(world.opens).toEqual([])

    // The brief's `turn/start` has landed, so the Host now calls the log
    // non-blank on the next re-read.
    world.rows['session-new'] = { blank: false }
    await poll()

    expect(world.refreshes).toBe(2)
    expect(world.opens).toEqual(['session-new'])
  })

  it('waits while the new row is not listed at all, then switches', async () => {
    await start()

    host.state = payload({ newSessionId: 'session-new' })
    await poll()
    expect(world.opens).toEqual([])

    world.rows['session-new'] = { blank: false }
    await poll()

    expect(world.opens).toEqual(['session-new'])
  })

  it('does not switch when openNewSessionOnHandoff is off', async () => {
    await start({ openNewSessionOnHandoff: false })

    host.state = payload({ newSessionId: 'session-new', openNewSessionOnHandoff: false })
    world.rows['session-new'] = { blank: false }
    await poll()
    await poll()

    expect(world.opens).toEqual([])
    expect(world.refreshes).toBe(0)
  })

  it('gives up quietly after maxAttempts while the row never becomes visible', async () => {
    await start({ maxAttempts: 2 })

    host.state = payload({ newSessionId: 'session-new' })
    world.rows['session-new'] = { blank: true }
    await poll()
    await poll()
    expect(world.refreshes).toBe(2)

    // Attempt three is over the cap: no further list re-reads, no navigation —
    // and the row becoming visible later changes nothing.
    await poll()
    world.rows['session-new'] = { blank: false }
    await poll()
    await poll()

    expect(world.refreshes).toBe(2)
    expect(world.opens).toEqual([])
    expect(errors).toEqual([])
  })

  it('reports a failed poll through onError instead of throwing into the page', async () => {
    await start()

    host.throws = new Error('network down')
    host.state = payload({ newSessionId: 'session-new' })
    await poll()

    expect(errors).toEqual(['network down'])
    expect(world.opens).toEqual([])

    // The failure is not sticky: the next good poll still migrates the page.
    host.throws = undefined
    world.rows['session-new'] = { blank: false }
    await poll()

    expect(world.opens).toEqual(['session-new'])
  })

  it('ignores a non-ok response and keeps polling', async () => {
    await start()

    host.notOk = true
    host.state = payload({ newSessionId: 'session-new' })
    await poll()
    expect(world.opens).toEqual([])

    host.notOk = false
    world.rows['session-new'] = { blank: false }
    await poll()
    expect(world.opens).toEqual(['session-new'])
  })

  it('stops polling after stop()', async () => {
    await start()
    expect(host.urls).toHaveLength(1)

    follower?.stop()
    await poll()
    await poll()

    expect(host.urls).toHaveLength(1)
  })

  it('stays inert without a sessions service or a fetch implementation', async () => {
    const withoutSessions = startHandoffFollower({ sessions: undefined, fetchImpl: host.fetchImpl })
    await poll()
    expect(host.urls).toEqual([])
    withoutSessions.stop()

    const withoutFetch = startHandoffFollower({ sessions: world.sessions, fetchImpl: undefined })
    await poll()
    expect(host.urls).toEqual([])
    withoutFetch.stop()
  })

  it('does nothing while no session is on screen', async () => {
    world.current = undefined
    await start()
    await poll()
    await poll()

    expect(host.urls).toEqual([])
  })

  it('documents its defaults', () => {
    expect(DEFAULT_FOLLOW_INTERVAL_MS).toBe(2_000)
    expect(DEFAULT_FOLLOW_ATTEMPTS).toBe(12)
  })
})
