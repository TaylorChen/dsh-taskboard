/**
 * Panel copy. Registration-time text reads through the bound translate as a
 * thunk, so the view tab label follows the active locale without re-registering.
 * @module @navidid/dsh-taskboard/client/locales
 */

/** Locale namespace owned by this package. */
export const NS = 'taskboard'

/** English dictionary. */
export const en = {
  'view.taskboard': 'Board',
  'column.todo': 'To do',
  'column.in_progress': 'In progress',
  'column.in_review': 'In review',
  'column.done': 'Done',
  'column.cancelled': 'Cancelled',
  'empty': 'No tasks yet. Add one here, or ask the agent to create one.',
  'error': 'Could not load the board',
  'refresh': 'Refresh',
  'loading': 'Loading…',
  'hint': 'You create tasks here directly; the agent needs your approval to write.',
  'new': 'New task',
  'title': 'Title',
  'priority': 'Priority',
  'create': 'Create',
  'cancel': 'Cancel',
  'origin.human': 'by you',
  'origin.agent': 'by agent',
} as const

/** Chinese dictionary. */
export const zh: Record<keyof typeof en, string> = {
  'view.taskboard': '任务板',
  'column.todo': '待办',
  'column.in_progress': '进行中',
  'column.in_review': '待评审',
  'column.done': '已完成',
  'column.cancelled': '已取消',
  'empty': '还没有任务。直接在这里加一个，或者让 agent 建。',
  'error': '任务板加载失败',
  'refresh': '刷新',
  'loading': '加载中…',
  'hint': '你在这里直接建任务；agent 要写则需要你审批。',
  'new': '新建任务',
  'title': '标题',
  'priority': '优先级',
  'create': '创建',
  'cancel': '取消',
  'origin.human': '你创建',
  'origin.agent': 'agent 创建',
}

/** Dictionary key union for the locale namespace map. */
export type TaskboardKey = keyof typeof en
