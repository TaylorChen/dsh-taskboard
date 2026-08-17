# Changelog

All notable changes to `@navidid/dsh-taskboard` are recorded here.
Versions follow [SemVer](https://semver.org/); the storage layer has no
migration path, so every breaking change ships with a migration note.

## [1.4.2] — 2025-08-17

Create and edit now share ONE task-form modal — the same fields, create starts
empty.

### Changed

- **Unified task form**: the inline per-column composer (title + priority
  only) is gone. The `+` on any column opens the same centered modal as 编辑,
  with empty fields, the target column set by the column clicked (blocked's
  `+` creates into draft — blocked is an agent report and needs a reason), and
  the header showing 新建任务 · <column> plus where it will land (the focused
  project, or the board default).
- Create now carries the full field set the server already accepted — body,
  priority, executor, `due_at` — so a task created from the panel is as rich
  as one created from a tool.
- Edit behaviour unchanged: PATCH with `expectedRevision` (a racing change
  stays a 409).

### Migration

None — panel-only change.

## [1.4.1] — 2025-08-17

Task editing moved out of the card into a centered modal (a 160px column is no
place for a form).

### Changed

- **Edit modal**: the card's inline editor is replaced by a centered 520px
  modal (glass styling, `role="dialog"` + `aria-modal`) with a semi-transparent
  backdrop; header shows 编辑 <key> plus project · status; the description
  textarea grows to six rows. Backdrop click or Escape closes; saving keeps
  the `expectedRevision` optimistic-concurrency guard (a racing change stays a
  409).

### Migration

None — panel-only change.

## [1.4.0] — 2025-08-17

Board usability (from the v1.4 plan): projects get focus, the board gets a
glance line, and a column's order becomes controllable.

### Added

- **Project focus (E1)**: the panel's project dropdown filters
  `/board?project=<id>`; composes with the archive view.
- **Glance stats (E2)**: a stats strip under the header — total, open,
  in-progress, 等你 (awaiting_human + blocked in warning colour), overdue
  (dueAt past, excluding done/cancelled), done — all derived from the loaded
  board, no new endpoint.
- **Drag to reorder (E3)**: `sortOrder` (additive, default null) ranks a
  column's tasks; `list()` serves ranked-first order so storage order IS the
  manual order. `reorder(refs)` pins a WHOLE column (partial batches are
  refused — they would silently demote the rest) and unranks the others. The
  panel drags cards (HTML5 DnD, 全部项目 view) and POSTs the column's full id
  list; while dragging, the column renders in storage order so the v1.2
  overdue float never leaks into `sortOrder`. New route `POST
  /api/taskboard/reorder`.
- Real E2E (`tests/e2e/v14-http.mjs`): project filter + composition, reorder
  round-trip served by `/board`, restore, partial reorder refused.

### Migration

None — additive `sortOrder` field with `.default(null)`; reorder is
opt-in by construction (unranked tasks keep recency order).

## [1.3.0] — 2025-08-17

Experience (from the v1.3 plan): cross-process writes stop silently losing
data, and the panel gains the four exits that were missing.

### Added

- **Cross-process write safety (C2)**: the store's write guard re-reads the
  JSON unit file before every durable write and refuses with
  `concurrent-modification` (HTTP 409) when another process rewrote it —
  stale-snapshot writes are detected, not silently clobbered (short-id
  counter races included). Medium records are normalized through the domain
  schemas (`.default()` fields), and fingerprints sort by canonical record
  rather than table key, so a schema-normalized snapshot compares equal to a
  raw older file. Guard is off when there is no readable JSON medium.
- **Archive view (D1)**: the panel's 只看归档 toggle loads
  `/board?archived=true`; archived cards get 恢复 — archiving is a round-trip.
- **Card editing (D2)**: an inline editor on every card changes title, body,
  priority, executor, and deadline, saved with `expectedRevision` (a racing
  change is a 409, not a clobber).
- **One-click unblock (D3)**: a blocked card gets 解除阻碍 (back to open).
- **Archive all done (D4)**: `POST /api/taskboard/archive-done` sweeps the
  done column; the done column's 归档全部 button (two-step confirm) calls it.
- Real E2E: `tests/e2e/v13-c2.mjs` (service-level: stale write refused,
  restored write lands) and `tests/e2e/v13-http.mjs` (route-level: archive
  sweep, archived view + restore, edit PATCH, 409 on a hand-edited medium).

### Migration

None — additive (`dsh-home-paths` dependency, new route, panel additions); the
write guard is off by construction when there is no readable JSON medium.

## [1.2.0] — 2025-08-17

Governance (from the v1.2 plan): the board will fill up, the ball will wait on
a person, and cost can run away — these three get an exit.

### Added

- **Soft archive (C1)**: `archivedAt` stamp on done tasks; `list()` and
  `/board` exclude archived by default, `?archived=true` queries the archive,
  `archive(ref, archived)` archives and restores, `archiveAllDone()` sweeps the
  done column. Only `done` tasks archive; export keeps archived tasks (an
  archive is never a deletion). The done card gets an **归档** button.
- **Ball-to-human highlight (B3)**: `awaiting_human`/`blocked` column counts
  render in warning colour and bold; cards waiting on a human wear the warning
  accent; overdue cards float to the top of their column (panel-side sort,
  storage order untouched).
- **Context budget (B2)**: `context_budget_tokens` caps the dispatched
  subagent's INPUT context; at dispatch the driver estimates the prompt cost
  (`estimateInputTokens = ceil(chars/4)`, a deliberate ceiling) and refuses —
  settling the task `blocked` with the estimate in the diagnosis — instead of
  launching a doomed run. Tools and routes pass `context_budget_tokens`
  through.
- Real E2E (`tests/e2e/v12-governance.mjs`): archived task leaves the active
  board and restores; an over-budget task settles blocked with no subagent
  ever registered.

### Migration

None — additive fields (`archivedAt`, `contextBudgetTokens`) with `.default()`,
plus panel-side sorting.

## [0.8.0] — 2025-08-17

Knowledge layer (ROADMAP L5): the board's history stops being an archive and
starts feeding the next task.

### Added

- **Experience cards**: `relatedExperience` projects done tasks (with evidence
  summaries) into `{ key, title, criteria, artifacts, summary }`, newest first,
  filterable by project / workspace / label. No schema change — the cards are
  derived from what tasks already carry.
- **Create-time injection**: `task_create`'s result lists up to three related
  completed tasks ("Related experience"), so the model can reuse prior
  conclusions instead of exploring from scratch.
- **Session context** (opt-in, off by default): `sessionContext: true` on the
  auto-claim row injects a bounded digest of open work + related experience
  into a new session's first turn via `agent.inject` (no wake).
- Real E2E (`tests/e2e/experience-feed.mjs`): the session log carries the
  injected digest and the create result references the seeded experience.

### Migration

None — additive config only; the digest is opt-in.

## [1.1.0] — 2025-08-17

Stop-loss and closure (from the v1.1 plan).

### Added

- **Dispatch cancel**: moving a dispatched task out of `in_progress` (human
  takeover) stops the subagent (`domain/changed` listener + `run.dispose`);
  a late child result never double-settles.
- **Dispatch timeout**: `Config.dispatchTimeoutMs` (default 30 min) disposes an
  over-running child and settles the task `blocked` with a timeout reason.
- **Execution visibility**: the board route carries `executions` and the panel
  shows an in-progress card's running subagent + elapsed minutes.
- **Bounce reasons**: 打回待立项 requires a reason, written to the notes and
  the activity stream.
- Real E2E (`tests/e2e/cancel-stop.mjs`): dispatch visible via `executionOf`,
  human takeover clears it, task stays done through the settle window.

### Migration

None — additive config (`dispatchTimeoutMs`) and read-only surfaces.

## [1.0.0] — 2025-08-17

First stable release. The agent-native task board has been verified end to end
across nine iterations (v0.1–v0.9): the execution layer (state machine, short
ids, activity stream, approval gate), the spec layer (acceptance criteria as
the gate to `open`), the verification loop (structured evidence, no
half-evidence, failure diagnosis), scheduling (dependencies, weighted
candidates, token budgets), the knowledge layer (experience cards, session
context), and the v0.9 intent fields (`executor`, `dueAt`, append-only
`notes`).

No schema or behaviour changes from v0.9.1 — this tag marks the
open-source-ready baseline: 91 unit/integration tests, 8 real E2E scripts, a
34-check route matrix, and a clean sensitive-information audit. Documentation
covers a 5-minute quick start, a consolidated tool-parameter reference, a
common-questions FAQ, and where the board data lives ($DSH_HOME/storages/
taskboard.json, in-place upgrades, backup guidance).

## [0.9.1] — 2025-08-17

Settlement-callback hardening (found by the full v0.9 E2E).

### Fixed

- The auto-claim dispatch's settle callback ran `ctx.taskboard` reads after
  the app began closing (a child settling post-shutdown), throwing a
  synchronous "inactive context" error that became an unhandled promise
  rejection and could kill the process. The whole settle path is now an
  async-guarded callback: a failed settle is a logged warning, never a crash.
- Added `tests/e2e/v09-full.mjs`: one real-process E2E covering executor
  filtering, dueAt scheduling, and a model-appended note (with a `noted`
  activity entry) — all passing.

## [0.9.0] — 2025-08-17

Executor intent, deadlines, and append-only notes.

### Added

- **`executor`** (`agent` / `human` / `any`, default `any`): `human` tasks are
  never picked up by auto-claim — the board stops auto-assigning work that
  needs a person.
- **`dueAt`** (nullable): a planned-deadline scheduling signal; auto-claim
  prefers earlier deadlines (after priority, before age); the panel flags
  overdue tasks. Deliberately not an estimate — no planned-start field.
- **`notes`** (append-only): `note` on `task_update` appends (never
  overwrites) and records a `noted` activity entry; cards show the latest
  notes.
- Routes and tools expose all three (`executor`, `due_at`, `note`/`notes`).
- Real E2E (`tests/e2e/executor-gate.mjs`): a `human` task stays unclaimed
  while an `agent` task is auto-claimed. Route matrix extended to 34 checks,
  all passing.

### Migration

None — additive fields.

## [0.7.1] — 2025-08-17

Route/tool exposure fix for v0.7 fields (found by the route verification
matrix).

### Fixed

- `depends_on` / `budget_tokens` were implemented in the service but never
  exposed: `POST|PATCH /api/taskboard/task` ignored them, and the
  `task_create` / `task_update` tools had no parameters. Both surfaces now
  pass them through; the cycle rejection (`PATCH depends_on` with a
  self-reference -> 400) is reachable over HTTP.
- Added `tests/e2e/route-matrix.sh`: a 25-check curl matrix over a clean web
  instance covering the v0.5–v0.8 fields, migrations, guards, reads, and the
  CSRF 415 — all passing.

## [0.7.0] — 2025-08-17

Dependencies and scheduling (ROADMAP L4): auto-claim stops picking the oldest
task and starts picking the right one.

### Added

- **`dependsOn`** prerequisites (additive): a task is claimable only when every
  dependency is `done` or `cancelled`; cycles are rejected at write time; an
  unresolvable dependency is kept (parks the task in not-ready) rather than
  dropped.
- **Weighted candidates**: auto-claim picks the highest-priority ready task
  (urgent → low, then oldest `createdAt`).
- **`budgetTokens`** (additive, task-level): caps the dispatched subagent's
  output via `maxTokens`; a `max-tokens` stop reason settles `blocked` with a
  budget-overrun reason.
- Real E2E (`tests/e2e/dependency-gate.mjs`): with B unfinished, A (depends on
  B) stays unclaimed while B is claimed; after B is confirmed done, the next
  idle event claims A.

### Migration

None — additive fields (`dependsOn`, `budgetTokens`).

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
