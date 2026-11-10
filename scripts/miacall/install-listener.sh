#!/bin/bash
# Install (or remove: --remove) the always-on incoming-call watcher (task 0636):
# LaunchAgent com.mia.call.listen runs MiaCall.app --listen at login and keeps it alive.
# It runs the app's own binary, so macOS attributes it to MiaCall (its Accessibility grant).
set -euo pipefail
LABEL=com.mia.call.listen
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP=${MIA_CALL_APP:-$HOME/Applications/MiaCall.app}
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--remove" ]]; then rm -f "$PLIST"; echo "removed $LABEL"; exit 0; fi
[[ -x "$APP/Contents/MacOS/MiaCall" ]] || { echo "no $APP — run scripts/miacall/build.sh" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.mission-control/mia/facetime"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$APP/Contents/MacOS/MiaCall</string><string>--listen</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>15</integer>
<key>ProcessType</key><string>Interactive</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>StandardErrorPath</key><string>/dev/null</string>
<key>StandardOutPath</key><string>/dev/null</string>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL → $APP --listen (log: ~/.mission-control/mia/facetime/listen.log)"
