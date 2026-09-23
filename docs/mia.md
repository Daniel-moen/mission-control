# Mia — the Mission Control assistant

Mia is a persistent Claude Code session that takes a task list from Daniel,
asks questions only when needed, hands each task to an executor session, checks
the result, and keeps him posted. She lives in a **Mia tab in the web panel**
and reaches him through push notifications. She has her own Gmail account.

This document is the contract between the three parts that implement her:

| Part | Owner | Files |
|------|-------|-------|
| Mac app | Swift | `Sources/AgentWidget/MiaManager.swift` (new), hooks in `AgentManager.swift`, `RemoteBridge.swift`, `ToolingInstaller.swift`, `Settings.swift`, `AgentModels.swift`; `scripts/mia` (CLI source of truth) |
| Relay | Node | `remote/server.js`, `remote/api.js`, `remote/push.js` (new) |
| Panel | React | `remote/app/src/views/mia/*` (new), `remote/app/src/lib/store.js`, `shell/Dock.jsx`, `App.jsx`, `views/home/AttentionCards.jsx`, `remote/app/public/sw.js` + `manifest.json` (new) |

Everything that already exists (fleets, manager/worker protocol, library,
launch, car/TV mode) stays exactly as it is. Mia is purely additive.

---

## 1. Fixed decisions

- Mia's model: **Opus 5.5** (`claude-opus-5-5`). Executors: also Opus 5.5.
  The model is a setting, not a constant, but that is the default.
- Mia **never edits code herself**. She dispatches executors.
- Mia's Gmail is her own account (`daniel.moen32@gmail.com`). Her session is
  launched with `--mcp-config ~/.mission-control/mia/mcp.json --strict-mcp-config`
  so she only sees that mailbox, never Daniel's claude.ai account connectors.
  (`mcp.json` already exists; the app must not overwrite it.)
- Mia's working directory is `~/.mission-control/mia/`.
- Mia is launched exactly like any other agent (same terminal bridge, same
  `launchSessions` path, same CLAUDE_CODE env scrub) so she gets a card, a
  terminal mirror, reply, and kill for free.
- **The app is the event bus.** Mia ends her turn whenever she is waiting.
  Everything that happens (an answer from Daniel, a new task, an executor
  finishing, a reminder firing) is delivered by the app **typing a message
  into her terminal**, using the existing `AgentManager.send`. No polling
  loops in her prompt. Zero tokens while idle.

---

## 2. State on disk — `~/.mission-control/mia/`

All files are plain JSON / JSONL so any tool can read them. The `mia` CLI is
the only writer agents use; the app reads and writes them too.

```
~/.mission-control/mia/
  mcp.json            Gmail MCP config (exists — never overwrite)
  state.json          written by the app: { sessionId, model, enabled, startedAt, restarts }
  messages.jsonl      the Mia <-> Daniel conversation, append-only (see 2.1)
  tasks/<id>.json     one file per task (see 2.2)
  schedule.json       heartbeats + reminders (see 2.3)
  events.jsonl        system events delivered (or queued) to Mia, append-only (see 2.4)
  dispatch/<id>.json  executor launch requests written by `mia dispatch`; consumed by the app
  briefs/<id>.md      executor briefs written by Mia
```

Task ids are zero-padded 4-digit counters (`0001`, `0002`, …), assigned by
whoever creates the task (CLI or app) by scanning `tasks/` for the max.

### 2.1 `messages.jsonl` — one JSON object per line

```json
{"id":"m_1727000000123","at":"2026-09-23T10:00:00Z","from":"daniel","kind":"chat","text":"Add dark mode to the settings page in jobcarver"}
{"id":"m_…","at":"…","from":"mia","kind":"question","text":"Only the settings page, or the whole app?","options":["Settings only","Whole app"],"taskId":"0007","questionId":"q_…"}
{"id":"m_…","at":"…","from":"daniel","kind":"answer","text":"Whole app","questionId":"q_…","taskId":"0007"}
{"id":"m_…","at":"…","from":"mia","kind":"notify","text":"0007 done — dark mode is in, PR #42 opened.","taskId":"0007","urgent":false}
{"id":"m_…","at":"…","from":"system","kind":"event","text":"Executor for 0007 finished"}
```

- `from`: `daniel` | `mia` | `system`
- `kind`: `chat` (no push) | `question` (push, expects answer) | `notify` (push) | `answer` | `event` (system, shown muted in the thread)
- `read`: the panel marks Mia's messages read by sending `miaRead {upTo: id}`; the app stores `readUpTo` in `state.json`. Badge = Mia messages after `readUpTo` plus unanswered questions.

### 2.2 `tasks/<id>.json`

```json
{
  "id": "0007",
  "title": "Add dark mode to settings",
  "detail": "Daniel's full wording / any extra context",
  "dir": "/Users/danielmoen/jobcarver",
  "status": "running",
  "priority": 2,
  "createdAt": "…", "updatedAt": "…",
  "questions": [
    {"id":"q_…","text":"…","options":["…"],"askedAt":"…","answer":"Whole app","answeredAt":"…"}
  ],
  "executor": {"sessionId":"…","model":"claude-opus-5-5","dispatchedAt":"…","finishedAt":null},
  "log": [{"at":"…","text":"Dispatched executor"}],
  "result": null
}
```

`status`: `queued` → `asking` (waiting on Daniel) → `running` (executor working)
→ `checking` (Mia reviewing) → `done` | `failed` | `cancelled`. Mia sets
statuses via the CLI; the app sets `checking` automatically when an executor
session ends. `priority` 1 = highest, default 3.

### 2.3 `schedule.json`

```json
{
  "heartbeats": [
    {"id":"hb_inbox","label":"Inbox check","everyMinutes":30,"prompt":"Check the Gmail inbox and calendar. Tell Daniel only if something needs him. Stay silent otherwise.","enabled":true},
    {"id":"hb_brief","label":"Morning brief","at":"07:30","prompt":"Morning brief: unread mail that matters, today's calendar, and the state of the task list — one `mia notify`.","enabled":true}
  ],
  "reminders": [
    {"id":"r_…","at":"2026-09-25T09:00:00Z","text":"Chase the invoice","taskId":null,"fired":false}
  ]
}
```

Defaults are seeded by the app the first time the file is missing.
`everyMinutes` or a daily `at` (local time `HH:MM`). The app fires each by
typing an event into Mia's terminal (section 4).

### 2.4 `events.jsonl`

Every event the app delivers to Mia is appended here too, with
`"delivered": true|false`. If Mia's terminal is unreachable the app retries
every 5 s; `mia inbox` prints the last 50 so a freshly restarted Mia can catch
up. The app marks an entry delivered once `send` returns `.sent`.

```json
{"id":"e_…","at":"…","kind":"answer|chat|task|executor|reminder|heartbeat|system","text":"…","delivered":true}
```

---

## 3. The `mia` CLI

Bash script, source of truth at `scripts/mia`, embedded byte-for-byte in
`ToolingInstaller.swift` and installed to `~/.mission-control/bin/mia` at app
launch (exactly the `mc-doc` pattern). Needs only bash + `python3` (for JSON;
macOS ships it) — no node dependency. All writes are atomic (write temp + mv).

```
mia say    "<text>" [--task <id>]                     chat message to Daniel, no push
mia notify "<text>" [--task <id>] [--urgent]           message + push + Mac banner
mia ask    "<question>" [--options "A|B|C"] [--task <id>]
                                                       question; push; prints the question id;
                                                       task status -> asking when --task given
mia task list [--status <s>]                           id<TAB>status<TAB>priority<TAB>title per line
mia task show <id>                                     the task JSON
mia task add "<title>" [--detail <text>|--stdin] [--dir <d>] [--priority n]
                                                       prints the new id
mia task set <id> <status|dir|priority|result|title> <value>
mia task note <id> "<text>"                            append to the task's log
mia dispatch <id> [--dir <d>] [--model <m>] --brief-file <f> | --stdin
                                                       write dispatch/<id>.json + briefs/<id>.md;
                                                       the app launches the executor
mia tell <id> "<text>"                                 type text into task <id>'s executor terminal
                                                       (writes dispatch/<id>.tell.json; app delivers)
mia remind --at <ISO-8601|HH:MM|+2h|+30m> "<text>" [--task <id>]
mia inbox [-n 50]                                      recent system events (catch-up after restart)
mia status                                             one-screen summary: tasks by status, open questions
mia help
```

The CLI never talks to the app directly; it writes files and the app's
watcher (1 s mtime poll, same style as transcript discovery) reacts.

---

## 4. Messages the app types into Mia's terminal

Every delivered event is one line, prefixed so Mia can recognise it, sent via
`AgentManager.send(_:to:)` (which already handles the paste-detection delay).

```
[MC] Daniel: <text>                                      (chat)
[MC] Daniel answered q_… (task 0007): <text>             (answer)
[MC] New task 0009 queued: <title>                        (task added from panel)
[MC] Executor for task 0007 finished (session <id>). Review it: mia task show 0007 ; report at ~/.mission-control/mia/briefs/0007.report.md
[MC] Executor for task 0007 exited without finishing.
[MC] Reminder: <text>                                     (reminder)
[MC] Heartbeat "<label>": <prompt>                        (heartbeat)
[MC] You were restarted. Run `mia inbox` and `mia status` to catch up.   (first message after a relaunch)
```

Several events that arrive within 2 s are batched into one send, one per line.

---

## 5. Mia's prompt (embedded in Swift, launched as the initial argument)

Must begin with `You are Mia` — that prefix is how the app identifies her
session (`AgentRun.isMia`, mirroring `isManager`).

```
You are Mia, Daniel's assistant inside Mission Control. You run on his Mac as a long-lived session. Your job: take the tasks he gives you, get them done through executor agents, ask him only what genuinely needs asking, and keep him posted. You are calm, brief, and direct. You never write or edit code yourself.

HOW YOU TALK TO DANIEL
- Everything you want him to see goes through the CLI at ~/.mission-control/bin/mia (it is on PATH as `mia`). Plain terminal output is NOT seen by him.
- `mia say "…"` for conversation. `mia notify "…"` when he should be pinged (a task finished, something in mail needs him). `mia ask "…" --options "A|B|C"` when you need a decision — give options whenever you can so he can answer with one tap. Batch questions: one `mia ask` per task, not five.
- After asking, END YOUR TURN. Do not poll, sleep, or loop. Mission Control delivers his answer as a message starting with `[MC]`.

HOW EVENTS REACH YOU
- Messages starting with `[MC]` come from Mission Control: Daniel's chat and answers, new tasks, executor results, reminders, heartbeats. Handle them and end your turn.
- On startup or after `[MC] You were restarted`, run `mia status` and `mia inbox` to catch up.

TASKS
- `mia task list / show / add / set / note` manage the list. Statuses: queued → asking → running → checking → done | failed | cancelled.
- For each queued task: decide if the brief is clear enough. If not, `mia ask` (status becomes asking). If yes, pick the folder (Daniel's projects are under ~; check the task's dir, ask if unknown), write a precise brief, and `mia dispatch <id> --dir <folder> --stdin` with the brief on stdin. The executor is an Opus Claude Code session in that folder. Never run two tasks in the same folder at once.
- When `[MC] Executor for task <id> finished` arrives, read the report, check it (you may read files and run tests, never edit), then `mia task set <id> status done` and `mia notify` with a one-line summary — or `mia tell <id> "…"` to send the executor corrections and keep it running.
- Keep task notes short and factual with `mia task note`.

MAIL AND CALENDAR
- You have a Gmail and Calendar MCP for the account daniel.moen32@gmail.com — that is YOUR mailbox, set up for you. Read freely. You may reply and send from it. Anything involving Daniel's personal address or money goes through `mia ask` first.
- On a heartbeat, check the inbox and calendar and speak ONLY if something changed and matters. Silence is the right answer most of the time.
- `mia remind --at <time> "…"` for anything that needs a follow-up.

RULES
- Never `sleep`, never loop waiting for files. End your turn and wait for `[MC]`.
- Never kill or interfere with other agents on the Mac.
- Never touch code, git, or files outside ~/.mission-control/mia/ except to read.
- One line is usually enough. Daniel reads you on his phone.

Start now: run `mia status`, greet Daniel with one short `mia say` if this is your first start (state.json restarts == 0), then handle anything queued.
```

## 6. Executor prompt

Must begin with `You are executing Mission Control task <id>` — the app
identifies executor sessions by that prefix and records `run.miaTaskId`.

```
You are executing Mission Control task <id> for Mia, Daniel's assistant. Work in this folder only. Do the task described below fully, run tests where they exist, and commit nothing unless the brief says to.

Do NOT ask Daniel anything and do not use AskUserQuestion. If you are blocked or need a decision, write it with `mia task note <id> "BLOCKED: …"` and stop — Mia will answer via a message starting with `[MC]`.

When finished, write a short report (what you did, what you verified, anything left) to ~/.mission-control/mia/briefs/<id>.report.md, then `mia task note <id> "DONE"` and end your turn.

BRIEF
<brief>
```

Executors are launched with the normal `--dangerously-skip-permissions`
command in the task's `dir`, model from the dispatch file (default Mia's
model), **without** the strict MCP config (they are ordinary agents).

---

## 7. Mac app behaviour (MiaManager)

- **Watch** `~/.mission-control/mia/` every 1 s (mtime), like transcripts.
- **Identity**: `AgentRun.isMia` (prompt prefix) and `AgentRun.miaTaskId`
  (executor prefix). Mia's session id is written to `state.json`.
- **Start / relaunch**: when `settings.miaEnabled` and no live Mia run exists,
  launch her (also on `miaStart`). Backoff 10 s, 30 s, 60 s on repeated exits.
  Increment `restarts` in `state.json`; the first delivery after a relaunch is
  the restart notice (section 4).
- **Deliver events** (section 4) via `manager.send`; retry every 5 s while
  Mia's terminal is not reachable; batch within 2 s.
- **Panel messages**: `miaSend` appends `{from:daniel, kind:chat}` and delivers;
  `miaAnswer` records the answer on the task's question, appends
  `{kind:answer}`, delivers, and flips the task `asking` → `queued` if it was asking.
- **Notify**: when a `mia notify` / `mia ask` line lands in `messages.jsonl`,
  post a Mac banner (`Notifier`, title "Mia", body text) and send the relay a
  `push` frame (section 8).
- **Dispatch**: a new `dispatch/<id>.json` → launch the executor in its dir,
  set task `running`, record `executor.dispatchedAt`; correlate the session
  the way fleets do (same resolved dir, `firstSeen` ≥ dispatch time, prompt
  prefix matches) and store `executor.sessionId`; delete the dispatch file.
  `dispatch/<id>.tell.json` → `send` its text to that executor, delete it.
- **Executor end**: when a run with `miaTaskId` goes `.done` (or its process
  exits), set task `checking`, `executor.finishedAt`, and deliver the
  "Executor … finished" event to Mia.
- **Schedule**: tick every 30 s. Fire due reminders (mark `fired`) and
  heartbeats (`everyMinutes` since last fire; daily `at` once per day, tracked
  in `state.json.lastHeartbeat[id]`). Nothing fires while Mia is disabled.
- **Settings**: `miaEnabled` (default false), `miaModel` (default
  `claude-opus-5-5`), `miaReadUpTo`.
- **Local UI**: no new macOS UI beyond a "Mia" toggle in the ⚙ settings menu.
  Everything else is the web panel.

---

## 8. Wire protocol additions

### Snapshot (host → viewers), new top-level key

```json
"mia": {
  "enabled": true, "online": true, "sessionId": "…", "model": "claude-opus-5-5",
  "restarts": 1, "readUpTo": "m_…",
  "messages": [ …last 200 lines of messages.jsonl… ],
  "tasks": [ …every tasks/<id>.json, cancelled/done older than 7 days omitted… ],
  "pendingQuestions": [ {"questionId":"q_…","taskId":"0007","text":"…","options":["…"],"askedAt":"…"} ],
  "schedule": { …schedule.json… },
  "pushKey": "<VAPID public key, if the relay told the host one>"
}
```

### Commands (viewer → host), all acked with `{type:"ack", cmd, ok, detail}`

| type | fields |
|------|--------|
| `miaSend` | `text` |
| `miaAnswer` | `questionId`, `text` |
| `miaRead` | `upTo` (message id) |
| `miaTaskAdd` | `title`, `detail?`, `dir?`, `priority?` (positive int, default 3). Ack carries `id` of the new task. |
| `miaTaskCancel` | `id` |
| `miaTaskSet` | `id`, `field`, `value` (status/priority/dir) |
| `miaStart` / `miaStop` | — (`miaStop` kills her session and sets enabled=false; `miaStart` sets enabled=true and launches) |
| `miaSetModel` | `model` |
| `miaSchedule` | `op: "addReminder"|"removeReminder"|"setHeartbeat"|"removeHeartbeat"`, `item` (the reminder/heartbeat object; `{id}` alone for the remove ops) |
| `miaPushTest` | — (host sends a test push) |

### Push (host → relay → phones)

Host sends `{type:"push", title, body, tag?, url?, urgent?}`. The relay does
**not** fan this out to viewers as-is (they get the message through the
snapshot); it sends a Web Push to every stored subscription. Relay → host on
host connect: `{type:"pushKey", key:"<VAPID public>"}` so the host can put it
in the snapshot; the panel also fetches it from `GET /push/key`.

### Relay HTTP (token-auth like everything else)

```
GET  /push/key                → {"key": "<VAPID public key>"}
POST /push/subscribe          body: PushSubscription JSON (+ optional "label")
POST /push/unsubscribe        body: {"endpoint": …}
```

VAPID keys come from env `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
`VAPID_SUBJECT` (mailto:). If missing, the relay generates a pair at boot,
logs them with a "set these on Railway to keep subscriptions valid" message,
and uses them for the process lifetime. Subscriptions are kept in memory and
in `PUSH_STORE` (default `./push-subscriptions.json`); the panel re-subscribes
on every load so a redeploy heals itself. Dead endpoints (410/404) are dropped.
Use the `web-push` npm package.

### REST (`remote/api.js`), for OpenClaw and scripts

```
GET  /api/v1/mia                     the snapshot's mia block
POST /api/v1/mia/message   {text}    → miaSend
POST /api/v1/mia/answer    {questionId,text}
POST /api/v1/mia/tasks     {title,detail?,dir?,priority?}
```

---

## 9. Panel

- New dock item **Mia** (first position, icon: a simple spark/assistant glyph
  from lucide), hash route `#mia`, keyboard `5`. Badge = unread Mia messages +
  pending questions.
- **Mia view**, Studio Glass design language (frosted glass over the photo,
  no blue, no glow, no bubbles-as-decoration). Two regions, stacked on phone,
  side by side on iPad/desktop:
  1. **Thread** — messages.jsonl rendered as a conversation. Mia's questions
     render with option pills + a free-text field; answered ones show the
     answer inline. `notify` messages get a subtle accent. System events are
     muted one-liners. Composer at the bottom with the existing mic dictation.
  2. **Tasks** — board grouped by status (Queued / Asking / Running /
     Checking / Done, failed+cancelled collapsed). Add-task field at the top
     with an optional folder picker (uses `knownDirs`). Each card: title,
     folder, priority, executor link (opens the executor's agent view),
     result when done, cancel.
- **Header**: Mia online/offline dot, model select, Start/Stop, a bell button
  that requests notification permission, registers `sw.js`, subscribes, and
  POSTs to `/push/subscribe`; shows "Notifications on" once done, and a
  "Test" button (`miaPushTest`).
- **Attention cards**: pending Mia questions appear as cards with pills
  (kind `mia`), answering sends `miaAnswer`.
- **Service worker** `public/sw.js`: shows the push (`title`, `body`, `tag`),
  click focuses/opens the panel at `#mia`. `public/manifest.json` with
  `display: standalone` (required for iOS push); link it from `index.html`.
- **Car mode**: read a pending Mia question aloud and accept a spoken answer
  (nice-to-have; do last).
