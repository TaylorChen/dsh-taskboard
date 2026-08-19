/**
 * Browser half: contributes one entry to the `conversation.view` slot — the
 * board tab beside the ordinary chat view — and this package's dictionaries.
 *
 * It defines no client service and imports no other plugin's values: the panel
 * reads the host through this package's own `/api/taskboard` routes, which is
 * what keeps it inside the client bundle purity rule (cross-plugin
 * collaboration goes through cordis services, never value imports). The one
 * cross-service call — jumping into a task's claiming session (W4) — goes
 * through the injected `sessions` cordis service (`ctx.sessions.open`, the
 * official session-switch API found by Spike S2), not through DOM or history.
 * @module @navidid/dsh-taskboard/client
 */

import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row, declared by its owning
// package, must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TaskboardView, type TaskboardViewInjected } from './TaskboardView.tsx'
import { resolveOpenableTarget } from './session.ts'
import { en, NS, zh, type TaskboardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The task board panel copy. */
    taskboard: TaskboardKey
  }
}

/** Required services: the slot registry, the locale service, and the sessions
 * service (for the "open in conversation" jump). */
export const inject = ['slots', 'locale', 'sessions']

/**
 * Client plugin body: register the dictionaries and the board tab. Both
 * registrations ride the services' effect wrappers, so unloading the plugin
 * removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-taskboard: dictionaries')
  const t = ctx.locale.bind(NS)
  // `sessions` is declared twice on the cordis Context: the host-side
  // dsh-session augmentation types it as SessionStore, the client runtime as
  // ISessions. In a mixed server+client typecheck the host one wins, so the
  // client face is recovered through its exported type. At runtime the client
  // runtime's sessions service is what is mounted.
  const sessions = ctx.sessions as unknown as ISessions
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'taskboard',
    // After the built-in chat and trajectory tabs.
    order: 20,
    locale: NS,
    label: () => t('view.taskboard'),
    inject: (): TaskboardViewInjected => ({
      t,
      sessions: {
        // The stored session id on a task is a plain string; the sessions
        // service expects its branded SessionId, so the brand is applied at
        // this one boundary. Liveness is checked against `byId` (host rows +
        // the current addressed subagent route) rather than `ids` (host list
        // order only, breadcrumb rows excluded): `open` accepts any listed or
        // retained catalog address, and a deleted session is absent from both.
        // v1.10 A-session: the jump must land on a session the sidebar can
        // show (`ids` = top-level rows). A claiming session that is a
        // subagent resolves to its parent; an id with no openable target is
        // treated as missing so the card shows the degraded hint instead of
        // a click that does nothing.
        open: (id: string) => {
          const snapshot = sessions.list.getSnapshot()
          const target = resolveOpenableTarget(id, snapshot.byId[id as SessionId], new Set(snapshot.ids))
          if (target !== null) sessions.open(target as SessionId)
        },
        exists: (id: string) => {
          const snapshot = sessions.list.getSnapshot()
          return resolveOpenableTarget(id, snapshot.byId[id as SessionId], new Set(snapshot.ids)) !== null
        },
      },
    }),
  }, TaskboardView))
}
