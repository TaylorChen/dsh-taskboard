/**
 * Deployment defaults. Every value here is reachable from `cordis.yml` through
 * the plugin `Config`; nothing in this file is a hidden tunable.
 * @module @navidid/dsh-taskboard/src/defaults
 */

/** Write-approval stance for the board. */
export type WritePolicy = 'ask' | 'auto' | 'off'

/** Default write stance: every mutation asks a human once. */
export const DEFAULT_WRITE_POLICY: WritePolicy = 'ask'

/** Default ceiling on stored tasks; a board is a work queue, not an archive. */
export const DEFAULT_MAX_TASKS = 2000

/** Default page size for `task_list` so one call cannot flood a model request. */
export const DEFAULT_LIST_LIMIT = 50

/** Hard ceiling on records accepted from one import document. */
export const MAX_IMPORT_RECORDS = 5000

/** Default short-id prefix: keys look like `TB-1`, `TB-2`, … */
export const DEFAULT_KEY_PREFIX = 'TB'

/** Default activity entries kept per task before the oldest are trimmed. */
export const DEFAULT_ACTIVITY_RETENTION_PER_TASK = 50

/** v1.5 S1: stuck-detection thresholds, in minutes, per "waiting" status. */
export const DEFAULT_STATS_STUCK_MINUTES = {
  in_progress: 120,
  awaiting_human: 1440,
  blocked: 720,
} as const

/** Characters of task body quoted into an approval payload before truncation. */
export const APPROVAL_BODY_PREVIEW_CHARS = 300

/** Reason prefix identifying this package's approval requests. */
export const APPROVAL_PREFIX = '[dsh-taskboard]'

/** Tool name carried on approval requests (presentation and audit). */
export const APPROVAL_TOOL_NAME = 'taskboard'
