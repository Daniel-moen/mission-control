#!/bin/bash
# Build MiaCall.app (task 0621) into ${1:-~/Applications}. Ad-hoc signed: a rebuild
# changes its identity, so macOS asks for the permissions again.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); DEST=${1:-$HOME/Applications}; APP="$DEST/MiaCall.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -o "$APP/Contents/MacOS/MiaCall" "$HERE/MiaCall.swift" -framework AVFoundation -framework CoreAudio -framework AudioToolbox -framework AppKit
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.mia.call</string>
<key>CFBundleName</key><string>MiaCall</string>
<key>CFBundleExecutable</key><string>MiaCall</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>14.2</string>
<key>LSUIElement</key><true/>
<key>NSAudioCaptureUsageDescription</key><string>Mia hears the FaceTime call she placed, so she can talk with Daniel.</string>
<key>NSAppleEventsUsageDescription</key><string>Mia starts and ends her FaceTime calls.</string>
</dict></plist>
PL
codesign --force --sign - "$APP" >/dev/null
echo "$APP"
