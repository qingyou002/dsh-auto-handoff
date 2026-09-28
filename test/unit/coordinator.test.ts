import { describe, expect, it, vi } from 'vitest'
import { Coordinator } from '../../src/coordinator.js'
import { DEFAULT_HANDOFF_SETTINGS, type HandoffSettings } from '../../src/settings.js'
import type { ActionRecord } from '../../src/types.js'
import { addAgent, createWorld, fakeEvent, TestAgent, createTestSession } from '../harness.js'

function settings(overrides: Partial<HandoffSettings> = {}): HandoffSettings {
  return { ...DEFAULT_HANDOFF_SETTINGS, ...overrides }
}

function completedAction(text = '已完成会话迁移：新会话 session-2。'): ActionRecord {
  return {
    kind: 'handoff',
    trigger: 'manual',
    outcome: 'completed',
    startedAt: 0,
    finishedAt: 1,
    text,
    newSessionId: 'session-2',
  }
}

describe('coordinator state machine (UT-ST)', () => {
  it('UT-ST-01 walks the phase machine, records the result, and is idempotent per session', async () => {
    const world = createWorld()
    const agent = addAgent(world, new TestAgent({ id: 'session-1' }))
    world.migration = async () => completedAction()

    const coordinator = new Coordinator({ services: world.services, settings: () => settings(), tickMs: 1 })

    expect(coordinator.status(agent.id)).toBeUndefined()
    expect(coordinator.records.get(agent.id).phase).toBe('IDLE')

    const outcome = await coordinator.arm(agent.id, 'handoff', 'manual')

    expect(outcome.ok).toBe(true)
    expect(outcome.action?.newSessionId).toBe('session-2')
    const record = coordinator.records.get(agent.id)
    expect(record.phase).toBe('COMPLETED')
    expect(record.armed).toBeUndefined()
    expect(record.stopRequested).toBe(false)
    expect(record.retired).toBe(true)
    expect(record.autoActions).toBe(0)
    expect(record.lastActionAtTokens).toBe(0)
    expect(coordinator.isLatched(agent.id)).toBe(false)
    expect(coordinator.status(agent.id)?.lastResult?.text).toContain('已完成会话迁移')

    // A second identical call starts a fresh attempt rather than erroring, and
    // reaches the same settled state.
    const again = await coordinator.arm(agent.id, 'handoff', 'manual')
    expect(again.ok).toBe(true)
    expect(coordinator.records.get(agent.id).phase).toBe('COMPLETED')
  })

  it('UT-ST-02 suppresses a second request for one session while the first is in flight', async () => {
    const world = createWorld()
    const agent = addAgent(world, new TestAgent({ id: 'session-1' }))
    let release: (() => void) | undefined
    world.migration = async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return completedAction()
    }

    const coordinator = new Coordinator({ services: world.services, settings: () => settings(), tickMs: 1 })
    const first = coordinator.arm(agent.id, 'handoff', 'manual')
    await new Promise((resolve) => setTimeout(resolve, 5))

    const second = await coordinator.arm(agent.id, 'handoff', 'manual')
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('in-flight')
    expect(second.text).toContain('已有')

    release?.()
    await expect(first).resolves.toBeTruthy()
    expect(coordinator.records.get(agent.id).phase).toBe('COMPLETED')
  })

  it('UT-ST-03 releases every latch and clears every record on unload', async () => {
    const world = createWorld()
    const agent = addAgent(world, new TestAgent({ id: 'session-1', status: 'running' }))
    world.migration = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return completedAction()
    }

    const coordinator = new Coordinator({ services: world.services, settings: () => settings(), tickMs: 1 })
    const pending = coordinator.arm(agent.id, 'handoff', 'manual')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(coordinator.latchCount).toBe(1)
    expect(coordinator.inflightCount).toBe(1)

    await coordinator.dispose()
    await pending

    expect(coordinator.latchCount).toBe(0)
    expect(coordinator.inflightCount).toBe(0)
    expect(coordinator.records.size).toBe(0)
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('refuses compaction when the deployment has no compaction service', async () => {
    const world = createWorld({ compactionAvailable: false })
    const agent = addAgent(world, new TestAgent({ id: 'session-1' }))
    const coordinator = new Coordinator({ services: world.services, settings: () => settings(), tickMs: 1 })

    const outcome = await coordinator.arm(agent.id, 'compact', 'manual')

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('compact-unsupported')
    expect(outcome.text).toContain('未安装 compaction')
    expect(coordinator.isLatched(agent.id)).toBe(false)
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('refuses a session with no live agent and never creates anything', async () => {
    const world = createWorld()
    const coordinator = new Coordinator({ services: world.services, settings: () => settings(), tickMs: 1 })

    const outcome = await coordinator.arm('missing', 'handoff', 'manual')

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('no-agent')
    expect(coordinator.records.size).toBe(0)
  })

  it('cancel only flips a flag, and a cancelled action settles as cancelled', async () => {
    const world = createWorld()
    const agent = addAgent(world, new TestAgent({ id: 'session-1', status: 'running' }))
    const coordinator = new Coordinator({ services: world.services, settings: () => settings(), tickMs: 1 })

    const pending = coordinator.arm(agent.id, 'handoff', 'manual')
    await new Promise((resolve) => setTimeout(resolve, 5))

    const cancelled = coordinator.cancel(agent.id)
    expect(cancelled.ok).toBe(true)
    expect(agent.cancel).not.toHaveBeenCalled()

    await expect(pending).resolves.toMatchObject({ ok: false })
    const record = coordinator.records.get(agent.id)
    expect(record.phase).toBe('CANCELLED')
    expect(record.stopRequested).toBe(false)
    expect(coordinator.isLatched(agent.id)).toBe(false)

    expect(coordinator.cancel(agent.id).reason).toBe('nothing-to-cancel')
  })

  it('retry re-arms the last failed action and refuses when nothing failed', async () => {
    const world = createWorld()
    const agent = addAgent(world, new TestAgent({ id: 'session-1' }))
    world.migration = async () => ({
      kind: 'handoff',
      trigger: 'manual',
      outcome: 'failed',
      startedAt: 0,
      finishedAt: 1,
      text: '会话迁移失败：测试。',
    })

    const coordinator = new Coordinator({ services: world.services, settings: () => settings(), tickMs: 1 })
    expect((await coordinator.retry(agent.id)).reason).toBe('nothing-to-retry')

    await coordinator.arm(agent.id, 'handoff', 'manual')
    expect(coordinator.records.get(agent.id).phase).toBe('FAILED')

    world.migration = async () => completedAction()
    const retried = await coordinator.retry(agent.id)
    expect(retried.ok).toBe(true)
    expect(coordinator.records.get(agent.id).phase).toBe('COMPLETED')
  })

  it('records agent errors as failure notes without disturbing the latch', async () => {
    const world = createWorld()
    const agent = addAgent(world, new TestAgent({ id: 'session-1' }))
    const coordinator = new Coordinator({ services: world.services, settings: () => settings(), tickMs: 1 })

    coordinator.records.get(agent.id)
    coordinator.noteAgentStatus(agent.id, 'running')
    coordinator.noteAgentError(agent.id, new Error('tool exploded'))

    const record = coordinator.records.get(agent.id)
    expect(record.failures.join(' ')).toContain('tool exploded')
  })

  it('arms automatically once the cumulative reading crosses the handoff threshold', async () => {
    const world = createWorld({
      usage: {
        uncachedInputTokens: 2_100_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
    const agent = addAgent(world, new TestAgent({ id: 'session-1' }))
    const migration = vi.fn(async () => completedAction())
    world.migration = migration

    const coordinator = new Coordinator({
      services: world.services,
      settings: () => settings({ autoHandoffEnabled: true, autoHandoffThreshold: 2_000_000 }),
      tickMs: 1,
    })

    coordinator.observe(agent.session, fakeEvent(1))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(migration).toHaveBeenCalledTimes(1)
    const record = coordinator.records.get(agent.id)
    expect(record.autoActions).toBe(1)
    expect(record.retired).toBe(true)
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('never evaluates the same log position twice', async () => {
    const world = createWorld({
      usage: { uncachedInputTokens: 3_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const agent = addAgent(world, new TestAgent({ id: 'session-1' }))
    const migration = vi.fn(async () => completedAction())
    world.migration = migration

    const coordinator = new Coordinator({
      services: world.services,
      settings: () => settings({ autoHandoffEnabled: true }),
      tickMs: 1,
    })

    const event = fakeEvent(7)
    coordinator.observe(agent.session, event)
    coordinator.observe(agent.session, event)
    coordinator.observe(agent.session, event)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(migration).toHaveBeenCalledTimes(1)
  })

  it('does not observe sessions whose agent is gone', () => {
    const world = createWorld({
      usage: { uncachedInputTokens: 9_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const session = createTestSession('detached')
    const coordinator = new Coordinator({
      services: world.services,
      settings: () => settings({ autoHandoffEnabled: true }),
      tickMs: 1,
    })

    coordinator.observe(session, fakeEvent(1))

    expect(coordinator.records.size).toBe(0)
  })
})
