# Channels in Mission Control (task 0260)

The Channels view in the panel (dock → **Channels**, key `7`, `#channels`, `#channels/<key>`) shows every YouTube
channel Mia runs: active channels as cards (posting ring for the week's Shorts target, streak, rolling counters,
the furthest video's checkpoint bar), parked channels collapsed, the four lineup channels as "starting" until
their first `status.json`, a pipeline of every video with animated checkpoints
(Idea → Script → Voice → Visuals → Render → QA → Ready → Uploaded → Scheduled → Public), a video sheet (player,
checkpoints with time + file on hover/tap, next step, numbers, controls) and analytics (views per day, views per
Short, top 5, first 24 h vs the median, subscribers over time, all channels + "double down on", and for Raw
Incident Shorts vs long and retitle before/after).

## How the data moves

Same pattern as Jarvis HQ: the relay can't reach the Mac, so the Mac pushes.

```
~/channels-hq (Mac, :8090)                    relay (Railway)                         panel
 hq/sync.py every 20 s ── PUT  /api/v1/channels/state ──► channels.json ◄── GET /api/v1/channels (15 s poll)
                      ◄── GET  /api/v1/channels/actions ── queue      ◄── POST /api/v1/channels/action
                      ── PUT  /api/v1/channels/media/<id>?size= ──► channels-media/ ◄── GET …/media/<id> (Range)
 actions.jsonl ◄─ files each tap; Mia marks done ─► status flows back in the next state push
```

- **Controls are requests to Mia, never YouTube.** Approve, Reject (note), Make the next 10, Pause/Resume channel,
  Schedule (slot), Publish now (confirmation sheet), Regenerate thumbnail, Change title. Each tap goes to Mia as a
  chat line (`Channels: … Action a_…`) and into the relay queue; Channels HQ files it in
  `~/.mission-control/mia/channels/actions.jsonl`. If the chat line couldn't be sent (Mac offline), the panel keeps
  it in an outbox and Channels HQ sets a one-minute `mia remind` so Mia still hears about it. Mia closes it with
  `cd ~/channels-hq && .venv/bin/python -m hq.actions done <id> [note]` (or `failed <id> <why>`); the panel shows
  Queued → Done/Failed.
- **Media:** the Mac pre-pushes thumbnails, Short posters and logos of active channels; anything else (an mp4 you
  tap to play) is asked for on demand: the relay answers 202, the Mac uploads within ~20 s, the panel retries.
  LRU cache capped by `CHANNELS_MEDIA_MB` (default 1024).
- **Public stats only** (yt-dlp, no login), "Public stats, updated HH:MM" in the header.

## Files

| Where | What |
|---|---|
| `remote/channels.js` | relay routes: state, action queue, media cache (Range, type sniffing, LRU) |
| `remote/server.js` | mounts `/api/v1/channels*`, `/health` → `channels` |
| `remote/api.js` | lists the routes on `GET /api/v1` |
| `remote/app/src/lib/channels.js` | polling, media URLs, actions (Mia line + queue + outbox), streak / week maths |
| `remote/app/src/views/channels/Channels.jsx` | overview, channel page, pipeline, video sheet + controls, analytics |
| `remote/app/src/views/channels/parts.jsx` | CheckpointBar, Ring, Counter, RelayImg / RelayVideo, AreaChart, Bars |
| `remote/app/src/App.jsx`, `shell/Dock.jsx`, `app.css` | route, dock item, keyboard 7, pulse keyframes |
| `remote/test/yt-channels-test.mjs` | relay unit/route test (24 checks) |
| `remote/test/yt-channels-panel-e2e.mjs` | relay + fake host + the real Channels HQ sync + headless panel (23 checks, screenshots, webm) |

No Mac app (Swift) change was needed. One follow-up for the next app release: `mia panel view channels` isn't
accepted yet (the CLI's `PANEL_VIEWS` list lives in ToolingInstaller.swift), so until then Daniel opens Channels
from the dock or with `#channels`.

## Deploy (Mia, after review)

```bash
# 1. review
git -C ~/widget-claude diff main...channels-0260 --stat
cd ~/widget-claude-0260/remote && npm run test:yt-channels && npm run test:api && npm run test:jarvis
npm run build && PLAYWRIGHT=~/PropIQ-design-0225/node_modules/playwright npm run test:yt-channels-panel

# 2. merge (main stays the deploy branch)
git -C ~/widget-claude checkout main && git -C ~/widget-claude merge --no-ff channels-0260 -m "Merge channels-0260 (Channels view, task 0260)"

# 3. deploy the relay + panel (the Dockerfile builds the panel)
cd ~/widget-claude/remote && railway up --detach
curl -s https://<relay-domain>/health | jq .channels       # → {"bytes":0,"receivedAt":null,…}

# 4. switch on the Mac side push
#    in ~/channels-hq/config/channels.json set "relay_sync": true, then
launchctl kickstart -k gui/$(id -u)/com.channels-hq
curl -s http://localhost:8090/api/health | jq .relay_sync  # → enabled: true, last_ok set, last_error null
```

Optional env on Railway: `CHANNELS_MEDIA_MB` (media cache cap, default 1024). Storage lands on the existing
volume (`channels.json`, `channels-media/`).

## Rollback

```bash
# Mac side first: stop pushing (the panel keeps the last state; nothing else depends on it)
#   ~/channels-hq/config/channels.json → "relay_sync": false
launchctl kickstart -k gui/$(id -u)/com.channels-hq

# relay + panel back to the previous main
git -C ~/widget-claude revert -m 1 <merge-commit> && cd ~/widget-claude/remote && railway up --detach
#   (or `railway redeploy` of the previous deployment from the Railway dashboard)
# optional cleanup on the volume: channels.json and channels-media/ (unused once reverted)
```

The relay change only adds routes under `/api/v1/channels`; nothing existing reads or writes them, so a revert
can't affect HQ, the Library, Mia or the fleet.
