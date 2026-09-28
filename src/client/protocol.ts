/**
 * The browser half's wire contract and the narrow service shapes both halves of
 * the UI code share (`TASK-PLAN.md` §10).
 *
 * This module is deliberately free of React: the settings card and the
 * always-on follower are two independent consumers of the same payload, and the
 * follower is started by `apply()`, long before any card is mounted. Keeping the
 * types here is also what lets the follower be unit-tested without a renderer.
 */

/** Settings namespace; must match the Host registration. */
export const NAMESPACE = 'dsh-auto-handoff'

/** HTTP prefix registered by the Host half. */
export const ROUTE_PREFIX = '/dsh-auto-handoff'

/** Wire shape of the settings section, mirrored from the Host schema. */
export interface HandoffSettingsShape {
  autoHandoffEnabled: boolean
  autoHandoffThreshold: number
  autoCompactEnabled: boolean
  autoCompactThreshold: number
  rearmDeltaTokens: number
  maxAutoActionsPerSession: number
  summaryMaxTokens: number
  stepWaitTimeoutMs: number
  actionDeadlineMs: number
  openNewSessionOnHandoff: boolean
}

/** Client settings scope, narrowed to what the card reads and writes. */
export interface SettingsScopeLike {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: HandoffSettingsShape | undefined
    revision: number | undefined
    writable: boolean
    mode: 'host' | 'memory'
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/**
 * One row of the client's session-list snapshot, narrowed to the two facts the
 * follower reads: whether the session is the one on screen, and whether the Host
 * still calls its log blank.
 */
export interface SessionListRow {
  /**
   * Host-computed empty-log bit. The workspace browser hides blank rows unless
   * they are the current selection, so a freshly created session is invisible
   * until the browser re-reads the Host summary.
   */
  blank?: boolean | undefined
}

/**
 * Sessions service, narrowed to listing and switching.
 *
 * `byId` is optional because the caller may be an older or narrower snapshot
 * provider; a missing map only costs the follower its blank-row guard.
 */
export interface SessionsLike {
  readonly list: {
    getSnapshot(): { current?: string | undefined; byId?: Record<string, SessionListRow> | undefined }
  }
  refresh(): Promise<void>
  open(id: string): void
}

/** Host state payload returned by `GET /dsh-auto-handoff/state`. */
export interface StatePayload {
  sessionId: string
  phase: string
  phaseLabel: string
  waitingForStep: boolean
  summarizing: boolean
  creatingSession: boolean
  transferring: boolean
  waitingForCompact: boolean
  stopRequested: boolean
  atBoundary: boolean
  retired: boolean
  slowWarning: boolean
  tokens: number
  tokenSource: 'exact' | 'estimated' | 'unavailable'
  thresholds: { handoff: number; compact: number }
  autoHandoffEnabled: boolean
  autoCompactEnabled: boolean
  maxAutoActionsPerSession: number
  rearmDeltaTokens: number
  openNewSessionOnHandoff: boolean
  autoActions: number
  persistence: 'host' | 'memory'
  newSessionId?: string
  lastResult?: { text: string; outcome: string; kind: string; newSessionId?: string } | undefined
  progress: readonly string[]
  failures: readonly string[]
  warnings: readonly string[]
}
