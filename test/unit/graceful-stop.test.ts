import { describe, expect, it, vi } from 'vitest'
import {
  carriesHumanPrompt,
  decidePreStep,
  isHumanPrompt,
  StopLatch,
  waitForBoundary,
} from '../../src/graceful-stop.js'
import { createTestSession, TestAgent } from '../harness.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const human = (text = '继续做这件事') =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

const plugin = (text = '继续任务') =>
  createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-auto-handoff' },
  })

const goal = () =>
  createUserMessage({ content: [{ type: 'text', text: 'goal round' }], source: { kind: 'goal' } as never })

describe('soft stop (UT-SM)', () => {
  it('UT-SM-01 lets an idle session proceed immediately', async () => {
    expect(decidePreStep({ stopRequested: false, messages: [human()] })).toEqual({
      reject: false,
      humanPrompt: true,
      reason: 'latch-clear',
    })

    const agent = new TestAgent({ session: createTestSession('idle') })
    const outcome = await waitForBoundary(agent.asAgent(), {
      slowAfterMs: 10_000,
      deadlineMs: 20_000,
      isCancelled: () => false,
      onSlow: () => undefined,
      tickMs: 1,
    })
    expect(outcome).toBe('boundary')
  })

  it('UT-SM-02 holds only a latch while a step runs, and never cancels', async () => {
    const agent = new TestAgent({ session: createTestSession('running'), status: 'running' })
    const latch = new StopLatch()
    latch.hold(agent.id)

    const waiting = waitForBoundary(agent.asAgent(), {
      slowAfterMs: 10_000,
      deadlineMs: 20_000,
      isCancelled: () => false,
      onSlow: () => undefined,
      tickMs: 1,
    })

    expect(latch.isHeld(agent.id)).toBe(true)
    expect(agent.cancel).not.toHaveBeenCalled()

    agent.finishStep()
    await expect(waiting).resolves.toBe('boundary')
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('UT-SM-03 refuses to hold back a step that carries a fresh human prompt', () => {
    const verdict = decidePreStep({ stopRequested: true, messages: [plugin(), human()] })
    expect(verdict).toEqual({ reject: false, humanPrompt: true, reason: 'human-prompt' })
  })

  it('UT-SM-04 rejects a step whose claimed batch is entirely non-human', () => {
    const messages = [plugin(), goal()]

    expect(carriesHumanPrompt(messages)).toBe(false)
    expect(messages.map(isHumanPrompt)).toEqual([false, false])
    expect(decidePreStep({ stopRequested: true, messages })).toEqual({
      reject: true,
      humanPrompt: false,
      reason: 'latch-held',
    })
  })

  it('UT-SM-05 gives up at the deadline without touching the agent', async () => {
    const agent = new TestAgent({ session: createTestSession('slow'), status: 'running' })
    const onSlow = vi.fn()
    // A clock that advances per read: the wait must end by deadline alone,
    // because this agent never becomes idle.
    let clock = 0
    const now = (): number => {
      clock += 50
      return clock
    }

    const outcome = await waitForBoundary(agent.asAgent(), {
      slowAfterMs: 100,
      deadlineMs: 300,
      isCancelled: () => false,
      onSlow,
      tickMs: 1,
      now,
    })

    expect(outcome).toBe('deadline')
    expect(onSlow).toHaveBeenCalledTimes(1)
    expect(onSlow.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(100)
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('stops waiting when the action is cancelled, still without destroying work', async () => {
    const agent = new TestAgent({ session: createTestSession('cancel'), status: 'running' })
    let cancelled = false
    const waiting = waitForBoundary(agent.asAgent(), {
      slowAfterMs: 10_000,
      deadlineMs: 20_000,
      isCancelled: () => cancelled,
      onSlow: () => undefined,
      tickMs: 1,
    })
    cancelled = true
    await expect(waiting).resolves.toBe('cancelled')
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('reports a slow boundary wait once, and keeps waiting', async () => {
    const agent = new TestAgent({ session: createTestSession('slow-warn'), status: 'running' })
    const onSlow = vi.fn()
    const waiting = waitForBoundary(agent.asAgent(), {
      slowAfterMs: 0,
      deadlineMs: 60_000,
      isCancelled: () => false,
      onSlow,
      tickMs: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    agent.finishStep()
    await expect(waiting).resolves.toBe('boundary')
    expect(onSlow).toHaveBeenCalledTimes(1)
  })

  it('releases every latch on teardown', () => {
    const latch = new StopLatch()
    latch.hold('a')
    latch.hold('b')
    expect(latch.size).toBe(2)
    expect(latch.heldIds().sort()).toEqual(['a', 'b'])
    latch.clear()
    expect(latch.size).toBe(0)
    expect(latch.isHeld('a')).toBe(false)
  })
})
