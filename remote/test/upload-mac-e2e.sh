#!/usr/bin/env bash
# Upload E2E against the REAL Swift receiver (Sources/AgentWidget/MiaUploads.swift):
# builds test/mac/main.swift with it, runs the pure-function self-test, then
# boots the relay, connects the harness as the Mac, uploads files over HTTP the
# way the panel does, and checks they land on disk with Mia's [MC] event.
#
#   cd remote && bash test/upload-mac-e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d -t mc-upload-mac)
PORT=8891
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$TMP"' EXIT
pass=0; fail=0
ok() { if eval "$1"; then pass=$((pass+1)); echo "  ✓ $2"; else fail=$((fail+1)); echo "  ✗ $2"; fi; }

echo "build"
swiftc -O ../Sources/AgentWidget/MiaUploads.swift test/mac/main.swift -o "$TMP/harness"
echo "self-test"
"$TMP/harness" selftest

echo "relay → Swift receiver"
MC_TOKEN=test PORT=$PORT UPLOAD_TMP="$TMP/relay" UPLOAD_MAX_MB=5 PUSH_STORE="$TMP/p.json" REALTIME_STORE="$TMP/r.json" TTS_STORE="$TMP/t.json" OPENAI_API_KEY= \
  node server.js >"$TMP/relay.log" 2>&1 &
for _ in $(seq 50); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.1; done
mkdir -p "$TMP/mia"
"$TMP/harness" $PORT test "$TMP/mia" >"$TMP/harness.log" 2>&1 &
sleep 2.5

post() { # file name caption batch
  curl -s -o "$TMP/resp.json" -w '%{http_code}' -X POST "http://localhost:$PORT/upload" \
    -H 'Authorization: Bearer test' -H "X-MC-Name: $(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$2")" \
    ${3:+-H "X-MC-Caption: $(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$3")"} \
    ${4:+-H "X-MC-Batch: $4" -H 'X-MC-Batch-Id: bT'} --data-binary @"$1"
}
{ printf '%%PDF-1.7\n'; head -c 3000000 /dev/urandom; printf '\n%%%%EOF\n'; } > "$TMP/big.pdf"
printf 'a,b\n1,2\n' > "$TMP/t.csv"
DAY=$(date +%Y-%m-%d)

code=$(post "$TMP/big.pdf" "Café menu (v2).pdf" "Summarise this for me")
ok '[ "$code" = 200 ]' "3 MB PDF delivered through the Swift receiver (HTTP $code)"
F="$TMP/mia/uploads/$DAY/Café menu (v2).pdf"
ok 'cmp -s "$TMP/big.pdf" "$F"' "byte-identical on disk at uploads/$DAY/Café menu (v2).pdf"
ok '[ "$(stat -f %Lp "$F")" = 600 ]' "saved 0600"
ok 'grep -qF "[MC] Daniel uploaded a file: $F (application/pdf, 2.9 MB) — note: Summarise this for me" "$TMP/mia/events.log"' "Mia's [MC] event line"
ok '[ -z "$(ls -A "$TMP/relay")" ]' "relay temp copy deleted after uploadDone"
code=$(post "$TMP/t.csv" "t.csv" "" "1/2"); code2=$(post "$TMP/t.csv" "t.csv" "" "2/2")
ok '[ "$code$code2" = 200200 ] && [ -f "$TMP/mia/uploads/$DAY/t-2.csv" ]' "same name twice → t.csv + t-2.csv"
ok 'grep -qF "uploaded a file (2 of 2): $TMP/mia/uploads/$DAY/t-2.csv (text/csv, 8 B)" "$TMP/mia/events.log"' "batch numbering"
echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
