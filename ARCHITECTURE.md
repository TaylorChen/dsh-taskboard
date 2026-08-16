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

## Not yet built

- **Workspace binding.** `Task.workspaceId` is stored and filterable, but nothing
  yet resolves it against `ctx.workspaceRegistry` or auto-assigns from a session's
  cwd.
- **Subagent claim-and-execute.** `task_claim` records the claiming session;
  handing a claimed task to a background subagent through `ctx.subagents` +
  `ctx.jobs` is the next capability, not a v1 promise.
