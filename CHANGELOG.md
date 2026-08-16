# Changelog

All notable changes to `@navidid/dsh-taskboard` are recorded here.
Versions follow [SemVer](https://semver.org/); the storage layer has no
migration path, so every breaking change ships with a migration note.

## [0.6.0] — 2025-08-17

Verification loop (ROADMAP L3): "completed" now means "completed with evidence".

### Added

- **Structured evidence**: the auto-claim dispatch gives the subagent an
  `outputSchema` and requires a report of `criteria` (per-criterion
  self-assessment), `artifacts`, and `summary`; the settled task stores it in a
  new additive `evidence` field.
- **No half-evidence**: a `completed` run without a valid structured report
  settles as `blocked`, never storing partial evidence.
- **Failure diagnosis**: an `error` settlement carries the tail of the child's
  output in `evidence.summary` alongside a readable `blockedReason`.
- **Panel**: `awaiting_human` cards show the evidence (✓/✗ per criterion,
  artifacts, summary) with 确认完成 (→ done) and 打回待立项 (→ draft) actions.
- Real E2E (`tests/e2e/evidence-loop.mjs`): subagent produced a structured
  report (met=true with note), task settled to `awaiting_human` with evidence.

### Migration

None — additive `evidence` field.

## [0.5.0] — 2025-08-17

Task specs (ROADMAP L2): the board stops being a tracker of intentions and
starts gating executability.

### Added

- **`spec` block** on every task: `acceptanceCriteria` (the hard gate),
  `contextRefs` (soft hint), `definitionOfDone` (optional). Additive field —
  v0.4 records read back with `spec: null`.
- **`draft` means "spec incomplete"**: a `create` asking for `open` without
  acceptance criteria lands in `draft`; an `update` may only *transition into*
  `open` with a complete spec (pre-v0.5 `open` tasks are not re-gated). Spec
  updates are partial merges.
- **Tools**: `task_create` / `task_update` accept `acceptance_criteria` /
  `context_refs` / `definition_of_done`; `task_list` renders the criteria.
- **Dispatch**: the auto-claim subagent prompt quotes the acceptance criteria
  to verify against, and the fallback follow-up does the same.
- **Panel**: draft cards show "缺少验收标准" (hard) and a context-ref hint
  (soft); non-draft cards with criteria show them.
- Real E2E (`tests/e2e/spec-gate.mjs`): model creates without criteria →
  `draft`; adds criteria + `open`; auto-claim dispatches a subagent that
  settles to `awaiting_human`.

### Migration

None — additive, no schema change to stored shape (new optional field).

## [0.4.0] — 2025-08-16

Workspace binding and subagent execution: the board's "organizing layer"
semantics close the two gaps left by v0.3.

### Added

- **Workspace binding (W1).** `create`, `task_claim` and auto-claim bind an
  unbound task to the workspace owning the session's cwd, when the optional
  `ctx.workspaceRegistry` seam is mounted (web profile); an explicit
  `workspaceId` wins, a bound task is never rebound, and headless deployments
  (no seam) keep the pre-v0.4 board-global behaviour. Auto-claim scopes its
  scan to the session's workspace plus unbound tasks. The panel shows the
  workspace name on bound cards; `/board` serves the workspace list.
- **Subagent execution (W2).** A claimed task is dispatched to a background
  subagent (independent child session) whose prompt names the task and tells
  it not to touch the board; `run.result` settles the task — `completed` →
  `awaiting_human`, `error` → `blocked` + reason. Activity stream gains
  `dispatched` / `completed` entries. A human-moved task is never overwritten;
  the `in_progress` state is the double-dispatch guard. Falls back to the
  v0.3 follow-up turn when the subagent seam is unavailable.

### Migration

None — additive: no schema change (the activity action enum gained two values,
which is backwards-compatible), no status change. The auto-claim row still
ships disabled.

## [0.3.0] — 2025-08-16

The board can hand work to an idle agent by itself, bound to token quota.

### Added

- **Auto-claim driver** (`taskboard-autoclaim` row, `src/autoclaim.ts`): when
  an agent session goes idle, claim the oldest unclaimed `open` task and wake
  the agent with a follow-up turn — only when
  `contextWindow − currentTokens ≥ minRemainingTokens` (quota signal from
  `agent.session.requestContext()` + `ctx.tokenMeter.measure()`, per the
  research recorded in ARCHITECTURE decision 26).
- **`TaskboardService.autoClaim`**: the automation claim write, serialized so
  two idle agents cannot both claim one task; records a `claimed` activity
  entry; refuses under `writePolicy: 'off'`.
- **Disabled by default**: the bundle patch mounts the row with
  `disabled: true` — opt in via your overlay (`disabled: false` +
  `minRemainingTokens`).

### Migration

None — this version is additive: no schema change, no status change. The new
row ships disabled, so upgrading a v0.2 board changes nothing until you enable
auto-claim.

## [0.2.0] — 2025-08-16

The board becomes agent-native: the status machine is reorganised around
"whose turn it is", tasks get human-readable short ids, every change lands in
an activity stream, and the panel can jump into the session that claimed a
task.

### Breaking changes

- **Status values changed.** `todo` → `open`, `in_review` → `awaiting_human`;
  `draft` and `blocked` are new. Old values are normalized on read (the legacy
  alias stays until v1.0), so a v0.1 board opens unchanged — but **export
  before upgrading**: after v0.2 writes to a board, rolling back to v0.1 would
  make the normalized records fail to parse.
- **`task_update` into `blocked` now requires a reason.** Use the new
  `task_block` tool; the panel does not offer `blocked` as a move target.
- **`task_list` / `task_create` / `task_update` / `task_claim` / `task_block`
  reference tasks by short key (`TB-1`).** The full id still works everywhere;
  the model no longer sees UUIDs.

### Added

- Seven-column status machine (`draft` / `open` / `in_progress` /
  `awaiting_human` / `blocked` / `done` / `cancelled`).
- `task_block(id, reason)` model tool; `blockedReason` on the task, cleared on
  leaving `blocked`.
- Short ids: `key` (`TB-1`), minted from a board-global counter, unique,
  never reused; v0.1 boards are backfilled once at the first mount.
- Activity stream: one entry per successful write (create / status / blocked /
  claimed / edited / removed), humans and agents in the same format, trimmed to
  `activityRetentionPerTask` (default 50) oldest-first.
- `GET /api/taskboard/task/<id|key>/activity`.
- Panel: per-column `+` create, blocked column warning tint + reason, activity
  drawer, claimed-session display with "open in conversation" jump
  (`ctx.sessions.open`, no page reload).
- `Config.keyPrefix` (default `TB`) and `Config.activityRetentionPerTask`
  (default `50`).

### Migration

1. `dsh plugin --profile web update @navidid/dsh-taskboard` (or re-add the
   package at 0.2.0).
2. Optionally export first (`/task export` or `GET /api/taskboard/export`) if
   you want the ability to roll back to v0.1.
3. First mount backfills keys and normalizes statuses; subsequent mounts are
   no-ops.

## [0.1.0] — 2025-08-15

Cross-session, workspace-scoped task board for DeepSeek Harness: `ctx.taskboard`
service + storage-domain provider + five model tools + `/task` commands + JSON
API + five-column panel. Approval gate for every model write, optimistic
concurrency via `revision`, export/import, cross-site-protected write routes.
