# OpenClaw ↔ Mission Control

Lets an OpenClaw instance on **any** machine monitor and command the Claude Code
fleet on the Mac. OpenClaw only makes outbound HTTPS calls to the public relay
(`/api/v1` on the Railway domain) — no port forwarding, no VPN, no inbound
service on OpenClaw's machine.

```
OpenClaw box ── outbound HTTPS ──► relay (Railway) ── WebSocket ──► Mac host app
```

## Install on the OpenClaw machine

1. Copy the skill folder to the OpenClaw machine:

   ```bash
   scp -r mission-control/ <openclaw-box>:~/.openclaw/skills/mission-control/
   ```

   (Any skills directory OpenClaw loads from works — `~/.openclaw/skills/` is the
   default; a workspace `skills/` folder also works.)

2. Give OpenClaw the URL + token. In the dashboard, open **Settings → API
   access → Copy** to get this snippet with the real token filled in, then put it
   in the OpenClaw process environment (e.g. `~/.openclaw/.env`):

   ```bash
   MISSION_CONTROL_URL="https://mission-control-remote-production.up.railway.app"
   MISSION_CONTROL_TOKEN="<the shared MC_TOKEN>"
   ```

3. Restart OpenClaw and test: *"check on my agents"* — it should call
   `GET /api/v1/status` and report the fleet.

## What it can do

Everything the iPad panel can: list agents + live fleet stats, read any agent's
terminal, answer agent questions (menus or free text), broadcast, kill, launch
agents/fleets (incl. plan mode + library docs), one-shot research, and full
document-library CRUD + search. `GET /api/v1` is self-describing.

The API itself lives in `../api.js` and is tested by `npm run test:api`.
