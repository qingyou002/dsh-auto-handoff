/**
 * Mount-level integration: the real plugin object inside a real Cordis context
 * (`TASK-PLAN.md` IT-15, IT-16, and the V5 loading expectation).
 *
 * The rest of the suite drives the plugin's modules directly; this file is the
 * only place that proves the *wiring* — that `apply()` registers what it says,
 * that a settings provider is installed under the documented namespace, that
 * the HTTP channel answers, and that unloading gives every registration back.
 */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject, name } from '../../src/index.js'
import { DEFAULT_HANDOFF_SETTINGS } from '../../src/settings.js'
import { appendUserMessage, createTestSession, openTurn, TestAgent } from '../harness.js'

interface FakeRequest {
  method: string
  url: string
  socket: { remoteAddress: string }
  body?: string
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>
}

interface FakeResponse {
  status: number
  headers: Record<string, unknown>
  body: string
  writeHead(status: number, headers?: Record<string, unknown>): void
  end(chunk?: string | Buffer): void
}

function makeRequest(method: string, url: string, body?: string): FakeRequest {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  const request: FakeRequest = {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  return request
}

function makeResponse(): FakeResponse {
  const response: FakeResponse = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.status = status
      response.headers = headers ?? {}
    },
    end(chunk) {
      response.body = typeof chunk === 'string' ? chunk : (chunk?.toString('utf8') ?? '')
    },
  }
  return response
}

function provide(ctx: Context, serviceName: string, value: unknown): () => void {
  const provideFn = (ctx as unknown as { provide(name: string, value?: unknown): () => void }).provide
  return provideFn.call(ctx, serviceName, value)
}

/** Total registered event listeners across the whole context. */
function hookCount(ctx: Context): number {
  const hooks = (ctx.events as unknown as { _hooks: Record<string, unknown[]> })._hooks
  return Object.values(hooks).reduce((total, list) => total + list.length, 0)
}

function streamJson(text: string): AsyncGenerator<StreamChunk> {
  return (async function* generate() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  })()
}

interface Mounted {
  ctx: Context
  fiber: { dispose(): Promise<void> }
  agent: TestAgent
  commands: string[]
  commandDisposed: () => boolean
  routes: { path: string; handler: (req: unknown, res: unknown) => unknown }[]
  routeDisposed: () => boolean
  installed: { ns: string; entry: unknown; sourceActive: () => boolean }[]
  calls: (req: FakeRequest) => Promise<FakeResponse>
  createdIds: string[]
  invoke: (rawInput: string, signal?: AbortSignal) => Promise<{ kind: string; text: string }>
}

async function mount(
  options: { withSettings?: boolean; withWebServer?: boolean; deferSessionController?: boolean } = {},
): Promise<Mounted> {
  const ctx = new Context()

  const session = createTestSession('session-1', 'E:\\project')
  openTurn(session)
  appendUserMessage(session, '请实现 dsh-auto-handoff')
  session.append('model/selection', { provider: 'deepseek', model: 'deepseek-chat' } as never)
  const agent = new TestAgent({ id: 'session-1', session })
  const agents = new Map<string, TestAgent>([['session-1', agent]])
  let created = 0
  const createdIds: string[] = []

  const commands: string[] = []
  let commandOff = false
  let commandHandler: ((invocation: unknown) => Promise<{ kind: string; text: string }>) | undefined
  provide(ctx, 'commands', {
    register: (definition: { name: string; handler: (invocation: unknown) => Promise<{ kind: string; text: string }> }) => {
      commands.push(definition.name)
      commandHandler = definition.handler
      return () => {
        commandOff = true
      }
    },
  })
  provide(ctx, 'agents', { get: (id: string) => agents.get(id)?.asAgent(), list: () => [...agents.values()].map((a) => a.asAgent()) })
  const sessionController = {
    create: async (request: { cwd?: string }) => {
      const sessionId = `session-new-${++created}`
      createdIds.push(sessionId)
      const child = new TestAgent({ id: sessionId, session: createTestSession(sessionId, request.cwd) })
      agents.set(sessionId, child)
      return { sessionId }
    },
    selectModel: async () => undefined,
  }
  // `deferSessionController` models the real Web tree: this row injects ten
  // services, so its fiber stays PENDING long after `apply()` returned.
  if (options.deferSessionController !== true) provide(ctx, 'sessionController', sessionController)
  provide(ctx, 'llm', { stream: () => streamJson('{"goal":"完成插件","next":"写 README"}') })

  const installed: Mounted['installed'] = []
  if (options.withSettings !== false) {
    provide(ctx, 'settings', {
      installSection: (
        _owner: unknown,
        ns: string,
        _schema: unknown,
        entry: unknown,
        hooks: { setSource(next: () => unknown): void },
      ) => {
        let active = true
        installed.push({
          ns,
          entry,
          sourceActive: () => active,
        })
        hooks.setSource(() => {
          active = true
          return {
            ...DEFAULT_HANDOFF_SETTINGS,
            autoHandoffEnabled: true,
            autoHandoffThreshold: 1_000_000,
          }
        })
        void (() => {
          active = false
        })
      },
    })
  }

  const routes: { path: string; handler: (req: unknown, res: unknown) => unknown }[] = []
  let routeOff = false
  if (options.withWebServer !== false) {
    provide(ctx, 'webServer', {
      register: (route: { path: string; handler: (req: unknown, res: unknown) => unknown }) => {
        routes.push(route)
        return () => {
          routeOff = true
        }
      },
    })
  }

  const plugin = { name, inject, apply }
  // The module object is a Cordis object-plugin; the cast only bridges the
  // loader's generic `plugin()` overload set.
  const load = ctx.plugin as unknown as (value: unknown) => PromiseLike<unknown>
  const fiber = await load(plugin)
  // `ctx.plugin` settles once the plugin callback ran; the optional child
  // fibers attach on later microtasks.
  await new Promise((resolve) => setTimeout(resolve, 25))
  if (options.deferSessionController === true) provide(ctx, 'sessionController', sessionController)

  return {
    ctx,
    fiber: fiber as unknown as { dispose(): Promise<void> },
    agent,
    commands,
    commandDisposed: () => commandOff,
    routes,
    routeDisposed: () => routeOff,
    installed,
    createdIds,
    calls: async (req) => {
      const target = routes.find((route) => req.url.startsWith(route.path))
      if (target === undefined) throw new Error(`no route for ${req.url}`)
      const response = makeResponse()
      await target.handler(req, response)
      return response
    },
    invoke: async (rawInput, signal) => {
      if (commandHandler === undefined) throw new Error('handoff command was not registered')
      return commandHandler({
        commandId: 'cmd-1',
        agent: agent.asAgent(),
        rawInput,
        attachments: [],
        signal: signal ?? new AbortController().signal,
      })
    },
  }
}

/**
 * Dispatch one `agent/pre-step` waterfall through the real event service.
 *
 * The scoped `this` the Harness passes is modelled by the first argument; the
 * cast bridges the typed event map, which the test does not need.
 */
function dispatchPreStep(
  ctx: Context,
  agent: TestAgent,
  messages: unknown[],
  step: number,
): Promise<unknown> {
  const serial = ctx.serial as unknown as (
    thisArg: unknown,
    event: string,
    ...args: unknown[]
  ) => Promise<unknown>
  return serial.call(
    ctx,
    agent.asAgent(),
    'agent/pre-step',
    { agent: agent.asAgent(), messages, turn: 1, step, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages }),
  )
}

const mounted: Mounted[] = []
afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop()
    await entry?.fiber.dispose()
  }
})

describe('plugin mount (IT-15 / IT-16)', () => {
  it('registers the command, the settings section, the routes, and the listeners', async () => {
    const before = hookCount(new Context())
    const world = await mount()
    mounted.push(world)

    expect(world.commands).toEqual(['handoff'])
    expect(world.installed.map((row) => row.ns)).toEqual(['dsh-auto-handoff'])
    expect(world.installed[0]?.entry).toEqual(DEFAULT_HANDOFF_SETTINGS)
    expect(world.routes.map((route) => route.path)).toEqual(['/dsh-auto-handoff'])
    expect(hookCount(world.ctx)).toBeGreaterThan(before)
  })

  it('answers the state channel and performs a handoff over HTTP', async () => {
    const world = await mount()
    mounted.push(world)

    const initial = await world.calls(makeRequest('GET', '/dsh-auto-handoff/state?sessionId=session-1'))
    expect(initial.status).toBe(200)
    const initialPayload = JSON.parse(initial.body) as { phase: string; thresholds: { handoff: number } }
    expect(initialPayload.phase).toBe('IDLE')
    expect(initialPayload.thresholds.handoff).toBe(1_000_000)

    const handoff = await world.calls(
      makeRequest('POST', '/dsh-auto-handoff/handoff', JSON.stringify({ sessionId: 'session-1' })),
    )
    const handoffPayload = JSON.parse(handoff.body) as { ok: boolean; text: string }
    expect(handoffPayload.ok).toBe(true)
    expect(handoffPayload.text).toContain('已完成会话迁移')
    expect(world.createdIds).toEqual(['session-new-1'])

    const after = await world.calls(makeRequest('GET', '/dsh-auto-handoff/state?sessionId=session-1'))
    const afterPayload = JSON.parse(after.body) as { phase: string; retired: boolean; newSessionId: string }
    expect(afterPayload.phase).toBe('COMPLETED')
    expect(afterPayload.retired).toBe(true)
    expect(afterPayload.newSessionId).toBe('session-new-1')
    expect(world.agent.cancel).not.toHaveBeenCalled()
  })

  it('rejects a non-loopback POST and an unknown route', async () => {
    const world = await mount()
    mounted.push(world)

    const remote = makeRequest('POST', '/dsh-auto-handoff/handoff', JSON.stringify({ sessionId: 'session-1' }))
    remote.socket.remoteAddress = '10.0.0.7'
    const forbidden = await world.calls(remote)
    expect(forbidden.status).toBe(403)

    const missing = await world.calls(makeRequest('GET', '/dsh-auto-handoff/nope'))
    expect(missing.status).toBe(404)
  })

  it('IT-17 resolves a service published after apply() instead of latching it absent', async () => {
    const world = await mount({ deferSessionController: true })
    mounted.push(world)

    // The Loader composes sibling entries concurrently, so `sessionController`
    // is routinely unpublished while this plugin applies. Reading it once at
    // apply time reported a healthy deployment as "本部署未安装 sessionController".
    const handoff = await world.calls(
      makeRequest('POST', '/dsh-auto-handoff/handoff', JSON.stringify({ sessionId: 'session-1' })),
    )
    const payload = JSON.parse(handoff.body) as { ok: boolean; text: string }
    expect(payload.ok).toBe(true)
    expect(payload.text).toContain('已完成会话迁移')
    expect(world.createdIds).toEqual(['session-new-1'])
  })

  it('IT-15 returns every registration and releases every latch on unload', async () => {
    const baseline = hookCount(new Context())
    const world = await mount()
    mounted.push(world)

    // Hold a latch so the unload path has something real to release.
    const pending = world.calls(
      makeRequest('POST', '/dsh-auto-handoff/handoff', JSON.stringify({ sessionId: 'session-1' })),
    )
    world.agent.startStep()
    await new Promise((resolve) => setTimeout(resolve, 10))

    await world.fiber.dispose()
    await pending

    expect(hookCount(world.ctx)).toBe(baseline)
    expect(world.commandDisposed()).toBe(true)
    expect(world.routeDisposed()).toBe(true)
    expect(world.agent.cancel).not.toHaveBeenCalled()
  })

  it('IT-16 stays loadable with no settings provider and no web server', async () => {
    const world = await mount({ withSettings: false, withWebServer: false })
    mounted.push(world)

    expect(world.commands).toEqual(['handoff'])
    expect(world.installed).toHaveLength(0)
    expect(world.routes).toHaveLength(0)

    // The command still works: settings simply fall back to the composition
    // entry, and nothing tries to reach a state channel.
    const result = await world.invoke('status')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('会话交接状态')

    const migrated = await world.invoke('')
    expect(migrated.kind).toBe('success')
    expect(world.createdIds).toEqual(['session-new-1'])
  })

  it('IT-14d lets a human prompt through while a real latch is held', async () => {
    const world = await mount()
    mounted.push(world)

    // A running step makes the armed action wait at the boundary, so the latch
    // is genuinely held when the prompt arrives.
    world.agent.startStep()
    const pending = world.invoke('')
    await new Promise((resolve) => setTimeout(resolve, 10))

    const human = createUserMessage({
      content: [{ type: 'text', text: '再来一条人类消息' }],
      source: { kind: 'user' },
    })
    const injected = createUserMessage({
      content: [{ type: 'text', text: '内部注入' }],
      source: { kind: 'plugin', plugin: 'other' },
    })

    // A non-human claimed batch *is* held back by the real listener.
    const rejected = await dispatchPreStep(world.ctx, world.agent, [injected], 2)
    expect(rejected).toEqual({ kind: 'reject' })

    // A human prompt is never held back; the migration gives way instead.
    const decision = await dispatchPreStep(world.ctx, world.agent, [human], 3)
    expect(decision).toEqual({ kind: 'enter', messages: [human] })

    world.agent.finishStep()
    const outcome = await pending
    expect(outcome.kind).toBe('error')
    expect(outcome.text).toContain('已取消')
    expect(world.agent.cancel).not.toHaveBeenCalled()
  })

  it('drops a session record when the real session/disposed event fires', async () => {
    const world = await mount()
    mounted.push(world)

    await world.invoke('')
    const before = JSON.parse(
      (await world.calls(makeRequest('GET', '/dsh-auto-handoff/state?sessionId=session-1'))).body,
    ) as { phase: string; retired: boolean; newSessionId?: string }
    expect(before.phase).toBe('COMPLETED')
    expect(before.retired).toBe(true)
    expect(before.newSessionId).toBe('session-new-1')

    // The event bus dispatches through the real listener registered by `apply()`.
    world.ctx.emit('session/disposed', world.agent.session)

    const after = JSON.parse(
      (await world.calls(makeRequest('GET', '/dsh-auto-handoff/state?sessionId=session-1'))).body,
    ) as { phase: string; retired: boolean; newSessionId?: string; progress: string[] }
    expect(after.phase).toBe('IDLE')
    expect(after.retired).toBe(false)
    expect(after.newSessionId).toBeUndefined()
    expect(after.progress).toEqual([])
  })
})

describe('plugin manifest', () => {
  it('declares the documented loader identity', () => {
    expect(name).toBe('dsh-auto-handoff')
    expect(inject).toEqual(['commands'])
    expect(typeof apply).toBe('function')
  })
})
