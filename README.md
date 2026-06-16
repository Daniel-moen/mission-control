# Mission Control

A macOS menu bar app for monitoring and commanding fleets of [Claude Code](https://claude.ai/code) agents in real time.

---

## What it does

Mission Control sits in your menu bar and watches every `claude` session running on your machine. The moment an agent starts writing to its transcript it lights up — live activity feed, token burn rate, plan progress, and a wall of fire that grows hotter the harder the fleet is working.

**Fleet tab** — Live cards for every active agent session, auto-discovered by watching `~/.claude/projects/`. Each card shows:
- Animated status ring (spinning while active, glowing while thinking)
- Activity sparkline — real event rate from the transcript, not a decoration
- Heartbeat equalizer that pulses with the agent's intensity
- Inline todo checklist mirroring the agent's `TodoWrite` plan with live progress
- Collapsible activity feed: bash commands, tool calls, model output, tool results
- Plan pop-out window with full markdown rendering and revision history
- Reply box — type directly into the agent's terminal without switching windows
- Quick-reply presets: Continue, Yes, Approve plan, Run tests, Stop
- Focus button — jumps straight to that agent's terminal tab

**Launch tab** — Spin up a coordinated fleet in seconds:
- Describe the mission once
- Toggle a manager agent on/off (runs on Opus by default, coordinates workers via `.mission-control/`)
- Add up to 8 workers, each on the model you choose (Opus / Sonnet / Haiku / Default)
- Hit launch — each agent opens in its own Terminal window and appears in Fleet automatically

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

Every Claude Code session writes a JSONL transcript to `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Mission Control scans that directory every 0.7s, picks up any transcript modified in the last 20 minutes, and tails new lines incrementally (it tracks a byte offset per file so it never re-reads).

### Status tracking

| Status | When |
|--------|------|
| **Working** | Transcript written in the last 60s *and* a `claude` process is alive in that directory |
| **Waiting** | No recent transcript writes, but the process is alive and the agent previously had work (probably waiting for your input) |
| **Done** | The last assistant turn ended with `end_turn` / `stop_sequence`, *or* the process has exited |

Liveness is tracked by scanning `ps` + `lsof` every ~2.5s in a background thread. A session is removed from the list after 5 consecutive misses (~12s) with no live process.

### Terminal control

Supported terminals and how they're driven:

| Terminal | Focus | Reply |
|----------|-------|-------|
| iTerm2 | AppleScript by TTY | AppleScript `write text` |
| Terminal.app | AppleScript by TTY | AppleScript `do script` |
| WezTerm | `wezterm cli activate-pane` | `wezterm cli send-text` |
| Ghostty, Alacritty, kitty, Hyper | `NSWorkspace` activate | Synthesized keystrokes (needs Accessibility) |

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
  main.swift          AppDelegate: menu bar, popover, spinner
  RootView.swift      Tab container, aurora background, celebration burst
  ContentView.swift   Fleet tab: filter/sort/search, dashboard chips
  AgentCard.swift     Per-agent card: rings, sparklines, feed, reply
  AgentModels.swift   AgentRun, FleetSummary, AgentTodo, LogLine
  AgentManager.swift  Discovery loop, transcript tailing, launch, fleet coordination
  BurnView.swift      Token burn tab: counter, rate, breakdown, leaderboard
  Fire.swift          FireView: tongues, embers, sparks, glow bed, hot core
  Effects.swift       AuroraBackground, Equalizer, Sparkline, StatusRing, Celebration
  LaunchView.swift    Launch tab: mission input, manager toggle, worker roster
  TerminalBridge.swift Terminal discovery (ps/lsof), focus, reply, launch
  Notifier.swift      UserNotifications + osascript fallback
  PlanWindow.swift    Plan pop-out window, markdown renderer
  Settings.swift      UserDefaults-backed preferences
  Theme.swift         AgentRun accent colours, status glyphs

Info.plist            Bundle metadata (id, LSUIElement for menu-bar-only)
bundle.sh             Build → assemble .app → ad-hoc sign
Makefile              Convenience targets: build, dev, release, clean
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

**Everything else (Ghostty, Alacritty, kitty…)** — needs **Accessibility** access to synthesize keystrokes. Grant it at `System Settings → Privacy & Security → Accessibility`. Mission Control will prompt you the first time you try to reply to an agent in one of these terminals.

---

## License

MIT — see [LICENSE](LICENSE).
