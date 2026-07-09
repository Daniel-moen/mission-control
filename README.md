# Mission Control

A macOS menu bar app for monitoring and commanding fleets of [Claude Code](https://claude.ai/code) agents in real time.

---

## What it does

Mission Control sits in your menu bar and watches every `claude` session running on your machine. The moment an agent starts writing to its transcript it lights up — live activity feed, token burn rate, plan progress, and a wall of fire that grows hotter the harder the fleet is working.

**Fleet tab** — Live cards for every active agent session, auto-discovered by watching `~/.claude/projects/`. Coordinated launches collapse into a single **fleet group** card (mission summary, roster counts, aggregate cost/tokens) that expands into each member's full card. Standalone sessions still show as individual cards. Each card shows:

- Animated status ring (spinning while active, glowing while thinking)
- Activity sparkline — real event rate from the transcript, not a decoration
- Heartbeat equalizer that pulses with the agent's intensity
- Inline todo checklist mirroring the agent's `TodoWrite` plan with live progress
- Collapsible activity feed: bash commands, tool calls, model output, tool results
- Plan pop-out window with full markdown rendering and revision history
- Reply box — type directly into the agent's terminal without switching windows
- Quick-reply presets: Continue, Yes, Approve plan, Run tests, Stop
- Focus button — jumps straight to that agent's terminal tab

The fleet dashboard also gives you filter pills (All / Working / Waiting / Done), sort modes, search when the list gets long, and a **broadcast** button to send the same message to every controllable agent at once.

**Launch tab** — Spin up a solo agent or a coordinated fleet in seconds:

- **Solo** — one agent, one mission, pick a model
- **Fleet** — describe the mission once, toggle a manager on/off (runs on Opus by default, coordinates workers via `.mission-control/`), add up to 8 workers each on the model you choose (Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5 / Default)
- Pick which terminal new sessions open in — Terminal.app, iTerm2, WezTerm, Ghostty, kitty, or Alacritty (only terminals actually installed on your Mac are offered)
- Recent working directories are remembered and one tap away
- Hit launch — each agent opens in its own window of your chosen terminal and appears in Fleet automatically (multi-agent launches grouped together)

**Burn tab** — Watch the tokens fly:

- Live fire animation whose intensity tracks the fleet's real-time token throughput
- Every new token batch triggers a flare — bigger batches = bigger burst
- Big counter with spring animation and fiery gradient
- Live tok/s readout
- Token breakdown bar (output / input / cache)
- Leaderboard of the biggest burners, with animated progress bars

**Remote panel** — a full Mission Control web app for the iPad (or any browser) via a tiny relay you deploy on Railway. Sidebar navigation in landscape, icon rail in portrait, bottom tabs on a phone; tapping any agent anywhere slides in an inspector with the full detail:

- **Dashboard** — fleet strength tiles (active / needs-you / done), burn rate with sparkline, spend, Mac link health, a "needs your call" queue, the live activity feed, and a broadcast bar.
- **Agents** — live cards mirrored from your Mac ~1×/second: status, current activity, plan progress, runtime/cost/burn. The inspector shows the objective, todo checklist, **a live terminal mirror** (the agent's actual screen, captured by TTY even at an idle prompt), the activity log, reply box + quick presets, and the kill switch.
- **Tasks** — a kanban board (to do / in progress / done) built live from every agent's `TodoWrite` plan; each card links back to its agent.
- **Projects** — fleets and working directories rolled up into project cards: member agents, aggregate plan progress, cost and tokens.
- **Analytics** — fleet-wide tok/s hero counter with a live chart, token breakdown bar (output / input / cache read / cache write, colorblind-safe palette), and a top-agents leaderboard.
- **Chat** — message any single agent (its transcript rendered as a conversation) or broadcast to all, with dictation via the mic button where the browser supports it.
- **Launch** — fire a solo agent or a manager-led fleet *from the iPad*: mission, working directory (recent folders one tap away), model per agent (Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5 / Default), up to 8 workers. Terminals open on the Mac as usual and the new agents appear on the board.

An emergency **Stop all** button rides in the header on every screen.

The Mac dials *out* to the relay over a WebSocket — nothing ever connects into your machine — and every connection (Mac and browser alike) must present a shared secret token. Terminal mirroring covers the scriptable terminals (iTerm2, Terminal.app, WezTerm — including quarantine-translocated WezTerm installs). See [Remote panel setup](#remote-panel-ipad) below.

**Menu bar icon** — Glanceable fleet state without opening anything:

- Bolt + green + count → agents are working
- Exclamation bubble + amber → an agent needs your input
- Check seal + dim → all done, nothing active
- Sparkles → fleet is quiet
- Braille spinner while active (8fps, no flicker)

---

## Requirements

- macOS 13 Ventura or later
- [Claude Code CLI](https://claude.ai/code) (`claude` in your PATH)
- Swift 5.9+ (ships with Xcode 15+)
- Xcode Command Line Tools or full Xcode

---

## Build & run

```bash
# Clone
git clone https://github.com/Daniel-moen/mission-control.git
cd mission-control

# Build & launch as a proper .app bundle (required for real notifications)
make release

# Or just build debug
make build
```

The `bundle.sh` script compiles, assembles the `.app`, and ad-hoc signs it. The bundle ID (`com.agentwidget.mission-control`) is what lets `UserNotifications` post real banners — without it the app falls back to `osascript` notifications attributed to Script Editor.

---

## How it works

### Session discovery

Every Claude Code session writes a JSONL transcript to `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Mission Control scans that directory on a **adaptive cadence** — every 0.7s while the dashboard popover is open (so the feed feels live), every 4s while it's closed (so the menu bar icon stays fresh without burning CPU). It picks up any transcript modified in the last 20 minutes and tails new lines incrementally (it tracks a byte offset per file so it never re-reads).

Live animations (aurora, equalizers, fire) also pause while the popover is hidden.

### Status tracking

| Status | When |
|--------|------|
| **Working** | Transcript written in the last 60s *and* a `claude` process is alive in that directory |
| **Waiting** | No recent transcript writes, but the process is alive and the agent previously had work (probably waiting for your input) |
| **Done** | The last assistant turn ended with `end_turn` / `stop_sequence`, *or* the process has exited |

Liveness is tracked by scanning `ps` + `lsof` every ~2.5s in a background thread. A session is removed from the list after 5 consecutive misses (~12s) with no live process.

### Fleet groups

When you launch two or more agents together, Mission Control registers a **fleet group** and correlates sessions to it after the fact — session IDs aren't known until transcripts appear. A session is claimed when its working directory matches the launch folder and it first appeared after that launch, so pre-existing agents in the same folder aren't swept in.

Groups show as a single collapsible card in the Fleet tab (mission title, working/waiting/done counts, total cost). Expand it and toggle between two views:

- **Board** (default) — a mission-control task board: a strip of aggregate metrics (combined task progress, live fleet burn rate in tok/s, total turns, spend, elapsed time) above one compact row per worker. Each worker row shows its role (Manager crowned, then Worker 1, 2, …), status, live "what it's doing right now" line, a step progress bar, and its full `TodoWrite` checklist — done (struck through), in-progress (highlighted), and pending — so you can see at a glance what every agent has finished and what it's working on. Fold any worker's checklist away to keep a big squad scannable.
- **Cards** — each member's full `AgentCard`, manager listed first.

### Terminal control

Supported terminals and how they're driven:

| Terminal | Focus | Reply | Launch |
|----------|-------|-------|--------|
| iTerm2 | AppleScript by TTY | AppleScript `write text` | AppleScript new window |
| Terminal.app | AppleScript by TTY | AppleScript `do script` | AppleScript new window |
| WezTerm | `wezterm cli activate-pane` | `wezterm cli send-text` | `wezterm start` |
| Ghostty | `NSWorkspace` activate | Synthesized keystrokes* | `ghostty -e` |
| kitty | `NSWorkspace` activate | Synthesized keystrokes* | `kitty` |
| Alacritty | `NSWorkspace` activate | Synthesized keystrokes* | `alacritty -e` |
| Hyper | `NSWorkspace` activate | Synthesized keystrokes* | — |

\* Needs **Accessibility** permission — see [Terminal permissions](#terminal-permissions).

Launches run inside your login shell so agents inherit your real PATH (node version managers, custom installs, etc.). Before starting `claude`, Mission Control also scrubs `CLAUDE_CODE*` / `CLAUDECODE` environment variables so agents launched from the menu bar aren't trapped in nested "child session" mode — the common reason a freshly launched agent never shows up in the fleet.

### Fleet coordination

When you launch with a manager, Mission Control writes a `.mission-control/` folder into your working directory:

```
.mission-control/
  mission.md          ← shared brief (written at launch)
  worker-1.md         ← manager writes each worker's assignment here
  worker-1.outbox.md  ← worker posts progress / results here
  worker-2.md
  worker-2.outbox.md
  RESULT.md           ← manager writes the final synthesis here
```

The manager and workers communicate purely through files — no sockets, no shared memory — so you can inspect the coordination in real time with any text editor.

---

## Project layout

```
Sources/AgentWidget/
  main.swift           AppDelegate: menu bar, popover, spinner
  RootView.swift       Tab container, aurora background, celebration burst
  ContentView.swift    Fleet tab: filter/sort/search, dashboard, broadcast
  FleetGroupCard.swift Collapsible card for a coordinated launch (Board/Cards toggle)
  FleetTaskBoard.swift Expanded fleet task board: aggregate metrics + per-worker todos
  AgentCard.swift      Per-agent card: rings, sparklines, feed, reply
  AgentModels.swift    AgentRun, FleetGroup, FleetSummary, AgentTodo, LogLine
  AgentManager.swift   Discovery loop, transcript tailing, launch, fleet coordination
  BurnView.swift       Token burn tab: counter, rate, breakdown, leaderboard
  Fire.swift           FireView: tongues, embers, sparks, glow bed, hot core
  Effects.swift        AuroraBackground, Equalizer, Sparkline, StatusRing, Celebration
  LaunchView.swift     Launch tab: solo/fleet, mission input, terminal picker
  TerminalBridge.swift Terminal discovery (ps/lsof), focus, reply, launch
  RemoteBridge.swift   WebSocket host: streams snapshots to the relay, runs remote commands
  Notifier.swift       UserNotifications + osascript fallback
  PlanWindow.swift     Plan pop-out window, markdown renderer
  Settings.swift       UserDefaults-backed preferences
  Theme.swift          AgentRun accent colours, status glyphs

Info.plist             Bundle metadata (id, LSUIElement for menu-bar-only)
bundle.sh              Build → assemble .app → ad-hoc sign
Makefile               Convenience targets: build, dev, release, clean
```

---

## Remote panel (iPad)

The `remote/` folder is a Node relay plus a Svelte + Tailwind web panel:

```
remote/
  server.js           Node relay: one "host" (your Mac) + N "viewer" (browser) sockets;
                      also serves the built SPA from dist/
  panel/              Panel source — Svelte 5 + Tailwind v4 (Vite)
  dist/               Built panel (created by `npm run build`; gitignored)
  vite.config.mjs     Build config (root=panel, outDir=dist)
  package.json        Runtime dep: ws · build deps: svelte, vite, tailwindcss
```

Build & run locally:

```bash
cd remote
npm install
npm run build          # emits dist/
MC_TOKEN=… npm start   # serves dist/ + runs the relay
# or: npm run dev      # Vite dev server for the panel
```

The panel is an iPad-first operations console: a fleet of large agent cards, a
full-screen agent workspace (live terminal mirror, plan, activity, resources,
reply), and a prominent voice composer (tap the mic → speak → live transcription
→ edit → send). Dark-first "Graphite + Electric" theme.

### Deploy (Railway)

```bash
cd remote
railway init                                 # create a project
railway up --detach                          # deploy
railway variables --set "MC_TOKEN=$(openssl rand -hex 24)"   # shared secret
railway domain                               # mint the public URL
```

### Point the app at it

The app reads three preferences (also surfaced in the ⚙ settings menu as the
**Remote panel (iPad)** toggle):

```bash
defaults write com.agentwidget.mission-control remoteURL "https://<your-domain>.up.railway.app"
defaults write com.agentwidget.mission-control remoteToken "<your MC_TOKEN>"
defaults write com.agentwidget.mission-control remoteEnabled -bool true
```

Restart Mission Control and it dials the relay. On the iPad, open the panel URL —
the ⚙ menu's **Copy panel link (with token)** gives you a link with the token baked
in; the panel stores it locally and strips it from the address bar. Add it to the
Home Screen for a full-screen app feel.

### How it works

- The Mac connects out as the single **host** and streams a JSON fleet snapshot
  (~1/s while anyone is watching); browsers connect as **viewers**.
- Viewer commands (`reply`, `broadcast`, `kill`, `launch`) are relayed to the Mac,
  executed through the same terminal bridge / launcher the local UI uses, and
  acknowledged back as a toast on the panel.
- Terminal mirrors are read every ~3s (AppleScript by TTY for iTerm2/Terminal.app,
  `wezterm cli get-text` for WezTerm), trimmed to the visible tail, and ride along
  with the snapshot — only while a viewer is connected.
- While at least one viewer is connected the app polls transcripts at the fast
  (popover-open) cadence so the remote feed reads as live; it drops back to the
  lazy cadence when the last viewer leaves.
- Every socket must present `MC_TOKEN`. No token, no data. The relay keeps no
  state beyond the last snapshot in memory.

---

## Notifications

Grant notification permission when prompted at first launch. You can also tune what fires from the settings menu (⚙ icon in the title bar):

- Agent finished (default: on)
- Agent waiting on you (default: on)
- Agent started (default: off)
- Sound (default: on)

The **Send test notification** button lets you confirm everything's wired up.

---

## Terminal permissions

**iTerm2 / Terminal.app / WezTerm** — no extra permissions needed. Mission Control talks to them via AppleScript or the WezTerm CLI and targets the exact tab/pane by TTY.

**Everything else (Ghostty, Alacritty, kitty, Hyper…)** — needs **Accessibility** access to synthesize keystrokes. Grant it at `System Settings → Privacy & Security → Accessibility`. Mission Control will prompt you the first time you try to reply to an agent in one of these terminals.

---

## License

MIT — see [LICENSE](LICENSE).
