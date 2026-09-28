/**
 * In-process coordinator state (`TASK-PLAN.md` §16 L4).
 *
 * There is deliberately no database: the repository already owns session
 * statistics (`tokenUsage`, `contextPressure`) and a second store would
 * conflict with them. Everything here is memory-only, so a restart loses the
 * latches and the last result — settings and already-created sessions are
 * unaffected, and the README says so.
 */
import { createSessionRecord, type SessionRecord } from './types.js'

/** How many progress lines a record keeps before the oldest are dropped. */
export const MAX_PROGRESS_LINES = 40

/** How many failure notes a record keeps. */
export const MAX_FAILURES = 20

/** The process-local table of per-session coordinator records. */
export class StateStore {
  private readonly records = new Map<string, SessionRecord>()

  /**
   * The record for one session, created on first use.
   *
   * @param sessionId - durable session id.
   * @returns the live record; callers mutate it in place.
   */
  get(sessionId: string): SessionRecord {
    const existing = this.records.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSessionRecord(sessionId)
    this.records.set(sessionId, created)
    return created
  }

  /** The record for one session, or `undefined` when nothing was recorded yet. */
  peek(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId)
  }

  /** Every record, in first-seen order. */
  all(): SessionRecord[] {
    return [...this.records.values()]
  }

  /** Drop one session's record (its agent or session was disposed). */
  remove(sessionId: string): void {
    this.records.delete(sessionId)
  }

  /** Drop everything (plugin teardown). */
  clear(): void {
    this.records.clear()
  }

  /** Number of tracked sessions. */
  get size(): number {
    return this.records.size
  }

  /**
   * Append one human-readable progress line.
   *
   * @param record - the record to annotate.
   * @param line - the line; the oldest lines are dropped past the cap.
   */
  note(record: SessionRecord, line: string): void {
    record.progress.push(line)
    if (record.progress.length > MAX_PROGRESS_LINES) {
      record.progress.splice(0, record.progress.length - MAX_PROGRESS_LINES)
    }
  }

  /**
   * Record one failure note for a session.
   *
   * @param record - the record to annotate.
   * @param line - the failure text; also appended to the progress log.
   */
  fail(record: SessionRecord, line: string): void {
    record.failures.push(line)
    if (record.failures.length > MAX_FAILURES) {
      record.failures.splice(0, record.failures.length - MAX_FAILURES)
    }
    this.note(record, line)
  }
}
