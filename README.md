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
| `task_create` | Add a task **(approval-gated)** |
| `task_update` | Move a task between columns or edit it **(approval-gated)** |
| `task_claim` | Claim a task for this session and move it to `in_progress` **(approval-gated)** |

`task_update` and `task_claim` accept `expected_revision`. A caller that passes
the revision it last read loses to any write that landed meanwhile
(`revision-conflict`) instead of silently clobbering it. This is what makes
parallel sessions on one board safe.

## Commands

`/task list [status]` · `/task show <id>` · `/task export`

Commands are read-only in this version. They dispatch without spending a model
turn. (Human-initiated command writes are possible now that the gate keys on the
initiator rather than the surface — they just are not built yet.)

## The board panel

Open any session and the board is the third view tab, beside 对话 and 轨迹. Five
columns, one card per task, a priority accent, labels, and per-column counts.

**You create and move tasks here directly** — no approval prompt, because you
are the one asking. The agent's `task_*` tools still need your approval. Each
card records which of you made it (`你创建` / `agent 创建`).

The panel ships no stylesheet — it colours itself with `color-mix` over
`currentColor` and inherits the shell's theme.

## HTTP API

| Method | Path | Effect |
| --- | --- | --- |
| GET | `/api/taskboard/board?status=…` | Read the board |
| GET | `/api/taskboard/task/<id>` | Read one task |
| GET | `/api/taskboard/export` | Backup document |
| POST | `/api/taskboard/task` | Create (human-initiated, no approval) |
| PATCH | `/api/taskboard/task/<id>` | Update; send `expectedRevision` to refuse a stale write |

Registered on the host's existing web server; no new port. **Writes require
`content-type: application/json`** — see [SECURITY.md](SECURITY.md) for why.

## Configuration

```yaml
# $DSH_HOME/cordis.patch.yml — a patch replaces the whole `config`, so restate
# every key you want to keep.
- replace:
    - id: taskboard
      config:
        writePolicy: ask        # ask | auto | off
        maxTasks: 2000
        listLimit: 50
        defaultProjectName: Inbox
```

| Key | Default | Meaning |
| --- | --- | --- |
| `writePolicy` | `ask` | `ask` routes every write to `ctx.approval`; `auto` writes unattended; `off` makes the board read-only |
| `maxTasks` | `2000` | Ceiling on stored tasks |
| `listLimit` | `50` | Default page size for `task_list` |
| `defaultProjectName` | `Inbox` | Project seeded when the board opens empty |

### Scaling past a few hundred tasks

The `web` profile routes storage domains to the JSON backend, which **rewrites
the whole unit file on every write** — deliberately, because legibility is that
backend's reason to exist. For a large board, route this domain to SQLite:

```yaml
- insert:
    - id: storage-sqlite
      name: '@deepseek-ai/dsh-storage-sqlite'
- replace:
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
reads it back. Export before upgrading across a domain version bump.

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
