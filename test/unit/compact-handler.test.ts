import { describe, expect, it, vi } from 'vitest'
import {
  COMPACT_MAX_RETRIES,
  CONTINUE_PROMPT,
  compactionErrorCode,
  runCompact,
} from '../../src/compact-handler.js'
import { DEFAULT_HANDOFF_SETTINGS } from '../../src/settings.js'
import { createSessionRecord, type ActionRunInput, type CompactionView } from '../../src/types.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createWorld, TestAgent, createTestSession } from '../harness.js'

const settings = () => DEFAULT_HANDOFF_SETTINGS

function makeInput(record = createSessionRecord('session-1')): {
  input: ActionRunInput
  record: ReturnType<typeof createSessionRecord>
  agent: TestAgent
  notes: string[]
} {
  const agent = new TestAgent({ session: createTestSession('session-1') })
  const notes: string[] = []
  return {
    record,
    agent,
    notes,
    input: {
      record,
      agent: agent.asAgent() as Agent,
      signal: new AbortController().signal,
      note: (line) => notes.push(line),
    },
  }
}

describe('compact handler', () => {
  it('retries a busy failure and then succeeds', async () => {
    const compactNow = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'busy' }))
      .mockResolvedValueOnce({ shadowedTokenCount: 1234 })
    const engine: CompactionView = { compactNow }
    const world = createWorld()
    const { input, record } = makeInput()

    const action = await runCompact(world.services, () => engine, settings, input)

    expect(compactNow).toHaveBeenCalledTimes(2)
    expect(action.outcome).toBe('completed')
    expect(action.text).toContain('1234')
    // An idle session is never woken with a fresh turn (§8.4).
    expect(record.softStoppedRunning).toBeUndefined()
    expect(world.deliveries.get('session-1')).toBeUndefined()
  })

  it('gives up after the retry ceiling and reports it', async () => {
    const compactNow = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { code: 'busy' }))
    const engine: CompactionView = { compactNow }
    const world = createWorld()
    const { input } = makeInput()

    const action = await runCompact(world.services, () => engine, settings, input)

    expect(compactNow).toHaveBeenCalledTimes(COMPACT_MAX_RETRIES)
    expect(action.outcome).toBe('failed')
    expect(action.text).toContain(`连续 ${COMPACT_MAX_RETRIES} 次`)
  })

  it('fails once for a non-busy failure class', async () => {
    const compactNow = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('summary shrank'), { code: 'summary' }))
    const engine: CompactionView = { compactNow }
    const world = createWorld()
    const { input } = makeInput()

    const action = await runCompact(world.services, () => engine, settings, input)

    expect(compactNow).toHaveBeenCalledTimes(1)
    expect(action.outcome).toBe('failed')
    expect(action.text).toContain('summary')
    expect(action.text).toContain('summary shrank')
  })

  it('treats a null result as "nothing safe to compact", not a failure', async () => {
    const engine: CompactionView = { compactNow: vi.fn().mockResolvedValue(null) }
    const world = createWorld()
    const { input } = makeInput()

    const action = await runCompact(world.services, () => engine, settings, input)

    expect(action.outcome).toBe('completed')
    expect(action.text).toContain('没有可安全压缩')
  })

  it('sends 继续任务 only when a running turn was soft-stopped', async () => {
    const engine: CompactionView = { compactNow: vi.fn().mockResolvedValue({ shadowedTokenCount: 10 }) }
    const world = createWorld()
    const agent = new TestAgent({ session: createTestSession('session-1') })
    world.agents.set('session-1', agent)
    const record = createSessionRecord('session-1')
    record.softStoppedRunning = true

    const action = await runCompact(world.services, () => engine, settings, {
      record,
      agent: agent.asAgent(),
      signal: new AbortController().signal,
      note: () => undefined,
    })

    expect(action.outcome).toBe('completed')
    expect(world.deliveries.get('session-1')).toEqual([CONTINUE_PROMPT])
    expect(agent.delivered).toHaveLength(1)
  })

  it('refuses to run without a compaction service', async () => {
    const world = createWorld()
    const { input } = makeInput()

    const action = await runCompact(world.services, () => undefined, settings, input)

    expect(action.outcome).toBe('failed')
    expect(action.text).toContain('未安装 compaction')
  })

  it('honours a cancellation request before entering the engine', async () => {
    const compactNow = vi.fn()
    const engine: CompactionView = { compactNow }
    const world = createWorld()
    const record = createSessionRecord('session-1')
    record.cancelRequested = true
    const { input } = makeInput(record)

    const action = await runCompact(world.services, () => engine, settings, input)

    expect(compactNow).not.toHaveBeenCalled()
    expect(action.outcome).toBe('cancelled')
  })

  it('reads a failure code defensively', () => {
    expect(compactionErrorCode(Object.assign(new Error('x'), { code: 'busy' }))).toBe('busy')
    expect(compactionErrorCode(new Error('x'))).toBeUndefined()
    expect(compactionErrorCode('nope')).toBeUndefined()
    expect(compactionErrorCode(null)).toBeUndefined()
  })
})
