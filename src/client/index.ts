/**
 * Browser half of `dsh-auto-handoff`.
 *
 * The Host registers the `dsh-auto-handoff` settings namespace; this half
 * registers the matching card under the same key in the `settings.plugin.item`
 * slot, which is the seat the plugin configuration tab dispatches
 * (`TASK-PLAN.md` §10.1), and starts the always-on migration follower (§10.4).
 *
 * `inject` must list every service `apply()` reads. Cordis resolves services
 * through a proxy whose `get` trap throws
 * `cannot get property "<name>" without inject` for any service the fiber does
 * not declare — even when the provider IS active in the same graph. A sibling
 * bundle provides each one (`slots` ← ui-slots, `settingsScope` ← ui-settings,
 * `sessions` ← the session controller), so the boot order is not ours to
 * assume; declaring them lets Cordis start the fiber only once all three are
 * live, which is also what `settingsScope.bind()` needs (it hangs its disposer
 * on the calling fiber). The card still degrades on its own when the Host does
 * not expose this namespace.
 */
import { createElement as h } from 'react'
import { HandoffCard } from './card.js'
import { startHandoffFollower } from './follow.js'
import { NAMESPACE, type SessionsLike, type SettingsScopeLike } from './protocol.js'

/** Loader diagnostic name; matches the Host half. */
export const name = 'dsh-auto-handoff'

/** Every service `apply()` reads; see the module doc for why all are declared. */
export const inject = ['slots', 'settingsScope', 'sessions']

/** The client context surface this bundle touches, kept structural on purpose. */
export interface HandoffClientContext {
  effect(callback: () => void | (() => void), label?: string): void
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component: () => unknown): unknown
  }
  settingsScope: { bind<T>(spec: { namespace: string }): T }
  sessions: SessionsLike
}

/**
 * Register the plugin card and start the migration follower.
 *
 * @param ctx - the browser plugin context; `inject` guarantees every service
 *   read below is active.
 */
export function apply(ctx: HandoffClientContext): void {
  const slots = ctx.slots
  const sessions = ctx.sessions

  // The follower runs for the whole page, not for one mounted component: it is
  // what navigates after a `/handoff` typed in the chat.
  ctx.effect(() => {
    const follower = startHandoffFollower({
      sessions,
      fetchImpl: typeof fetch === 'function' ? fetch.bind(globalThis) : undefined,
      onError: (message) => console.warn(`[dsh-auto-handoff] 自动切换轮询失败：${message}`),
    })
    return () => follower.stop()
  }, 'dsh-auto-handoff: handoff follower')

  if (slots === undefined) {
    console.warn('[dsh-auto-handoff] slots 服务不可用，设置卡未注册。')
    return
  }

  const scope = ctx.settingsScope.bind<SettingsScopeLike>({ namespace: NAMESPACE })

  ctx.effect(() => {
    slots.inject('settings.plugin.item', () =>
      slots.register({ name: 'settings.plugin.item', key: NAMESPACE }, () =>
        h(HandoffCard, { scope, sessions }),
      ),
    )
  }, 'dsh-auto-handoff: settings card')
}

export default { name, inject, apply }
