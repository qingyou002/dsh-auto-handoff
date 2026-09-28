import { describe, expect, it } from 'vitest'
import { DEFAULT_HANDOFF_SETTINGS, type HandoffSettings } from '../../src/settings.js'
import {
  decideAutoAction,
  readCumulativeUsage,
  sumBuckets,
  thresholdProgress,
  TokenTracker,
} from '../../src/token-threshold.js'
import { createSessionRecord, type SessionRecord } from '../../src/types.js'

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { ...createSessionRecord('session-1'), ...overrides }
}

function settings(overrides: Partial<HandoffSettings> = {}): HandoffSettings {
  return { ...DEFAULT_HANDOFF_SETTINGS, ...overrides }
}

function buckets(uncachedInputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

describe('cumulative usage (UT-TT)', () => {
  it('UT-TT-01 sums the four disjoint buckets into the exact cumulative value', () => {
    const reading = readCumulativeUsage({
      projection: { totals: buckets(1_000, 250, 4_000, 500) },
      measure: undefined,
    })

    expect(reading.source).toBe('exact')
    expect(reading.tokens).toBe(5_750)
    expect(reading.buckets).toEqual(buckets(1_000, 250, 4_000, 500))
    expect(sumBuckets(buckets(1, 2, 3, 4))).toBe(10)
  })

  it('UT-TT-02 falls back to the heuristic measurement and labels it estimated', () => {
    const reading = readCumulativeUsage({
      projection: { totals: buckets(0, 0, 0, 0) },
      measure: { totalTokens: 12_345 },
    })

    expect(reading.source).toBe('estimated')
    expect(reading.tokens).toBe(12_345)
    expect(reading.detail).toContain('估算')
  })

  it('UT-TT-03 reports unavailable when neither reader has a value, and never arms', () => {
    const reading = readCumulativeUsage({ projection: undefined, measure: undefined })
    expect(reading.source).toBe('unavailable')
    expect(reading.tokens).toBe(0)

    const decision = decideAutoAction({
      reading,
      settings: settings({ autoHandoffEnabled: true, autoHandoffThreshold: 1 }),
      record: record(),
      hasPendingAction: false,
    })
    expect(decision).toEqual({ kind: 'none', reason: 'tokens-unavailable' })
  })

  it('UT-TT-04 stops arming after maxAutoActionsPerSession', () => {
    const decision = decideAutoAction({
      reading: { tokens: 9_000_000, source: 'exact' },
      settings: settings({ autoHandoffEnabled: true, maxAutoActionsPerSession: 3 }),
      record: record({ autoActions: 3 }),
      hasPendingAction: false,
    })
    expect(decision).toEqual({ kind: 'none', reason: 'budget-exhausted' })
  })

  it('UT-TT-05 counts each watermark position once', () => {
    const tracker = new TokenTracker()
    expect(tracker.observe('session-1', 4)).toBe(true)
    expect(tracker.observe('session-1', 4)).toBe(false)
    expect(tracker.observe('session-1', 3)).toBe(false)
    expect(tracker.observe('session-1', 5)).toBe(true)
    expect(tracker.watermark('session-1')).toBe(5)

    tracker.reset('session-1')
    expect(tracker.watermark('session-1')).toBe(-1)
    expect(tracker.size).toBe(0)
  })

  it('UT-TT-06 does not stack an estimate on top of itself across evaluations', () => {
    // The reading is recomputed from scratch each time; nothing accumulates.
    const first = readCumulativeUsage({ projection: undefined, measure: { totalTokens: 700 } })
    const second = readCumulativeUsage({ projection: undefined, measure: { totalTokens: 700 } })
    expect(second.tokens).toBe(first.tokens)
    expect(second.source).toBe('estimated')
  })

  it('UT-TT-07 re-arms only after rearmDeltaTokens beyond the last action', () => {
    const base = {
      settings: settings({ autoHandoffEnabled: true, autoHandoffThreshold: 1_000, rearmDeltaTokens: 500 }),
      record: record({ lastActionAtTokens: 1_000 }),
      hasPendingAction: false,
    }

    expect(decideAutoAction({ ...base, reading: { tokens: 1_400, source: 'exact' } })).toEqual({
      kind: 'none',
      reason: 'not-rearmed',
    })
    expect(decideAutoAction({ ...base, reading: { tokens: 1_500, source: 'exact' } })).toEqual({
      kind: 'handoff',
      reason: 'handoff-threshold',
    })
  })

  it('UT-TT-08 prefers handoff when both thresholds are met', () => {
    const decision = decideAutoAction({
      reading: { tokens: 2_500_000, source: 'exact' },
      settings: settings({ autoHandoffEnabled: true, autoCompactEnabled: true }),
      record: record(),
      hasPendingAction: false,
    })
    expect(decision.kind).toBe('handoff')
  })

  it('UT-TT-09 returns only compact when only compaction is enabled', () => {
    const decision = decideAutoAction({
      reading: { tokens: 2_500_000, source: 'exact' },
      settings: settings({ autoHandoffEnabled: false, autoCompactEnabled: true }),
      record: record(),
      hasPendingAction: false,
    })
    expect(decision.kind).toBe('compact')
  })

  it('suppresses while an action is already pending, and for retired sessions', () => {
    const base = {
      reading: { tokens: 9_000_000, source: 'exact' as const },
      settings: settings({ autoHandoffEnabled: true }),
    }
    expect(decideAutoAction({ ...base, record: record(), hasPendingAction: true })).toEqual({
      kind: 'none',
      reason: 'action-in-flight',
    })
    expect(decideAutoAction({ ...base, record: record({ retired: true }), hasPendingAction: false })).toEqual({
      kind: 'none',
      reason: 'retired',
    })
    expect(decideAutoAction({ ...base, record: record(), hasPendingAction: false }).kind).toBe('handoff')
  })

  it('reports threshold progress without dividing by zero', () => {
    expect(thresholdProgress(50, 100)).toBe(0.5)
    expect(thresholdProgress(500, 100)).toBe(1)
    expect(thresholdProgress(-5, 100)).toBe(0)
    expect(thresholdProgress(50, 0)).toBe(0)
  })
})
