# Security

## Reporting

Report a vulnerability through a [private security advisory](https://github.com/navidid/dsh-taskboard/security/advisories/new).
Please do not open a public issue for one. Expect an acknowledgement within
three working days.

## What this plugin can do on your machine

Stated plainly, because a plugin runs inside your agent's process with your
agent's authority.

| Capability | Used? | Detail |
| --- | --- | --- |
| Local file write | **Indirect** | Task records go through `ctx.storageDomain`, which the host routes to a backend. Under the shipped `web` profile that is the JSON backend, writing `taskboard.json` under `$DSH_HOME/storages`. This plugin never opens a file itself. |
| Network egress | **No** | No outbound request of any kind. |
| Credential access | **No** | No environment variable, key file, or credential store is read. |
| Shell execution | **No** | No subprocess is spawned. |
| Telemetry | **No** | Nothing is reported anywhere. |
| HTTP listener | **Indirect** | Six routes under `/api/taskboard` are registered on the host's existing web server. No new port is opened. Four are reads (board, export, one task, one task's activity stream); two accept human-initiated writes from the panel. |
| Install-time scripts | **No** | No `prepare`, `postinstall`, or other lifecycle script. Published to npm pre-built, so installing never executes our code. |

## Trust boundaries

**Writes are gated, and the gate cannot be bypassed from inside this package.**
Every mutation — from the `task_*` tools, from `/task`, or from another plugin
calling `ctx.taskboard` directly — passes through the approval gate inside
`TaskboardService`. The default `writePolicy: 'ask'` routes each one to
`ctx.approval`, so a human decides. Setting `writePolicy: 'auto'` removes that
check for unattended deployments; do so deliberately.

**The write routes are gated by initiator, not by surface.** A write arriving on
`POST /api/taskboard/task` or `PATCH /api/taskboard/task/<id>` is attributed to
the human at the keyboard and skips the approval prompt — you do not approve your
own click. Every write from the *model* still passes `ctx.approval`. Setting
`writePolicy: 'off'` refuses both.

**Cross-site protection on the write routes.** The host web server documents that
it ships no TLS, auth, or origin policy, and binds loopback by default. A write
route must therefore not be reachable from a page you merely visit, so both write
routes require `content-type: application/json` and reject anything else with
415. That content type is not CORS-simple, so a cross-origin caller must pass a
preflight this server never answers. Request bodies are capped at 64 KB.

This is the protection a loopback dev server can offer. If you bind the host web
server to `0.0.0.0`, everyone on that network can write to your board — that
exposure is the host's documented posture, not something this plugin can fix.

**Task text is model-visible.** Titles and bodies reach the model through
`task_list` and `task_create` results. Do not store secrets in a task.

**`blockedReason` is model-visible text with a narrow flow.** The reason is
*supplied by* the model (through `task_block`), and it appears wherever a human
needs it: on the board card, in the activity drawer, and inside approval
payloads (so the human decides an unblock against the concrete reason). The
current tool outputs do not project it back to the model — a blocked task is
ball-with-human, and the model has no call that reads the reason back. But it
is stored on the task record and served by the API, so treat it like any task
text: no secrets in a blocking reason.

**Activity entries are not model-visible.** The per-task activity stream is
served only to the panel over the read route; no tool projects it. It records
who (human or agent, plus the agent's session id), when, and what transition —
the same audit facts the session log already carries for agent writes, now in
board state. A refused write never produces an entry; refusals stay in the
session log only.

**Approval payloads quote the change.** So a human approves a concrete
before/after rather than an abstract verb, an approval prompt contains the task
title and up to 300 characters of the body. That text reaches whatever surface
answers approvals.

**The board is not access-controlled.** Any agent in this dsh installation can
read and (subject to approval) write any task. Workspace scoping is an
organising field, not a permission boundary.

## Supported versions

Pre-release. Only the latest published version receives fixes. This plugin pins
`@deepseek-ai/dsh-*` peers to an exact release; a dsh upgrade may require a
matching plugin upgrade.
