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
- **Fleet** — describe the mission once, toggle a manager on/off (runs on Opus by default, coordinates workers via `.mission-control/`), add up to 8 workers each on the model you choose (Opus / Sonnet / Haiku / Default)
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

Groups show as a single collapsible card in the Fleet tab (mission title, working/waiting/done counts, total cost). Expand to see each member's full `AgentCard`, manager listed first.

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
  FleetGroupCard.swift Collapsible card for a coordinated launch
  AgentCard.swift      Per-agent card: rings, sparklines, feed, reply
  AgentModels.swift    AgentRun, FleetGroup, FleetSummary, AgentTodo, LogLine
  AgentManager.swift   Discovery loop, transcript tailing, launch, fleet coordination
  BurnView.swift       Token burn tab: counter, rate, breakdown, leaderboard
  Fire.swift           FireView: tongues, embers, sparks, glow bed, hot core
  Effects.swift        AuroraBackground, Equalizer, Sparkline, StatusRing, Celebration
  LaunchView.swift     Launch tab: solo/fleet, mission input, terminal picker
  TerminalBridge.swift Terminal discovery (ps/lsof), focus, reply, launch
  Notifier.swift       UserNotifications + osascript fallback
  PlanWindow.swift     Plan pop-out window, markdown renderer
  Settings.swift       UserDefaults-backed preferences
  Theme.swift          AgentRun accent colours, status glyphs

Info.plist             Bundle metadata (id, LSUIElement for menu-bar-only)
bundle.sh              Build → assemble .app → ad-hoc sign
Makefile               Convenience targets: build, dev, release, clean
```

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
