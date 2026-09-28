/**
 * `/handoff status` rendering (`TASK-PLAN.md` §14 行 5).
 *
 * The wait sentence exists in three surfaces — the command, the HTTP state
 * payload, and the settings card. This file pins the command's half of that
 * contract, including the elapsed-minute note the coordinator records into
 * `progress`.
 */
import { describe, expect, it } from 'vitest'
import { renderStatusText } from '../../src/command.js'
import { DEFAULT_HANDOFF_SETTINGS } from '../../src/settings.js'
import { MESSAGES, createSessionRecord, toSessionStatus } from '../../src/types.js'

describe('renderStatusText', () => {
  it('UT-CM-01 renders an untracked session as idle with the persistence hint', () => {
    const text = renderStatusText(undefined, DEFAULT_HANDOFF_SETTINGS, 'memory')
    expect(text).toContain('空闲（本会话尚无记录）')
    expect(text).toContain(MESSAGES.persistenceMemory())
    // A host-persisted deployment says nothing about losing state.
    expect(renderStatusText(undefined, DEFAULT_HANDOFF_SETTINGS, 'host')).not.toContain(
      MESSAGES.persistenceMemory(),
    )
  })

  it('UT-CM-02 falls back to a timeless wait sentence before any note is recorded', () => {
    const record = createSessionRecord('session-1')
    record.phase = 'WAITING_FOR_STEP_BOUNDARY'
    record.lastReading = { tokens: 1234, source: 'exact' }

    const text = renderStatusText(toSessionStatus(record), DEFAULT_HANDOFF_SETTINGS, 'host')
    expect(text).toContain('正在等待当前 Step 完成。')
    expect(text).toContain('会话累计 Token：1234（精确）')
    expect(text).not.toContain('进度：')
    // The plain-text fallback must not invent an elapsed time.
    expect(text).not.toContain('已等待')
  })

  it('UT-CM-03 prints the recorded elapsed-minute note exactly once, under 进度', () => {
    const record = createSessionRecord('session-1')
    record.phase = 'WAITING_FOR_STEP_BOUNDARY'
    record.slowWarning = true
    record.progress.push('正在生成任务摘要…')
    record.progress.push(MESSAGES.waitingForStep(3))

    const text = renderStatusText(toSessionStatus(record), DEFAULT_HANDOFF_SETTINGS, 'host')
    const waitLines = text.split('\n').filter((line) => line.includes('正在等待当前 Step 完成'))
    expect(waitLines).toHaveLength(1)
    expect(waitLines[0]).toContain('已等待 3 分钟')
    expect(text).toContain('进度：')
    expect(text).toContain('  · 正在生成任务摘要…')
  })

  it('UT-CM-04 shows only the trailing progress lines and the failure list', () => {
    const record = createSessionRecord('session-1')
    for (let index = 1; index <= 9; index += 1) record.progress.push(`步骤 ${index}`)
    record.failures.push('当前 Tool Call 失败：boom')

    const text = renderStatusText(toSessionStatus(record), DEFAULT_HANDOFF_SETTINGS, 'host')
    expect(text).not.toContain('步骤 4')
    expect(text).toContain('  · 步骤 5')
    expect(text).toContain('  · 步骤 9')
    expect(text).toContain('失败记录：当前 Tool Call 失败：boom')
  })
})
