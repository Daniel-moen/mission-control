# Mia v2, phase 1 — mia-core (task 0292)

Spec: Library `mia-v2-how-i-work-today-and-a-better-str` (task 0291). This is
the "this week" list plus the core of "this month": headless executors, a
durable SQLite job queue, a concurrency cap, routing by default with an Opus
budget, heartbeats outside Mia's context, and Mia resuming her own session.

Everything is behind a switch in `~/.mission-control/mia/core.json`. With the
file missing (the default) Mission Control behaves exactly as before.

## Pieces

| Piece | Where | Portable? |
|---|---|---|
| `mia-core` — queue, runner, cap, budget, heartbeat runs, reconcile | `scripts/mia-core` (Python 3 stdlib, installed to `~/.mission-control/bin/mia-core`) | yes (POSIX + Windows branches: msvcrt lock, taskkill, process groups, SetThreadExecutionState) |
| `mia` CLI hooks — dispatch/verify/tell → queue, `mia jobs`, `mia core …`, routing guess | `scripts/mia` | same as before (bash + python; the CLI's own flock is phase 2) |
| App link — keeps mia-core up, feeds its events to Mia, `jobs` in the snapshot, legacy cap/reaper, Mia resume | `Sources/AgentWidget/MiaCore.swift` + small hooks in `MiaManager.swift` | macOS app (phase 2 replaces it) |
| Embedded copies | `ToolingInstaller.swift`, regenerate with `python3 scripts/sync-tooling` (`--check` to verify) | — |

State under `$MIA_DIR` (`~/.mission-control/mia`):

```
core.json      switches (below)                  jobs.db     SQLite (WAL): jobs, runs, events, meta
core.pid/.lock single instance                   runs/<job>/ run-N.jsonl (raw stream-json), .prompt, .err, pids
inbox.jsonl    events for Mia, written once      inbox.offset  the app's read position
jobs.json      snapshot for the app/panel        core.log    service stdout/stderr (when the app starts it)
```

`tasks/*.json`, `briefs/*.md` and reports are unchanged and stay the human
record; a headless task's `executor` gets `headless: true`, `jobId`,
`sessionId` (pre-assigned), `model`, `attempt`, `turn`, `pid`, `log`,
`finishedAt`, `finishKey`, `costUsd`, `outputTokens`.

## How each item works

1. **Headless executors** (`headless`). `mia dispatch` writes the brief and
   queues a job instead of `dispatch/NNNN.json`. mia-core starts
   `claude -p --output-format stream-json --verbose --model M --session-id <uuid>
   --dangerously-skip-permissions` in the task folder, prompt on **stdin** (no
   argv/Windows length limit), stdout straight to `runs/<job>/run-N.jsonl`, in
   its own process group so it outlives the service. The final `result` line is
   the finish: session id, `total_cost_usd`, usage, `modelUsage`, `is_error`.
   One event per job turn, key `finish:<job>:<turn>` (UNIQUE in `events`), so a
   second "finished" is impossible at the database level. The executor prompt
   keeps its fixed opening (the Fleet still labels it "Mia task NNNN") plus a
   headless paragraph (`$MIA_RUN_PIDFILE`, two-line summary). The app skips
   `headless` tasks in `trackExecutors` — no more guessing.
   **`mia tell <id> "…"`** → `mia-core tell`: a finished/failed job is resumed
   with `claude -p --resume <session>` and the message as the prompt (any
   length); a running one gets it right after the current turn (that turn's
   finish is folded into the next, still one event); `--now` interrupts the
   turn and resumes at once. **Live log**: `mia core log <task> [-f]` (pretty
   tail of the stream), `jobs.json` → snapshot `mia.jobs[].tail`, and the
   session's transcript shows up in the Fleet like any session.
2. **Durable queue** (`jobs.db`). Jobs: state (`queued/running/finished/failed/cancelled`),
   attempts, failures, model, kind, tier, cost, tokens, timestamps, wait
   reason. Runs: pid, log, offset, outcome. Every tick (2 s) reconciles each
   open run by its log and pid (a pid now owned by another Claude session counts
   as dead). A run that dies (crash, sleep, flat battery, API error) is resumed
   **once** (`resumeRetries`, `--resume` when the session had started, else a
   fresh start with the same id) after `retryDelaySeconds`; a second failure
   marks the job failed and sends Mia one event with the reason. A gap of more
   than 90 s between ticks is logged as a sleep. The service is single-instance
   (`core.lock`); workers keep running when it stops and are adopted on start.
   A task set `cancelled`/`done`/`failed` stops its job.
3. **Cap + cleanup** (`maxConcurrent` 4, optional `nightMaxConcurrent` +
   `night`). Queued jobs wait with a reason ("waiting for a slot (4 running,
   max 4)", "folder busy with another job" — never two jobs in one folder).
   `claude -p` exits when done, so no idle sessions; if a run lingers after its
   `result` (a background shell), its process group is stopped after
   `reapGraceSeconds`, then every PID the run wrote to `$MIA_RUN_PIDFILE` (dev
   servers). `keepAwake` holds the machine awake only while jobs run.
   For WezTerm executors (headless off): `legacyCap` holds dispatch files while
   `maxConcurrent` executor processes are alive; `reapLegacy` ends an executor
   idling 10 min after Mia closed its task (its own pid only).
4. **Routing + budget**. Kind → tier → model is the existing `mia routing`
   table (plus `heartbeat`, `inbox` → cheap). `routeByDefault`: a dispatch with
   no `--model/--tier/--kind` gets a kind guessed from title + brief (build
   words → `build`/Opus; research/compare → Sonnet; summarise/scout → Haiku;
   anything else → `defaultKind`), recorded as `routing.guessed`. **Budget**
   (`budget.enabled`): before starting a NEW Opus job (not `--urgent`) it reads,
   in order, `mia usage --json` (task 0290; any `pct/percent/utilization` field,
   the highest wins, cached 5 min), else the larger of the newest
   `rate_limit_event` utilisation seen in any run's stream (≤ 30 min old: the
   real 5-hour/7-day windows) and today's Opus output tokens /
   `opusDailyOutputTokens`. At `pauseAt` (0.8) Opus jobs wait, cheap/mid work
   keeps going, Mia gets one heads-up per day. `mia core budget` shows it.
5. **Heartbeats out of Mia's context** (`heartbeats.enabled`, `beats` map id →
   kind; default `hb_health`→health, `hb_scout`→scout, `hb_inbox`→triage). mia-core
   fires those `schedule.json` beats itself (same everyMinutes/at rules, one in
   flight per beat) as headless runs on the routed (cheap) model in `$MIA_DIR`
   with Mia's `mcp.json`, read-only, told not to message Daniel. Final answer
   `HEARTBEAT_OK` → silent; anything else → one `[MC] Heartbeat "<label>" … found: …`
   event. Two failures in a row → one event. The app stops typing those beats
   into Mia; brief/wrap/initiative stay hers.
6. **Mia resumes her session** (`miaResume`). The app remembers
   `state.lastSessionId`; a relaunch after a crash/exit runs
   `claude … --resume <id>` with a short catch-up note (it starts "You are Mia"
   so she is recognised) instead of a blank session + "You were restarted".
   If the resumed session dies within 3 min, `state.resumeFailed` marks it and
   the next launch is fresh. The panel's "Restart Mia now" stays a fresh start.

## Settings (`mia core config set <key> <json>`; `default` removes a key)

| Key | Default | Effect |
|---|---|---|
| `headless` | false | dispatch/verify/tell go through mia-core |
| `maxConcurrent` | 4 | running jobs at once (beats included) |
| `nightMaxConcurrent`, `night` | null, 22:00–07:00 | lower cap at night |
| `resumeRetries`, `retryDelaySeconds` | 1, 20 | automatic resumes of a dead run |
| `reapGraceSeconds` | 30 | linger allowed after `result` |
| `keepAwake` | true | caffeinate / Windows API while jobs run |
| `routeByDefault`, `defaultKind` | false, build | guess a kind when none given |
| `budget.enabled`, `pauseAt`, `opusDailyOutputTokens`, `usageCommand` | false, 0.8, 1500000, true | Opus pause |
| `heartbeats.enabled`, `heartbeats.beats` | false, health/scout/inbox | beats as cheap runs |
| `miaResume` | false | app resumes Mia's session |
| `legacyCap`, `reapLegacy` | false, false | cap + reaper for WezTerm executors |
| `claude`, `permissionMode`, `maxBudgetUsd` | auto, skip, {} | binary, permissions, per-tier `--max-budget-usd` |

## Commands

```
mia jobs [--all] [--json]                  queue: running, queued (+ why), cost, tokens
mia core status | budget [--json]          service, switches, budget
mia core log <task|#job> [-f] [--all] [--raw]
mia core cancel <task|#job>
mia core beat <hb_id>                      run one heartbeat now
mia core config [get [key] | set <key> <json>]
mia dispatch … [--urgent] [--legacy]       skip the budget pause / force WezTerm
mia tell <id> "…" [--now]
```

## Tests

- `python3 remote/test/mia-core-test.py` — 19 unit/integration tests with a fake
  `claude` (`remote/test/fake-claude.py`): one finish per run, crash → resume
  once, twice → failed, API error, died before the session, restart
  reconciliation, cap + folder queueing, reaper (lingering run + registered
  server), tell (resume, 2 000-char message, while running), cancel, routing
  guess, budget (tokens, rate-limit, usage shapes, --urgent), heartbeat runs,
  legacy path unchanged, single instance, config.
- `python3 remote/test/mia-core-e2e.py` — the real `claude -p` on Haiku through
  the real service loop in a throwaway `MIA_DIR` (a few cents).
- `swift test` — `MiaCoreTests` (config, inbox once across restarts, resume helpers).
- `node remote/test/routing-cli-test.mjs` (kind count updated) and the existing suites.
