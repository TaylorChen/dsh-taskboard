/**
 * Browser half: contributes one entry to the `conversation.view` slot — the
 * board tab beside the ordinary chat view — and this package's dictionaries.
 *
 * It defines no client service and imports no other plugin's values: the panel
 * reads the host through this package's own `/api/taskboard` routes, which is
 * what keeps it inside the client bundle purity rule (cross-plugin
 * collaboration goes through cordis services, never value imports).
 * @module @navidid/dsh-taskboard/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row, declared by its owning
// package, must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TaskboardView, type TaskboardViewInjected } from './TaskboardView.tsx'
import { en, NS, zh, type TaskboardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The task board panel copy. */
    taskboard: TaskboardKey
  }
}

/** Required services: the slot registry and the locale service. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the board tab. Both
 * registrations ride the services' effect wrappers, so unloading the plugin
 * removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-taskboard: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'taskboard',
    // After the built-in chat and trajectory tabs.
    order: 20,
    locale: NS,
    label: () => t('view.taskboard'),
    inject: (): TaskboardViewInjected => ({ t }),
  }, TaskboardView))
}
