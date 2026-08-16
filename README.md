# dsh-taskboard

A cross-session, workspace-scoped task board for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Built as a **complete capability seam** — `ctx.taskboard` service + storage-domain
provider + model tools + `/task` commands + a JSON API + a board panel — not as a
bag of tools.

## Why this exists next to `todo_write`

dsh already ships session-scoped work tracking. This plugin does not replace it:

| | Scope | Survives session end | Who writes |
| --- | --- | --- | --- |
| `todo_write` (built in) | one session | no | the model, freely |
| `ctx.goals` (built in) | one session | no | requires human root authority |
| **`dsh-taskboard`** | **across sessions and workspaces** | **yes** | **you directly; the model needs your approval** |

Use `todo_write` for "the steps of this task". Use the board for "the work this
project still owes", carried between sessions and picked up by whichever session
claims it.

## Install

```sh
dsh plugin --profile web add @navidid/dsh-taskboard
dsh --profile web --dump-config   # a "# == @navidid/dsh-taskboard" layer appears
dsh web
```

## Support boundary: the web-app bundle is required

The board persists through `ctx.storageDomain` and serves its API through
`ctx.webServer` — both mounted by the shipped `web` profile, neither by
`headless`.

**Installing this into a headless profile fails the boot, loudly:**

```
Error: dsh: plugin tree failed to load: dsh: 3 entries did not activate
@navidid/dsh-taskboard: pending (waiting for service: storageDomain)
@navidid/dsh-taskboard/tool: pending (waiting for service: taskboard)
@navidid/dsh-taskboard/routes: pending (waiting for service: webServer)
```

That is dsh working as designed — a row that never activates is a
misconfiguration, not a benign no-op, so it stops startup instead of leaving you
with a half-mounted plugin.

For a headless board, mount the storage rows yourself and switch the routes row
off:

```yaml
# headless-taskboard.yml, used as: dsh --profile headless --patch ./headless-taskboard.yml "…"
- id: taskboard-routes
  disabled: true

- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

Because the medium is home-level, a headless run and the web UI then share one
board.

## Model-facing tools

| Tool | Effect |
| --- | --- |
| `task_projects` | List projects, to obtain a `project_id` — the only discovery path on an empty board |
| `task_list` | Read the board, optionally filtered by column or project |
| `task_create` | Add a task, optionally straight into a column **(approval-gated)** |
| `task_update` | Move a task between columns or edit it **(approval-gated)** |
| `task_claim` | Claim a task for this session and move it to `in_progress` **(approval-gated)** |
| `task_block` | Report a task as blocked, with the reason **(approval-gated)** |

Tasks are referenced by their short key (`TB-1`) everywhere — every `id`
parameter accepts the key or the full id, and the model only ever sees the key.
`task_update` and `task_claim` accept `expected_revision`. A caller that passes
the revision it last read loses to any write that landed meanwhile
(`revision-conflict`) instead of silently clobbering it. This is what makes
parallel sessions on one board safe.

## The status machine

Columns describe **whose turn it is**, not how far the work progressed — the
board is organised around the ball, because that is what drives notifications,
highlighting, and (v0.3) auto-claim:

| Status | Meaning | Ball is with |
| --- | --- | --- |
| `draft` | 待立项 — not defined yet | human |
| `open` | 等待认领 — defined, claimable | agent (claimable) |
| `in_progress` | 处理中 — on an agent's hands | agent |
| `awaiting_human` | 等你确认 — back with the human | human |
| `blocked` | 遇到阻碍 — agent stuck, needs a human | human (exception) |
| `done` | 完成 | — |
| `cancelled` | 取消 | — |

Moving into `blocked` requires a reason (use `task_block`); leaving `blocked`
clears it. Blocking is an agent's report — the panel does not offer it as a
move target, a human unblocks by moving the card anywhere else.

## Automatic claiming (v0.3)

The board can hand work to an idle agent by itself — bound to **token quota**,
not to a timer: when an agent session goes idle, the auto-claim driver claims
the oldest unclaimed task in `open` **only if**
`contextWindow − currentContextTokens ≥ minRemainingTokens`, then wakes the
agent with a follow-up turn telling it what it claimed. A nearly full context
gets no new work; a context of unknown capacity gets no new work either.

It is **off by default**: the bundle's `taskboard-autoclaim` row ships
`disabled: true`, so installing or upgrading never surprises anyone. Enable it
in your overlay:

```yaml
# $DSH_HOME/cordis.patch.yml — the row's whole config is replaced, so restate
# every key you want to keep.
- id: taskboard-autoclaim
  disabled: false
  config:
    minRemainingTokens: 8000
```

| Key | Default | Meaning |
| --- | --- | --- |
| `minRemainingTokens` | `8000` | Floor on `contextWindow − totalTokens` before the driver will claim |

Two notes. The claim itself is a system write and skips the approval prompt
(it is the deployment's configured automation, not the model asking) —
everything the agent does *after* the claim still passes the normal gate.

Since v0.4 the driver also **scopes to workspaces** and **hands the task to a
background subagent**:

- **Workspace scoping.** When the session's working directory belongs to a
  registered workspace, only tasks of that workspace (plus unbound
  board-global tasks) are claimable — an idle session never picks up another
  workspace's work. Without a resolvable workspace the scan stays whole-board.
- **Subagent execution.** A claimed task is dispatched to a background
  subagent (an independent child session) that runs it and reports back; the
  task then moves to **等你确认 (`awaiting_human`)** on success, or **遇到阻碍
  (`blocked`)** with the reason on failure. The claiming session only claims
  and monitors — it is free to keep working. If the subagent seam is
  unavailable the driver falls back to handing the task to the claiming
  session directly.

## Workspaces

Tasks can be bound to a workspace (a project directory). Binding is automatic
from v0.4: a task created or claimed by a session is bound to the workspace
owning that session's working directory, when one is registered; an explicit
workspace always wins and a bound task is never rebound. The panel shows the
workspace name on bound cards. Unbound tasks are board-global and claimable
from any workspace. (Workspace *management* — creating, renaming, reordering —
is the host's own workspace UI, not this plugin's.)

## Commands

`/task list [status]` · `/task show <id|key>` · `/task export`

Commands are read-only in this version. They dispatch without spending a model
turn. (Human-initiated command writes are possible now that the gate keys on the
initiator rather than the surface — they just are not built yet.)

## The board panel

Open any session and the board is the third view tab, beside 对话 and 轨迹.
Seven columns, one card per task, a priority accent, labels, and per-column
counts. The `blocked` column and its cards are warning-tinted and show the
blocking reason.

**You create and move tasks here directly** — no approval prompt, because you
are the one asking. Each column has its own `+` that creates straight into that
column. The agent's `task_*` tools still need your approval. Each card records
which of you made it (`你创建` / `agent 创建`).

A card opens an **activity drawer**: who (you or the agent) did what and when,
newest first. A claimed task shows its session and an **「在对话中打开」** button
that switches the conversation to that session — no page reload.

The panel ships no stylesheet — it colours itself with `color-mix` over
`currentColor` and inherits the shell's theme.

## Short ids

Every task carries a human-readable key — `TB-1`, `TB-2`, … — unique board-wide,
never reused after deletion. Say it out loud, paste it into a commit message,
reference it in any tool call. The prefix is `Config.keyPrefix` (default `TB`).
v0.1 boards are backfilled once at the first mount, in creation order, with no
further action.

## HTTP API

| Method | Path | Effect |
| --- | --- | --- |
| GET | `/api/taskboard/board?status=…` | Read the board |
| GET | `/api/taskboard/task/<id\|key>` | Read one task |
| GET | `/api/taskboard/task/<id\|key>/activity` | One task's activity stream, newest first |
| GET | `/api/taskboard/export` | Backup document |
| POST | `/api/taskboard/task` | Create (human-initiated, no approval) |
| PATCH | `/api/taskboard/task/<id\|key>` | Update; send `expectedRevision` to refuse a stale write |

Registered on the host's existing web server; no new port. **Writes require
`content-type: application/json`** — see [SECURITY.md](SECURITY.md) for why.

## Configuration

```yaml
# $DSH_HOME/cordis.patch.yml — a config patch replaces the whole `config`, so
# restate every key you want to keep. (The loader's patch entry is the flat
# `{ id, config }` form — no `replace:` wrapper.)
- id: taskboard
  config:
    writePolicy: ask        # ask | auto | off
    maxTasks: 2000
    listLimit: 50
    defaultProjectName: Inbox
    keyPrefix: TB
    activityRetentionPerTask: 50
```

| Key | Default | Meaning |
| --- | --- | --- |
| `writePolicy` | `ask` | `ask` routes every write to `ctx.approval`; `auto` writes unattended; `off` makes the board read-only |
| `maxTasks` | `2000` | Ceiling on stored tasks |
| `listLimit` | `50` | Default page size for `task_list` |
| `defaultProjectName` | `Inbox` | Project seeded when the board opens empty |
| `keyPrefix` | `TB` | Short-id prefix; keys look like `TB-1` |
| `activityRetentionPerTask` | `50` | Activity entries kept per task before the oldest are trimmed |

### Scaling past a few hundred tasks

The `web` profile routes storage domains to the JSON backend, which **rewrites
the whole unit file on every write** — deliberately, because legibility is that
backend's reason to exist. For a large board, route this domain to SQLite:

```yaml
- insert:
    - id: storage-sqlite
      name: '@deepseek-ai/dsh-storage-sqlite'
- id: storage-domain
  config:
    backend: json
    routes:
      taskboard: sqlite
```

## Backup, and why it ships in v1

The storage layer has **no migration path**: a medium stamped with a different
domain version rejects at open. `/task export` and `GET /api/taskboard/export`
produce a `dsh-taskboard-export-v1` document, and `ctx.taskboard.importDocument`
reads it back.

> **Upgrading to v0.2? Export first.** v0.2 normalizes stored statuses and
> backfills keys — the board reads fine after the upgrade, but rolling back to
> v0.1 afterwards would make the normalized records fail to parse. Export
> (`/task export` or the export route) before upgrading, so you can restore if
> you ever need to go back.

## Compatibility

Peers are pinned to an exact dsh release (`0.1.0-rc.6`). dsh is pre-release and
ships breaking changes; a dsh upgrade may need a matching plugin upgrade.

> **npm dist-tag warning.** Every `@deepseek-ai/dsh-*` library package currently
> has `latest` pointing at an old `0.0.1-rc.1` while the real build is on the
> `next` tag. Always install those packages by exact version, never by `latest`.

## Development

```sh
pnpm install
pnpm run check    # typecheck + tests
pnpm run build    # tsdown bundles lib/, tsc emits lib/types/
```

End-to-end against a throwaway dsh home, so your real profile is untouched:

```sh
export DSH_HOME=/tmp/dsh-taskboard-check
pnpm run build
dsh plugin --profile web add .          # requires pnpm on PATH
dsh --profile web --dump-config | grep -A6 '@navidid/dsh-taskboard'
dsh web --port 3099 &
curl -s http://127.0.0.1:3099/api/taskboard/board
```

A typechecking build can still fail to boot — Cordis resolves services at
runtime — so run this before publishing.

## Security

See [SECURITY.md](SECURITY.md) — it states exactly what this plugin can do on
your machine, and what the approval gate does and does not cover.

## License

[MIT](LICENSE)
