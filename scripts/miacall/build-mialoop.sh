#!/bin/bash
# Build MiaLoop.driver (task 0632): a BlackHole build with TWO separate devices that
# share one buffer: "Mia Voice" (output only, MiaCall plays Mia into it) and "Mia Mic"
# (input only, FaceTime's microphone).
#
# Why: FaceTime's voice processor (AUVoiceProcessor in avconferenced) enables the *output
# tap* of its mic device and adds it to the echo reference. With BlackHole 2ch as the mic,
# Mia's voice is both the mic signal and the echo reference, so echo cancellation removes
# it completely: avconferenced logged uplink averagePower = -120 dB for the whole call
# (calls c_02afeb1960 and c_3b6edf36a1). An input-only "Mia Mic" has no output, so there
# is nothing of Mia's in the echo reference.
#
# No Xcode needed (clang + Command Line Tools). Installing needs admin (Daniel):
#   sudo cp -R ~/.mission-control/mia/facetime/MiaLoop.driver /Library/Audio/Plug-Ins/HAL/
#   sudo killall coreaudiod        # or reboot
# MiaCall picks the pair up by itself (MiaLoop_UID / MiaLoop_2_UID); BlackHole 2ch stays
# installed and is the fallback.
set -euo pipefail
OUT=${1:-$HOME/.mission-control/mia/facetime}
REV=6008d295ff00c8b57412a23564619963f4ecbeac   # BlackHole master, 0.7.1 (checked 10 Nov 2026)
FACTORY=2e0707a6-957c-4d2a-8be7-b7c4e63c8149   # unique, so it can sit beside BlackHole 2ch
WORK=$(mktemp -d /tmp/mialoop.XXXXXX)
git clone -q https://github.com/ExistentialAudio/BlackHole.git "$WORK/src"
git -C "$WORK/src" checkout -q "$REV"
DRV="$WORK/MiaLoop.driver"; mkdir -p "$DRV/Contents/MacOS"
clang -O2 -bundle -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -DDEBUG=0 \
  -D'kDriver_Name="MiaLoop"' -D'kPlugIn_BundleID="com.mia.loop"' -DkHas_Driver_Name_Format=false \
  -D'kDevice_Name="Mia Mic"' -D'kDevice2_Name="Mia Voice"' -D'kManufacturer_Name="Mia"' \
  -DkDevice_IsHidden=false -DkDevice_HasInput=true -DkDevice_HasOutput=false \
  -DkDevice2_IsHidden=false -DkDevice2_HasInput=false -DkDevice2_HasOutput=true \
  -DkNumber_Of_Channels=2 \
  -framework CoreAudio -framework CoreFoundation -framework Accelerate \
  -o "$DRV/Contents/MacOS/MiaLoop" "$WORK/src/BlackHole/BlackHole.c"
sed -e 's/${EXECUTABLE_NAME}/MiaLoop/; s/$(PRODUCT_BUNDLE_IDENTIFIER)/com.mia.loop/; s/${PRODUCT_NAME}/MiaLoop/; s/$(MARKETING_VERSION)/0.7.1/' \
    -e "s/e395c745-4eea-4d94-bb92-46224221047c/$FACTORY/g" \
    "$WORK/src/BlackHole/BlackHole.plist" > "$DRV/Contents/Info.plist"
plutil -lint "$DRV/Contents/Info.plist" >/dev/null
codesign --force --sign - "$DRV" >/dev/null
mkdir -p "$OUT"; rm -rf "$OUT/MiaLoop.driver"; cp -R "$DRV" "$OUT/"
rm -rf "$WORK"
echo "$OUT/MiaLoop.driver"
