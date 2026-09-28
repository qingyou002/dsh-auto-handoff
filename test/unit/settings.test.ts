import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HANDOFF_SETTINGS,
  HandoffSettingsSchema,
  HANDOFF_NAMESPACE,
  resolveHandoffSettings,
  settingsWarnings,
  validateHandoffSettings,
} from '../../src/settings.js'

describe('settings (UT-SE)', () => {
  it('UT-SE-01 exposes every documented default and backfills an old section', () => {
    expect(HANDOFF_NAMESPACE).toBe('dsh-auto-handoff')
    expect(DEFAULT_HANDOFF_SETTINGS).toEqual({
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
    })

    // A section written by an older build, missing three fields.
    const old = { autoHandoffEnabled: true, autoHandoffThreshold: 3_000_000 }
    const resolved = resolveHandoffSettings(old)
    expect(resolved.autoHandoffEnabled).toBe(true)
    expect(resolved.autoHandoffThreshold).toBe(3_000_000)
    expect(resolved.autoCompactThreshold).toBe(DEFAULT_HANDOFF_SETTINGS.autoCompactThreshold)
    expect(resolved.maxAutoActionsPerSession).toBe(3)

    // The schemastery schema itself also backfills, which is what the settings
    // provider renders and resolves through.
    const viaSchema = HandoffSettingsSchema(old) as typeof DEFAULT_HANDOFF_SETTINGS
    expect(viaSchema.autoHandoffEnabled).toBe(true)
    expect(viaSchema.autoCompactThreshold).toBe(1_500_000)
    expect(viaSchema.summaryMaxTokens).toBe(4096)
  })

  it('UT-SE-02 rejects compact >= handoff while both automations are enabled', () => {
    const bothOn = {
      ...DEFAULT_HANDOFF_SETTINGS,
      autoHandoffEnabled: true,
      autoCompactEnabled: true,
      autoHandoffThreshold: 1_000_000,
      autoCompactThreshold: 1_000_000,
    }
    expect(() => validateHandoffSettings(bothOn)).toThrow(/必须小于/)
    expect(() =>
      validateHandoffSettings({ ...bothOn, autoCompactThreshold: 999_999 }),
    ).not.toThrow()

    // With one automation off the ordering cannot produce an ambiguous
    // decision, so the writer warns instead of blocking the save.
    expect(() =>
      validateHandoffSettings({ ...bothOn, autoCompactEnabled: false }),
    ).not.toThrow()
    expect(settingsWarnings({ ...bothOn, autoCompactEnabled: false }).length).toBeGreaterThan(0)
  })

  it('UT-SE-03 ignores negative, non-integer, and non-numeric values', () => {
    const resolved = resolveHandoffSettings({
      autoHandoffThreshold: -1,
      autoCompactThreshold: 1.5,
      rearmDeltaTokens: Number.NaN,
      maxAutoActionsPerSession: '3',
      summaryMaxTokens: Number.POSITIVE_INFINITY,
      stepWaitTimeoutMs: null,
      actionDeadlineMs: undefined,
    })

    expect(resolved.autoHandoffThreshold).toBe(DEFAULT_HANDOFF_SETTINGS.autoHandoffThreshold)
    expect(resolved.autoCompactThreshold).toBe(DEFAULT_HANDOFF_SETTINGS.autoCompactThreshold)
    expect(resolved.rearmDeltaTokens).toBe(DEFAULT_HANDOFF_SETTINGS.rearmDeltaTokens)
    expect(resolved.maxAutoActionsPerSession).toBe(DEFAULT_HANDOFF_SETTINGS.maxAutoActionsPerSession)
    expect(resolved.summaryMaxTokens).toBe(DEFAULT_HANDOFF_SETTINGS.summaryMaxTokens)
    expect(resolved.stepWaitTimeoutMs).toBe(DEFAULT_HANDOFF_SETTINGS.stepWaitTimeoutMs)
    expect(resolved.actionDeadlineMs).toBe(DEFAULT_HANDOFF_SETTINGS.actionDeadlineMs)
  })

  it('UT-SE-04 warns about a small threshold without blocking the save', () => {
    const small = {
      ...DEFAULT_HANDOFF_SETTINGS,
      autoHandoffEnabled: true,
      autoHandoffThreshold: 1_000,
      autoCompactEnabled: false,
    }
    const warnings = settingsWarnings(small)
    expect(warnings.some((warning) => warning.includes('偏小'))).toBe(true)
    expect(() => validateHandoffSettings(small)).not.toThrow()
  })
})
