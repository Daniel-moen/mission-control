#!/bin/bash
# Build AgentWidget as a proper .app bundle so it has a bundle identifier and
# can post real macOS notifications via the UserNotifications framework.
# Ad-hoc code-signs it (enough for *local* notifications; no entitlements needed).
set -eo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP=".build/Mission Control.app"
BIN=".build/$CONFIG/AgentWidget"

echo "▸ Building ($CONFIG)…"
swift build -c "$CONFIG"

echo "▸ Assembling $APP…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/AgentWidget"
cp Info.plist "$APP/Contents/Info.plist"

echo "▸ Ad-hoc signing…"
codesign --force --sign - "$APP"

echo "✓ Built: $APP"
echo "  Launch with:  open \"$APP\""
