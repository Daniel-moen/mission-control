#!/bin/bash
# Create (once) a stable, local, self-signed code-signing identity "Mia Local Signing" for
# MiaCall.app (task 0633). Ad-hoc signatures change on every build, so macOS (TCC) forgot the
# Accessibility + system-audio grants each rebuild. With a fixed certificate, the app's
# designated requirement is  identifier "com.mia.call" and certificate leaf = H"<sha1>",
# the same for every build, so the grants survive.
#
# The identity lives in its own keychain (~/Library/Keychains/mia-signing.keychain-db) with a
# random password in ~/.mission-control/mia/facetime/.signing-keychain-pass (0600), so codesign
# never needs the login keychain password and nothing prompts. The cert is not trusted for
# anything (it isn't added to any trust store); codesign and TCC don't need that.
# Idempotent: does nothing when the identity already exists.
set -euo pipefail
NAME="Mia Local Signing"
KC="$HOME/Library/Keychains/mia-signing.keychain-db"
PASSF="$HOME/.mission-control/mia/facetime/.signing-keychain-pass"
# codesign only finds identities in keychains on the user search list: add ours (keeps the rest).
in_list() { security list-keychains -d user | grep -q "mia-signing.keychain-db"; }
add_to_list() {
  in_list && return 0
  eval "local cur=($(security list-keychains -d user | tr '\n' ' '))"
  security list-keychains -d user -s "${cur[@]}" "$KC"
}

if [[ -f "$KC" && -f "$PASSF" ]]; then
  security unlock-keychain -p "$(cat "$PASSF")" "$KC"
  if security find-identity -p codesigning "$KC" | grep -q "\"$NAME\""; then add_to_list; echo "$KC"; exit 0; fi
fi

OPENSSL=$(command -v /opt/homebrew/bin/openssl || command -v openssl)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
umask 077
[[ -f "$PASSF" ]] || "$OPENSSL" rand -hex 24 > "$PASSF"
chmod 600 "$PASSF"
PASS=$(cat "$PASSF")
cat > "$TMP/cfg" <<CFG
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CFG
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 7300 -config "$TMP/cfg" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
# macOS `security import` only reads the legacy PKCS#12 ciphers.
"$OPENSSL" pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -passout "pass:$PASS" -out "$TMP/id.p12" 2>/dev/null \
  || "$OPENSSL" pkcs12 -export -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -passout "pass:$PASS" -out "$TMP/id.p12"

[[ -f "$KC" ]] || security create-keychain -p "$PASS" "$KC"
security set-keychain-settings "$KC"            # no auto-lock timeout
security unlock-keychain -p "$PASS" "$KC"
security import "$TMP/id.p12" -k "$KC" -P "$PASS" -T /usr/bin/codesign >/dev/null
# Let Apple's tools (codesign) use the key without a GUI prompt.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASS" "$KC" >/dev/null
security find-identity -p codesigning "$KC" | grep -q "\"$NAME\"" || { echo "identity not found after import" >&2; exit 1; }
add_to_list
echo "$KC"
