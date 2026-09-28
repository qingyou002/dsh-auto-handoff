/**
 * Browser-half mount: the real client plugin object inside a real Cordis
 * context (`TASK-PLAN.md` §10.1).
 *
 * The Host half has had a mount-level test from the beginning; the browser half
 * had none, and shipped this bug: `apply()` read `ctx.settingsScope` and
 * `ctx.sessions` while the module declared only `inject = ['slots']`.
 *
 * Cordis resolves services through a proxy whose `get` trap throws
 * `cannot get property "<name>" without inject` for any service the fiber does
 * not declare — even when the service IS provided elsewhere in the graph. So
 * the bundle failed to apply at boot and the web client showed
 * "Failed to load plugins". These tests pin the declaration and the wiring.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../../src/client/index.js'
import { HandoffCard, NAMESPACE, type SettingsScopeLike, type SessionsLike } from '../../src/client/card.js'

interface SlotRegistration {
  meta: Record<string, unknown>
  component: () => unknown
}

/**
 * Provide one service from its own plugin fiber, mirroring how the real client
 * bundles do it (`ui-settings` provides `settingsScope`, the session controller
 * provides `sessions`). Providing from the root instead would hide the very bug
 * this file guards: a sibling fiber's service is only reachable through
 * `inject`, while a root-provided one resolves without it.
 */
async function provideFromPlugin(ctx: Context, serviceName: string, value: unknown): Promise<void> {
  const load = ctx.plugin as unknown as (value: unknown) => PromiseLike<unknown>
  await load({
    name: `fake-${serviceName}`,
    apply: (own: Context) => {
      const provideFn = (own as unknown as { provide(name: string, value?: unknown): () => void }).provide
      provideFn.call(own, serviceName, value)
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

interface ClientWorld {
  fiber: { dispose(): Promise<void> }
  registrations: SlotRegistration[]
  slotsInjected: string[]
  boundNamespaces: string[]
  scope: SettingsScopeLike
  sessions: SessionsLike
}

async function mountClient(
  options: { withScope?: boolean; withSessions?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ClientWorld> {
  const ctx = new Context()
  const registrations: SlotRegistration[] = []
  const slotsInjected: string[] = []
  const boundNamespaces: string[] = []

  // `apply()` reads the global `fetch` for the migration follower, which polls
  // immediately; without a stub every mount would reach the network layer with a
  // relative URL. A test that asserts on the poll installs its own spy here.
  const fetchImpl =
    options.fetchImpl ??
    (async (_url: string) => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response)
  vi.stubGlobal('fetch', fetchImpl)

  const scope: SettingsScopeLike = {
    getSnapshot: () => ({ status: 'ready', value: undefined, revision: 1, writable: true, mode: 'host' }),
    subscribe: () => () => undefined,
    set: async () => undefined,
  }
  const sessions: SessionsLike = {
    list: { getSnapshot: () => ({ current: 'session-1', byId: {} }) },
    refresh: async () => undefined,
    open: () => undefined,
  }

  await provideFromPlugin(ctx, 'slots', {
    inject: (slot: string, register: () => void) => {
      slotsInjected.push(slot)
      register()
    },
    register: (meta: Record<string, unknown>, component: () => unknown) => {
      registrations.push({ meta, component })
      return () => undefined
    },
  })
  if (options.withScope !== false) {
    await provideFromPlugin(ctx, 'settingsScope', {
      bind: (spec: { namespace: string }) => {
        boundNamespaces.push(spec.namespace)
        return scope
      },
    })
  }
  if (options.withSessions !== false) await provideFromPlugin(ctx, 'sessions', sessions)

  // The module object is a Cordis object-plugin; the cast bridges the generic
  // `plugin()` overload set, exactly as the Host-side mount test does.
  const load = ctx.plugin as unknown as (value: unknown) => PromiseLike<unknown>
  const fiber = (await load({ name, inject, apply })) as unknown as { dispose(): Promise<void> }
  await new Promise((resolve) => setTimeout(resolve, 25))

  return { fiber, registrations, slotsInjected, boundNamespaces, scope, sessions }
}

const mounted: ClientWorld[] = []
afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.fiber.dispose()
  vi.unstubAllGlobals()
})

describe('browser half mount', () => {
  it('applies and registers the settings card when its services are active', async () => {
    const world = await mountClient()
    mounted.push(world)

    expect(world.slotsInjected).toEqual(['settings.plugin.item'])
    expect(world.registrations.map((row) => row.meta)).toEqual([
      { name: 'settings.plugin.item', key: NAMESPACE },
    ])
    // The scope is bound to the documented namespace, and the card really gets
    // the live services — not the degraded `undefined` path.
    expect(world.boundNamespaces).toEqual([NAMESPACE])
    const element = world.registrations[0]?.component() as {
      type: unknown
      props: { scope?: unknown; sessions?: unknown }
    }
    expect(element.type).toBe(HandoffCard)
    expect(element.props.scope).toBe(world.scope)
    expect(element.props.sessions).toBe(world.sessions)
  })

  it('starts the migration follower from apply(), without any card being mounted', async () => {
    // The switch after `/handoff` used to live in the settings card, so it only
    // ran while the settings tab happened to be open — which is never the case
    // for a `/handoff` typed in the chat. The follower must poll host state from
    // `apply()`, before (and without) any component rendering.
    const poll = vi.fn(async (_url: string) => ({ ok: false, status: 503, json: async () => ({}) }))

    const world = await mountClient({ fetchImpl: poll as unknown as typeof fetch })
    mounted.push(world)

    expect(world.registrations).toHaveLength(1)
    // The registration is a thunk; nothing has rendered it.
    expect(poll).toHaveBeenCalled()
    expect(String(poll.mock.calls[0]?.[0])).toBe('/dsh-auto-handoff/state?sessionId=session-1')
  })

  it('declares every service apply() reads, so the bundle can boot', () => {
    expect([...inject].sort()).toEqual(['sessions', 'settingsScope', 'slots'])
  })

  it('stays inert instead of throwing when a declared service never appears', async () => {
    const world = await mountClient({ withSessions: false })
    mounted.push(world)

    expect(world.registrations).toEqual([])
  })
})
