---
name: mission-control
description: Monitor and command the Claude Code agent fleet on Daniel's Mac via the Mission Control REST API — check what agents are doing, read their terminals, answer their questions, send instructions, kill runaways, launch new agents or fleets, run one-shot research, and read/write the plans-and-research document library. Use whenever Daniel asks about his agents, his Mac's fleet, Mission Control, widget-claude, or wants something built/researched on the Mac.
---

# Mission Control

Mission Control runs Claude Code agents on Daniel's Mac. You can see and command
the whole fleet through a REST API on the public relay — plain outbound HTTPS,
no VPN or port forwarding.

## Connection

Every request needs the base URL and token from the environment:

```bash
BASE="$MISSION_CONTROL_URL/api/v1"
AUTH="Authorization: Bearer $MISSION_CONTROL_TOKEN"
```

If `MISSION_CONTROL_URL` is unset, the relay is
`https://mission-control-remote-production.up.railway.app`.

Quick sanity check (also tells you whether the Mac itself is online):

```bash
curl -sf -H "$AUTH" "$BASE/status"
# → {"ok":true,"host":true,"snapshotAgeSec":1,"agents":4,"summary":{...}}
```

`host:false` or a 502 means the Mac app is offline — say so instead of retrying.
`GET $BASE` returns a self-describing index of every endpoint.

## Reading the fleet

```bash
curl -sf -H "$AUTH" "$BASE/agents"                       # everyone: status, activity, todos, cost, tokens
curl -sf -H "$AUTH" "$BASE/agents/<id>"                  # one agent in full (includes last screen)
curl -sf -H "$AUTH" "$BASE/agents/<id>/screen"           # live terminal scrollback right now
```

- An agent's `:id` is its `id` (sessionId) from the list; a **unique** agent
  `name` or `folder` also works. Ambiguous names return 409 — fall back to the id.
- `status` is `active` / `idle` / `done`. `statusLabel: "Needs input"` + activity
  "Waiting for your answer" means the agent asked a question — read its screen to
  see the question and the numbered options.
- Fleet-wide numbers (spend, tokens, tok/s, CPU/MEM) ride in `summary` and `system`.

## Commanding agents

```bash
# Type a message into an agent's terminal (submits like pressing Enter):
curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"Looks good — continue, and add tests."}' "$BASE/agents/<id>/reply"

# Answer a numbered menu / press a single key (digit, or up/down/enter/esc/tab/space):
curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"key":"1"}' "$BASE/agents/<id>/key"

# Message every reachable agent at once:
curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"Wrap up and commit your work."}' "$BASE/broadcast"

# Kill a runaway (irreversible — confirm with Daniel unless he already told you to):
curl -sf -X POST -H "$AUTH" "$BASE/agents/<id>/kill"
```

When an agent shows a numbered question, prefer `key` with the option number;
use `reply` for free-form instructions.

## Launching work on the Mac

```bash
# One agent (model: sonnet | opus | haiku | fable; omit for default):
curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"mission":"Fix the flaky login test and open a PR","dir":"~/acme","model":"sonnet"}' \
  "$BASE/launch"

# A managed fleet: one manager + N workers:
curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"mission":"Revamp the checkout flow","dir":"~/shop","managerModel":"opus","workerModels":["sonnet","sonnet"]}' \
  "$BASE/launch"
```

- `dir` is a folder on the Mac (`~` expands; relative resolves against home). A
  nonexistent folder is rejected in the ack — relay that error to Daniel.
- Daniel dictates: if a folder name looks garbled, check `knownDirs` in
  `GET /agents` for the closest real path before launching.
- `planMode:true` starts the agent in plan mode. `docId` (+ `docMode`
  `"build"`|`"continue"`) attaches a library document as the mission.

## Research + the document library

The library holds plans, research reports and notes as markdown docs.

```bash
# Fire-and-forget research; the report lands in the library as kind=research:
curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"topic":"Best Postgres queue libraries in 2026","model":"sonnet"}' "$BASE/research"
# → {"ok":true,"id":"best-postgres-queue-libraries-in-2026.md"}  (status active → done when finished)

curl -sf -H "$AUTH" "$BASE/docs"                          # metadata for every doc
curl -sf -H "$AUTH" "$BASE/docs/search?q=checkout"        # full-text search
curl -sf -H "$AUTH" "$BASE/docs/<id>"                     # one doc with markdown body
curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"Standup notes","kind":"note","content":"# Standup\n\n- ..."}' "$BASE/docs"
curl -sf -X PUT   -H "$AUTH" -H 'content-type: application/json' -d '{"content":"..."}' "$BASE/docs/<id>"
curl -sf -X PATCH -H "$AUTH" -H 'content-type: application/json' -d '{"status":"done"}' "$BASE/docs/<id>"
curl -sf -X DELETE -H "$AUTH" "$BASE/docs/<id>"
```

`kind`: plan | research | note. `status`: draft | active | done | archived.

## Ground rules

- Acks are truthful: `{"ok":false,"detail":...}` means it really failed — report
  the detail, don't silently retry.
- Timeouts: 504 means the Mac didn't answer in 15s; check `/status` before retrying.
- Never paste `MISSION_CONTROL_TOKEN` into chat messages or logs.
- Killing agents or broadcasting interrupts real work — do it when asked, not
  speculatively.
