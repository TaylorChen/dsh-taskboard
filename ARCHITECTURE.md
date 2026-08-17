# ARCHITECTURE

Design of `@navidid/dsh-taskboard`: the three-role seam, the row split, and the
reason behind each decision that was not forced.

## The seam

```
┌────────────────────────────────────────────────────────────────────────┐
│ Consumer: task_* tools        Consumer: /task commands   Consumer: API │
│ (src/tool.ts, own row)        (src/commands.ts)          (src/routes)  │
│  write via the service         read-only (v1)             read + write │
└───────────────┬────────────────────────────────────────────────────────┘
                │ create / update / remove / importDocument
                ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Service Definition: ctx.taskboard  (src/service.ts)                    │
│   reads  → synchronous, straight from provider memory                  │
│   writes → gate() ─▶ ctx.approval.request ─▶ revision recheck ─▶ store │
│   THE GATE IS HERE. No other file in this package may write.           │
└───────────────┬────────────────────────────────────────────────────────┘
                │ TaskboardStore (src/store.ts — the only Domain consumer)
                ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Provider: ctx.storageDomain, domain `taskboard` v1 (src/domain.ts)     │
│   tables: tasks, projects · zod-validated at the durable boundary      │
│   writes serialize on the domain's own chain; domain/changed emitted   │
└────────────────────────────────────────────────────────────────────────┘
```

## Decisions

**1. The approval gate is inside the service's write methods, not in the tools.**
A gate in a tool's `execute` only covers callers that go through that tool.
`ctx.taskboard` is a public service: another plugin can call `create()` directly.
Putting the gate at the capability boundary means every path — tools, commands,
third-party plugins — is covered by construction.

**2. Approval payloads carry the complete change.** `create` quotes the title and
a bounded body preview; `update` quotes `from:` / `to:` renderings of both
versions; `remove` quotes the whole task. A human approves a concrete change, not
the word "update". Free text is bounded at 300 characters so one task cannot
flood the approval surface.

**3. The revision guard is rechecked after approval, not only before.** A human
may take a minute to answer, and another session may write in that window. The
pre-check avoids disturbing anyone over a conflict already visible; the recheck
at commit time is the authoritative one. Same shape as the capacity check.

**4. Approval unavailable is a refusal, never a silent allow.** The approval seam
requires an open turn so its `approval/asked` + `approval/decided` audit pair
stays inside one. A caller between turns makes `request()` throw; `gate()`
converts that to `write-denied` rather than falling through to a write. This is
why an AGENT write cannot originate between turns. It does not constrain a
human write: see decision 15.

**5. Provider types stop at `src/store.ts`.** The storage-domain design note is
still `proposed/` upstream — the API may change. `Domain` and `KvTable` are named
in exactly one file; the service and every consumer see `TaskboardStore`, `Task`,
and `Project`. A seam change costs one adapter.

**6. Four entries, one per host capability — but a missing service is a boot
failure, not an inert row.** `.` needs `storageDomain`, `/tool` needs the tool
registry, `/routes` needs `webServer`, `/invariant` needs `invariants`. Splitting
them keeps each row's dependency honest and lets a deployment disable one half
(a human-only board = drop the tool row) without patching the others.

What the split does **not** buy is graceful degradation. The first design here
assumed a row whose service is absent would simply never activate; booting into
a headless profile disproved it:

```
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
@navidid/dsh-taskboard/routes: pending (waiting for service: webServer)
```

dsh treats a permanently pending row as a misconfiguration and stops startup.
That is the right call — a half-mounted plugin is worse than a refusal — so the
bundle documents the web-app requirement and gives headless deployments an
explicit overlay (`- id: taskboard-routes` / `disabled: true` plus the storage
rows) rather than pretending the rows are optional.

**7. No `global` slot in the domain.** Every piece of state belongs to a task or a
project. A global would be one more thing to validate, version, and migrate.
Aggregates a UI wants (per-column counts) are derived from the tables.

> **v0.2 amendment.** Decision 7 was deliberately reversed for one slot: the
> short-id counter (`{ nextTaskNumber }`) is board-global by nature — it is not
> an aggregate of the tables, it is the sequence the tables draw from. Spike S1
> (decision 18) verified that adding the slot does not strand v0.1 mediums, so
> the reversal is free. Everything else stays derived.

**8. Export/import ships in v1 rather than v2.** The storage layer rejects a
medium whose stamped version differs from the declared one, with no migration —
the pre-release stance. Without an export, the first `version: 2` would strand
every existing board. The document carries an explicit `dsh-taskboard-export-v1`
marker and a record ceiling, and an unknown schema is rejected loudly rather than
guessed at.

**9. Seeding the first project bypasses the gate, deliberately.** `create`
requires a project to exist, so an empty board is seeded with one at mount.
There is nothing for a human to decide about an empty board's first container,
and asking during `apply` would block the mount behind a UI that may not exist
yet. This is the only write in the package that does not pass `gate()`, and it
can only ever run once per medium.

**10. Config over constants.** Everything a deployment might reasonably vary —
write stance, ceilings, page size, seed name — is a validated `Config` field
reachable from `cordis.yml`. The values in `src/defaults.ts` are the schema's
defaults, not hidden tunables. Protocol constants (the export schema marker, the
approval reason prefix) stay fixed.

**11. An optional service is `ctx.inject([...], cb)`, never a guarded property
read.** `commands` is optional: a composition without it should simply get no
slash commands. The obvious shape —

```ts
const commands = (ctx as { commands?: CommandRegistry }).commands
if (commands === undefined) return                    // WRONG
```

— typechecks and then throws at boot: `cannot get property "commands" without
inject`. Cordis rejects a property read for a service the fiber did not inject
rather than returning `undefined`, so a TypeScript optional buys nothing. The
working shape is `ctx.inject(['commands'], scoped => …)`, which runs the callback
in a sub-fiber once the service exists and never runs it otherwise. Found by
booting, not by typechecking — the type system cannot see this.

**12. `output.render` is the model's only view — ids are never abbreviated
there.** `task_list` first rendered `t.id.slice(0, 8)`, which reads fine to a
human. A real model turn then did exactly what the text invited: it called
`task_update` with the 8-character prefix and got

```
Error: task 'a6ca77a5' does not exist
```

The canonical value carried the full id the whole time, but the canonical value
never reaches the model — `render` produces the content blocks, and those are
the model's entire view of the result. Any identifier a later tool call needs
must therefore appear in full in the rendered text. A UI that wants a short id
truncates in its own `presentResult`, where truncation costs nothing.

The general rule: a tool's rendered text is an interface for the *next* tool
call, not a status line. Design it as one.

**v0.2 makes the fix structural instead of cosmetic — see decision 20: the
rendered identifier IS the canonical short key, so there is nothing left to
truncate.**

**18. Spike S1: adding a `global` slot and an `activity` table does not reject a
v0.1 medium — plan A, no bump.** The v0.2 spec adds a `global` slot and the
`activity` table while keeping `DOMAIN_VERSION = 1`. The spike opened a real
v0.1-written `taskboard.json` (three tasks: two `todo`, one `in_progress`)
against the v0.2 spec through the real `dsh-storage-json` backend and the real
domain layer:

- The JSON backend's `parse` validates only `unit.name` and `unit.version`
  against the stored header. `hasGlobal` and the `tables` list are NOT part of
  the medium's stamped identity; a table missing from the medium is initialized
  empty on load. So the descriptor change is invisible to the backend.
- The domain layer's open validates every stored record against the new zod
  schemas, which is where the v0.2 changes live: `todo`/`in_review` normalize
  through `LEGACY_STATUS`, `origin`/`blockedReason` default, `key` is optional.
  All three v0.1 records parsed.
- The `global` slot serves `initial: { nextTaskNumber: 1 }` when the medium
  holds none, and the first write materializes it alongside the `activity`
  table.

Conclusion recorded here so the next person does not re-run the spike: **plan A
works, no `malformed-medium` risk.** The risk this spike was meant to retire is
gone because the storage layer's unit identity is `name + version`, nothing
more.

**19. The `key` backfill is the package's SECOND write that does not pass
`gate()`.** `key` cannot carry a `default` (each value must be unique), so v0.1
records have none. `apply()` calls `service.backfillKeys()` at mount, which
numbers keyless records in `createdAt` order and advances the counter past
them. It is idempotent — a later mount finds nothing to write — and it runs
before the seed-project check, so a board that needs both gets keys first. It
sits next to the seed in the same status: a plugin-owned bootstrap write that
is neither a user nor a model write, so there is no second party to approve.
Unlike the seed it is not "once per medium" but "once per keyless record",
which is why it must be re-runnable rather than guarded by a flag.

**20. `key` is the identifier layer; `id` stays the primary key.** `TB-1` can
be spoken, referenced in 3 model tokens, pasted into a commit message — a UUID
cannot. Every lookup entry point (`task_update`, `task_claim`, `task_block`,
`GET|PATCH /task/:ref`, `/task show`) accepts the key or the id; the service
resolves the reference once at the top (`isKey` → scan by key, else by id). The
`id` stays the durable primary key because backends, revisions, and imports are
all keyed on it. The counter that mints keys lives in the domain `global` slot
(decision 7 amendment) and is serialized on a private promise chain in the
service — two parallel creates must not read the same number before either's
`setGlobal` lands. Keys are never reused; a failed write after reservation
burns a number, which is why gaps are a non-issue.

The model never sees a UUID: `taskValueSchema` projects `key` and every
`render` prints it (decision 12's fix). The one subtlety: a removed task's
activity stream is keyed by the UUID, so once the card is gone the stream is
only reachable by the id — the panel never needs this, since there is nothing
to click.

**21. The activity stream records who acted, when, and what — humans and agents
in the same shape.** No "system operation" special-casing: an agent's `blocked`
and a human's `blocked` are the same entry format differing only in `actor`.
Entries are appended ONLY after the write is durable, so a refused or failed
write leaves no trace — the refusal itself already lives in the session log's
`approval/asked` + `approval/decided` pair, and duplicating it in board state
would be a second source of truth. `from`/`to` carry the transition's endpoints
(statuses for `status`/`blocked`, the claiming session for `claimed`, the
initial status for `created`, the final status for `removed`, `null` for plain
`edited`). Retention is `Config.activityRetentionPerTask` (default 50): the
oldest entries are trimmed after each append, so a long-lived task cannot grow
without bound. Activity is deliberately NOT exported — it is derived history,
not state a migration must carry.

**22. The status machine is organised around "whose turn it is", not "how far
the work progressed".** `draft` waits for a human to define it, `open` can be
claimed, `in_progress` is on an agent's hands, `awaiting_human` has the ball
back with the human, `blocked` is an agent explicitly stuck, `done`/`cancelled`
are terminal. This is what the v0.2 plan calls "球在谁手上" — it is the seam
notifications, panel highlighting, and (v0.3) auto-claim hang off. The v0.1
statuses were a work-phase model inherited from human issue trackers; they
could not drive any of those. `blocked` is the one status v0.1 entirely lacked,
and it carries an invariant enforced by the service: entering `blocked`
requires a non-empty `blockedReason` (the tool `task_block` is the sanctioned
path), leaving `blocked` clears the reason.

**23. Spike S2: the official session-switch API is `ctx.sessions.open(id)` on
the CLIENT context — no DOM, no history.** The client runtime exposes
`ISessions` (declared on the cordis `Context` augmentation in
`dsh-client-runtime`); `open(id)` selects the session as current, is
synchronous, needs no page refresh, and persists the selection to
`localStorage` (`dsh.sessions.current`). There is no deep-link parameter —
`?session=` does not exist — so `sessions.open` is the only sanctioned path,
and UI precedents (workflow-run panel, workspace browser, conversation header)
use exactly this call. Two caveats recorded: `open` throws on unknown ids, so
the panel guards with `sessions.list.getSnapshot().byId` (host rows plus the
current addressed subagent route — wider than `ids`, which excludes
breadcrumb-only rows) and shows a "session no longer exists" hint instead; and the host-side `dsh-session` package declares
`ctx.sessions` as its own `SessionStore`, so in a mixed server+client typecheck
the host augmentation wins and the client face must be recovered through its
exported `ISessions` type.

**24. The panel's status select excludes `blocked` as a target.** Blocking is
an agent reporting that it is stuck — it requires a reason and is done through
`task_block`. A human unblocks by moving the card anywhere else; a card already
in `blocked` shows its own status plus the reason, and the service clears the
reason on the way out. Making `blocked` a selectable target would force either
a reason prompt into the panel or an error on a click, both worse than not
offering it.

**25. Auto-claim is the package's THIRD write that does not pass `gate()` — and
it is opt-in by construction.** v0.3's driver (`src/autoclaim.ts`, its own
cordis row) claims the oldest `open` task for an idle session and hands it to
the agent as a follow-up turn. The claim itself is a system automation, not the
model asking, so it bypasses the approval gate like the seed project and the
`key` backfill; the row ships `disabled: true` in the bundle patch, so a
deployment that never mounts it (or never flips it on) gets no auto-claim at
all, and everything the agent does AFTER the claim still passes the normal
gate. `writePolicy: 'off'` still refuses the claim, because that is a
deployment declaring the board read-only.

**26. Spike S3 (token-meter research): the quota signal is
`contextWindow − totalTokens`, and when capacity is unknown the driver does
nothing.** The v0.2 plan required knowing what `ctx.tokenMeter` can signal
before building auto-claim. Findings: `ctx.tokenMeter.measure(session)` returns
a `TokenMeasurement` whose `totalTokens` is the current request-and-response
pressure (provider-usage-anchored when available, heuristically repriced
otherwise); the meter itself has NO capacity concept — the ceiling comes from
`agent.session.requestContext()`, whose `RequestContext.contextWindow` is the
provider-advertised maximum for the session's resolved route (same source the
compaction policy reads). So the driver's rule is: claim only when
`contextWindow − totalTokens ≥ Config.minRemainingTokens` (default 8000). If
`requestContext()` is absent (a brand-new session) or `contextWindow` is not
advertised, the driver skips — conservatively, pulling work into a context of
unknown size would risk an immediate overflow. The `totalTokens` of a fresh
idle session is small, so in practice the floor only bites under sustained
pressure, which is exactly the intent: automation binds to capacity, not to a
manual switch.

**27. The driver mirrors `dsh-goal-round-driver`'s coalescing pattern.** An
`agent/status → idle` transition requests one serialized drive per agent
(`requestDrive`), rechecked against quiescence before acting: the row's own
fiber is ACTIVE, the agent is still the live registry handle, `agent.status`
is `idle`, and `agent.inbox.hasPending` is false — so auto-claim never
interleaves with a user's pending prompt. Dispatch is `agent.followup()` with a
`createUserMessage` whose source kind is this package's own merge-extensible
`taskboard` entry; the claim itself is serialized on the service's `claimChain`
so two idle agents scanning one `open` column cannot both win. The activity
entry for a claim is appended AFTER the authoritative task write, so a hard
process exit between the two loses only the audit line, never the claim — the
activity stream is best-effort history, the task state is authoritative.

**28. v0.4 research: `workspaceRegistry` is a web-only seam, so workspace
binding must be an optional injection.** `@deepseek-ai/dsh-workspace` provides
`ctx.workspaceRegistry` (`Workspace { id, path, title, sessionIds }`), with
session↔workspace membership defined by canonical-cwd equality
(`session.header.cwd` against `workspace.path`; `resolveByPath(path)` finds the
owning workspace). But the package is a dependency of `dsh-web-app` only —
`dsh-base` and `dsh-headless` do not mount it. The taskboard's main row cannot
therefore add `workspaceRegistry` to `inject` (that would fail every headless
boot); resolution must ride `ctx.inject(['workspaceRegistry'], cb)` exactly like
the optional `commands` peer (decision 11), and every workspace-aware behavior
must have a defined no-registry fallback (no auto-assign, no scoping, panel
shows no workspace name).

**29. v0.4 Spike S4 (W2 pre-implementation): `ctx.subagents.start()` works
end-to-end with a real model — the plan's risk is retired.** The V0.4 plan
called for a 30-minute spike before building "claim → background subagent".
It passed in a throwaway headless profile: a real agent invoked `task_subagent`
(a `ctx.subagents.start()` caller), which created a child session whose own
user message was exactly the delegated prompt; the child ran independently and
answered, and the parent's `SubagentRun.result` settled with the child's output
and a normal stop reason. Confirmed facts the W2 implementation will rely on:
`request.prompt` becomes the child's user message, the child's id is
`SubagentRun.id`, completion is `run.result` (never rejects on a child-level
failure — `stopReason: 'error'` instead), and `ctx.subagents` ships in
`dsh-base` so web and headless both have it. `ctx.jobs` remains the
observability layer only; the core completion signal is `run.result`.

**30. v0.4 W1: workspace binding is a cwd-equality resolution with a defined
no-seam fallback.** The board consumes `ctx.workspaceRegistry` only through a
minimal structural face (`src/workspace.ts` — same seam-isolation shape as
`TaskboardStore`): a session's `header.cwd` resolves to the workspace whose
canonical `path` owns it. Three binding points: `create` and `task_claim`
(tool-side, passing `sessionCwd`), and `autoClaim` (driver-side, passing the
session cwd); an explicitly supplied `workspaceId` always wins and a bound task
is never rebound. Scoping: the auto-claim scan includes only tasks of the
session's workspace plus unbound board-global tasks — a foreign-workspace task
is never claimable from another workspace's session. Because the registry is
web-only (decision 28), every behavior has a defined absence mode: no
auto-assign, whole-board scan, and the panel shows no workspace name — the
pre-v0.4 behaviour, verified by the headless regression run.

**31. v0.4 W2: claiming can hand the task to a background subagent, and the
outcome settles the task.** When the auto-claim driver's subagent seam is
available, a claimed task is dispatched via `ctx.subagents.start()` with a
prompt naming the task and telling the child NOT to touch the board — the
parent owns the write-back. `recordDispatched` marks the dispatch in the
activity stream (naming the child session), and `run.result` drives
`settleDispatch`: `completed` → `awaiting_human` (the ball is back with the
human to confirm), `error` → `blocked` + reason. Both are automation writes in
the same standing as `autoClaim` (decision 25 — the row is the opt-in), and
both refuse when the task is no longer `in_progress` under the same claiming
session, so a human who moved the task meanwhile is never overwritten; the
`in_progress` state itself is the double-dispatch guard (a dispatched task is
not `open`, so nothing can claim it again). When the subagent seam is absent,
the driver falls back to the v0.3 follow-up turn in the claiming session —
defensive, since `dsh-base` ships the seam everywhere.

**One trap found by the real end-to-end run:** `ctx.subagents.start(name, …)`
takes the *provider* name, not a label — passing `'taskboard'` throws "no
provider" and the driver silently fell back to the follow-up path. The provider
is now `Config.subagentProvider`, default `'spawn'` (the in-process provider
`dsh-subagent-spawn-in-process` registers on `dsh-base`). The real E2E
(`tests/e2e/full-chain.mjs`, which boots a profile WITHOUT the one-shot
headless runner and keeps the process alive) passes with the full evidence
chain: seeded `open` task → `claimed` → `dispatched` (child session id) →
`completed` → `awaiting_human`, with the child session's own log carrying the
dispatch prompt.

**32. v0.5 (ROADMAP L2): `open` means executable, and executable means a
complete spec.** A task's executable specification lives in `spec {
acceptanceCriteria, contextRefs, definitionOfDone }`; the hard gate is
`isSpecComplete` — present and at least one acceptance criterion. `contextRefs`
are deliberately a soft hint (verification-style tasks may have no file
references), surfaced as a suggestion rather than a gate. Two enforcement
points: a `create` asking for `open` without a complete spec lands in `draft`
(a graceful queue — the model creates far more often than it specs), and an
`update` may only TRANSITION into `open` with a complete spec. The transition
gate deliberately does not re-gate tasks already sitting in `open` without a
spec (pre-v0.5 records keep working; the panel prompts to complete them).
Spec updates are partial merges onto the existing block. The dispatch prompt
now quotes the acceptance criteria so the executing subagent verifies against
them — this is what makes the field load-bearing rather than decorative.

**33. v0.6 (ROADMAP L3): "completed" means "completed with evidence".** The
dispatched subagent is given an `outputSchema` (the object-rooted subset
`ctx.subagents.start` accepts) and told to report `criteria` (per-criterion
self-assessment: met + note), `artifacts`, and `summary`. `run.result.structured`
is the evidence; `settleDispatch` stores it on the task (`evidence` field,
additive). Two failure guards: a `completed` run WITHOUT a valid structured
report settles as an error — no half-evidence is ever stored — and an `error`
run settles `blocked` with the reason plus a diagnosis (the tail of the
child's partial output) carried in `evidence.summary`. The panel turns
`awaiting_human` into a decision surface: it shows the evidence and offers
confirm (→ `done`) and bounce (→ `draft`). The self-assessment is an
accelerator for the human, never a replacement — the human is the final judge,
and `met` without a note is visibly thinner evidence.

**13. The invariant companion is empty, with the reason recorded.** Stored
records are already validated by the storage seam on every load and write;
revision monotonicity is enforced in `update` and covered by tests; the approval
audit pair lives on the session log, not in state this package could cross-check.
An explained empty companion is the correct shape when no owned relationship is
assertable.

**15. The gate is about the initiator, not the surface.** The first design made
the panel read-only, reasoning that a write control there would be "a second
path to durability the approval prompt does not cover". That conflated *which
surface* with *who initiated*. The approval gate answers one question — *the
model wants to write; does a human agree?* When the initiator IS the human,
there is no second party to ask, and prompting them to approve their own click
is ceremony. dsh's own design says the same thing about this package's seed
project: "there is nothing for a human to decide".

So `Actor` is a discriminated union:

| Initiator | Gate | Recorded as |
| --- | --- | --- |
| `{ kind: 'agent' }` — the `task_*` tools | `ctx.approval` | `origin: 'agent'` |
| `{ kind: 'human' }` — the panel, a command | none | `origin: 'human'` |

`writePolicy: 'off'` still refuses both, because that is a deployment declaring
the board read-only rather than a question about authority.

Two consequences fell out. The `/task` command surface is no longer forced to be
read-only by the open-turn constraint (decision 4) — a human typing a command
needs no approval. And the write routes need a cross-site guard, because the host
web server ships no origin policy: every write requires
`content-type: application/json`, which is not CORS-simple, so a page the user
merely visits must first pass a preflight this server never answers.

**16. Adding `origin` did not bump `DOMAIN_VERSION`.** The storage layer rejects
a medium whose stamped version differs, with no migration — so a new *required*
field would strand every existing board. `origin` is declared
`z.enum([...]).default('agent')`: a record written before the field existed still
parses and reads back as `agent`. An additive field with a default is the one
schema change this storage layer tolerates; anything structural is not.

**17. A patch can change a row's `config` and `disabled`, never its `name`.**
Swapping the directory picker with

```yaml
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-browse'
```

silently did nothing; dsh reported on stderr `patch: name mismatch for
"directory-picker" … skipping` and kept the original row. Replacing an
implementation means disabling the old row and inserting a new one under a new
id. Worth knowing because the failure is a stderr line, not an error — a patch
that "has no effect" is usually this.

## The browser panel

The client half registers one entry into the session-scoped `conversation.view`
slot, so the board appears as a third tab beside 对话 / 轨迹. It reads this
package's own `/api/taskboard/board` route and nothing else, which is what keeps
it inside the client bundle purity rule (no cross-plugin value imports; the
build fails on one).

It ships no stylesheet. Colours are `color-mix` over `currentColor`, so the
panel inherits the shell's palette instead of carrying a CSS-modules pipeline
and a `lightningcss` dependency. Verified against the light theme; the dark
theme follows from `currentColor` but has not been checked on screen.

The panel writes — see decision 15.

v0.2 panel surface: seven columns (the `blocked` column and its cards carry a
warning tint; a blocked card shows `blockedReason`), a per-column `+` that
creates straight into that column (W5), an activity drawer per card fed by
`GET /task/<id>/activity` newest-first (W3, decision 21), and — for a claimed
task — the claiming session plus an "open in conversation" button that calls
`ctx.sessions.open` through the injected sessions face (W4, decision 23). The
seven-column layout keeps the v0.1 `minWidth` shrink-floor strategy; the floor
drops from 180 to 160 so seven columns fit a 1280px pane before the row
scrolls.

## Not yet built

- **Subagent cancellation wiring.** A dispatched subagent runs to completion;
  the driver does not yet cancel it when the task changes or the deployment
  shuts down (`run.dispose` is available but unwired).
- **Jobs-surface execution indicator.** `ctx.jobs` (dsh-jobs) can expose
  in-flight dispatches to the panel ("running in subagent…"); v0.4 deliberately
  kept the observability layer out of scope.
- **Subagent-produced subtasks.** W2 lands plain execution; turning a
  subagent's output into child tasks is a later evaluation, once real execution
  patterns are visible.

**34. v0.7 (ROADMAP L4): dependencies and scheduling are the agent era's answer
to ordering.** `dependsOn` (canonical task ids, additive) makes a task
claimable only when every dependency is `done` or `cancelled` (`isReady`). An
unresolvable dependency is KEPT rather than dropped — deleting a prerequisite
must not wedge the board, it parks the dependent in not-ready until a human
clears the reference. Cycles are rejected at write time (`assertAcyclic`, a
bounded DFS from the written task). The auto-claim candidate is the highest-
weight ready task (priority 4…1, then oldest `createdAt`), so ordering is
decided by dependencies × priority × waiting, not creation order. The
per-task `budgetTokens` caps the dispatched subagent's output via
`agentOptions.maxTokens`; a `max-tokens` stop reason settles the task `blocked`
with a budget-overrun reason — the token meter guards input pressure (v0.3),
the budget guards output cost per task.

**35. v0.8 (ROADMAP L5): history is input, not archive.** A completed task
already carries the full knowledge of one execution — `spec.criteria` (what
was to be done), `evidence` (what was produced and concluded) — so an
experience card needs no new field: `relatedExperience` projects done tasks
(with non-empty summaries) into `{ key, title, criteria, artifacts, summary }`
cards, newest first, filterable by project/workspace/label. Two injection
points make that history live: `task_create`'s rendered result appends up to
three related cards (the model sees "TB-7 did something similar — …" before it
starts exploring), and — opt-in via `Config.sessionContext` (off by default,
bounded by `sessionContextLimit`) — the driver injects a
`<taskboard_session_context>` digest (open work + related experience for the
session's workspace) into a new session's first pre-step through
`agent.inject`, which does not wake the driver. Both paths are bounded so the
digest cannot balloon the context. This is the closure of the v0.2 plan's
"任务板是会话的组织层": the board now seeds a session with what it needs to
know instead of waiting to be asked.

**36. v0.9: executor intent, deadlines as scheduling signal, and append-only
notes.** Three additive fields round out the task as a domain object. (1)
`executor: 'agent' | 'human' | 'any'` is an INTENT declaration, not an ACL —
its only enforcement is that auto-claim never picks up `human` tasks (the
state machine says who the ball is with; the executor says who it is FOR).
(2) `dueAt` is a human's commitment, not an estimate — it feeds the
scheduling weight (priority, then earlier due first, then age) and the
panel's overdue hint; it deliberately does NOT reintroduce estimation, and
`plannedStartAt` stays excluded because agents are not calendar-driven.
(3) `notes` is append-only process log (`note` patch appends, never
overwrites, recording a `noted` activity entry) — distinct from `body` (the
original intent) and the activity stream (structured events). All three are
`.default()`-compatible additions, so v0.8 records read back unchanged.

**37. v1.1 (A1): execution is cancellable and time-bounded.** The auto-claim
driver keeps a process-local `executions` map (task id → subagent run, start
time, timeout timer). A `domain/changed` listener (storage-domain emits the
new task snapshot on every write) cancels the child the moment a dispatched
task leaves `in_progress` — a human takeover, cancellation, or edit stops the
subagent instead of letting it burn tokens. `Config.dispatchTimeoutMs`
(default 30 min) disposes an over-running child and settles the task `blocked`
with a timeout reason. The settle callback is ownership-guarded: it only
writes back while the execution is still in the map, so a cancelled child's
late `run.result` can never double-settle a task the human already moved.

**38. v1.1 (A2): execution is visible.** The same map feeds a tracker the
service exposes (`setExecutionTracker` → `executionOf` / `executions`); the
board route carries `executions` and the panel shows an in-progress card's
running subagent and elapsed minutes. Without the driver row the tracker is
absent and nothing is shown — visibility is a property of having dispatched.

**39. v1.1 (B1): a bounce carries its reason.** The panel's 打回待立项 now
requires a reason, written into the task notes (`note: "bounce: …"`) alongside
the `status → draft` migration — the activity stream reconstructs the full
bounce (who, when, why), so the next executor knows what to change.

**40. v1.2 (C1): done is archive material, not board clutter.** `archivedAt:
number | null` (additive, default null) soft-archives a task: `list()` and
`/board` exclude it by default, `ListFilter.archived: true` queries only the
archive, and `archive(ref, boolean)` both archives and restores (restoring is
the same write flipped). Only `done` tasks may be archived; `archiveAllDone()`
sweeps the whole done column. Archiving is a governance write, not a data
change — it records an `edited` activity entry and needs no approval because it
is reversible and touches nothing but the stamp. Export keeps archived tasks
(backup completeness), so an archive is never a deletion.

**41. v1.2 (B3): the panel says who must act.** The two columns whose ball is
with a HUMAN — `awaiting_human` and `blocked` — get their count badge in the
warning colour and bold, so the header reads as a call to action, not a
statistic. Within a column, cards with an overdue `dueAt` float to the top
(stable sort over the per-column filter; storage order is untouched). A card
waiting on a human gets the warning left border, matching the blocked column's
existing tint. One `now` serves the whole render so the sort and the per-card
overdue badge cannot disagree.

**42. v1.2 (B2): the input side is budgeted too.** `budgetTokens` caps a
subagent's OUTPUT; `contextBudgetTokens: number | null` (null = unlimited)
caps its INPUT. At dispatch the driver estimates the prompt cost as
`estimateInputTokens(text) = ceil(chars / 4)` — deliberately a ceiling, "宁严
勿松" — and when the estimate exceeds the task's budget it refuses BEFORE
starting the child: the task settles `blocked` with a reason naming the
refusal and a diagnosis quoting the estimate. A giant task is thus recognized
as undispatchable instead of being launched into a truncated context. The
estimate is a pure exported function so the formula is unit-tested directly.

**43. v1.3 (C2): a stale-snapshot process is refused, not silently clobbered.**
The JSON backend rewrites the whole unit file per write, and the domain's
per-process write chain does not span processes — two processes on one home
can overwrite each other (including short-id counter races). The store adapter
therefore carries a write guard: before every durable write it reads the
medium file and compares a canonical fingerprint of its state against the
domain's in-memory snapshot. A divergence means another process rewrote the
file; the write refuses with `concurrent-modification` (409 on the routes) —
"refresh and retry" — instead of losing data. The medium side is normalized
through the domain schemas first, because in-memory records carry `.default()`
fields the raw file may predate; and fingerprints sort by canonical record,
never by table key, because the domain's activity table is keyed by index, not
by record id. Guard off when there is no readable JSON medium (fresh board,
non-JSON backend); the read→write TOCTOU window that remains is the backend's
last-writer-wins, out of this seam — the guard converts "always silently
lost" into "detected unless exactly concurrent".

**44. v1.3 (D1): the archive has an exit.** The panel's 只看归档 toggle loads
`/board?archived=true`; archived cards (always done) get a 恢复 button that
flips the same `archive(ref, false)` write. 归档 ≠ 删除 is now a visible
round-trip, not a claim in the docs.

**45. v1.3 (D2): the panel edits cards.** An inline editor on every card
changes title, body, priority, executor, and deadline (datetime-local →
epoch ms; empty clears `dueAt`). The PATCH carries `expectedRevision`, so an
edit racing an agent write is a 409, not a clobber — the same optimistic
concurrency as status moves.

**46. v1.3 (D3): blocked has a one-click exit.** A blocked card shows 解除阻碍
— a single PATCH to `open`; the service already clears `blockedReason` on
leaving blocked, and the activity stream records the move. The reason stays
visible on the card, so the unblock is informed.

**47. v1.3 (D4): the done column sweeps in one click.** `POST
/api/taskboard/archive-done` returns `{archived: n}` and the panel's done
column header button (two-step: arm → confirm) calls it. This is the UI exit
for the `archiveAllDone()` service method that v1.2 shipped without one.
