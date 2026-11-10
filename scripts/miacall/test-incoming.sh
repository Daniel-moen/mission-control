#!/bin/bash
# Incoming-call detection without a real call (task 0636): simulated AX trees (fixtures/*.json)
# → MiaCall --listen-test (the detector) → mia-phone's caller check (Daniel or not).
# Usage: scripts/miacall/test-incoming.sh [path to the MiaCall binary]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=${1:-}
if [[ -z "$BIN" ]]; then BIN=$(mktemp -d)/MiaCall; swiftc -O -o "$BIN" "$HERE/MiaCall.swift" -framework AVFoundation -framework CoreAudio -framework AudioToolbox -framework AppKit || exit 1; fi
D=$(mktemp -d); echo "+27835615106" > "$D/phone.txt"; printf "daniel.moen32@gmail.com\nname:Daniel Moen\n" > "$D/phone-callers.txt"
pass=0; fail=0
for f in "$HERE"/fixtures/*.json; do
  name=$(basename "$f" .json); want=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["expect"])' "$f")
  out=$("$BIN" --listen-test "$f" 2>/dev/null)
  n=$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$out")
  if [[ "$n" == 0 ]]; then got=none; else
    caller=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])[0]["caller"])' "$out")
    r=$(MIA_DIR="$D" MC_RELAY_URL=http://127.0.0.1:9 MC_TOKEN=x python3 "$HERE/../mia-phone" incoming --from "$caller" 2>/dev/null)
    if grep -q '"ignore": true' <<<"$r"; then got=other; else got=daniel; fi
  fi
  if [[ "$got" == "$want" ]]; then pass=$((pass+1)); echo "  ✓ $name → $got"; else fail=$((fail+1)); echo "  ✗ $name → $got (want $want) $out"; fi
done
echo "$pass passed, $fail failed"; [[ $fail == 0 ]]
