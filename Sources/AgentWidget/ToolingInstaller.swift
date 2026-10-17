import Foundation

/// Installs the agent-facing tooling that lets *any* Claude Code agent on this
/// Mac reach the document library — not only agents launched from the panel:
/// the `mc-doc` CLI and the skill that teaches a model to file work with it.
///
/// A library file is reachable by anything that can write to disk, but an agent
/// only knows how to put work there if the tool and skill sit in their standard
/// locations. This owns exactly two paths and rewrites each only when the copy
/// it would install differs from what is already there, so an unchanged launch
/// touches nothing.
///
/// The embedded strings mirror, byte for byte, `scripts/mc-doc`, `scripts/mia`,
/// `scripts/mia-jarvis`
/// and `skills/mission-control-library/SKILL.md` in the repo (the short Mia
/// skill lives only here). Those are the
/// readable, testable source of truth; the app ships as a bundle, so a copy has
/// to live in the binary. Edit the repo files and regenerate — do not let the
/// two diverge.
enum ToolingInstaller {
    static func install() {
        // Off the main thread: this does filesystem work at launch and the only
        // thing waiting on it is a future agent's shell, not the UI.
        DispatchQueue.global(qos: .utility).async {
            let home = NSHomeDirectory()
            installFile(dir: home + "/.mission-control/bin",
                        name: "mc-doc", body: mcDoc, executable: true)
            installFile(dir: home + "/.claude/skills/mission-control-library",
                        name: "SKILL.md", body: skill, executable: false)
            installFile(dir: home + "/.mission-control/bin",
                        name: "mia", body: mia, executable: true)
            installFile(dir: home + "/.mission-control/bin",
                        name: "mia-jarvis", body: miaJarvis, executable: true)
            installFile(dir: home + "/.claude/skills/mission-control-mia",
                        name: "SKILL.md", body: miaSkill, executable: false)
        }
    }

    /// The embedded literals drop each file's final newline (a Swift multiline
    /// string omits the newline before its closing delimiter); restore it so the
    /// bytes on disk match the repo file exactly.
    private static func installFile(dir: String, name: String, body: String, executable: Bool) {
        let fm = FileManager.default
        let path = dir + "/" + name
        let desired = body + "\n"
        if let existing = try? String(contentsOfFile: path, encoding: .utf8), existing == desired {
            if executable { setExecutable(path) }
            return
        }
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        guard (try? desired.write(toFile: path, atomically: true, encoding: .utf8)) != nil else { return }
        if executable { setExecutable(path) }
    }

    private static func setExecutable(_ path: String) {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
    }

    private static let mcDoc = #"""
#!/usr/bin/env bash
# mc-doc — a command-line handle on the Mission Control document library.
#
# The library is one directory of markdown-with-frontmatter files that the
# Mission Control menu-bar app reads live (~1 Hz). Any agent on this Mac can
# create and update those files through this tool without going through the
# app, in the exact on-disk format DocLibrary.swift expects, so a report an
# agent writes here shows up in the panel within a second or two.
#
# Repo source of truth: scripts/mc-doc. ToolingInstaller.swift embeds a
# byte-for-byte copy and installs it to ~/.mission-control/bin/mc-doc; edit it
# here, not there.
#
# Byte-for-byte compatibility with DocLibrary.write matters: a file is
#   "---\n" + frontmatter-lines + "\n---\n" + body(with one trailing "\n")
# and frontmatter keys are written in the order kind, status, subject, tags,
# company, dir, session, created — with subject/tags/company/dir/session
# omitted when empty. (company — a Jarvis registry company/project id — is
# mc-doc's own key; the app reads it but does not write it yet.)

set -eu

# Byte-oriented everywhere: the body is copied verbatim and must survive
# whatever unicode it holds without the locale reinterpreting it.
export LC_ALL=C

LIB="${MC_LIBRARY:-$HOME/.mission-control/library}"
case "$LIB" in /*) ;; *) LIB="$PWD/$LIB" ;; esac

die() { printf 'mc-doc: %s\n' "$*" >&2; exit 1; }

# Ids arrive from arbitrary agents; never let one point outside the library.
valid_id() {
  case "$1" in
    ""|.*|*/*|*\\*|*..*) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

require_id() {
  valid_id "$1" || die "bad id: $1"
  [ -f "$LIB/$1" ] || die "no such doc: $1"
}

ensure_root() { mkdir -p "$LIB"; }

# A filesystem-safe slug from a title: lowercase, keep letters/digits, collapse
# spaces/dashes/underscores to a single dash, drop everything else, cap at 40.
slugify() {
  local s
  s=$(printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cd 'a-z0-9 _-' \
    | tr ' _' '--' \
    | sed -e 's/--*/-/g' -e 's/^-*//' -e 's/-*$//' \
    | cut -c1-40 \
    | sed -e 's/-*$//')
  [ -n "$s" ] || s=doc
  printf '%s' "$s"
}

# The markdown body of $1, frontmatter stripped, streamed verbatim.
get_body() {
  awk '
    NR==1 && $0=="---" { infront=1; next }
    infront==1 && $0=="---" { infront=2; next }
    infront==2 { print; next }
    infront==0 { print }
  ' "$LIB/$1"
}

# The opening "---" through the closing "---" inclusive, verbatim.
get_head() {
  awk '
    NR==1 && $0=="---" { print; infront=1; next }
    infront==1 { print; if ($0=="---") exit }
  ' "$LIB/$1"
}

# The trimmed value of a single frontmatter key ("" if absent).
front_val() {
  awk -v want="$2" '
    NR==1 && $0=="---" { infront=1; next }
    infront==1 && $0=="---" { exit }
    infront==1 {
      i=index($0, ":")
      if (i>0) {
        key=substr($0,1,i-1); val=substr($0,i+1)
        gsub(/^[ \t]+|[ \t]+$/,"",key)
        gsub(/^[ \t]+|[ \t]+$/,"",val)
        if (tolower(key)==want) { print val; exit }
      }
    }
  ' "$LIB/$1"
}

# The document title the app would show: first markdown heading in the body,
# else the first non-empty line, capped like DocLibrary.title(ofBody:).
doc_title() {
  get_body "$1" | awk '
    {
      t=$0; gsub(/^[ \t]+|[ \t]+$/,"",t)
      if (t=="") next
      if (substr(t,1,1)=="#") {
        h=t; sub(/^#+/,"",h); gsub(/^[ \t]+|[ \t]+$/,"",h)
        if (h!="") { print substr(h,1,90); exit }
      }
      if (fb=="") fb=substr(t,1,90)
    }
    END { if (fb!="") print fb }
  '
}

# "a, b ,c" -> "a, b, c"; blanks dropped, matching DocLibrary's tag writer.
normalize_tags() {
  printf '%s' "$1" | awk -v RS=',' '
    { gsub(/^[ \t\n]+|[ \t\n]+$/,"")
      if ($0!="") out = (out=="" ? $0 : out ", " $0) }
    END { printf "%s", out }'
}

trim() { printf '%s' "$1" | sed -e 's/^[[:blank:]]*//' -e 's/[[:blank:]]*$//'; }

# A frontmatter value on one line (a newline would forge a key), trimmed.
one_line() { trim "$(printf '%s' "$1" | tr '\n\r' '  ')"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Guarantee exactly one trailing newline on the body file, as DocLibrary.write does.
finalize_body_file() {
  if [ -s "$1" ] && [ "$(tail -c1 "$1" | od -An -tu1 | tr -d ' ')" = "10" ]; then
    return 0
  fi
  printf '\n' >>"$1"
}

# Emit a full document to stdout from F_* globals plus a body file ($1).
emit_doc() {
  printf -- '---\n'
  printf 'kind: %s\n' "$F_kind"
  printf 'status: %s\n' "$F_status"
  [ -n "$F_subject" ] && printf 'subject: %s\n' "$F_subject"
  [ -n "$F_tags" ] && printf 'tags: %s\n' "$F_tags"
  [ -n "${F_company:-}" ] && printf 'company: %s\n' "$F_company"
  [ -n "$F_dir" ] && printf 'dir: %s\n' "$F_dir"
  [ -n "$F_session" ] && printf 'session: %s\n' "$F_session"
  printf 'created: %s\n' "$F_created"
  printf -- '---\n'
  cat "$1"
}

# Atomically replace $LIB/$id with stdin, staged on the same filesystem.
replace_file() {
  local id="$1" tmp
  tmp=$(mktemp "$LIB/.mc-doc.XXXXXX")
  cat >"$tmp"
  mv "$tmp" "$LIB/$id"
}

require_val() { [ $# -ge 2 ] && [ -n "${2:-}" ] || die "$1 needs a value"; }

cmd_new() {
  local kind="" title="" subject="" tags="" company="" dir="" bodyfile="" stdin=0 base="" html="" summary=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --assets-from) require_val "$1" "${2:-}"; base=$2; shift 2 ;;
      --kind) require_val "$1" "${2:-}"; kind=$2; shift 2 ;;
      --title) require_val "$1" "${2:-}"; title=$2; shift 2 ;;
      --subject) subject=${2:-}; shift 2 ;;
      --tags) tags=${2:-}; shift 2 ;;
      --company) company=${2:-}; shift 2 ;;
      --dir) dir=${2:-}; shift 2 ;;
      --body-file) require_val "$1" "${2:-}"; bodyfile=$2; shift 2 ;;
      --stdin) stdin=1; shift ;;
      --html) require_val "$1" "${2:-}"; html=$2; shift 2 ;;
      --summary) summary=${2:-}; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  [ -n "$kind" ] || die "new needs --kind"
  [ -n "$title" ] || die "new needs --title"
  case "$kind" in plan|research|note|page) ;; *) die "kind must be plan|research|note|page" ;; esac
  if [ "$kind" = page ]; then
    [ -n "$bodyfile" ] && die "a page takes --html <file> (or --stdin), not --body-file"
    [ -n "$html" ] || [ "$stdin" -eq 1 ] || die "new --kind page needs --html <file> (or --stdin)"
  else
    [ -z "$html" ] || die "--html is for --kind page"
  fi

  ensure_root
  local slug id n
  slug=$(slugify "$title")
  id="$slug.md"; n=2
  while [ -e "$LIB/$id" ]; do id="$slug-$n.md"; n=$((n+1)); done

  if [ "$kind" = page ]; then
    local src_tmp=""
    if [ -z "$html" ]; then src_tmp=$(mktemp); cat >"$src_tmp"; html=$src_tmp; fi
    [ -n "$base" ] || { [ -n "$src_tmp" ] && base=$PWD || base=$(dirname "$html"); }
    F_kind=page
    F_status=done
    F_subject=$(trim "$subject")
    F_tags=$(with_page_tag "$tags")
    F_company=$(one_line "$company")
    F_dir=$(trim "$dir")
    F_session=""
    F_created=$(now_iso)
    # Reserve the id first (the stub), then import the page into it.
    local stub; stub=$(mktemp)
    printf '# %s\n' "$title" >"$stub"
    emit_doc "$stub" | replace_file "$id"
    rm -f "$stub"
    # (in a subshell: a failed import exits it, and we clean the stub up)
    ( page_import "$id" "$html" "$base" "$title" "$summary" ) || { rm -rf "$LIB/$id" "$LIB/${id%.md}.html" "$LIB/${id%.md}.assets"; [ -z "$src_tmp" ] || rm -f "$src_tmp"; exit 1; }
    [ -z "$src_tmp" ] || rm -f "$src_tmp"
    sync_assets "$id"
    printf '%s\n' "$LIB/$id"
    return 0
  fi

  local body_tmp; body_tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$body_tmp'" EXIT
  if [ "$stdin" -eq 1 ]; then
    cat >"$body_tmp"
  elif [ -n "$bodyfile" ]; then
    [ -f "$bodyfile" ] || die "no such body file: $bodyfile"
    cat "$bodyfile" >"$body_tmp"
  else
    printf '# %s\n\n' "$title" >"$body_tmp"
  fi
  finalize_body_file "$body_tmp"
  # Local image refs (./photo.jpg, ~/x.png) are attached and rewritten to assets/.
  [ -n "$base" ] || { [ -n "$bodyfile" ] && base=$(dirname "$bodyfile") || base=$PWD; }
  resolve_refs "$id" "$body_tmp" "$base"

  F_kind=$kind
  F_status=draft
  F_subject=$(trim "$subject")
  F_tags=$(normalize_tags "$tags")
  F_company=$(one_line "$company")
  F_dir=$(trim "$dir")
  F_session=""
  F_created=$(now_iso)
  emit_doc "$body_tmp" | replace_file "$id"
  sync_assets "$id"
  printf '%s\n' "$LIB/$id"
}

cmd_path() {
  local id="${1:-}"
  valid_id "$id" || die "bad id: $id"
  [ -f "$LIB/$id" ] || exit 1
  printf '%s\n' "$LIB/$id"
}

cmd_get() {
  require_id "${1:-}"
  get_body "$1"
}

cmd_list() {
  local fk="" fs="" ft=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) fk=${2:-}; shift 2 ;;
      --status) fs=${2:-}; shift 2 ;;
      --tag) ft=${2:-}; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  [ -d "$LIB" ] || return 0
  local f
  for f in "$LIB"/*.md; do
    [ -e "$f" ] || continue
    printf '%s\t%s\n' "$(stat -f %m "$f" 2>/dev/null || echo 0)" "$f"
  done | sort -rn | while IFS="$(printf '\t')" read -r _ f; do
    local id kind status tags title
    id=$(basename "$f")
    kind=$(front_val "$id" kind)
    status=$(front_val "$id" status)
    tags=$(front_val "$id" tags)
    # Match DocLibrary's defaults for pre-library files missing keys.
    if [ -z "$kind" ]; then
      if [ -n "$(front_val "$id" session)" ]; then kind=plan; else kind=note; fi
    fi
    [ -n "$status" ] || status=draft
    title=$(doc_title "$id")
    [ -n "$title" ] || title=${id%.md}
    [ -z "$fk" ] || [ "$fk" = "$kind" ] || continue
    [ -z "$fs" ] || [ "$fs" = "$status" ] || continue
    if [ -n "$ft" ]; then
      printf '%s' ", $tags," | grep -qi -- ", *$ft *," || continue
    fi
    printf '%s\t%s\t%s\t%s\n' "$id" "$kind" "$status" "$title"
  done
}

cmd_set() {
  local id="${1:-}" key="${2:-}" value="${3:-}"
  require_id "$id"
  [ -n "$key" ] || die "set needs a key"
  local body_tmp; body_tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$body_tmp'" EXIT
  get_body "$id" >"$body_tmp"

  F_kind=$(front_val "$id" kind)
  F_status=$(front_val "$id" status)
  F_subject=$(front_val "$id" subject)
  F_tags=$(front_val "$id" tags)
  F_company=$(front_val "$id" company)
  F_dir=$(front_val "$id" dir)
  F_session=$(front_val "$id" session)
  F_created=$(front_val "$id" created)
  [ -n "$F_kind" ] || { [ -n "$F_session" ] && F_kind=plan || F_kind=note; }
  [ -n "$F_status" ] || F_status=draft
  [ -n "$F_created" ] || F_created=$(now_iso)

  case "$key" in
    kind)   case "$value" in plan|research|note|page) ;; *) die "kind must be plan|research|note|page" ;; esac
            if [ "$value" = page ] && [ ! -f "$LIB/${id%.md}.html" ]; then die "no page HTML for $id (use: mc-doc page $id --html <file>)"; fi
            F_kind=$value ;;
    status) case "$value" in draft|active|done|archived) ;; *) die "status must be draft|active|done|archived" ;; esac; F_status=$value ;;
    subject) F_subject=$(trim "$value") ;;
    tags)    F_tags=$(normalize_tags "$value") ;;
    company) F_company=$(one_line "$value") ;;
    dir)     F_dir=$(trim "$value") ;;
    *) die "cannot set '$key' (only kind, status, subject, tags, company, dir)" ;;
  esac
  emit_doc "$body_tmp" | replace_file "$id"
}

cmd_write() {
  local id="${1:-}"; shift || true
  require_id "$id"
  is_page "$id" && die "$id is a page: update it with  mc-doc page $id --html <file>"
  local bodyfile="" stdin=0 base=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --assets-from) require_val "$1" "${2:-}"; base=$2; shift 2 ;;
      --stdin) stdin=1; shift ;;
      --body-file) require_val "$1" "${2:-}"; bodyfile=$2; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  local body_tmp; body_tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$body_tmp'" EXIT
  if [ "$stdin" -eq 1 ]; then
    cat >"$body_tmp"
  elif [ -n "$bodyfile" ]; then
    [ -f "$bodyfile" ] || die "no such body file: $bodyfile"
    cat "$bodyfile" >"$body_tmp"
  else
    die "write needs --stdin or --body-file"
  fi
  finalize_body_file "$body_tmp"
  [ -n "$base" ] || { [ -n "$bodyfile" ] && base=$(dirname "$bodyfile") || base=$PWD; }
  resolve_refs "$id" "$body_tmp" "$base"
  # Frontmatter is preserved verbatim — only the body changes.
  { get_head "$id"; cat "$body_tmp"; } | replace_file "$id"
  sync_assets "$id"
}

# ---------------------------------------------------------------------------
# Images (task 0124). A doc's pictures live next to it in <stem>.assets/ and
# the body points at them relatively: ![alt](assets/photo.jpg "Tag | caption").
# The Mac app lists only *.md, so the folder is invisible to it. Attaching
# shrinks big photos (max ${MC_DOC_IMG_MAX:-1600} px, JPEG) and keeps a small
# copy in .thumbs/ for the panel's inline view; then the files are pushed to
# the relay (the panel can't read the Mac's disk), which serves them under the
# same token as the docs. Pushing is skipped quietly when no relay is set up.

IMG_MAX=${MC_DOC_IMG_MAX:-1600}
THUMB_MAX=${MC_DOC_THUMB_MAX:-800}
KEEP_JPEG_BYTES=1572864   # a JPEG this small and within IMG_MAX is kept as-is
KEEP_PNG_BYTES=1048576    # same for PNG (screenshots, diagrams stay crisp)
MAX_SRC_BYTES=104857600   # refuse anything over 100 MB outright
MAX_GIF_BYTES=12582912    # GIFs are copied verbatim (animation), so cap them

assets_dir() { printf '%s/%s.assets' "$LIB" "${1%.md}"; }

valid_asset_name() {
  case "$1" in
    ""|.*|*/*|*\\*|*..*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9._-]*\.(jpg|png|gif)$'
}

# sips property ($2) of image $1, or "" if it isn't an image sips can read.
img_prop() { sips -g "$2" "$1" 2>/dev/null | awk -v k="$2" '$1==k":" && $2!="<nil>" { print $2; exit }'; }

file_bytes() { stat -f %z "$1" 2>/dev/null || wc -c <"$1" | tr -d ' '; }

# The asset name for source file $1 (or the --name $2), extension $3.
asset_name_for() {
  local base="${2:-$(basename "$1")}" stem
  stem=${base%.*}
  [ "$stem" != "" ] || stem=$base
  stem=$(slugify "$stem")
  printf '%s.%s' "$stem" "$3"
}

# Copy image $1 into the doc's assets as name $3 (format $4), shrinking it.
# Writes the full copy and, when it is bigger than THUMB_MAX, a thumb.
store_image() {
  local src="$1" adir="$2" name="$3" fmt="$4" w="$5" h="$6" bytes="$7"
  local max=$w; [ "$h" -gt "$max" ] && max=$h
  local tmp; tmp=$(mktemp "$adir/.in.XXXXXX")
  case "$fmt" in
    gif) cp "$src" "$tmp" ;;
    png)
      if [ "$max" -le "$IMG_MAX" ] && [ "$bytes" -le "$KEEP_PNG_BYTES" ]; then cp "$src" "$tmp"
      else sips -s format png -Z "$IMG_MAX" "$src" --out "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; die "could not convert $src"; }
      fi ;;
    jpg)
      if [ "$max" -le "$IMG_MAX" ] && [ "$bytes" -le "$KEEP_JPEG_BYTES" ] && [ "$(img_prop "$src" format)" = "jpeg" ]; then
        cp "$src" "$tmp"
      elif [ "$max" -gt "$IMG_MAX" ]; then
        sips -s format jpeg -s formatOptions 82 -Z "$IMG_MAX" "$src" --out "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; die "could not convert $src"; }
      else
        sips -s format jpeg -s formatOptions 82 "$src" --out "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; die "could not convert $src"; }
      fi ;;
  esac
  mv "$tmp" "$adir/$name"
  chmod 644 "$adir/$name"
  rm -f "$adir/.thumbs/$name"
  if [ "$fmt" != gif ] && [ "$max" -gt "$THUMB_MAX" ]; then
    mkdir -p "$adir/.thumbs"
    if [ "$fmt" = png ]; then
      sips -s format png -Z "$THUMB_MAX" "$adir/$name" --out "$adir/.thumbs/$name" >/dev/null 2>&1 || true
    else
      sips -s format jpeg -s formatOptions 76 -Z "$THUMB_MAX" "$adir/$name" --out "$adir/.thumbs/$name" >/dev/null 2>&1 || true
    fi
    if [ -f "$adir/.thumbs/$name" ]; then chmod 644 "$adir/.thumbs/$name"; fi
  fi
  return 0
}

# Attach one file to doc $1; prints the stored name. $3 = explicit name.
attach_one() {
  local id="$1" src="$2" want="${3:-}"
  [ -f "$src" ] || die "no such file: $src"
  local bytes; bytes=$(file_bytes "$src")
  [ "$bytes" -le "$MAX_SRC_BYTES" ] || die "too large (over 100 MB): $src"
  local sfmt w h fmt
  sfmt=$(img_prop "$src" format)
  w=$(img_prop "$src" pixelWidth); h=$(img_prop "$src" pixelHeight)
  case "$w$h" in ""|*[!0-9]*) sfmt="" ;; esac
  [ -n "$sfmt" ] || die "not an image this Mac can read: $src"
  case "$sfmt" in
    gif) fmt=gif; [ "$bytes" -le "$MAX_GIF_BYTES" ] || die "GIF over 12 MB: $src" ;;
    png) fmt=png
         # opaque big PNGs (photos saved as PNG) are far smaller as JPEG
         if [ "$(img_prop "$src" hasAlpha)" != "yes" ] && [ "$bytes" -gt "$KEEP_PNG_BYTES" ]; then fmt=jpg; fi ;;
    *) fmt=jpg ;;   # jpeg, heic, tiff, webp, bmp… → JPEG
  esac
  local name; name=$(asset_name_for "$src" "$want" "$fmt")
  valid_asset_name "$name" || die "bad asset name: $name"
  local adir; adir=$(assets_dir "$id")
  mkdir -p "$adir"
  store_image "$src" "$adir" "$name" "$fmt" "$w" "$h" "$bytes"
  printf '%s\n' "$name"
}

# Relay URL and token: env first, else the Mission Control app's settings.
relay_conf() {
  R_URL=${MC_RELAY_URL:-}
  R_TOKEN=${MC_TOKEN:-}
  if [ -z "$R_URL" ] && [ "${MC_DOC_NO_DEFAULTS:-0}" != 1 ]; then
    R_URL=$(defaults read com.agentwidget.mission-control remoteURL 2>/dev/null || true)
  fi
  if [ -z "$R_TOKEN" ] && [ "${MC_DOC_NO_DEFAULTS:-0}" != 1 ]; then
    R_TOKEN=$(defaults read com.agentwidget.mission-control remoteToken 2>/dev/null || true)
  fi
  R_URL=$(trim "$R_URL"); R_URL=${R_URL%/}
  case "$R_URL" in
    wss://*) R_URL="https://${R_URL#wss://}" ;;
    ws://*) R_URL="http://${R_URL#ws://}" ;;
    http://*|https://*) ;;
    "") ;;
    *) R_URL="https://$R_URL" ;;
  esac
  R_URL=${R_URL%/ws}
  R_TOKEN=$(trim "$R_TOKEN")
  [ -n "$R_URL" ] && [ -n "$R_TOKEN" ]
}

# Push doc $1's assets to the relay, skipping files it already has.
# Quiet no-op without a relay (or with MC_DOC_NO_SYNC=1). $2=strict → fail loudly.
sync_assets() {
  local id="$1" strict="${2:-}"
  [ "${MC_DOC_NO_SYNC:-0}" = 1 ] && return 0
  # A page's images go first, then its HTML (sync_page), so the page never
  # reaches the relay before the pictures it points at.
  if is_page "$id"; then
    sync_assets_only "$id" "$strict" || return 1
    sync_page "$id" "$strict"
    return $?
  fi
  sync_assets_only "$id" "$strict"
}

sync_assets_only() {
  local id="$1" strict="${2:-}"
  local adir; adir=$(assets_dir "$id")
  [ -d "$adir" ] || return 0
  if ! relay_conf; then
    [ -n "$strict" ] && die "no relay configured (set MC_RELAY_URL and MC_TOKEN, or the app's Remote settings)"
    printf 'mc-doc: images kept on this Mac only (no relay configured)\n' >&2
    return 0
  fi
  local stem=${id%.md} have failed=0 pushed=0 f name sha tsha
  have=$(curl -sS --max-time 20 -H "Authorization: Bearer $R_TOKEN" "$R_URL/api/v1/doc-assets/$stem/" 2>/dev/null || true)
  case "$have" in *'"ok":true'*) ;; *) have="" ;; esac
  for f in "$adir"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    valid_asset_name "$name" || continue
    sha=$(shasum -a 256 "$f" | awk '{print $1}')
    tsha=""
    [ -f "$adir/.thumbs/$name" ] && tsha=$(shasum -a 256 "$adir/.thumbs/$name" | awk '{print $1}')
    local entry
    entry=$(printf '%s' "$have" | grep -o "\"name\":\"$name\",\"bytes\":[0-9]*,\"sha256\":\"[0-9a-f]*\",\"thumb\":[^}]*" || true)
    case "$entry" in *"\"sha256\":\"$sha\""*) ;; *)
      if curl -sS --fail --max-time 120 -X PUT --data-binary @"$f" -H "Authorization: Bearer $R_TOKEN" \
           -H 'Content-Type: application/octet-stream' "$R_URL/api/v1/doc-assets/$stem/$name" >/dev/null 2>&1; then
        pushed=$((pushed+1))
      else
        failed=$((failed+1)); printf 'mc-doc: could not push %s to the relay\n' "$name" >&2
      fi ;;
    esac
    if [ -n "$tsha" ]; then
      case "$entry" in *"\"thumb\":\"$tsha\""*) ;; *)
        curl -sS --fail --max-time 120 -X PUT --data-binary @"$adir/.thumbs/$name" -H "Authorization: Bearer $R_TOKEN" \
          -H 'Content-Type: application/octet-stream' "$R_URL/api/v1/doc-assets/$stem/$name?size=thumb" >/dev/null 2>&1 \
          || { failed=$((failed+1)); printf 'mc-doc: could not push the thumb of %s\n' "$name" >&2; } ;;
      esac
    fi
  done
  [ "$pushed" -gt 0 ] && printf 'mc-doc: pushed %s image(s) to the relay\n' "$pushed" >&2
  if [ "$failed" -gt 0 ]; then
    printf 'mc-doc: %s upload(s) failed; the images are safe on this Mac — run: mc-doc sync %s\n' "$failed" "$id" >&2
    [ -n "$strict" ] && return 1
  fi
  return 0
}

# The python half of relative-image handling in new/write: list (mode=scan) or
# rewrite (mode=rewrite, with a "path<TAB>name" map) the local image refs of a
# markdown body. Fenced code is left alone; http(s)/data refs and ones already
# under assets/ are not touched (missing assets/ files are reported).
refs_py() {
  python3 - "$@" <<'PY'
import os, re, sys
from urllib.parse import unquote
mode, body, base, adir = sys.argv[1:5]
mp = {}
if mode == 'rewrite':
    for line in open(sys.argv[5], encoding='utf-8'):
        k, _, v = line.rstrip('\n').partition('\t')
        if k: mp[k] = v
IMG = re.compile(r'(!\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^\s)\n]+)((?:\s+"[^"\n]*")?\s*\))')
def resolve(ref):
    r = ref[1:-1] if ref.startswith('<') else ref
    if re.match(r'^(?:[a-z][a-z0-9+.-]*:|#|//)', r, re.I): return None
    r2 = re.sub(r'^\./', '', r)
    if r2.startswith('assets/'):
        if mode == 'scan' and not os.path.isfile(os.path.join(adir, r2[7:])):
            sys.stderr.write('mc-doc: warning: %s is not attached to this doc (mc-doc attach)\n' % r2)
        return None
    for cand in (r, unquote(r)):
        p = os.path.expanduser(cand)
        p = os.path.realpath(p if os.path.isabs(p) else os.path.join(base, p))
        if os.path.isfile(p): return p
    if mode == 'scan': sys.stderr.write('mc-doc: warning: image not found: %s\n' % r)
    return None
text = open(body, encoding='utf-8', errors='surrogateescape').read()
out, fence, seen = [], None, []
for line in text.split('\n'):
    m = re.match(r'^\s*(```+|~~~+)', line)
    if fence:
        if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence): fence = None
        out.append(line); continue
    if m:
        fence = m.group(1); out.append(line); continue
    def sub(mt):
        p = resolve(mt.group(2))
        if p is None: return mt.group(0)
        if mode == 'scan':
            if p not in seen: seen.append(p)
            return mt.group(0)
        name = mp.get(p)
        return mt.group(1) + 'assets/' + name + mt.group(3) if name else mt.group(0)
    out.append(IMG.sub(sub, line))
if mode == 'scan':
    for p in seen: print(p)
else:
    open(body, 'w', encoding='utf-8', errors='surrogateescape').write('\n'.join(out))
PY
}

# Attach every local image the body refers to and point the refs at assets/.
resolve_refs() {
  local id="$1" body="$2" base="$3"
  command -v python3 >/dev/null 2>&1 || { printf 'mc-doc: python3 missing; image refs left as written\n' >&2; return 0; }
  grep -q '!\[' "$body" || return 0
  local adir; adir=$(assets_dir "$id")
  local srcs; srcs=$(refs_py scan "$body" "$base" "$adir") || return 0
  [ -n "$srcs" ] || return 0
  local map; map=$(mktemp)
  local src name
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    name=$(attach_one "$id" "$src") || { rm -f "$map"; exit 1; }
    printf '%s\t%s\n' "$src" "$name" >>"$map"
    printf 'mc-doc: attached %s as assets/%s\n' "$src" "$name" >&2
  done <<EOF
$srcs
EOF
  refs_py rewrite "$body" "$base" "$adir" "$map"
  rm -f "$map"
  finalize_body_file "$body"
}

# A ready-to-paste markdown ref for asset $1 (caption $2, tag $3).
md_ref() {
  local name="$1" caption="$2" tag="$3" alt title=""
  alt=${caption:-${name%.*}}
  alt=$(printf '%s' "$alt" | tr -d '[]')
  if [ -n "$tag" ] && [ -n "$caption" ]; then title="$tag | $caption"
  elif [ -n "$tag" ]; then title="$tag |"
  else title="$caption"; fi
  title=$(printf '%s' "$title" | tr -d '"')
  if [ -n "$title" ]; then printf '![%s](assets/%s "%s")\n' "$alt" "$name" "$title"
  else printf '![%s](assets/%s)\n' "$alt" "$name"; fi
}

cmd_attach() {
  local id="${1:-}"; shift || true
  require_id "$id"
  local name="" caption="" tag="" nosync=0 files=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --name) require_val "$1" "${2:-}"; name=$2; shift 2 ;;
      --caption) caption=${2:-}; shift 2 ;;
      --tag) tag=${2:-}; shift 2 ;;
      --no-sync) nosync=1; shift ;;
      --) shift; while [ $# -gt 0 ]; do files+=("$1"); shift; done ;;
      -*) die "unknown flag: $1" ;;
      *) files+=("$1"); shift ;;
    esac
  done
  [ ${#files[@]} -gt 0 ] || die "attach needs at least one file"
  [ -z "$name" ] || [ ${#files[@]} -eq 1 ] || die "--name works with one file at a time"
  local f stored
  for f in "${files[@]}"; do
    stored=$(attach_one "$id" "$f" "$name") || exit 1
    md_ref "$stored" "$caption" "$tag"
  done
  [ "$nosync" -eq 1 ] || sync_assets "$id"
}

cmd_assets() {
  local id="${1:-}"
  require_id "$id"
  local adir; adir=$(assets_dir "$id")
  [ -d "$adir" ] || return 0
  local f name
  for f in "$adir"/*; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    valid_asset_name "$name" || continue
    printf '%s\t%s\t%sx%s\tassets/%s\n' "$name" "$(file_bytes "$f")" \
      "$(img_prop "$f" pixelWidth)" "$(img_prop "$f" pixelHeight)" "$name"
  done
}

cmd_sync() {
  local id="${1:-}"
  require_id "$id"
  sync_assets "$id" strict
}

cmd_detach() {
  local id="${1:-}"; shift || true
  require_id "$id"
  [ $# -gt 0 ] || die "detach needs a file name"
  local adir; adir=$(assets_dir "$id")
  local n
  for n in "$@"; do
    n=${n#assets/}
    valid_asset_name "$n" || die "bad asset name: $n"
    [ -f "$adir/$n" ] || die "not attached: $n"
    rm -f "$adir/$n" "$adir/.thumbs/$n"
    if [ "${MC_DOC_NO_SYNC:-0}" != 1 ] && relay_conf; then
      curl -sS --max-time 20 -X DELETE -H "Authorization: Bearer $R_TOKEN" \
        "$R_URL/api/v1/doc-assets/${id%.md}/$n" >/dev/null 2>&1 || true
    fi
  done
}

# ---------------------------------------------------------------------------
# Pages (task 0126). A page is a full, self-contained HTML page — the kind of
# thing a Claude artifact is — shown full-bleed in the panel inside a sandboxed
# frame. On disk:
#   <stem>.md      a stub (kind: page, tag "page", "# Title" + a summary) so
#                  the Mac app, `list` and the panel's Library see it like any doc;
#   <stem>.html    the page itself, local refs rewritten to assets/<name>;
#   <stem>.assets/ its images, through the same attach pipeline as markdown docs.
# The HTML and the images are pushed to the relay, which serves the page from
# /p/<capability>/<stem>/ with a strict CSP (see remote/docpages.js).

PAGE_MAX_BYTES=2097152   # the relay's cap: put images in assets, not data: URIs

page_file() { printf '%s/%s.html' "$LIB" "${1%.md}"; }
is_page() { [ -f "$(page_file "$1")" ]; }

# "a, b" → "page, a, b" (once).
with_page_tag() {
  local t; t=$(normalize_tags "$1")
  case ", $t, " in *", page, "*) printf '%s' "$t" ;; *) normalize_tags "page, $t" ;; esac
}

# The python half of page import: list the local files an HTML page refers to
# (mode=scan) or rewrite those refs to assets/<name> (mode=rewrite). Looks at
# src/href/poster/data-src, srcset lists and CSS url(...). Web, data:, blob:,
# #anchor and already-assets/ refs are left alone.
page_refs_py() {
  python3 - "$@" <<'PY'
import os, re, sys
from urllib.parse import unquote
mode, html, base, adir = sys.argv[1:5]
mp = {}
if mode == 'rewrite':
    for line in open(sys.argv[5], encoding='utf-8'):
        k, _, v = line.rstrip('\n').partition('\t')
        if k: mp[k] = v
IMG_EXT = re.compile(r'\.(jpe?g|png|gif|webp|heic|heif|tiff?|avif|bmp)$', re.I)
text = open(html, encoding='utf-8', errors='surrogateescape').read()
seen, warned = [], set()
def resolve(ref):
    r = ref.strip()
    if not r or re.match(r'^(?:[a-z][a-z0-9+.-]*:|#|//|\{)', r, re.I): return None
    r = r.split('#')[0].split('?')[0]
    if not r: return None
    r2 = re.sub(r'^\./', '', r)
    if r2.startswith('assets/'):
        if mode == 'scan' and not os.path.isfile(os.path.join(adir, r2[7:])) and r2 not in warned:
            warned.add(r2); sys.stderr.write('mc-doc: warning: %s is not attached to this page\n' % r2)
        return None
    for cand in (r, unquote(r)):
        p = os.path.expanduser(cand)
        p = os.path.realpath(p if os.path.isabs(p) else os.path.join(base, p))
        if os.path.isfile(p):
            if IMG_EXT.search(p): return p
            if mode == 'scan' and p not in warned:
                warned.add(p); sys.stderr.write('mc-doc: warning: %s is a local file the page cannot load; inline it (only images become assets)\n' % r)
            return None
    if mode == 'scan' and r not in warned and IMG_EXT.search(r):
        warned.add(r); sys.stderr.write('mc-doc: warning: image not found: %s\n' % r)
    return None
def one(ref):
    p = resolve(ref)
    if p is None: return ref
    if mode == 'scan':
        if p not in seen: seen.append(p)
        return ref
    name = mp.get(p)
    return 'assets/' + name if name else ref
ATTR = re.compile(r'(\b(?:src|href|poster|data-src|data-full|xlink:href)\s*=\s*)(["\'])(.*?)\2', re.I | re.S)
SRCSET = re.compile(r'(\b(?:srcset|data-srcset)\s*=\s*)(["\'])(.*?)\2', re.I | re.S)
URL = re.compile(r'(url\(\s*)(["\']?)([^"\')]+)\2(\s*\))', re.I)
def srcset(m):
    parts = []
    for item in m.group(3).split(','):
        bits = item.strip().split(None, 1)
        if not bits: continue
        bits[0] = one(bits[0])
        parts.append(' '.join(bits))
    return m.group(1) + m.group(2) + ', '.join(parts) + m.group(2)
text = SRCSET.sub(srcset, text)
text = ATTR.sub(lambda m: m.group(1) + m.group(2) + one(m.group(3)) + m.group(2), text)
text = URL.sub(lambda m: m.group(1) + m.group(2) + one(m.group(3)) + m.group(2) + m.group(4), text)
if mode == 'scan':
    for p in seen: print(p)
else:
    open(html, 'w', encoding='utf-8', errors='surrogateescape').write(text)
PY
}

# A one-paragraph plain-text summary of a page: <meta name=description>, else
# its first <p>, else "" — for the stub (the Library card's preview line).
page_summary_py() {
  python3 - "$1" <<'PY'
import html, re, sys
t = open(sys.argv[1], encoding='utf-8', errors='replace').read()
t = re.sub(r'(?is)<(script|style|template)\b.*?</\1\s*>', ' ', t)
m = re.search(r'(?is)<meta\s+[^>]*name\s*=\s*["\']description["\'][^>]*content\s*=\s*["\'](.*?)["\']', t)
s = m.group(1) if m else ''
if not s:
    m = re.search(r'(?is)<p\b[^>]*>(.*?)</p\s*>', t)
    s = m.group(1) if m else ''
s = html.unescape(re.sub(r'(?s)<[^>]+>', ' ', s))
s = re.sub(r'\s+', ' ', s).strip()
if len(s) > 320: s = s[:317].rsplit(' ', 1)[0] + '…'
print(s)
PY
}

# The asset name for page image $1, numbered past names in $2 (" a.jpg b.jpg ")
# — two files can slug to the same name (long names are cut at 40 chars).
page_asset_name() {
  local p="$1" used="$2" stem n=2 cand
  stem=$(slugify "$(basename "${p%.*}")")
  cand=$stem
  while case "$used" in *" $cand."*) true ;; *) false ;; esac; do
    cand="$(printf '%s' "$stem" | cut -c1-36)-$n"; n=$((n+1))
  done
  printf '%s' "$cand"
}

# Import HTML file $2 as page doc $1: attach its local images, rewrite refs to
# assets/<name>, write <stem>.html, refresh the stub. $3 base dir for relative
# refs, $4 title ("" = keep the stub's), $5 summary ("" = from the page).
page_import() {
  local id="$1" src="$2" base="$3" title="$4" summary="$5"
  [ -f "$src" ] || die "no such HTML file: $src"
  command -v python3 >/dev/null 2>&1 || die "pages need python3"
  local work; work=$(mktemp)
  cat "$src" >"$work"
  grep -qi '<[a-z!]' "$work" || { rm -f "$work"; die "that doesn't look like HTML: $src"; }
  local adir; adir=$(assets_dir "$id")
  local srcs; srcs=$(page_refs_py scan "$work" "$base" "$adir") || { rm -f "$work"; die "could not read $src"; }
  if [ -n "$srcs" ]; then
    local map used=" " p name count=0
    map=$(mktemp)
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      name=$(attach_one "$id" "$p" "$(page_asset_name "$p" "$used")") || { rm -f "$map" "$work"; exit 1; }
      used="$used$name "
      count=$((count+1))
      printf '%s\t%s\n' "$p" "$name" >>"$map"
    done <<SRCS
$srcs
SRCS
    page_refs_py rewrite "$work" "$base" "$adir" "$map"
    rm -f "$map"
    printf 'mc-doc: attached %s image(s) to the page\n' "$count" >&2
  fi
  [ "$(file_bytes "$work")" -le "$PAGE_MAX_BYTES" ] || { rm -f "$work"; die "page HTML over 2 MB (keep images as files next to it, not data: URIs)"; }
  local pf; pf=$(page_file "$id")
  local tmp; tmp=$(mktemp "$LIB/.mc-doc.XXXXXX")
  cat "$work" >"$tmp"; mv "$tmp" "$pf"; chmod 644 "$pf"
  [ -n "$summary" ] || summary=$(page_summary_py "$work")
  rm -f "$work"
  [ -n "$title" ] || title=$(doc_title "$id")
  # The stub: what the Mac app, `list` and the Library card read.
  local stub; stub=$(mktemp)
  {
    printf '# %s\n\n' "$title"
    if [ -n "$summary" ]; then printf '%s\n\n' "$summary"; fi
    printf '<!-- mc-doc page: the content is %s next to this file and opens full-bleed in the Mission Control panel. Update it with: mc-doc page %s --html <file> -->\n' "$(basename "$pf")" "$id"
  } >"$stub"
  { get_head "$id"; cat "$stub"; } | replace_file "$id"
  rm -f "$stub"
}

# Push page $1's HTML to the relay (after its images).
sync_page() {
  local id="$1" strict="${2:-}"
  [ "${MC_DOC_NO_SYNC:-0}" = 1 ] && return 0
  if ! relay_conf; then
    [ -n "$strict" ] && die "no relay configured (set MC_RELAY_URL and MC_TOKEN, or the app's Remote settings)"
    printf 'mc-doc: page kept on this Mac only (no relay configured)\n' >&2
    return 0
  fi
  if curl -sS --fail --max-time 60 -X PUT --data-binary @"$(page_file "$id")" -H "Authorization: Bearer $R_TOKEN" \
       -H 'Content-Type: text/html; charset=utf-8' "$R_URL/api/v1/doc-pages/${id%.md}" >/dev/null 2>&1; then
    printf 'mc-doc: pushed the page to the relay\n' >&2
    return 0
  fi
  printf 'mc-doc: could not push the page to the relay; it is safe on this Mac. Run: mc-doc sync %s\n' "$id" >&2
  [ -n "$strict" ] && return 1
  return 0
}

# mc-doc page <id>                    → the page's HTML path
# mc-doc page <id> --html <file> [--assets-from <dir>] [--summary s] [--title t]
#                                     → replace the page (and re-sync)
cmd_page() {
  local id="${1:-}"; shift || true
  require_id "$id"
  local html="" base="" summary="" title="" stdin=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --html) require_val "$1" "${2:-}"; html=$2; shift 2 ;;
      --stdin) stdin=1; shift ;;
      --assets-from) require_val "$1" "${2:-}"; base=$2; shift 2 ;;
      --summary) summary=${2:-}; shift 2 ;;
      --title) require_val "$1" "${2:-}"; title=$2; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  if [ -z "$html" ] && [ "$stdin" -eq 0 ]; then
    is_page "$id" || die "$id is not a page"
    printf '%s\n' "$(page_file "$id")"
    return 0
  fi
  if ! is_page "$id" && [ "$(front_val "$id" kind)" != page ]; then
    die "$id is a markdown doc, not a page (make one with: mc-doc new --kind page --title … --html file.html)"
  fi
  local src_tmp=""
  if [ -z "$html" ]; then src_tmp=$(mktemp); cat >"$src_tmp"; html=$src_tmp; fi
  [ -n "$base" ] || { [ -n "$src_tmp" ] && base=$PWD || base=$(dirname "$html"); }
  ( page_import "$id" "$html" "$base" "$title" "$summary" ) || { [ -z "$src_tmp" ] || rm -f "$src_tmp"; exit 1; }
  [ -z "$src_tmp" ] || rm -f "$src_tmp"
  # Keep the managed frontmatter honest: kind page + the page tag (an older
  # Mission Control app may have rewritten the kind to note).
  local tags; tags=$(front_val "$id" tags)
  case ", $tags, " in *", page, "*) ;; *) (cmd_set "$id" tags "$(with_page_tag "$tags")") ;; esac
  [ "$(front_val "$id" kind)" = page ] || (cmd_set "$id" kind page)
  sync_assets "$id"
}

cmd_help() {
  cat <<'EOF'
mc-doc — command-line handle on the Mission Control document library.

Library root: ${MC_LIBRARY:-$HOME/.mission-control/library}

  mc-doc new --kind <plan|research|note> --title <t>
             [--subject <s>] [--tags a,b] [--company <id>] [--dir <path>]
             [--body-file <f> | --stdin] [--assets-from <dir>]
        Create a doc; prints its absolute path (and nothing else).
        --company: the Jarvis company/project id it belongs to (HQ grouping).

  mc-doc new --kind page --title <t> --html <file.html> [--assets-from <dir>]
             [--subject <s>] [--tags a,b] [--company <id>] [--summary <s>]
        Publish a full HTML page (shown full-bleed in the panel, sandboxed).
        Stores <stem>.html + <stem>.assets/ and a .md stub; local images the
        page refers to are attached and rewritten to assets/<name>.
  mc-doc page <id> --html <file> [--assets-from <dir>] [--summary s] [--title t]
                                   Replace a page's HTML (and re-sync).
  mc-doc page <id>                 Print the page's HTML path.

  mc-doc path <id>                 Absolute path of <id> (exit 1 if missing).
  mc-doc list [--kind k] [--status s] [--tag t]
                                   One "id<TAB>kind<TAB>status<TAB>title" per line.
  mc-doc get  <id>                 Print the body (frontmatter stripped).
  mc-doc write <id> [--stdin | --body-file f] [--assets-from <dir>]
                                   Replace the body, keep frontmatter verbatim.
  mc-doc set  <id> <key> <value>   Rewrite one of kind|status|subject|tags|company|dir
                                   (an empty value clears subject/tags/company/dir).

Images (stored in <stem>.assets/ next to the doc, pushed to the relay):
  mc-doc attach <id> <file>... [--name n] [--caption c] [--tag t] [--no-sync]
                                   Copy images in (big ones shrunk to 1600 px
                                   JPEG, plus an 800 px thumb) and print the
                                   markdown to paste: ![c](assets/x.jpg "t | c")
  mc-doc assets <id>               "name<TAB>bytes<TAB>WxH<TAB>assets/name" per image.
  mc-doc sync   <id>               Push the doc's images (and a page's HTML) to the relay again.
  mc-doc detach <id> <name>...     Remove images (here and on the relay).
  new/write also accept local image refs — ![x](./photo.jpg), ![x](~/Desktop/a.png):
  they are attached and rewritten to assets/… (relative to the body file's
  folder, the current folder for --stdin, or --assets-from <dir>).

Layout blocks (lines of ::: around normal markdown; see the library skill):
  :::pair  :::gallery  :::facts  :::pills  :::callout <tone> [title]   …   :::

  mc-doc help

Typical research flow:
  id=$(mc-doc new --kind research --title "Pricing at Acme" --subject "Acme Corp")
  id=$(basename "$id")
  mc-doc set "$id" status active
  ...do the research, then...
  mc-doc write "$id" --body-file report.md
  mc-doc set "$id" status done
EOF
}

main() {
  local cmd="${1:-help}"; shift || true
  case "$cmd" in
    new)   cmd_new "$@" ;;
    path)  cmd_path "$@" ;;
    list)  cmd_list "$@" ;;
    get)   cmd_get "$@" ;;
    set)   cmd_set "$@" ;;
    write) cmd_write "$@" ;;
    attach) cmd_attach "$@" ;;
    assets) cmd_assets "$@" ;;
    sync)  cmd_sync "$@" ;;
    detach) cmd_detach "$@" ;;
    page)  cmd_page "$@" ;;
    help|-h|--help) cmd_help ;;
    *) die "unknown command: $cmd (try: mc-doc help)" ;;
  esac
}

main "$@"
"""#

    private static let skill = #"""
---
name: mission-control-library
description: Save and retrieve research, plans, and notes in the Mission Control document library — the user's central directory that the Mission Control web panel reads live. Use this whenever the user asks you to research something and keep/save/file the findings; write a report, plan, or note somewhere they can read later; or when they refer to "the library", "my plans", "my research", "my notes", or "the central directory". Also use it to look up or update a document that already lives there. Also use it to publish a designed, self-contained HTML page (a gallery, visual comparison, dashboard; like a Claude artifact) into the Library.
---

# Mission Control document library

The library is one directory of markdown files the user keeps their plans,
research reports, and notes in: `~/.mission-control/library/`. The Mission
Control menu-bar app and its web panel read it live (about once a second), so a
file you create or edit here appears in the user's panel within a second or two.
That is the point of putting work here instead of a scratch file: the user can
open, search, and act on it from the panel later.

Every file has a small managed frontmatter block, then a markdown body:

```
---
kind: research
status: done
subject: Acme Corp
tags: pricing, competitors
created: 2026-07-09T18:22:04Z
---
# Acme Corp — pricing teardown
...
```

- `kind` is `plan`, `research`, `note`, or `page` (a full HTML page; see **Pages**).
- `status` is `draft`, `active`, `done`, or `archived`.
- `subject` is the company/product/thing it is about; `tags` is a comma list.

**Never hand-edit or hand-write the frontmatter block, and never create these
files with the Write tool.** The frontmatter is managed by the CLI below; the
slug, ids, and byte format must match exactly or the panel misreads the file.
Use the tool for everything.

## The tool

`~/.mission-control/bin/mc-doc` is a self-contained CLI. Commands:

- `mc-doc new --kind <plan|research|note> --title <t> [--subject <s>] [--tags a,b] [--company <id>] [--dir <path>] [--stdin | --body-file <f>]`
  — creates the doc and prints its absolute path (and nothing else). New docs
  start at `status: draft`. There is no `--status` flag; set status with `set`.
- `mc-doc list [--kind k] [--status s] [--tag t]` — one `id<TAB>kind<TAB>status<TAB>title` per line.
- `mc-doc path <id>` — absolute path of a doc (exit 1 if it does not exist).
- `mc-doc get <id>` — print the body (frontmatter stripped).
- `mc-doc write <id> [--stdin | --body-file f]` — replace the body, keep frontmatter.
- `mc-doc set <id> <key> <value>` — rewrite one of `kind`, `status`, `subject`, `tags`, `company`, `dir` (empty value clears).
- `--company` / `company` is the Jarvis company or project id the doc belongs to (`mia jarvis show` lists them), so HQ can group it.
- `mc-doc attach <id> <file>... [--name n] [--caption c] [--tag t]` — copy images into the doc
  (see **Images** below) and print the markdown line to paste for each one.
- `mc-doc assets <id>` — the doc's images: `name<TAB>bytes<TAB>WxH<TAB>assets/name`.
- `mc-doc sync <id>` — push the doc's images to the panel's relay again (after a network failure).
- `mc-doc detach <id> <name>...` — remove images.
- `mc-doc new --kind page --title <t> --html <file> [--assets-from <dir>]` / `mc-doc page <id> --html <file>`
  — publish or replace a full HTML page (see **Pages** below).

`new` and `path` print an absolute path; the other commands take an `id`, which
is the filename (the last path component, e.g. `acme-pricing.md`). Capture it
with `id=$(basename "$(mc-doc new ...)")`.

## Research flow (the main one)

When the user asks you to research a topic and keep the findings:

1. Create the doc and mark it active so the user sees it working:
   ```sh
   path=$(mc-doc new --kind research --title "Pricing at Acme Corp" --subject "Acme Corp" --tags "pricing,competitors")
   id=$(basename "$path")
   mc-doc set "$id" status active
   ```
2. Do the research.
3. Write the report body in one shot (`--stdin` or `--body-file`):
   ```sh
   mc-doc write "$id" --body-file report.md
   ```
4. Mark it done:
   ```sh
   mc-doc set "$id" status done
   ```

Plans and notes work the same way (`--kind plan` / `--kind note`); a note you
are just jotting down can stay `draft`.

## Report structure

Write the body as a self-contained markdown report the user can read cold:

- A single `#` title on the first line (this becomes the doc's title in the panel).
- A short **executive summary** — the answer up top, a few sentences.
- Structured `##` sections for the substance.
- Concrete, cited facts — numbers, dates, names — not vague summary.
- A final `## Sources` section listing every source you used.

## Images

Reports can carry photos, screenshots and maps — use them whenever a picture is
evidence (a listing photo next to Street View, a chart, a screenshot of a page).

- Images live next to the doc in `~/.mission-control/library/<stem>.assets/`
  and the body points at them relatively: `![alt](assets/photo.jpg)`.
- **Always add them with `mc-doc attach`** (never copy files in by hand). It
  shrinks big photos to 1600 px JPEG, makes an 800 px thumbnail for fast
  phone/iPad loading, and pushes both to the relay so Daniel's panel can show
  them (the panel can't read this Mac's disk). It prints the line to paste:
  ```sh
  mc-doc attach "$id" ~/Downloads/p47.jpg --tag Listing --caption "Drive with garages"
  # → ![Drive with garages](assets/p47.jpg "Listing | Drive with garages")
  ```
- Shortcut: `mc-doc new/write` also accept local refs like `![x](./shots/a.png)`
  or `![x](~/Desktop/map.png)` — they are attached and rewritten to `assets/…`
  for you (relative to the body file's folder; `--stdin` uses the current
  folder; `--assets-from <dir>` overrides). Web images (`https://…`) are left
  as links and load through the relay's proxy.
- Raster only: JPEG, PNG, HEIC, WebP, TIFF (→ JPEG), GIF (as-is, ≤12 MB). No SVG.
- If attach says it could not push to the relay, the image is still safe on the
  Mac; run `mc-doc sync <id>` later.
- Caption = the image title. Text before ` | ` is a small coloured tag:
  `![alt](assets/x.jpg "Street View | 27 Ravensteyn Rd, Oct 2024")`. Write a real
  alt text too. An image alone on its line becomes a captioned figure; tap
  opens a full-size lightbox (swipe/arrows through every image in the doc).

## Layout blocks

Fence a few lines with `:::name` … `:::` (each on its own line; blocks don't
nest). Outside the panel they read as plain markdown.

| Block | Inside | Renders as |
|---|---|---|
| `:::pair` (alias `:::compare`) | optional prose + 2 (or 3) images | side-by-side evidence, stacked on a phone. Tags `Listing`/`Photo` are warm, `Street View`/`Satellite`/`Map` cool |
| `:::gallery` | any number of images | a responsive grid of tiles; tap → lightbox |
| `:::facts` | a list of `- Label: value` | label/value chips (mono values) |
| `:::pills` | a list of `- [ok] text` (`ok`, `warn`, `bad`, `info`; no tag = neutral) | verdict / confidence pills |
| `:::callout <ok\|warn\|bad\|info> [Title]` | any markdown | a toned box with an optional bold title |

Link to another Library doc by its id — `[the Fetzer search](fetzer-search-camps-bay-12-bed-with-ocea.md)` —
and the panel opens it in place.

Pattern for a visual comparison report (one evidence pair per finding):
`# title` → one-paragraph answer → `:::facts` → `:::pills` → then per finding a
`## short heading`, one paragraph, one `:::pair` → a `:::callout warn` for what
doesn't match yet → `## Sources`.

### Worked example — "is this listing in that building?"

```sh
id=$(basename "$(mc-doc new --kind research --title "Is the Double.D flat in Silvertree Place?" \
  --subject "Silvertree Place" --tags "property,camps-bay")")
mc-doc set "$id" status active
cd ~/research/silvertree          # where the screenshots/photos were saved
mc-doc attach "$id" listing-p47.jpg sv-platteklip.jpg >/dev/null
mc-doc write "$id" --stdin <<'REPORT'
# Is the Double.D flat in Silvertree Place?

Probably: the drive, the two flat-roofed blocks and the palm all match.

:::facts
- Scheme: SS66/1993
- Erf: 1447
- Best-guess unit: Section 25
:::

:::pills
- [ok] Building: about 75% sure
- [warn] Section 25: about 40% sure
:::

## The drive and garages

:::pair
Red-paved drive with garages on both sides and Lion's Head at the end — the
same drive Street View looks down from Platteklip Plain.

![Listing photo: red-paved drive and garages](assets/listing-p47.jpg "Listing | Drive with garages, looking north")
![Street View down the gated drive](assets/sv-platteklip.jpg "Street View | 9 Platteklip Plain, Aug 2025")
:::

:::callout warn What doesn't match yet
The walls look white from the street, not cream.
:::

## Sources
- Property24 listing 117363447
- Google Street View, Platteklip Plain (Aug 2025)
REPORT
mc-doc set "$id" status done
```

Daniel can also see it right away: `mia panel show-doc "$id"`.

## Pages (full HTML, like a Claude artifact)

Besides markdown docs, the library holds **pages**: one self-contained HTML
page that opens full-bleed in Daniel's panel (Library reader and
`mia panel show-doc`), the way a Claude artifact does.

**Page or markdown doc?**
- **Markdown doc** (the default): research reports, plans, notes, anything
  that is mostly text, gets edited or extended later, or that Daniel may want
  as a PDF. The `:::pair`/`:::gallery`/`:::facts` blocks already cover
  most visual reports.
- **Page**: when the *layout itself* is the point and markdown can't carry
  it: a visual gallery or mood board, a designed comparison, a dashboard
  with a chart, a timeline, an interactive calculator or filter. Also use a
  page when Daniel says "make it like an artifact" or "make a page".

**Commands**
```sh
path=$(mc-doc new --kind page --title "Crystal Garden designs" \
  --html ~/work/gallery/index.html [--subject s] [--tags a,b] [--summary "one line for the card"])
id=$(basename "$path")
mc-doc page "$id" --html ~/work/gallery/index.html   # replace it later (re-syncs)
mc-doc page "$id"                                     # print the stored .html path
mc-doc sync "$id"                                     # push images + HTML to the relay again
```
- On disk: `<stem>.md` (a stub with `kind: page`, the tag `page`, the title
  and a one-line summary, so lists work), `<stem>.html` and `<stem>.assets/`.
  Never edit the stub; `mc-doc write` refuses pages. A new page starts as
  `status: done`.
- Local images the HTML points at (`src`, `href`, `srcset`, `poster`, CSS
  `url(...)`, relative to the HTML file's folder or `--assets-from <dir>`)
  are attached through the normal image pipeline (shrunk to 1600 px, pushed
  to the relay) and rewritten to `assets/<name>`. A link around an image to
  the same image (`<a href="x.jpg"><img src="x.jpg"></a>`) opens the panel's
  full-screen lightbox when Daniel taps it.

**Page rules** (the panel enforces the CDN and network rules; anything else is
blocked silently):
- **Self-contained:** one HTML file; a fragment is fine (the panel adds the
  `<!doctype>`, `<meta charset>` and viewport). Inline your CSS and JS. Max
  2 MB of HTML; images are separate files, never big `data:` URIs.
- **Scripts:** inline, or from `cdnjs.cloudflare.com`, `cdn.jsdelivr.net` or
  `unpkg.com` only. **Fonts:** Google Fonts (`fonts.googleapis.com` /
  `fonts.gstatic.com`). **Images:** the page's own files, `data:` and
  `blob:`. **No other network:** no `fetch`/XHR or WebSocket, no iframes, no
  forms, no remote images (download them and reference the file instead).
- **Theme tokens:** define colours as CSS variables on `:root`, with a dark
  set under `@media (prefers-color-scheme: dark)` guarded by
  `:root:not([data-theme="light"])`, and again under
  `:root[data-theme="dark"]`. The panel sets `data-theme` on `<html>` to
  match itself. Give `body` an explicit background.
- **Phone width first:** it must read at 390 px wide with a 16 px side gutter
  and no sideways scroll (`min-width:0` on grid children, `max-width:100%` on
  media), and scale up to the iPad and desktop
  (`grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`).
- **Links:** web links open in a new tab; a link to another Library doc by id
  (`href="silvertree-place-is-the-doubled-flat-her.md"`) opens it in the panel.
- **Sandbox:** the page runs in a sandboxed frame with no access to the panel,
  its storage or its token. Don't try to reach `/api`, `localStorage` or the
  parent page.

Minimal skeleton:
```html
<title>Crystal Garden designs</title>
<style>
:root{--bg:#f4f2fa;--card:#fff;--fg:#221d33;--muted:#6a6380;--line:#e2ddef}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#14111d;--card:#1e1a2b;--fg:#ece8f7;--muted:#a49cbd;--line:#2e2840;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#14111d;--card:#1e1a2b;--fg:#ece8f7;--muted:#a49cbd;--line:#2e2840;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;padding:24px 16px 48px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;max-width:1200px;margin:0 auto}
figure{margin:0;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
figure img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}
</style>
<h1>Crystal Garden designs</h1>
<div class="grid">
  <figure><a href="01-prism-tree.jpg"><img src="01-prism-tree.jpg" alt="Prism Tree" loading="lazy"></a>
    <figcaption>Prism Tree</figcaption></figure>
</div>
```
Show it to Daniel right away with `mia panel show-doc "$id"`.

## Worked example — "research pricing at Acme Corp"

```sh
path=$(mc-doc new --kind research --title "Pricing at Acme Corp" \
  --subject "Acme Corp" --tags "pricing,competitors")
id=$(basename "$path")
mc-doc set "$id" status active

# ...gather the facts...

mc-doc write "$id" --stdin <<'REPORT'
# Acme Corp — pricing teardown

## Executive summary
Acme sells three tiers; the mid tier at $49/seat/mo is the volume play and
undercuts its closest competitor by ~15%.

## Tiers
- Starter — $19/seat/mo, 3-seat minimum.
- Team — $49/seat/mo, the default.
- Enterprise — custom, annual only.

## How it compares
Competitor X lists $58/seat/mo for a comparable tier.

## Sources
- https://acme.example.com/pricing (accessed 2026-07-09)
- https://competitorx.example.com/pricing
REPORT

mc-doc set "$id" status done
```
"""#

    /// Mirror of scripts/mia (docs/mia.md §3) — Mia's and her executors' CLI.
    private static let mia = #"""
#!/usr/bin/env bash
# mia — the command-line handle Mia (Mission Control's assistant) and her
# executors use to talk to Daniel and manage the task list.
#
# Everything lives as plain JSON / JSONL under ~/.mission-control/mia/ (or
# $MIA_DIR). The CLI never talks to the Mission Control app directly: it writes
# files, and the app's 1 s watcher reacts (delivers pushes, launches
# executors, types events into Mia's terminal). See docs/mia.md.
#
# Repo source of truth: scripts/mia. ToolingInstaller.swift embeds a
# byte-for-byte copy and installs it to ~/.mission-control/bin/mia; edit it
# here, not there.
#
# Needs only bash + python3. Every write is atomic (temp file + rename) and
# serialized with the app through an flock on $MIA_DIR/.lock.

set -eu

MIA_DIR="${MIA_DIR:-$HOME/.mission-control/mia}"
export MIA_DIR

command -v python3 >/dev/null 2>&1 || { printf 'mia: python3 is required\n' >&2; exit 1; }

# read -d '' rather than $(cat <<…): bash 3.2 mis-parses quotes and parens
# inside a heredoc nested in a command substitution.
read -r -d '' MIA_PY <<'PY' || true
import sys, os, json, time, re, fcntl, tempfile, datetime

D = os.path.abspath(os.path.expanduser(os.environ.get("MIA_DIR") or "~/.mission-control/mia"))
TASKS = os.path.join(D, "tasks")
DISPATCH = os.path.join(D, "dispatch")
BRIEFS = os.path.join(D, "briefs")
MSGS = os.path.join(D, "messages.jsonl")
PANEL = os.path.join(D, "panel.jsonl")
EVENTS = os.path.join(D, "events.jsonl")
SCHED = os.path.join(D, "schedule.json")
STATE = os.path.join(D, "state.json")
UPLOADS = os.path.join(D, "uploads.jsonl")
ROUTING = os.path.join(D, "routing.json")
REGISTRY = os.path.join(D, "jarvis", "registry.json")
STATUSES = ["queued", "asking", "running", "checking", "done", "failed", "cancelled"]
DEFAULT_SCHEDULE = {
    "heartbeats": [
        {"id": "hb_inbox", "label": "Inbox check", "everyMinutes": 30,
         "prompt": "Check the Gmail inbox and calendar. Tell Daniel only if something needs him. Stay silent otherwise.",
         "enabled": True},
        {"id": "hb_brief", "label": "Morning brief", "at": "07:30",
         "prompt": "Morning brief: today's calendar (with a line of prep for anything that needs it), mail that needs Daniel, what executors finished overnight, open questions, reminders due today, and anything you suggest he do today — one short, scannable `mia notify`.",
         "enabled": True},
        {"id": "hb_wrap", "label": "Evening wrap-up", "at": "18:30",
         "prompt": "Evening wrap-up: what got done today (tasks, mail handled), what is still open or waiting on Daniel, and tomorrow's first commitments. Set `mia remind` for loose ends — one short `mia notify`.",
         "enabled": True},
    ],
    "reminders": [],
}


def die(msg, code=1):
    sys.stderr.write("mia: %s\n" % msg)
    sys.exit(code)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def to_iso(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Lock(object):
    """Exclusive flock shared with the Mission Control app."""
    def __enter__(self):
        os.makedirs(D, exist_ok=True)
        self.fd = os.open(os.path.join(D, ".lock"), os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)
        return False


def write_atomic(path, text):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".mia.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except (IOError, OSError):
        return ""


def read_json(path, default=None):
    t = read_text(path)
    if not t.strip():
        return default
    try:
        return json.loads(t)
    except ValueError:
        return default


def write_json(path, obj):
    write_atomic(path, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def read_jsonl(path):
    out = []
    for line in read_text(path).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def append_jsonl(path, obj):
    text = read_text(path)
    if text and not text.endswith("\n"):
        text += "\n"
    text += json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    write_atomic(path, text)


def next_stamp(path, prefix):
    """Millisecond id, bumped past the last line's so ids stay monotonic."""
    ms = int(time.time() * 1000)
    lines = [l for l in read_text(path).splitlines() if l.strip()]
    if lines:
        try:
            last = json.loads(lines[-1]).get("id", "")
            m = re.match(r"^" + re.escape(prefix) + r"(\d+)$", last)
            if m:
                ms = max(ms, int(m.group(1)) + 1)
        except ValueError:
            pass
    return prefix + str(ms)


def norm_id(s):
    s = (s or "").strip()
    if not re.match(r"^\d{1,6}$", s):
        die("bad task id: %r" % s)
    return "%04d" % int(s)


def task_path(tid):
    return os.path.join(TASKS, tid + ".json")


def load_task(tid):
    t = read_json(task_path(tid))
    if not isinstance(t, dict):
        die("no such task: %s" % tid)
    return t


def save_task(t):
    t["updatedAt"] = now_iso()
    write_json(task_path(t["id"]), t)


def all_tasks():
    out = []
    try:
        names = os.listdir(TASKS)
    except OSError:
        return out
    for n in sorted(names):
        if re.match(r"^\d+\.json$", n):
            t = read_json(os.path.join(TASKS, n))
            if isinstance(t, dict):
                out.append(t)
    return out


def next_task_id():
    m = 0
    try:
        for n in os.listdir(TASKS):
            mm = re.match(r"^(\d+)\.json$", n)
            if mm:
                m = max(m, int(mm.group(1)))
    except OSError:
        pass
    return "%04d" % (m + 1)


def expand_dir(d):
    return os.path.abspath(os.path.expanduser(d.strip()))


def load_schedule():
    s = read_json(SCHED)
    if not isinstance(s, dict):
        s = json.loads(json.dumps(DEFAULT_SCHEDULE))
    s.setdefault("heartbeats", [])
    s.setdefault("reminders", [])
    return s


def parse(args, spec):
    """spec: {"--flag": takes_value(bool)}. Returns (positionals, opts)."""
    pos, opts = [], {}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            pos.extend(args[i + 1:])
            break
        if a.startswith("-") and len(a) > 1:
            name, eq, val = a.partition("=")
            if name not in spec:
                die("unknown option: %s" % name)
            if spec[name]:
                if not eq:
                    i += 1
                    if i >= len(args):
                        die("%s needs a value" % name)
                    val = args[i]
                opts[name] = val
            else:
                opts[name] = True
        else:
            pos.append(a)
        i += 1
    return pos, opts


def text_arg(pos, what):
    t = " ".join(pos).strip()
    if t == "-":
        t = sys.stdin.read().strip()
    if not t:
        die("%s is empty" % what)
    return t


def message(kind, text, task=None, **extra):
    with Lock():
        mid = next_stamp(MSGS, "m_")
        m = {"id": mid, "at": now_iso(), "from": "mia", "kind": kind, "text": text}
        if task:
            load_task(task)
            m["taskId"] = task
        m.update(extra)
        append_jsonl(MSGS, m)
    return m


# ---- model routing (task 0204) ---------------------------------------------
# A dispatch can name a tier (cheap/mid/smart) or a kind of work that maps to
# one; the tier picks the model id the app launches `claude --model` with.
# $MIA_DIR/routing.json may override either table: {"tiers": {...}, "kinds": {...}}.

TIERS = ["cheap", "mid", "smart"]
DEFAULT_TIER_MODELS = {"cheap": "claude-haiku-5-5", "mid": "claude-sonnet-5-5",
                       "smart": "claude-opus-5-5"}
DEFAULT_KINDS = {}
for _tier, _kinds in (("cheap", "scout summary triage classify stats health"),
                      ("mid", "research fix docs content refresh"),
                      ("smart", "build design release verify review")):
    for _k in _kinds.split():
        DEFAULT_KINDS[_k] = _tier


def warn(msg):
    sys.stderr.write("mia: warning: %s\n" % msg)


def load_routing():
    """(tier -> model, kind -> tier): the defaults with routing.json merged over."""
    tiers, kinds = dict(DEFAULT_TIER_MODELS), dict(DEFAULT_KINDS)
    if not os.path.exists(ROUTING):
        return tiers, kinds
    try:
        with open(ROUTING, "r", encoding="utf-8") as f:
            r = json.load(f)
        if not isinstance(r, dict):
            raise ValueError("not an object")
        rt, rk = r.get("tiers") or {}, r.get("kinds") or {}
        if not isinstance(rt, dict) or not isinstance(rk, dict):
            raise ValueError("tiers/kinds must be objects")
    except (IOError, OSError, ValueError) as e:
        warn("ignoring malformed %s (%s)" % (ROUTING, e))
        return tiers, kinds
    for k, v in rt.items():
        if k not in TIERS:
            warn("routing.json: unknown tier %r ignored" % k)
        elif not isinstance(v, str) or not v.strip():
            warn("routing.json: tier %r needs a model id" % k)
        else:
            tiers[k] = v.strip()
    for k, v in rk.items():
        if v not in TIERS:
            warn("routing.json: kind %r -> %r is not a tier; ignored" % (k, v))
        else:
            kinds[str(k).strip()] = v
    return tiers, kinds


def resolve_route(model=None, tier=None, kind=None):
    """(tier, kind, model). --model wins, then --tier, then --kind."""
    model = (model or "").strip() or None
    if tier is None and kind is None:
        return None, None, model
    tiers, kinds = load_routing()
    if tier is not None and tier not in tiers:
        die("unknown tier: %s (tiers: %s)" % (tier, ", ".join(TIERS)))
    if kind is not None:
        if kind not in kinds:
            die("unknown kind: %s (kinds: %s)" % (kind, ", ".join(sorted(kinds))))
        if tier is None:
            tier = kinds[kind]
    return tier, kind, model or tiers[tier]


def dispatch_locked(t, brief, d, tier=None, kind=None, model=None):
    """Write the brief + dispatch request for task t. Caller holds Lock()."""
    tid = t["id"]
    if not d:
        die("task %s has no folder; pass --dir" % tid)
    if not os.path.isdir(d):
        die("no such folder: %s" % d)
    brief_path = os.path.join(BRIEFS, tid + ".md")
    write_atomic(brief_path, brief.rstrip("\n") + "\n")
    req = {"taskId": tid, "dir": d, "model": model or None,
           "brief": brief_path, "at": now_iso()}
    if tier or kind:
        req["tier"] = tier
        req["kind"] = kind
    write_json(os.path.join(DISPATCH, tid + ".json"), req)
    t["dir"] = d
    line = "Dispatch requested in " + d
    if tier:
        line += " (%s \u00b7 %s)" % (tier, model)
        prev = t.get("routing") if isinstance(t.get("routing"), dict) else {}
        t["routing"] = {"tier": tier, "kind": kind, "model": model,
                        "verify": "smart" if tier == "cheap" else None}
        if prev.get("verifiedBy"):
            t["routing"]["verifiedBy"] = prev["verifiedBy"]
    t.setdefault("log", []).append({"at": req["at"], "text": line})
    save_task(t)
    return d


# ---- Jarvis registry lookups -------------------------------------------------

def resolve_company(value):
    """A company or project id -> (company, project). Checked against the Jarvis
    registry when there is one; without it the value is kept as a company id."""
    v = (value or "").strip()
    if not v:
        return None, None
    reg = read_json(REGISTRY)
    if not isinstance(reg, dict):
        if os.path.exists(REGISTRY):
            warn("cannot read %s; keeping %r as given" % (REGISTRY, v))
        return v, None
    companies = [c.get("id") for c in reg.get("companies") or []
                 if isinstance(c, dict) and c.get("id")]
    projects = dict((p.get("id"), p) for p in reg.get("projects") or []
                    if isinstance(p, dict) and p.get("id"))
    if v in companies:
        return v, None
    if v in projects:
        return projects[v].get("company") or None, v
    die("unknown company or project: %s\n  companies: %s\n  projects: %s"
        % (v, ", ".join(companies) or "-", ", ".join(sorted(projects)) or "-"))


def apply_company(t, value):
    c, p = resolve_company(value)
    t.pop("company", None)
    t.pop("project", None)
    if c:
        t["company"] = c
    if p:
        t["project"] = p


# ---- commands -------------------------------------------------------------

def speak_extra(o):
    """--speak: an open panel reads the message aloud (docs/mia.md §8.3)."""
    return {"speak": True} if o.get("--speak") else {}


def cmd_say(args):
    pos, o = parse(args, {"--task": True, "--speak": False})
    task = norm_id(o["--task"]) if "--task" in o else None
    m = message("chat", text_arg(pos, "message"), task, **speak_extra(o))
    print(m["id"])


def cmd_notify(args):
    pos, o = parse(args, {"--task": True, "--urgent": False, "--speak": False})
    task = norm_id(o["--task"]) if "--task" in o else None
    m = message("notify", text_arg(pos, "message"), task, urgent=bool(o.get("--urgent")),
                **speak_extra(o))
    print(m["id"])


def cmd_ask(args):
    pos, o = parse(args, {"--task": True, "--options": True, "--speak": False})
    text = text_arg(pos, "question")
    task = norm_id(o["--task"]) if "--task" in o else None
    options = [x.strip() for x in o.get("--options", "").split("|") if x.strip()]
    with Lock():
        t = load_task(task) if task else None
        mid = next_stamp(MSGS, "m_")
        qid = "q_" + mid[2:]
        at = now_iso()
        m = {"id": mid, "at": at, "from": "mia", "kind": "question",
             "text": text, "options": options, "questionId": qid}
        m.update(speak_extra(o))
        if task:
            m["taskId"] = task
        append_jsonl(MSGS, m)
        if t is not None:
            t.setdefault("questions", []).append(
                {"id": qid, "text": text, "options": options, "askedAt": at,
                 "answer": None, "answeredAt": None})
            if t.get("status") not in ("done", "failed", "cancelled"):
                t["status"] = "asking"
            t.setdefault("log", []).append({"at": at, "text": "Asked Daniel: " + text})
            save_task(t)
    print(qid)


def cmd_task(args):
    if not args:
        die("task needs a subcommand: list|show|add|set|note")
    sub, rest = args[0], args[1:]
    if sub == "list":
        pos, o = parse(rest, {"--status": True})
        want = o.get("--status")
        for t in all_tasks():
            if want and t.get("status") != want:
                continue
            print("%s\t%s\t%s\t%s" % (t.get("id", ""), t.get("status", ""),
                                      t.get("priority", 3), t.get("title", "")))
    elif sub == "show":
        pos, o = parse(rest, {})
        if len(pos) != 1:
            die("usage: mia task show <id>")
        print(json.dumps(load_task(norm_id(pos[0])), indent=2, ensure_ascii=False))
    elif sub == "add":
        pos, o = parse(rest, {"--detail": True, "--stdin": False, "--dir": True, "--priority": True,
                              "--company": True})
        title = text_arg(pos, "title")
        detail = o.get("--detail", "")
        if o.get("--stdin"):
            detail = sys.stdin.read().strip()
        prio = 3
        if "--priority" in o:
            try:
                prio = int(o["--priority"])
            except ValueError:
                die("priority must be a number")
        d = expand_dir(o["--dir"]) if o.get("--dir") else ""
        with Lock():
            tid = next_task_id()
            at = now_iso()
            t = {"id": tid, "title": title, "detail": detail, "dir": d, "status": "queued",
                 "priority": prio, "createdAt": at, "updatedAt": at, "questions": [],
                 "executor": None, "log": [{"at": at, "text": "Created"}], "result": None}
            if o.get("--company", "").strip():
                apply_company(t, o["--company"])
            write_json(task_path(tid), t)
        print(tid)
    elif sub == "set":
        if len(rest) < 3:
            if len(rest) == 2 and rest[1] == "company":
                rest = rest + [""]
            else:
                die("usage: mia task set <id> <status|dir|priority|result|title|company> <value>")
        tid, field, value = norm_id(rest[0]), rest[1], " ".join(rest[2:])
        with Lock():
            t = load_task(tid)
            if field == "status":
                if value not in STATUSES:
                    die("status must be one of: " + ", ".join(STATUSES))
                old = t.get("status")
                t["status"] = value
                t.setdefault("log", []).append({"at": now_iso(), "text": "Status: %s -> %s" % (old, value)})
            elif field == "priority":
                try:
                    t["priority"] = int(value)
                except ValueError:
                    die("priority must be a number")
            elif field == "dir":
                t["dir"] = expand_dir(value) if value.strip() else ""
            elif field in ("result", "title"):
                t[field] = value
            elif field == "company":
                apply_company(t, value)
            else:
                die("field must be one of: status, dir, priority, result, title, company")
            save_task(t)
        shown = t.get(field, "")
        if field == "company" and t.get("project"):
            shown = "%s (project %s)" % (shown, t["project"])
        print("%s %s = %s" % (tid, field, shown))
    elif sub == "note":
        if len(rest) < 2:
            die("usage: mia task note <id> \"<text>\"")
        tid = norm_id(rest[0])
        text = text_arg(rest[1:], "note")
        with Lock():
            t = load_task(tid)
            t.setdefault("log", []).append({"at": now_iso(), "text": text})
            save_task(t)
        print("noted on %s" % tid)
    else:
        die("unknown task subcommand: %s" % sub)


def cmd_dispatch(args):
    pos, o = parse(args, {"--dir": True, "--model": True, "--tier": True, "--kind": True,
                          "--brief-file": True, "--stdin": False})
    if len(pos) != 1:
        die("usage: mia dispatch <id> [--dir <d>] [--tier cheap|mid|smart] [--kind <k>] "
            "[--model <m>] --brief-file <f> | --stdin")
    tid = norm_id(pos[0])
    tier, kind, model = resolve_route(o.get("--model"), o.get("--tier"), o.get("--kind"))
    if o.get("--stdin"):
        brief = sys.stdin.read()
    elif o.get("--brief-file"):
        brief = read_text(os.path.expanduser(o["--brief-file"]))
    else:
        die("give the brief with --brief-file <f> or --stdin")
    if not brief.strip():
        die("the brief is empty")
    with Lock():
        t = load_task(tid)
        d = expand_dir(o["--dir"]) if o.get("--dir") else (t.get("dir") or "")
        dispatch_locked(t, brief, d, tier, kind, model)
    print("dispatch %s queued in %s" % (tid, d))


VERIFY_BRIEF = """Verify task {orig} ("{title}"). You are the checker, not the builder: never redo, fix or finish the work yourself.

1. Read what was claimed: {report} (the executor's report), and the original task's log and result (`mia task show {orig}`).
2. Check every claim against this repo ({dir}): `git log` / `git diff` for the commits or changes it says it made, and run its tests (whatever the repo has) to confirm they pass.
3. Write your verdict to {out}: first line `PASS` or `FAIL`, then the reasons — what you checked, what held up, what did not.
4. Record it on the original: mia task note {orig} "VERIFIED: PASS — <one line>" (or "VERIFIED: FAIL — <one line>").
"""


def cmd_verify(args):
    pos, o = parse(args, {"--tier": True, "--dir": True})
    if len(pos) != 1:
        die("usage: mia verify <id> [--tier smart] [--dir <d>]")
    orig = norm_id(pos[0])
    tier, kind, model = resolve_route(None, o.get("--tier") or "smart", "verify")
    with Lock():
        ot = load_task(orig)
        d = expand_dir(o["--dir"]) if o.get("--dir") else (ot.get("dir") or "")
        if not d:
            die("task %s has no folder; pass --dir" % orig)
        if not os.path.isdir(d):
            die("no such folder: %s" % d)
        tid = next_task_id()
        at = now_iso()
        title = ot.get("title") or ""
        t = {"id": tid, "title": "Verify %s: %s" % (orig, title),
             "detail": "Independent check of task %s (%s): confirm its claimed work against the repo "
                       "and record PASS/FAIL on %s. Do not redo the work." % (orig, title, orig),
             "dir": d, "status": "queued", "priority": ot.get("priority", 3),
             "createdAt": at, "updatedAt": at, "questions": [], "executor": None,
             "log": [{"at": at, "text": "Created to verify task %s" % orig}], "result": None,
             "verifies": orig}
        for k in ("company", "project"):
            if ot.get(k):
                t[k] = ot[k]
        write_json(task_path(tid), t)
        brief = VERIFY_BRIEF.format(orig=orig, title=title, dir=d,
                                    report=os.path.join(BRIEFS, orig + ".report.md"),
                                    out=os.path.join(BRIEFS, tid + ".report.md"))
        dispatch_locked(t, brief, d, tier, kind, model)
        r = ot.get("routing") if isinstance(ot.get("routing"), dict) else {}
        r["verifiedBy"] = tid
        ot["routing"] = r
        ot.setdefault("log", []).append({"at": now_iso(), "text": "Verification: task %s (%s \u00b7 %s)"
                                         % (tid, tier, model)})
        save_task(ot)
    print(tid)


def cmd_routing(args):
    pos, o = parse(args, {})
    if pos:
        die("usage: mia routing")
    tiers, kinds = load_routing()
    for tier in TIERS:
        print("tier %s\t%s" % (tier, tiers[tier]))
    for k in sorted(kinds):
        print("kind %s\t%s" % (k, kinds[k]))


def cmd_tell(args):
    if len(args) < 2:
        die("usage: mia tell <id> \"<text>\"")
    tid = norm_id(args[0])
    text = text_arg(args[1:], "text")
    with Lock():
        load_task(tid)
        path = os.path.join(DISPATCH, tid + ".tell.json")
        old = read_json(path)
        if isinstance(old, dict) and old.get("text"):
            text = old["text"] + "\n" + text
        write_json(path, {"taskId": tid, "text": text, "at": now_iso()})
    print("told %s" % tid)


def parse_when(s):
    s = s.strip()
    now = datetime.datetime.now().astimezone()
    m = re.match(r"^\+(\d+)\s*([mhd])$", s)
    if m:
        n = int(m.group(1))
        delta = {"m": datetime.timedelta(minutes=n), "h": datetime.timedelta(hours=n),
                 "d": datetime.timedelta(days=n)}[m.group(2)]
        return now + delta
    m = re.match(r"^(\d{1,2}):(\d{2})$", s)
    if m:
        h, mi = int(m.group(1)), int(m.group(2))
        if h > 23 or mi > 59:
            die("bad time: %s" % s)
        dt = now.replace(hour=h, minute=mi, second=0, microsecond=0)
        if dt <= now:
            dt += datetime.timedelta(days=1)
        return dt
    try:
        iso = s[:-1] + "+00:00" if s.endswith("Z") else s
        dt = datetime.datetime.fromisoformat(iso)
    except ValueError:
        die("can't read time %r (use ISO-8601, HH:MM, +2h or +30m)" % s)
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt


def cmd_remind(args):
    if args and args[0] == "list":
        s = load_schedule()
        rs = [r for r in s["reminders"] if not r.get("fired") or "--all" in args[1:]]
        if not rs:
            print("(no reminders)")
        for r in sorted(rs, key=lambda r: r.get("at", "")):
            tag = " (task %s)" % r["taskId"] if r.get("taskId") else ""
            done = "  [fired]" if r.get("fired") else ""
            print("%s\t%s\t%s%s%s" % (r.get("id"), r.get("at"), r.get("text", ""), tag, done))
        return
    if args and args[0] == "cancel":
        if len(args) != 2:
            die("usage: mia remind cancel <reminder-id>")
        with Lock():
            s = load_schedule()
            keep = [r for r in s["reminders"] if r.get("id") != args[1]]
            if len(keep) == len(s["reminders"]):
                die("no reminder %s" % args[1])
            s["reminders"] = keep
            write_json(SCHED, s)
        print("cancelled %s" % args[1])
        return
    pos, o = parse(args, {"--at": True, "--task": True})
    if "--at" not in o:
        die("usage: mia remind --at <ISO-8601|HH:MM|+2h|+30m> \"<text>\" [--task <id>]")
    when = parse_when(o["--at"])
    text = text_arg(pos, "reminder")
    task = norm_id(o["--task"]) if "--task" in o else None
    with Lock():
        if task:
            load_task(task)
        s = load_schedule()
        rid = "r_%d" % int(time.time() * 1000)
        while any(r.get("id") == rid for r in s["reminders"]):
            rid = "r_%d" % (int(rid[2:]) + 1)
        s["reminders"].append({"id": rid, "at": to_iso(when), "text": text,
                               "taskId": task, "fired": False})
        write_json(SCHED, s)
    print("%s %s" % (rid, to_iso(when)))


def cmd_heartbeat(args):
    usage = ("usage: mia heartbeat list | set <id> (--every <min>|--at HH:MM) [--label <l>] [--prompt <p>]"
             " | enable <id> | disable <id> | remove <id>")
    sub = args[0] if args else "list"
    if sub == "list":
        s = load_schedule()
        if not s["heartbeats"]:
            print("(no heartbeats)")
        for h in s["heartbeats"]:
            when = ("every %sm" % h["everyMinutes"]) if h.get("everyMinutes") else ("at %s" % h.get("at", "?"))
            on = "on" if h.get("enabled", True) else "off"
            print("%s\t%s\t%s\t%s\t%s" % (h.get("id"), on, when, h.get("label", ""), h.get("prompt", "")))
        return
    if sub not in ("set", "enable", "disable", "remove") or len(args) < 2:
        die(usage)
    hid = args[1]
    pos, o = parse(args[2:], {"--every": True, "--at": True, "--label": True, "--prompt": True})
    if pos:
        die(usage)
    with Lock():
        s = load_schedule()
        hbs = s["heartbeats"]
        cur = next((h for h in hbs if h.get("id") == hid), None)
        if sub == "remove":
            if cur is None:
                die("no heartbeat %s" % hid)
            hbs.remove(cur)
        elif sub in ("enable", "disable"):
            if cur is None:
                die("no heartbeat %s" % hid)
            cur["enabled"] = sub == "enable"
        else:
            if "--every" in o and "--at" in o:
                die("give --every or --at, not both")
            h = cur if cur is not None else {"id": hid, "label": hid, "prompt": "", "enabled": True}
            if "--every" in o:
                try:
                    every = int(o["--every"])
                except ValueError:
                    every = 0
                if every <= 0:
                    die("--every must be a positive number of minutes")
                h["everyMinutes"] = every
                h.pop("at", None)
            if "--at" in o:
                if not re.match(r"^([01]?\d|2[0-3]):[0-5]\d$", o["--at"]):
                    die("--at must be HH:MM (local time)")
                h["at"] = o["--at"]
                h.pop("everyMinutes", None)
            if "--label" in o:
                h["label"] = o["--label"]
            if "--prompt" in o:
                h["prompt"] = o["--prompt"]
            if not h.get("everyMinutes") and not h.get("at"):
                die("a new heartbeat needs --every or --at")
            if not h.get("prompt"):
                die("a new heartbeat needs --prompt")
            if cur is None:
                hbs.append(h)
        write_json(SCHED, s)
    print("%s %s" % (sub if sub != "set" else "saved", hid))


def cmd_inbox(args):
    pos, o = parse(args, {"-n": True})
    try:
        n = int(o.get("-n", 50))
    except ValueError:
        die("-n must be a number")
    evs = read_jsonl(EVENTS)[-n:] if n > 0 else []
    if not evs:
        print("(no events)")
    for e in evs:
        mark = "" if e.get("delivered") else "  [not yet delivered]"
        print("%s  %-9s %s%s" % (e.get("at", ""), e.get("kind", ""), e.get("text", ""), mark))


def human_size(n):
    n = int(n or 0)
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.0f KB" % (n / 1024.0)
    return "%.1f MB" % (n / 1048576.0)


def cmd_uploads(args):
    pos, o = parse(args, {"-n": True, "--json": False})
    try:
        n = int(o.get("-n", 20))
    except ValueError:
        die("-n must be a number")
    recs = read_jsonl(UPLOADS)[-n:] if n > 0 else []
    if o.get("--json"):
        print(json.dumps(recs, indent=2, ensure_ascii=False))
        return
    if not recs:
        print("(no uploads)")
    for r in recs:
        p = r.get("path", "")
        gone = "" if p and os.path.exists(p) else "  [file moved or deleted]"
        note = (" — note: %s" % " ".join(r["caption"].split())) if r.get("caption") else ""
        batch = (" (%s)" % r["batch"].replace("/", " of ")) if r.get("batch") else ""
        print("%s  %8s  %-28s %s%s%s%s" % (r.get("at", ""), human_size(r.get("size")),
                                          r.get("mime", ""), p, batch, note, gone))


# ---- questions ---------------------------------------------------------------
# A question is open until Daniel answers it, he dismisses it from the panel,
# or it is closed here (`mia question dismiss|expire`). Closures live in
# questions.json — {"maxAgeHours": 48, "closed": {qid: {state, at, by}}} — so
# the history in messages.jsonl is never rewritten. Open questions older than
# maxAgeHours are "old": hidden from the panel, badges, read-aloud and
# `mia status` (unless --all), but still answerable and never deleted.
# The app (MiaManager.swift, MiaQuestions.swift) reads the same file.

QUESTIONS = os.path.join(D, "questions.json")
DEFAULT_MAX_AGE_HOURS = 48


def load_qstate():
    s = read_json(QUESTIONS)
    if not isinstance(s, dict):
        s = {}
    if not isinstance(s.get("closed"), dict):
        s["closed"] = {}
    try:
        s["maxAgeHours"] = max(0.0, float(s.get("maxAgeHours", DEFAULT_MAX_AGE_HOURS)))
    except (TypeError, ValueError):
        s["maxAgeHours"] = float(DEFAULT_MAX_AGE_HOURS)
    return s


def save_qstate(s):
    h = s["maxAgeHours"]
    s["maxAgeHours"] = int(h) if h == int(h) else h
    write_json(QUESTIONS, s)


def parse_iso(v):
    try:
        return datetime.datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


def q_age_hours(q, now=None):
    at = parse_iso(q.get("at"))
    if at is None:
        return 0.0
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return (now - at).total_seconds() / 3600.0


def parse_hours(s):
    """48h, 2d, 90m, 1w, or a bare number of hours → hours (float)."""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*([mhdw]?)\s*$", str(s or "").lower())
    if not m:
        die("bad duration %r (try 48h, 2d, 90m)" % s)
    n = float(m.group(1))
    return n * {"m": 1 / 60.0, "h": 1, "": 1, "d": 24, "w": 168}[m.group(2)]


def fmt_hours(h):
    if h <= 0:
        return "never"
    if h >= 24 and h % 24 == 0:
        return "%dd" % (h // 24)
    return ("%dh" % h) if h == int(h) else ("%gh" % h)


def all_open_questions(qs=None):
    """Every unanswered, unclosed question, oldest first."""
    qs = qs or load_qstate()
    msgs = read_jsonl(MSGS)
    answered = set(m.get("questionId") for m in msgs if m.get("kind") == "answer")
    closed = qs["closed"]
    return [m for m in msgs if m.get("kind") == "question" and m.get("questionId")
            and m["questionId"] not in answered and m["questionId"] not in closed]


def split_old(open_qs, max_age):
    if max_age <= 0:
        return open_qs, []
    fresh = [q for q in open_qs if q_age_hours(q) <= max_age]
    old = [q for q in open_qs if q_age_hours(q) > max_age]
    return fresh, old


def close_questions(ids, state, by):
    """Mark questions dismissed/expired (and their task records). Returns the
    ids actually closed; already answered/closed/unknown ids are skipped."""
    done = []
    with Lock():
        qs = load_qstate()
        open_by_id = dict((q["questionId"], q) for q in all_open_questions(qs))
        at = now_iso()
        touched = {}
        for qid in ids:
            q = open_by_id.get(qid)
            if not q:
                continue
            qs["closed"][qid] = {"state": state, "at": at, "by": by}
            done.append(qid)
            if q.get("taskId"):
                touched.setdefault(q["taskId"], []).append(qid)
        if done:
            save_qstate(qs)
        for tid, qids in touched.items():
            t = read_json(task_path(tid))
            if not isinstance(t, dict):
                continue
            for rec in t.get("questions") or []:
                if rec.get("id") in qids:
                    rec[state + "At"] = at
            still = [r for r in t.get("questions") or []
                     if r.get("answer") is None and not r.get("dismissedAt") and not r.get("expiredAt")]
            if t.get("status") == "asking" and not still:
                t["status"] = "queued"
            t.setdefault("log", []).append({"at": at, "text": "%s question%s %s" % (
                state.capitalize(), "s" if len(qids) > 1 else "", ", ".join(qids))})
            save_task(t)
    return done


def q_line(q, now=None):
    tag = " (task %s)" % q["taskId"] if q.get("taskId") else ""
    opts = "  [%s]" % " | ".join(q.get("options") or []) if q.get("options") else ""
    return "  %s%s %s%s  · %s ago" % (q.get("questionId"), tag, q.get("text", ""), opts,
                                      fmt_age(q_age_hours(q, now)))


def fmt_age(h):
    if h < 1:
        return "%dm" % max(0, round(h * 60))
    if h < 48:
        return "%dh" % round(h)
    return "%dd" % round(h / 24)


def cmd_question(args):
    if not args or args[0] in ("help", "-h", "--help"):
        die("question needs: list|dismiss|expire|max-age (see mia help)")
    sub, rest = args[0], args[1:]
    if sub == "list":
        pos, o = parse(rest, {"--all": False, "--json": False})
        qs = load_qstate()
        fresh, old = split_old(all_open_questions(qs), qs["maxAgeHours"])
        rows = fresh + old if o.get("--all") else fresh
        if o.get("--json"):
            out = [dict(id=q["questionId"], taskId=q.get("taskId"), text=q.get("text", ""),
                        options=q.get("options") or [], askedAt=q.get("at"),
                        old=q in old) for q in rows]
            print(json.dumps(out, indent=2, ensure_ascii=False))
            return
        if not rows:
            print("(no open questions)")
        for q in rows:
            print(q_line(q) + ("  [old]" if q in old else ""))
        if old and not o.get("--all"):
            print("(+%d older than %s hidden — mia question list --all)" % (len(old), fmt_hours(qs["maxAgeHours"])))
    elif sub == "dismiss":
        pos, o = parse(rest, {})
        ids = [x.strip() for x in pos if x.strip()]
        if not ids:
            die("usage: mia question dismiss <question-id>…")
        done = close_questions(ids, "dismissed", "mia")
        for qid in ids:
            print("%s\t%s" % (qid, "dismissed" if qid in done else "not open (answered, closed or unknown)"))
        if not done:
            sys.exit(1)
    elif sub == "expire":
        pos, o = parse(rest, {"--older-than": True, "--dry-run": False})
        if pos:
            die("usage: mia question expire [--older-than 48h] [--dry-run]")
        qs = load_qstate()
        h = parse_hours(o["--older-than"]) if "--older-than" in o else qs["maxAgeHours"]
        if h <= 0:
            die("--older-than must be more than 0")
        old = [q for q in all_open_questions(qs) if q_age_hours(q) > h]
        if o.get("--dry-run"):
            for q in old:
                print(q_line(q))
            print("would expire %d question%s" % (len(old), "" if len(old) == 1 else "s"))
            return
        done = close_questions([q["questionId"] for q in old], "expired", "mia")
        print("expired %d question%s older than %s%s" % (len(done), "" if len(done) == 1 else "s",
                                                       fmt_hours(h), (": " + " ".join(done)) if done else ""))
    elif sub == "max-age":
        pos, o = parse(rest, {})
        if not pos:
            print(fmt_hours(load_qstate()["maxAgeHours"]))
            return
        if len(pos) != 1:
            die("usage: mia question max-age [<48h|3d|never>]")
        h = 0.0 if pos[0].lower() in ("never", "off", "0") else parse_hours(pos[0])
        with Lock():
            qs = load_qstate()
            qs["maxAgeHours"] = h
            save_qstate(qs)
        print("old questions: %s" % ("never hidden" if h <= 0 else "hidden after " + fmt_hours(h)))
    else:
        die("unknown question command: %s (try: mia help)" % sub)


def cmd_status(args):
    pos, o = parse(args, {"--all": False})
    st = read_json(STATE, {}) or {}
    if st:
        print("Mia: %s · model %s · restarts %s" % (
            "enabled" if st.get("enabled") else "disabled", st.get("model", "?"), st.get("restarts", 0)))
    tasks = all_tasks()
    counts = {}
    for t in tasks:
        counts[t.get("status", "?")] = counts.get(t.get("status", "?"), 0) + 1
    if not tasks:
        print("Tasks: none")
    else:
        print("Tasks: " + " · ".join("%d %s" % (counts[s], s) for s in STATUSES if s in counts))
        open_ = [t for t in tasks if t.get("status") not in ("done", "failed", "cancelled")]
        open_.sort(key=lambda t: (STATUSES.index(t["status"]) if t.get("status") in STATUSES else 9,
                                  t.get("priority", 3), t.get("id", "")))
        for t in open_:
            folder = os.path.basename(t.get("dir") or "") or "-"
            print("  %s  %-9s p%s  %s  [%s]" % (t.get("id"), t.get("status"), t.get("priority", 3),
                                                 t.get("title", ""), folder))
        closed = [t for t in tasks if t.get("status") in ("done", "failed", "cancelled")]
        closed.sort(key=lambda t: t.get("updatedAt", ""), reverse=True)
        for t in closed[:3]:
            print("  %s  %-9s      %s" % (t.get("id"), t.get("status"), t.get("title", "")))
    qst = load_qstate()
    fresh, old = split_old(all_open_questions(qst), qst["maxAgeHours"])
    shown = fresh + old if o.get("--all") else fresh
    print("Open questions: %s" % ("none" if not shown else len(shown)))
    for q in shown:
        print(q_line(q) + ("  [old]" if q in old else ""))
    if old and not o.get("--all"):
        print("  (+%d older than %s hidden — `mia status --all`, or clear them: `mia question expire`)"
              % (len(old), fmt_hours(qst["maxAgeHours"])))
    s = read_json(SCHED)
    if isinstance(s, dict):
        rs = [r for r in s.get("reminders", []) if not r.get("fired")]
        if rs:
            print("Reminders:")
            for r in sorted(rs, key=lambda r: r.get("at", "")):
                print("  %s  %s  %s" % (r.get("id"), r.get("at"), r.get("text", "")))
    pend = [e for e in read_jsonl(EVENTS) if not e.get("delivered")]
    if pend:
        print("Undelivered events: %d (see `mia inbox`)" % len(pend))


# ---- panel ------------------------------------------------------------------
# `mia panel …` drives the Mission Control panel on Daniel's iPad: navigation
# and view actions only, from a fixed allow-list. Each command is a line in
# panel.jsonl; the app ships it to the relay, which hands it to the most
# recently active panel (docs/mia.md §8.2). Fire-and-forget: if no panel is
# open or the target isn't found, an [MC] event says so.

PANEL_VIEWS = ["home", "hq", "fleet", "library", "mia", "insights", "settings"]
PANEL_SCROLLS = ["down", "up", "top", "bottom"]


def panel_cmd(action, **fields):
    with Lock():
        pid = next_stamp(PANEL, "p_")
        c = {"id": pid, "at": now_iso(), "action": action}
        c.update({k: v for k, v in fields.items() if v is not None})
        append_jsonl(PANEL, c)
    print(pid)


def one_arg(pos, usage, limit=200):
    t = " ".join(pos).strip()
    if not t:
        die("usage: mia panel " + usage)
    if len(t) > limit or "\n" in t:
        die("argument too long or multi-line")
    return t


def cmd_panel(args):
    if not args or args[0] in ("help", "-h", "--help"):
        die("panel needs: open-doc|open-task|open-agent|view|open-url|search|scroll-to|scroll|highlight|"
            "show-url|show-doc|close (see mia help)")
    sub, rest = args[0], args[1:]
    if sub == "open-doc":
        pos, o = parse(rest, {"--at": True})
        heading = o.get("--at")
        panel_cmd("open-doc", arg=one_arg(pos, "open-doc <library-id|title> [--at <heading>]"),
                  heading=heading.strip() if heading else None)
    elif sub == "open-task":
        pos, o = parse(rest, {})
        if len(pos) != 1:
            die("usage: mia panel open-task <id>")
        panel_cmd("open-task", arg=norm_id(pos[0]))
    elif sub == "open-agent":
        pos, o = parse(rest, {})
        panel_cmd("open-agent", arg=one_arg(pos, "open-agent <name|session-id>", 120))
    elif sub == "view":
        pos, o = parse(rest, {})
        if len(pos) != 1 or pos[0] not in PANEL_VIEWS:
            die("usage: mia panel view <%s>" % "|".join(PANEL_VIEWS))
        panel_cmd("view", arg=pos[0])
    elif sub == "open-url":
        pos, o = parse(rest, {})
        url = one_arg(pos, "open-url <https-url>", 2000)
        if not re.match(r"^https://[^\s/$.?#][^\s]*$", url, re.I):
            die("open-url takes an https:// link only")
        panel_cmd("open-url", arg=url)
    elif sub == "search":
        pos, o = parse(rest, {})
        panel_cmd("search", arg=one_arg(pos, 'search "<text>"'))
    elif sub == "scroll-to":
        pos, o = parse(rest, {})
        panel_cmd("scroll-to", arg=one_arg(pos, 'scroll-to "<heading or text>"'))
    elif sub == "highlight":
        pos, o = parse(rest, {})
        panel_cmd("highlight", arg=one_arg(pos, 'highlight "<text>"'))
    elif sub == "scroll":
        pos, o = parse(rest, {})
        if len(pos) != 1 or pos[0] not in PANEL_SCROLLS:
            die("usage: mia panel scroll <%s>" % "|".join(PANEL_SCROLLS))
        panel_cmd("scroll", arg=pos[0])
    elif sub == "show-url":
        pos, o = parse(rest, {})
        url = one_arg(pos, "show-url <https-url>", 2000)
        if not re.match(r"^https://[^\s/$.?#][^\s]*$", url, re.I):
            die("show-url takes an https:// link only")
        panel_cmd("show-url", arg=url)
    elif sub == "show-doc":
        pos, o = parse(rest, {"--at": True})
        heading = o.get("--at")
        panel_cmd("show-doc", arg=one_arg(pos, "show-doc <library-id|title> [--at <text>]"),
                  heading=heading.strip() if heading else None)
    elif sub == "close":
        pos, o = parse(rest, {})
        panel_cmd("close", arg="")
    else:
        die("unknown panel command: %s (try: mia help)" % sub)


HELP = """mia — Mia's line to Daniel and the Mission Control task list.

  mia say    "<text>" [--task <id>] [--speak]       chat message to Daniel (no push)
  mia notify "<text>" [--task <id>] [--urgent] [--speak]
                                                    message + push + Mac banner
  mia ask    "<question>" [--options "A|B|C"] [--task <id>] [--speak]
                                                    ask Daniel; prints the question id
                                                    --speak: an open panel reads it aloud
  mia task list [--status <s>]                      id<TAB>status<TAB>priority<TAB>title
  mia task show <id>                                the task JSON
  mia task add "<title>" [--detail <text>|--stdin] [--dir <d>] [--priority n]
               [--company <company-or-project-id>]  (checked against the Jarvis registry)
  mia task set <id> <status|dir|priority|result|title|company> <value>
                                                    (company "" clears company + project)
  mia task note <id> "<text>"                       append to the task's log
  mia dispatch <id> [--dir <d>] [--tier cheap|mid|smart] [--kind <k>] [--model <m>]
               --brief-file <f> | --stdin           launch an executor for the task
                                                    --model wins, then --tier, then --kind;
                                                    none of them = Mia's own model
  mia verify <id> [--tier smart] [--dir <d>]        new task that checks <id>'s claimed work
                                                    (smart tier); prints the new id
  mia routing                                       tier -> model and kind -> tier tables
                                                    ($MIA_DIR/routing.json overrides)
  mia tell <id> "<text>"                            type text into the task's executor
  mia remind --at <ISO-8601|HH:MM|+2h|+30m> "<text>" [--task <id>]
  mia remind list [--all]                           pending reminders (--all: fired too)
  mia remind cancel <reminder-id>
  mia heartbeat list                                id, on/off, when, label, prompt
  mia heartbeat set <id> (--every <min>|--at HH:MM) [--label <l>] [--prompt <p>]
                                                    add or change a recurring prompt
  mia heartbeat enable|disable|remove <id>
  mia panel open-doc <library-id|title> [--at "<heading or text>"]
                                                    open a Library doc on Daniel's panel
  mia panel open-task <id>                          show a task on Mia's board
  mia panel open-agent <name|session-id>            open an agent's window
  mia panel view <home|hq|fleet|library|mia|insights|settings>
  mia panel open-url <https-url>                    open a link on the iPad (Zoom/Meet/Teams…)
  mia panel search "<text>"                         open search with this text
  mia panel scroll-to "<heading or text>"           scroll the open doc/page to it (forgiving match)
  mia panel highlight "<text>"                      scroll to text and mark it for a few seconds
  mia panel scroll <down|up|top|bottom>             about one screen per step
  mia panel show-url <https-url>                    show a web page in a viewer over the panel
                                                    (a card with photos + Open if the site blocks framing)
  mia panel show-doc <library-id|title> [--at "<text>"]
                                                    show a Library doc in that viewer
  mia panel close                                   close the viewer
  mia inbox [-n 50]                                 recent system events
  mia uploads [-n 20] [--json]                      files Daniel sent from the panel (newest last)
  mia question list [--all] [--json]               open questions (--all: old ones too)
  mia question dismiss <question-id>…               close questions that no longer matter
  mia question expire [--older-than 48h] [--dry-run]
                                                    close every open question older than that
                                                    (default: the max age below)
  mia question max-age [<48h|3d|never>]             show/set when open questions count as old
                                                    (old = hidden from Daniel; never deleted)
  mia jarvis <show|set-level|metric|finding|pause|resume|…>
                                                    the HQ registry (mia jarvis help)
  mia status [--all]                                tasks, open questions, reminders
                                                    (--all: old questions too)
  mia help

Statuses: queued, asking, running, checking, done, failed, cancelled.
State lives in $MIA_DIR (default ~/.mission-control/mia)."""


def cmd_jarvis(args):
    """The Jarvis registry (HQ view) lives in its own script beside this one."""
    me = os.environ.get("MIA_SELF") or ""
    for c in (os.path.join(os.path.dirname(os.path.realpath(me)), "mia-jarvis") if me else "",
              os.path.expanduser("~/.mission-control/bin/mia-jarvis")):
        if c and os.path.isfile(c):
            os.execvp("python3", ["python3", c] + list(args))
    die("mia-jarvis is not installed next to mia (update Mission Control)")


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(HELP)
        return
    cmd, rest = argv[0], argv[1:]
    table = {"say": cmd_say, "notify": cmd_notify, "ask": cmd_ask, "task": cmd_task,
             "dispatch": cmd_dispatch, "verify": cmd_verify, "routing": cmd_routing,
             "tell": cmd_tell, "remind": cmd_remind,
             "heartbeat": cmd_heartbeat, "inbox": cmd_inbox, "status": cmd_status,
             "panel": cmd_panel, "uploads": cmd_uploads,
             "question": cmd_question, "questions": cmd_question, "jarvis": cmd_jarvis}
    if cmd not in table:
        die("unknown command: %s (try: mia help)" % cmd)
    table[cmd](rest)


main(sys.argv[1:])
PY

MIA_SELF="${BASH_SOURCE[0]:-$0}"
export MIA_SELF
exec python3 -c "$MIA_PY" "$@"
"""#

    private static let miaSkill = #"""
---
name: mission-control-mia
description: The `mia` CLI — how Mia (Daniel's Mission Control assistant) and the executor agents she dispatches talk to Daniel and manage the Mia task list. Use it when you are Mia, when you are executing a Mission Control task for Mia, or when the user asks to add, list, or check tasks for Mia.
---

# mia — Mia's task list and line to Daniel

`~/.mission-control/bin/mia` is a small CLI over plain JSON files in
`~/.mission-control/mia/`. The Mission Control app watches that folder: it
pushes Mia's messages to Daniel's phone, launches executors, and types events
(lines starting with `[MC]`) into Mia's terminal. Plain terminal output is
never seen by Daniel — only what goes through `mia`.

```
mia say    "<text>" [--task <id>] [--speak]       chat message to Daniel (no push)
mia notify "<text>" [--task <id>] [--urgent] [--speak]   message + push + Mac banner
mia ask    "<question>" [--options "A|B|C"] [--task <id>] [--speak]   prints the question id
mia panel open-doc|open-task|open-agent|view|open-url|search|scroll-to|scroll|
          highlight|show-url|show-doc|close …     act on Daniel's panel (Mia only; see mia help)
mia task list [--status <s>]                      id<TAB>status<TAB>priority<TAB>title
mia task show <id>
mia task add "<title>" [--detail <text>|--stdin] [--dir <d>] [--priority n] [--company <company|project>]
mia task set <id> <status|dir|priority|result|title|company> <value>
mia task note <id> "<text>"
mia dispatch <id> [--dir <d>] [--tier cheap|mid|smart] [--kind <k>] [--model <m>] --brief-file <f> | --stdin
mia verify <id>                                   Opus checks a finished task's work (new task)
mia routing                                       tier → model, kind → tier
mia tell <id> "<text>"                            type into that task's executor
mia remind --at <ISO-8601|HH:MM|+2h|+30m> "<text>" [--task <id>]
mia remind list [--all] | cancel <reminder-id>
mia heartbeat list                                recurring prompts Mia gets
mia heartbeat set <id> (--every <min>|--at HH:MM) [--label <l>] [--prompt <p>]
mia heartbeat enable|disable|remove <id>
mia inbox [-n 50]                                 recent events delivered to Mia
mia uploads [-n 20] [--json]                      files Daniel sent from the panel
mia status [--all]                                tasks, open questions, reminders
                                                  (--all: old questions too)
mia question list [--all] [--json]                open questions (--all: old ones too)
mia question dismiss <q_id>…                      close questions that no longer matter
mia question expire [--older-than 48h] [--dry-run]   close every open question older than that
mia question max-age [<48h|3d|never>]             when an open question counts as old
```

Statuses: `queued → asking → running → checking → done | failed | cancelled`.
Task ids are 4-digit (`0007`); `7` works too.

**Model routing (Mia)**: the dumbest model that can do the job does it, and a
smart model checks cheap work before Daniel hears it's done.
`--tier cheap` = Haiku (scouting, stats, triage, summaries, classifying),
`mid` = Sonnet (routine fixes, research, docs, content), `smart` = Opus
(builds, design, releases, verifying). `--kind scout|research|build|…` picks the
tier for you (`mia routing`; overrides in `~/.mission-control/mia/routing.json`).
`--model` still wins. A cheap-tier task is marked `verify: smart`: when it
finishes, run `mia verify <id>` and report only after it says PASS.

**Companies**: file every task and doc under its company —
`mia task add … --company <company|project>`, `mc-doc new … --company <id>`
(ids: `mia jarvis show`). HQ company pages show them, plus what you know
(memory files) and action buttons; a tap arrives as
`[MC] Daniel: HQ action · <company> · <label>: <the job>` — treat it as a
request from Daniel, file the task under that company.

**If you are an executor** (your prompt starts "You are executing Mission
Control task <id>"): never ask Daniel anything. If blocked, run
`mia task note <id> "BLOCKED: …"` and stop. When finished, write your report to
`~/.mission-control/mia/briefs/<id>.report.md`, run `mia task note <id> "DONE"`,
and end your turn.

**Files from Daniel**: the panel's upload button saves them to
`~/.mission-control/mia/uploads/<yyyy-MM-dd>/<name>` and Mia gets one event per file:

```
[MC] Daniel uploaded a file: <path> (<mime>, <size>) — note: <his note>
[MC] Daniel uploaded a file (2 of 3): <path> (<mime>, <size>) — note: <his note>
```

The note is optional ("summarise this", "file this for Oblivion"). Files sent
together are numbered and share the note. `mia uploads` lists recent ones
(`--json` for id, path, mime, size, sha256, caption).

**Showing Daniel things (Mia only)** — he mostly reads the panel on his iPad
or phone:

```
mia panel open-doc <id|title> [--at "<heading or text>"]   open a Library doc
mia panel scroll-to "<heading or text>"   jump to it and flash it (forgiving:
                                          case, emoji, punctuation, prefix,
                                          any paragraph/list item/table row,
                                          then fuzzy — you're told if fuzzy)
mia panel highlight "<text>"              same, with a longer-lasting mark
mia panel scroll down|up|top|bottom       about one screen per step
mia panel show-url <https-url>            page in a viewer over the panel
mia panel show-doc <id|title> [--at "…"]  a Library doc in that viewer
mia panel close                           close the viewer (or the open doc)
```

`show-url` answers with `[MC] Panel: show-url … — framed …` (the page is inside
the panel; he scrolls it himself, `scroll` can't reach into another site) or
`— card …` (the site forbids framing, e.g. Property24: he sees its title,
photos, summary and an Open button). Scroll commands act on the viewer while
it's open, else the open doc, else the main view.

**Old questions**: an unanswered question older than the max age (48 h by
default; Daniel can change it in the panel's Settings, you with
`mia question max-age`) is hidden from Daniel: no badge, no home card, not
read aloud, not in `mia status` (use `--all`). Nothing is deleted; closures
live in `~/.mission-control/mia/questions.json`. Close questions yourself once
they're moot — `mia question dismiss q_…` for one you no longer need,
`mia question expire` (or `--older-than 3d`) to clear stale ones. When Daniel
dismisses from the panel you get:

```
[MC] Daniel dismissed q_… (task 0012) — no answer is coming, don't wait on it: "<question>"
[MC] Daniel dismissed 5 old questions — no answers are coming, don't wait on them: q_…, q_… (task 0012)
```

Carry on without the answer, or ask again differently if it still matters.

**If you are Mia**: never sleep or poll — end your turn and wait for `[MC]`.
"""#

    // `mia jarvis …` (task 0199): the HQ registry CLI, beside `mia`.
    private static let miaJarvis = #"""
#!/usr/bin/env python3
# mia-jarvis — the Jarvis registry behind Mission Control's HQ view (task 0199).
#
# Reached as `mia jarvis …` (scripts/mia hands the arguments over). One file on
# the Mac is the source of truth: $MIA_DIR/jarvis/registry.json — companies →
# projects, each with links, a health check, metrics, an autonomy level and
# standing permissions. Mia maintains it with this CLI; the HQ panel changes it
# through the relay (`sync` pulls those changes and applies them here). The
# schema is documented in $MIA_DIR/jarvis/README.md (written by `seed`).
#
#   findings.jsonl   what Mia found / fixed / shipped, health changes, controls
#   sync.json        the sync loop's bookkeeping (last push, applied controls)
#
# Repo source of truth: scripts/mia-jarvis. ToolingInstaller.swift embeds a
# byte-for-byte copy next to `mia` in ~/.mission-control/bin. Needs only
# python3 (stdlib). Never prints or pushes a secret: the relay token is read
# from MC_TOKEN or the app's defaults and only ever sent as a bearer header.

import sys, os, json, time, re, fcntl, tempfile, datetime, subprocess, threading
import urllib.request, urllib.error

D = os.path.abspath(os.path.expanduser(os.environ.get("MIA_DIR") or "~/.mission-control/mia"))
J = os.path.join(D, "jarvis")
REG = os.path.join(J, "registry.json")
FINDINGS = os.path.join(J, "findings.jsonl")
SYNC = os.path.join(J, "sync.json")
README = os.path.join(J, "README.md")
TASKS = os.path.join(D, "tasks")
SCHED = os.path.join(D, "schedule.json")
HERE = os.path.dirname(os.path.realpath(__file__))

LEVELS = ["off", "watch", "suggest", "fix"]
LEVEL_NAMES = {0: "Off", 1: "Watch", 2: "Suggest", 3: "Fix with undo"}
# Pitch frequency steps, quietest first ("quieter"/"louder" move one step).
PITCH_STEPS = [0.14, 0.5, 1, 2, 3]
PITCH_NAMES = {0.14: "about once a week", 0.5: "every other day", 1: "once a day", 2: "twice a day", 3: "three a day"}
FINDING_KINDS = ["found", "fixed", "shipped", "health", "control", "scout", "note", "action"]
HISTORY_MAX = 120  # points kept per metric
RECENT_MAX = 300  # health samples kept per project (~3 days at 15 min)
UA = "MissionControl-Jarvis/1 (health check; +https://oblivionestate.com)"


def die(msg, code=1):
    sys.stderr.write("mia: %s\n" % msg)
    sys.exit(code)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(v):
    try:
        return datetime.datetime.strptime(str(v), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except (TypeError, ValueError):
        return None


class Lock(object):
    """Exclusive flock on the registry (the panel sync and Mia share it)."""
    def __enter__(self):
        os.makedirs(J, exist_ok=True)
        self.fd = os.open(os.path.join(J, ".lock"), os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)
        return False


def write_atomic(path, text):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".jarvis.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except (IOError, OSError):
        return ""


def read_json(path, default=None):
    t = read_text(path)
    if not t.strip():
        return default
    try:
        return json.loads(t)
    except ValueError:
        return default


def write_json(path, obj):
    write_atomic(path, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def read_jsonl(path):
    out = []
    for line in read_text(path).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def append_jsonl(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")


def parse(args, spec):
    """spec: {"--flag": takes_value(bool)}. Returns (positionals, opts)."""
    pos, opts = [], {}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            pos.extend(args[i + 1:])
            break
        if a.startswith("--") and len(a) > 2:
            name, eq, val = a.partition("=")
            if name not in spec:
                die("unknown option: %s" % name)
            if spec[name]:
                if not eq:
                    i += 1
                    if i >= len(args):
                        die("%s needs a value" % name)
                    val = args[i]
                opts[name] = val
            else:
                opts[name] = True
        else:
            pos.append(a)
        i += 1
    return pos, opts


# ---------------------------------------------------------------------------
# The seed: every company and project Mia manages, as of 14 Oct 2026 (from
# memory/*.md and the task list). `seed` writes it once; Mia owns it after.

def P(pid, name, company, summary, links=(), check=None, dirs=(), keywords=(), fallback=(), notes="", probes=(), autonomy=2):
    return {
        "id": pid, "name": name, "company": company, "summary": summary,
        "links": [{"label": l, "url": u, "kind": k} for (l, u, k) in links],
        "healthcheck": check, "probes": list(probes),
        "metrics": [], "autonomy": autonomy, "notes": notes,
        "match": {"dirs": list(dirs), "keywords": list(keywords), "fallbackDirs": list(fallback)},
        "docs": [], "permissions": [],
    }


def http(url, expect=None, slow_ms=4000):
    c = {"type": "http", "target": url, "slowMs": slow_ms}
    if expect:
        c["expect"] = list(expect)
    return c


SEED_COMPANIES = [
    {"id": "oblivion", "name": "Oblivion Estates", "tagline": "Cape Town luxury property: prospecting, mandates, the website", "photo": "hq/oblivion.jpg"},
    {"id": "klear", "name": "Klear", "tagline": "The fund: Penny for customers, Houston for research", "photo": "hq/klear.jpg"},
    {"id": "dryager", "name": "Dry-ager", "tagline": "Dry-ager sales pipeline and lead panel", "photo": "hq/dryager.jpg"},
    {"id": "games", "name": "Games", "tagline": "Roblox studio: one live game, three in the oven", "photo": "hq/games.jpg"},
    {"id": "video", "name": "YouTube & video", "tagline": "Bodycam and history channels, narration pipelines", "photo": "hq/video.jpg"},
    {"id": "propiq", "name": "PropIQ", "tagline": "Who sells next: a LOOM competitor in the making", "photo": "hq/propiq.jpg"},
    {"id": "civentropy", "name": "CivEntropy", "tagline": "Civilisation game with an AI diplomat", "photo": "hq/civentropy.jpg"},
    {"id": "mission-control", "name": "Mission Control", "tagline": "Mia, the panel, the relay and the Mac app", "photo": "hq/mission-control.jpg"},
]

SEED_PROJECTS = [
    P("prospect-engine", "Prospect engine", "oblivion",
      "Crawls listings, finds owners and runs the lead pipeline (VPS).",
      [("Dashboard", "https://209-159-148-182.sslip.io", "live"), ("Railway copy", "https://prospect-engine-production-2170.up.railway.app", "admin")],
      http("https://209-159-148-182.sslip.io", [200, 204, 301, 302, 401, 403]),
      ["~/prospecting-auto"], ["prospect", "prospecting", "lead pipeline", "leads", "erf", "owner pull", "loom", "property24"],
      notes="Prod is the VPS (Caddy → gunicorn). Railway copy lags behind."),
    P("oblivion-site", "oblivionestate.com", "oblivion",
      "The public website: listings, enquiries, SEO.",
      [("Website", "https://oblivionestate.com", "live")],
      http("https://oblivionestate.com"),
      ["~/Oblivion-estates"], ["oblivionestate", "oblivion estates website", "website", "seo", "site"],
      notes="v3b live from ~/Oblivion-estates-release (Cloudflare-fronted)."),
    P("penny", "Penny", "klear",
      "Customer chat bot for the fund.",
      [("Playground", "https://klear-production.up.railway.app/playground", "live")],
      http("https://klear-production.up.railway.app/playground", [200, 301, 302, 401, 403]),
      ["~/Klear"], ["penny", "klear"],
      notes="Deploy `railway up --service klear --detach` (not GitHub-linked)."),
    P("houston", "Houston research desk", "klear",
      "Research desk writing investment theses.",
      [("Research desk", "https://research-klear.up.railway.app", "live")],
      http("https://research-klear.up.railway.app", [200, 301, 302, 401, 403]),
      ["~/Klear-research"], ["houston", "research desk", "thesis", "theses"],
      notes="AI runs through the Mac bridge LaunchAgent; Mac must be awake."),
    P("dryager-panel", "Dry-ager panel", "dryager",
      "Lead pipeline for dry-ager sales.",
      [("Panel", "https://dryager-panel.up.railway.app", "live")],
      http("https://dryager-panel.up.railway.app", [200, 301, 302, 401, 403]),
      ["~/dryager-panel", "~/.mission-control/mia/research/dryager"], ["dry-ager", "dryager", "dry ager"],
      notes="SQLite on /data, no off-site backup."),
    P("crystal-garden", "Crystal Garden", "games",
      "Public on Roblox since 7 Oct.",
      [("Roblox page", "https://www.roblox.com/games/88007603886231", "live")],
      http("https://www.roblox.com/games/88007603886231"),
      ["~/CrystalGarden"], ["crystal garden", "crystalgarden"],
      probes=[{"type": "roblox", "universeId": "10769738529"}],
      notes="Live updates only when Daniel publishes from Studio."),
    P("empire-clash", "Empire Clash", "games", "AoE-style 4-player RTS (unpublished).",
      dirs=["~/EmpireClash"], keywords=["empire clash", "empireclash", "pocket empires"]),
    P("flip-this-house", "Flip This House", "games", "Daniel's favourite: grid walls and layout appraisal (unpublished).",
      dirs=["~/FlipThisHouse"], keywords=["flip this house", "flipthishouse"]),
    P("crime-scene-cleaners", "Crime Scene Cleaners", "games", "v2: one big realistic house (unpublished).",
      dirs=["~/CrimeSceneCleaners"], keywords=["crime scene"]),
    P("bodycam", "Bodycam channel", "video", "Bodycam breakdown videos with narration.",
      dirs=["~/bodycam-pipeline"], keywords=["bodycam", "youtube", "video"]),
    P("history", "History pipeline", "video", "History explainers and narration (voice lab).",
      dirs=["~/history-pipeline", "~/voice-lab"], keywords=["history", "narration", "voice lab", "tts"]),
    P("propiq", "PropIQ", "propiq", "Who-sells-next predictions; needs DeedsWeb pricing.",
      dirs=["~/PropIQ"], keywords=["propiq", "erfsight", "deedsweb"],
      notes="Name pending (Erfsight recommended)."),
    P("civentropy-game", "CivEntropy", "civentropy", "The game.",
      [("Play", "https://frontend-production-89b0.up.railway.app", "live")],
      http("https://frontend-production-89b0.up.railway.app"),
      ["~/CivEntropy"], ["civentropy"]),
    P("diplomat", "Diplomat API", "civentropy", "The AI diplomat behind the game.",
      [("API", "https://civentropy-production.up.railway.app/diplomat/", "live")],
      http("https://civentropy-production.up.railway.app/diplomat/", [200, 301, 302, 401, 403, 404, 405]),
      keywords=["diplomat"], notes="Kill switch DIPLOMAT_RUNS_PER_DAY=0."),
    P("mc-panel", "Panel & relay", "mission-control", "The iPad panel and the Railway relay.",
      [("Panel", "https://mission-control-remote-production.up.railway.app", "live")],
      http("https://mission-control-remote-production.up.railway.app/health"),
      keywords=["mission control", "panel", "relay", "dock", "hq", "library", "voice", "talk mode"],
      fallback=["~/widget-claude"]),
    P("mia", "Mia", "mission-control", "The assistant herself: heartbeats, scouting, tasks.",
      keywords=["mia", "jarvis", "scout", "heartbeat", "imessage", "mac mini", "memory"],
      fallback=["~/.mission-control/mia"]),
]


def seed_registry():
    r = {
        "version": 1,
        "updatedAt": now_iso(),
        "jarvis": {"paused": False, "pausedAt": None, "pausedHeartbeats": [],
                   "proactiveHeartbeats": ["hb_scout", "hb_health", "hb_crystal"],
                   "pitchesPerDay": 1, "healthEveryMinutes": 15},
        "companies": json.loads(json.dumps(SEED_COMPANIES)),
        "projects": json.loads(json.dumps(SEED_PROJECTS)),
    }
    ensure_v2(r)
    return r


# ---------------------------------------------------------------------------
# Registry access

def load(required=True):
    r = read_json(REG)
    if not isinstance(r, dict):
        if required:
            die("no registry yet at %s (run: mia jarvis seed)" % REG)
        return None
    r.setdefault("jarvis", {})
    j = r["jarvis"]
    j.setdefault("paused", False)
    j.setdefault("pitchesPerDay", 1)
    j.setdefault("healthEveryMinutes", 15)
    j.setdefault("proactiveHeartbeats", ["hb_scout", "hb_health", "hb_crystal"])
    j.setdefault("pausedHeartbeats", [])
    r.setdefault("companies", [])
    r.setdefault("projects", [])
    for p in r["projects"]:
        p.setdefault("metrics", [])
        p.setdefault("links", [])
        p.setdefault("docs", [])
        p.setdefault("permissions", [])
        p.setdefault("autonomy", 2)
        p.setdefault("match", {})
    ensure_v2(r)
    return r


def save(r):
    r["updatedAt"] = now_iso()
    write_json(REG, r)


class Bad(ValueError):
    """A bad project/level from the panel: skip that control, keep syncing."""


def lookup(r, q):
    """By id, then case-insensitive name, then a unique prefix/substring."""
    q0 = (q or "").strip().lower()
    if not q0:
        raise Bad("which project? (mia jarvis show lists them)")
    ps = r["projects"]
    for p in ps:
        if p["id"].lower() == q0:
            return p
    for p in ps:
        if p.get("name", "").lower() == q0:
            return p
    hits = [p for p in ps if p["id"].lower().startswith(q0) or p.get("name", "").lower().startswith(q0)]
    if len(hits) == 1:
        return hits[0]
    hits = hits or [p for p in ps if q0 in p["id"].lower() or q0 in p.get("name", "").lower()]
    if len(hits) == 1:
        return hits[0]
    if hits:
        raise Bad("'%s' matches several projects: %s" % (q, ", ".join(p["id"] for p in hits)))
    raise Bad("no project '%s' (ids: %s)" % (q, ", ".join(p["id"] for p in ps)))


def find_project(r, q):
    try:
        return lookup(r, q)
    except Bad as e:
        die(str(e))


def level_of(v):
    s = str(v).strip().lower()
    if s.isdigit() and 0 <= int(s) <= 3:
        return int(s)
    alias = {"off": 0, "watch": 1, "suggest": 2, "fix": 3, "fix-with-undo": 3, "fix with undo": 3, "auto": 3}
    if s in alias:
        return alias[s]
    raise Bad("level must be 0-3 or off|watch|suggest|fix")


def parse_level(v):
    try:
        return level_of(v)
    except Bad as e:
        die(str(e))


def level_label(n):
    return "%s (%d)" % (LEVEL_NAMES.get(n, "?"), n)


def pitch_label(v):
    return PITCH_NAMES.get(v, "%g a day" % v)


def step_pitch(cur, how):
    try:
        cur = float(cur)
    except (TypeError, ValueError):
        cur = 1
    idx = min(range(len(PITCH_STEPS)), key=lambda i: abs(PITCH_STEPS[i] - cur))
    if how == "quieter":
        idx = max(0, idx - 1)
    elif how == "louder":
        idx = min(len(PITCH_STEPS) - 1, idx + 1)
    return PITCH_STEPS[idx]


def add_finding(project, kind, text, by="mia", **extra):
    # ms + a random tail: several controls applied in one sync stay distinct.
    f = {"id": "f_%d_%s" % (int(time.time() * 1000), os.urandom(2).hex()), "at": now_iso(), "project": project or "", "kind": kind, "text": text, "by": by}
    f.update(extra)
    append_jsonl(FINDINGS, f)
    return f


# ---------------------------------------------------------------------------
# Heartbeats (pause/resume). Through the `mia` CLI so schedule.json keeps one
# writer protocol (its own lock, shared with the app).

def mia_bin():
    for c in (os.path.join(HERE, "mia"), os.path.expanduser("~/.mission-control/bin/mia")):
        if os.path.isfile(c):
            return c
    return "mia"


def heartbeats():
    s = read_json(SCHED, {}) or {}
    return {h.get("id"): h.get("enabled", True) for h in s.get("heartbeats", []) if isinstance(h, dict)}


def set_heartbeat(hid, on):
    try:
        subprocess.run([mia_bin(), "heartbeat", "enable" if on else "disable", hid],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
                       env=dict(os.environ, MIA_DIR=D))
    except (OSError, subprocess.SubprocessError):
        pass


def do_pause(r):
    j = r["jarvis"]
    if j.get("paused"):
        return False
    hb = heartbeats()
    off = [h for h in j.get("proactiveHeartbeats", []) if hb.get(h)]
    for h in off:
        set_heartbeat(h, False)
    j["paused"] = True
    j["pausedAt"] = now_iso()
    j["pausedHeartbeats"] = off
    return True


def do_resume(r):
    j = r["jarvis"]
    if not j.get("paused"):
        return False
    for h in j.get("pausedHeartbeats", []):
        set_heartbeat(h, True)
    j["paused"] = False
    j["pausedAt"] = None
    j["pausedHeartbeats"] = []
    return True


# ---------------------------------------------------------------------------
# Metrics

def num(v):
    try:
        f = float(str(v).replace(",", "").replace("%", "").strip())
    except ValueError:
        die("metric value must be a number (got %r)" % v)
    return int(f) if f.is_integer() and abs(f) < 1e15 else f


def put_metric(p, name, value, label=None, unit=None, better=None, source="mia", at=None):
    key = re.sub(r"[^a-z0-9_]+", "_", name.strip().lower()).strip("_") or "metric"
    m = next((x for x in p["metrics"] if x.get("name") == key), None)
    if m is None:
        m = {"name": key, "label": label or name.strip(), "unit": unit or "", "better": better or "up", "source": source, "history": []}
        p["metrics"].append(m)
    if label:
        m["label"] = label
    if unit is not None:
        m["unit"] = unit
    if better in ("up", "down"):
        m["better"] = better
    at = at or now_iso()
    m["value"] = value
    m["at"] = at
    h = m.setdefault("history", [])
    h.append({"t": at, "v": value})
    del h[:-HISTORY_MAX]
    return m


# ---------------------------------------------------------------------------
# Health + probes

def fetch(url, timeout=12, accept="*/*"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(200000)
            return resp.status, int((time.time() - t0) * 1000), body, ""
    except urllib.error.HTTPError as e:
        return e.code, int((time.time() - t0) * 1000), b"", ""
    except Exception as e:  # noqa — any network failure is a "down"
        return 0, int((time.time() - t0) * 1000), b"", (str(getattr(e, "reason", "")) or e.__class__.__name__)[:160]


def check_one(p):
    c = p.get("healthcheck") or {}
    t = c.get("type")
    if t in ("http", "railway"):
        code, ms, _, err = fetch(c.get("target", ""))
        expect = c.get("expect") or []
        good = (code in expect) if expect else (200 <= code < 400)
        if not good:
            return {"status": "down", "code": code, "ms": ms, "error": err or ("HTTP %d" % code)}
        slow = int(c.get("slowMs") or 4000)
        return {"status": "slow" if ms > slow else "up", "code": code, "ms": ms, "error": ""}
    if t == "ssh":
        cmd = c.get("command") or "true"
        t0 = time.time()
        try:
            res = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", c.get("target", ""), cmd],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25)
            ms = int((time.time() - t0) * 1000)
            if res.returncode == 0:
                return {"status": "up", "code": 0, "ms": ms, "error": ""}
            return {"status": "down", "code": res.returncode, "ms": ms, "error": (res.stderr.decode("utf-8", "replace").strip() or "exit %d" % res.returncode)[:160]}
        except (OSError, subprocess.SubprocessError) as e:
            return {"status": "down", "code": -1, "ms": int((time.time() - t0) * 1000), "error": str(e)[:160]}
    return None


def run_probe(pr):
    """Public, unauthenticated numbers. Returns [(name, label, value, unit, better)]."""
    if pr.get("type") == "roblox" and pr.get("universeId"):
        code, _, body, _ = fetch("https://games.roblox.com/v1/games?universeIds=%s" % pr["universeId"], accept="application/json")
        if code != 200:
            return []
        try:
            g = (json.loads(body.decode("utf-8")).get("data") or [{}])[0]
        except ValueError:
            return []
        out = []
        if g.get("visits") is not None:
            out.append(("visits", "Visits", int(g["visits"]), "", "up"))
        if g.get("playing") is not None:
            out.append(("playing", "Playing now", int(g["playing"]), "", "up"))
        if g.get("favoritedCount") is not None:
            out.append(("favorites", "Favourites", int(g["favoritedCount"]), "", "up"))
        return out
    return []


def gather_health(projects):
    """Run every check and probe in parallel. No registry access: callers hold
    no lock while this waits on the network."""
    results = {}

    def work(p):
        try:
            results[p["id"]] = (check_one(p), [m for pr in p.get("probes", []) for m in run_probe(pr)])
        except Exception as e:  # noqa
            results[p["id"]] = ({"status": "unknown", "code": 0, "ms": 0, "error": str(e)[:160]}, [])

    threads = [threading.Thread(target=work, args=(p,)) for p in projects]
    for t in threads:
        t.start()
    for t in threads:
        t.join(40)
    return dict(results)


def apply_health(r, results, quiet=False):
    """Fold gathered results into the (freshly locked) registry; log changes."""
    at = now_iso()
    lines = []
    for p in r["projects"]:
        if p["id"] not in results:
            continue
        res, probe = results[p["id"]]
        for (name, label, value, unit, better) in probe:
            put_metric(p, name, value, label=label, unit=unit, better=better, source="probe", at=at)
        if res is None:
            continue
        prev = p.get("health") or {}
        h = {"status": res["status"], "code": res["code"], "ms": res["ms"], "error": res["error"], "checkedAt": at,
             "since": prev.get("since") if prev.get("status") == res["status"] else at,
             "recent": (prev.get("recent") or [])[-(RECENT_MAX - 1):] + [[at, res["ms"] if res["status"] != "down" else -1]]}
        was = prev.get("status")
        if was and was != res["status"]:
            if res["status"] == "down":
                add_finding(p["id"], "health", "Went down: %s" % (res["error"] or "no answer"), by="checker")
            elif was == "down":
                gone = (parse_iso(at) or 0) - (parse_iso(prev.get("since")) or parse_iso(at) or 0)
                add_finding(p["id"], "health", "Back up after %s" % fmt_dur(gone), by="checker")
        p["health"] = h
        lines.append("%-22s %-5s %4s %6dms %s" % (p["id"], h["status"], h["code"], h["ms"], h["error"]))
    r["jarvis"]["lastHealthAt"] = at
    if not quiet:
        for l in lines:
            print(l)


def fmt_dur(s):
    s = max(0, int(s))
    if s < 90:
        return "%ds" % s
    if s < 5400:
        return "%d min" % round(s / 60)
    if s < 172800:
        return "%.1f h" % (s / 3600)
    return "%d days" % round(s / 86400)


# ---------------------------------------------------------------------------
# Tasks → projects

def expand(d):
    return os.path.abspath(os.path.expanduser(d)) if d else ""


def matcher(r, fallback=True):
    rules = []
    for p in r["projects"]:
        m = p.get("match") or {}
        rules.append((p["id"], [expand(d) for d in m.get("dirs", [])], [k.lower() for k in m.get("keywords", []) if k],
                      [expand(d) for d in m.get("fallbackDirs", [])] if fallback else []))

    def dir_hit(tdir, d):
        return tdir == d or tdir.startswith(d + "/") or tdir.startswith(d + "-")

    def kw_hit(title, k):
        return re.search(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])", title) is not None

    def match(task):
        tdir = expand(task.get("dir") or "")
        title = (task.get("title") or "").lower()
        best, score = None, 0
        for pid, dirs, kws, fb in rules:
            s = 0
            for d in dirs:
                if tdir and dir_hit(tdir, d):
                    s = max(s, 100 + len(d))
            for k in kws:
                if kw_hit(title, k):
                    s = max(s, 50 + len(k))
            for d in fb:
                if tdir and dir_hit(tdir, d):
                    s = max(s, 10)
            if s > score:
                best, score = pid, s
        return best
    return match


def all_tasks():
    out = []
    try:
        names = sorted(os.listdir(TASKS))
    except OSError:
        return out
    for n in names:
        if n.endswith(".json"):
            t = read_json(os.path.join(TASKS, n))
            if isinstance(t, dict) and t.get("id"):
                out.append(t)
    return out


def slim_tasks(r, days=45):
    match = matcher(r)
    cut = time.time() - days * 86400
    out = []
    for t in all_tasks():
        upd = parse_iso(t.get("updatedAt")) or parse_iso(t.get("createdAt")) or 0
        open_ = t.get("status") in ("queued", "asking", "running", "checking")
        if upd < cut and not open_:
            continue
        res = t.get("result")
        # Filed by hand (`mia task add --company`) beats the match rules.
        own = resolve_owner(r, t.get("project") or "") or resolve_owner(r, t.get("company") or "")
        pid = own[1] if own else None
        if not own:
            pid = match(t)
        company = own[0] if own else company_of(r, pid) if pid else ""
        rt = t.get("routing") if isinstance(t.get("routing"), dict) else {}
        out.append({"id": t["id"], "title": (t.get("title") or "")[:160], "status": t.get("status", ""),
                    "project": pid, "company": company, "createdAt": t.get("createdAt"), "updatedAt": t.get("updatedAt"),
                    "result": (res if isinstance(res, str) else "")[:240],
                    "tier": rt.get("tier") or None, "model": rt.get("model") or ((t.get("executor") or {}).get("model") if isinstance(t.get("executor"), dict) else None)})
    return out


# ---------------------------------------------------------------------------
# Company-centric data (task 0204): actions, the Library filed by company,
# and what Mia knows about each company with its source. All additive: a
# registry without these keys still works, and an older sync agent keeps them
# untouched (it rewrites the whole JSON it read).

LIB = os.path.abspath(os.path.expanduser(os.environ.get("MC_LIBRARY") or "~/.mission-control/library"))
MEMORY = os.path.join(D, "memory")
ACTION_TIERS = ("cheap", "mid", "smart")


def A(aid, label, prompt, icon="sparkles", inputs=(), project=None, tier=None, hint=""):
    a = {"id": aid, "label": label, "icon": icon, "prompt": prompt, "inputs": [dict(i) for i in inputs]}
    if project:
        a["project"] = project
    if tier:
        a["tier"] = tier
    if hint:
        a["hint"] = hint
    return a


def I(name, label, placeholder="", required=True, kind="text"):
    return {"name": name, "label": label, "placeholder": placeholder, "required": required, "kind": kind}


def scout_action(name):
    return A("scout", "Scout now", "Scout %s now: check every project's health and numbers, compare with last week, and tell me the one thing worth doing." % name,
             icon="scout", tier="cheap", hint="Health and numbers, one finding")


# The seeded buttons per company. Prompts are what Mia receives (as an [MC]
# line from Daniel); {name} placeholders are filled from the inputs.
SEED_ACTIONS = {
    "video": [
        A("new-video", "Make a new video", "Make a new bodycam video on {topic}. Follow the bodycam style rules in memory/video.md (let the footage play, cut back to explain), run the full pipeline (script, narration, edit, thumbnail), keep the files on the Mac only, and send me the cut to review. Do not upload.",
          icon="video", inputs=[I("topic", "Topic", "e.g. the 2019 Phoenix traffic stop")], project="bodycam", tier="smart", hint="Script → narration → edit → thumbnail"),
        A("upload-latest", "Upload latest video", "Get the latest finished bodycam video ready to upload: title, description, tags and thumbnail, then ask me before anything goes public.",
          icon="upload", project="bodycam", tier="mid", hint="Prepared, then asks before publishing"),
    ],
    "games": [
        A("propose-crystal", "Propose improvements", "Propose 3 improvements for Crystal Garden based on its latest numbers (visits, retention, favourites) and what players do. Evidence for each, effort, and which one you'd build first.",
          icon="sparkles", project="crystal-garden", tier="mid", hint="Three pitches with evidence"),
    ],
    "oblivion": [
        A("mandate-targets", "Find mandate targets", "Find mandate targets in {area}: properties over R10m that look likely to sell, with address and erf for each (no LOOM pulls, no owner contact). File the report in the Library under Oblivion.",
          icon="search", inputs=[I("area", "Area", "e.g. Bantry Bay, Fresnaye")], project="prospect-engine", tier="mid", hint="Address + erf, filed in the Library"),
    ],
}

# Which memory files describe which company. other-projects.md holds a bit of
# everything: its lines are filed by the projects' match rules.
SEED_MEMORY = {
    "oblivion": ["oblivion.md"], "klear": ["klear.md"], "games": ["roblox.md"],
    "video": ["video.md"], "mission-control": ["mission-control.md"],
}
SHARED_MEMORY = ["other-projects.md"]

# Company-wide words for filing Library docs that name no project.
SEED_KEYWORDS = {
    "oblivion": ["oblivion", "mandate", "mandates", "buyer", "buyers", "buyer briefs", "owner letter", "dossier", "dossiers",
                 "listing", "listings", "fresnaye", "bantry bay", "camps bay", "clifton", "sea point", "green point",
                 "kommetjie", "foreign buyers", "game farm", "game farms", "glamping", "virtual agent", "estate agency"],
    "games": ["roblox", "game ideas", "garden build mode", "mother crystals", "perfect breed", "gear shop", "black market",
              "friend boost", "clean all the leaves", "hybrids"],
    "video": ["youtube", "faceless", "clipping", "bodycam", "raw incident"],
    "klear": ["klear", "investment report", "thesis"],
    "dryager": ["dry-ager", "dryager", "restaurants"],
    "propiq": ["propiq", "deeds"],
    "civentropy": ["civentropy", "diplomat"],
    "mission-control": ["mission control", "mia", "jarvis"],
}


def ensure_v2(r):
    """Give an older registry the 0204 keys (never overwrites). True if changed."""
    changed = False
    for c in r["companies"]:
        if "actions" not in c:
            c["actions"] = json.loads(json.dumps(SEED_ACTIONS.get(c["id"], []))) + [scout_action(c.get("name") or c["id"])]
            changed = True
        if "memory" not in c:
            c["memory"] = list(SEED_MEMORY.get(c["id"], []))
            changed = True
        if "keywords" not in c:
            c["keywords"] = list(SEED_KEYWORDS.get(c["id"], []))
            changed = True
    for k in ("library", "libraryOverrides"):
        if not isinstance(r.get(k), dict):
            r[k] = {}
            changed = True
    if not isinstance(r.get("sharedMemory"), list):
        r["sharedMemory"] = list(SHARED_MEMORY)
        changed = True
    return changed


def company_of(r, pid):
    for p in r["projects"]:
        if p["id"] == pid:
            return p.get("company") or ""
    return ""


def resolve_owner(r, v):
    """A company or project id → (company, project|None), or None."""
    v = (v or "").strip()
    if not v:
        return None
    for c in r["companies"]:
        if c["id"] == v:
            return (v, None)
    for p in r["projects"]:
        if p["id"] == v:
            return (p.get("company") or "", p["id"])
    return None


# ---- the Library ------------------------------------------------------------

def frontmatter(text):
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    f = {}
    for line in text[4:end].splitlines():
        k, sep, v = line.partition(":")
        if sep:
            f[k.strip()] = v.strip()
    return f, text[end + 4:].lstrip("\n")


MD_STRIP = [(re.compile(r"!\[[^\]]*\]\([^)]*\)"), ""), (re.compile(r"\[([^\]]+)\]\([^)]*\)"), r"\1"),
            (re.compile(r"[*_`]{1,3}"), ""), (re.compile(r"^#+\s*"), ""), (re.compile(r"\s+"), " ")]


def plain(s):
    for rx, rep in MD_STRIP:
        s = rx.sub(rep, s)
    return s.strip()


def doc_summary(body):
    """The answer-first line of a doc: '**Answer:** …' / '**In one line:** …', else the first paragraph."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    pick = ""
    for p in paras[:8]:
        if re.match(r"^\*\*(the\s+)?(short\s+)?(answer|in one line|tl;?dr|summary|bottom line)[^*]*\*\*", p, re.I):
            pick = re.sub(r"^\*\*[^*]+\*\*\s*:?\s*", "", p)
            break
    if not pick:
        for p in paras:
            if p.startswith(("#", ":::", "|", "!", "-", "*   ", "```", ">")) or len(plain(p)) < 40:
                continue
            pick = p
            break
    s = re.sub(r"^[-*]\s+", "", plain(pick))
    return s if len(s) <= 300 else s[:297].rsplit(" ", 1)[0] + "…"


def library_docs():
    out = []
    try:
        names = sorted(os.listdir(LIB))
    except OSError:
        return out
    for n in names:
        if not n.endswith(".md") or n.startswith("."):
            continue
        path = os.path.join(LIB, n)
        text = read_text(path)
        f, body = frontmatter(text)
        m = re.search(r"^#\s+(.+)$", body, re.M)
        try:
            mt = os.path.getmtime(path)
        except OSError:
            mt = 0
        out.append({
            "id": n[:-3], "title": plain(m.group(1)) if m else n[:-3], "kind": f.get("kind", ""), "status": f.get("status", ""),
            "subject": f.get("subject", ""), "tags": [t.strip() for t in f.get("tags", "").split(",") if t.strip()],
            "dir": f.get("dir", ""), "company": f.get("company", ""), "created": f.get("created", ""),
            "updatedAt": datetime.datetime.fromtimestamp(mt, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if mt else "",
            "summary": doc_summary(body),
        })
    return out


def doc_matcher(r):
    """Like matcher() but for docs → (company, project|None) or None: folder,
    then a project keyword or name in the title, subject and tags, then a
    company keyword. No fallback folders: Mia writes docs from her own dir."""
    match = matcher(r, fallback=False)
    ckw = [(c["id"], k.lower()) for c in r["companies"] for k in (c.get("keywords") or []) if k]
    names = []
    for p in r["projects"]:
        if len(p.get("name") or "") >= 4:
            names.append((p["id"], p["name"].lower()))
    for c in r["companies"]:
        for p in r["projects"]:
            if p.get("company") == c["id"] and len(c.get("name") or "") >= 4:
                names.append((p["id"], c["name"].lower()))
                break

    def m(d):
        hay = " ".join([d.get("title", ""), d.get("subject", ""), " ".join(d.get("tags", []))])
        best = match({"dir": d.get("dir", ""), "title": hay})
        if best:
            return (company_of(r, best), best)
        low = hay.lower()
        hit = lambda k: re.search(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])", low)
        for pid, n in names:
            if hit(n):
                return (company_of(r, pid), pid)
        best, score = None, 0
        for cid, k in ckw:
            if len(k) > score and hit(k):
                best, score = cid, len(k)
        return (best, None) if best else None
    return m


def classify_library(r, docs=None):
    """Recompute r['library'] = {doc id: {company, project, by}}. True if changed."""
    docs = library_docs() if docs is None else docs
    m = doc_matcher(r)
    pins = {}
    for p in r["projects"]:
        for d in p.get("docs") or []:
            pins.setdefault(re.sub(r"\.md$", "", str(d)), p["id"])
    over = r.get("libraryOverrides") or {}
    lib = {}
    for d in docs:
        did = d["id"]
        own, by = None, ""
        if did in over:
            own, by = resolve_owner(r, over[did]) or ("", None), "manual"
        elif d.get("company") and resolve_owner(r, d["company"]):
            own, by = resolve_owner(r, d["company"]), "frontmatter"
        elif did in pins:
            own, by = (company_of(r, pins[did]), pins[did]), "pinned"
        else:
            own = m(d)
            by = "rule" if own else ""
        if own and own[0]:
            lib[did] = {"company": own[0], "project": own[1], "by": by}
        else:
            lib[did] = {"company": "", "project": None, "by": by or "none"}
    changed = lib != r.get("library")
    r["library"] = lib
    return changed


# ---- what Mia knows -----------------------------------------------------------
# Memory bullets, filed by company, each with file + line. Contact details,
# addresses of machines and anything that looks like a secret are cut before a
# fact leaves the Mac: the panel shows what Mia knows, not how to reach anyone.

REDACT = [
    (re.compile(r"\b[\w.-]+@\d{1,3}(\.\d{1,3}){3}\b"), "‹host›"),
    (re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+"), "‹email›"),
    (re.compile(r"\b\d{1,3}(\.\d{1,3}){3}\b"), "‹ip›"),
    (re.compile(r"\b\d{1,3}(-\d{1,3}){3}\.sslip\.io\b"), "‹host›"),
    (re.compile(r"\+\d{1,3}[\d ()-]{7,}\d"), "‹number›"),
    (re.compile(r"\b0\d{2}[ -]?\d{3}[ -]?\d{4}\b"), "‹number›"),
    (re.compile(r"\b\d{10,}\b"), "‹number›"),
    (re.compile(r"(?i)\b(password|passwd|token|secret|api[_ -]?key|bearer)\b(\s*[:=]\s*|\s+)([^\s,;)]+)"), r"\1 ‹hidden›"),
    (re.compile(r"\b(sk|pk|rk|ghp|xox[bp])[-_][A-Za-z0-9_-]{8,}"), "‹hidden›"),
]


def redact(s):
    for rx, rep in REDACT:
        s = rx.sub(rep, s)
    return s


def memory_facts(fname):
    """[(line number, section, text)] for the bullets of one memory file."""
    out, section = [], ""
    for i, line in enumerate(read_text(os.path.join(MEMORY, fname)).splitlines(), 1):
        s = line.strip()
        if s.startswith("#"):
            section = plain(s)
            continue
        if s.startswith(("- ", "* ")):
            t = plain(s[2:])
            if len(t) >= 12:
                out.append((i, section, t))
    return out


def knowledge(r, docs=None, per_company_docs=12):
    """{company id: [fact]}; fact = {text, section, project, source: {kind, file, line} | {kind, id, title}}."""
    match = matcher(r)
    out = {c["id"]: [] for c in r["companies"]}

    def proj(text, company):
        pid = match({"title": text.lower()})
        return pid if pid and company_of(r, pid) == company else None

    for c in r["companies"]:
        for fname in c.get("memory") or []:
            for line, section, text in memory_facts(fname):
                out[c["id"]].append({"text": redact(text), "section": section, "project": proj(text, c["id"]),
                                     "source": {"kind": "memory", "file": fname, "line": line}})
    for fname in r.get("sharedMemory") or []:
        for line, section, text in memory_facts(fname):
            pid = match({"title": text.lower()})
            if pid and company_of(r, pid) in out:
                out[company_of(r, pid)].append({"text": redact(text), "section": section, "project": pid,
                                                "source": {"kind": "memory", "file": fname, "line": line}})
    docs = library_docs() if docs is None else docs
    lib = r.get("library") or {}
    for cid in out:
        mine = [d for d in docs if (lib.get(d["id"]) or {}).get("company") == cid and d.get("summary")]
        mine.sort(key=lambda d: d.get("updatedAt", ""), reverse=True)
        for d in mine[:per_company_docs]:
            out[cid].append({"text": redact(d["summary"]), "section": d.get("kind") or "doc", "project": (lib.get(d["id"]) or {}).get("project"),
                             "source": {"kind": "doc", "id": d["id"], "title": d["title"], "at": d.get("updatedAt", "")}})
    return out


def find_action(r, company, aid):
    for c in r["companies"]:
        if c["id"] == company:
            for a in c.get("actions") or []:
                if a.get("id") == aid:
                    return c, a
            raise Bad("no action '%s' on %s" % (aid, company))
    raise Bad("no company '%s'" % company)


def render_action(a, inputs):
    vals = {k: str(v).strip() for k, v in (inputs or {}).items()}
    for i in a.get("inputs") or []:
        if i.get("required", True) and not vals.get(i["name"]):
            raise Bad("%s needs %s" % (a.get("label"), i.get("label") or i["name"]))
    return re.sub(r"\{(\w+)\}", lambda m: vals.get(m.group(1), m.group(0)), a.get("prompt") or "")


# ---------------------------------------------------------------------------
# Relay sync

def relay_conf():
    if os.environ.get("MC_JARVIS_NO_SYNC") == "1":
        return None, None
    url = os.environ.get("MC_RELAY_URL", "").strip()
    tok = os.environ.get("MC_TOKEN", "").strip()
    if (not url or not tok) and os.environ.get("MC_DOC_NO_DEFAULTS") != "1":
        def dflt(k):
            try:
                return subprocess.run(["defaults", "read", "com.agentwidget.mission-control", k], stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, timeout=10).stdout.decode().strip()
            except (OSError, subprocess.SubprocessError):
                return ""
        url = url or dflt("remoteURL")
        tok = tok or dflt("remoteToken")
    url = url.rstrip("/")
    if url.startswith("ws"):
        url = "http" + url[2:]
    return (url, tok) if url and tok else (None, None)


def relay(method, path, body=None, timeout=20):
    url, tok = relay_conf()
    if not url:
        raise RuntimeError("no relay configured")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError("relay said HTTP %d" % e.code)
    except urllib.error.URLError as e:
        raise RuntimeError("relay unreachable (%s)" % getattr(e, "reason", e))


def public_registry(r):
    """What the panel may see: no ssh targets, no private notes fields."""
    out = json.loads(json.dumps(r))
    for p in out["projects"]:
        c = p.get("healthcheck") or None
        if c:
            p["healthcheck"] = {"type": c.get("type")}
            if c.get("type") in ("http", "railway"):
                p["healthcheck"]["target"] = c.get("target")
        p.pop("probes", None)
    out["jarvis"].pop("pausedHeartbeats", None)
    return out


def build_state(r, applied, docs=None):
    docs = library_docs() if docs is None else docs
    lib = r.get("library") or {}
    index = []
    for d in docs:
        own = lib.get(d["id"]) or {}
        index.append({k: d[k] for k in ("id", "title", "kind", "status", "subject", "tags", "updatedAt", "summary")})
        index[-1].update({"company": own.get("company") or "", "project": own.get("project"), "filedBy": own.get("by") or ""})
    return {
        "version": 1,
        "schema": 2,  # 0204: docs (filed by company) + knowledge; older panels ignore both
        "docs": index,
        "knowledge": knowledge(r, docs),
        "at": now_iso(),
        "home": os.path.expanduser("~"),  # so the panel can match live task folders
        "registry": public_registry(r),
        "findings": read_jsonl(FINDINGS)[-300:],
        "tasks": slim_tasks(r),
        "applied": applied,
    }


def apply_control(r, c):
    """One panel control → registry change + a findings line. Returns a summary."""
    a = c.get("action")
    who = "daniel"
    if a == "level":
        p = lookup(r, c.get("project"))
        lv = level_of(c.get("level"))
        old = p.get("autonomy", 2)
        p["autonomy"] = lv
        add_finding(p["id"], "control", "Autonomy %s → %s" % (LEVEL_NAMES.get(old), LEVEL_NAMES.get(lv)), by=who, control=c.get("id"))
        return "%s autonomy %s" % (p["id"], level_label(lv))
    if a == "pause":
        do_pause(r)
        add_finding("", "control", "Jarvis paused", by=who, control=c.get("id"))
        return "paused"
    if a == "resume":
        do_resume(r)
        add_finding("", "control", "Jarvis resumed", by=who, control=c.get("id"))
        return "resumed"
    if a == "pitch":
        v = c.get("value")
        new = step_pitch(r["jarvis"].get("pitchesPerDay", 1), v) if v in ("quieter", "louder") else step_pitch(v, "")
        r["jarvis"]["pitchesPerDay"] = new
        add_finding("", "control", "Pitches: %s" % pitch_label(new), by=who, control=c.get("id"))
        return "pitch %s" % pitch_label(new)
    if a == "action":
        co, act = find_action(r, c.get("company"), c.get("actionId"))
        text = render_action(act, c.get("inputs"))
        add_finding(act.get("project") or "", "action", "%s: %s" % (act.get("label"), text), by=who, control=c.get("id"),
                    company=co["id"], action=act.get("id"), inputs=c.get("inputs") or {}, told=bool(c.get("told")))
        return "action %s/%s" % (co["id"], act.get("id"))
    if a == "scout":
        p = lookup(r, c.get("project"))
        p["scoutRequestedAt"] = now_iso()
        add_finding(p["id"], "scout", "Scout requested from HQ", by=who, control=c.get("id"))
        return "scout %s" % p["id"]
    raise ValueError("unknown control action %r" % a)


def sync_once(force_health=False, quiet=False):
    st = read_json(SYNC, {}) or {}
    applied_ids = st.get("appliedIds", [])
    applied_now = []
    err = ""
    controls = []
    url, _ = relay_conf()
    if url:
        try:
            controls = relay("GET", "/api/v1/jarvis/controls").get("controls") or []
        except RuntimeError as e:
            err = str(e)
    r0 = load(required=False)
    if r0 is None:
        return "no registry (run: mia jarvis seed)"
    every = float(r0["jarvis"].get("healthEveryMinutes") or 15) * 60
    last = parse_iso(r0["jarvis"].get("lastHealthAt")) or 0
    health = gather_health(r0["projects"]) if (force_health or time.time() - last >= every) else None
    docs = library_docs()
    with Lock():
        r = load(required=False)
        if r is None:
            return "no registry (run: mia jarvis seed)"
        changed = False
        for c in controls:
            cid = c.get("id")
            if not cid:
                continue
            if cid in applied_ids:
                applied_now.append(cid)  # applied before, the relay just hasn't heard
                continue
            try:
                msg = apply_control(r, c)
                if not quiet:
                    print("applied %s: %s" % (cid, msg))
            except ValueError as e:
                if not quiet:
                    print("skipped %s: %s" % (cid, e))
            applied_now.append(cid)
            applied_ids.append(cid)
            changed = True
        if health is not None:
            apply_health(r, health, quiet=True)
            changed = True
        if classify_library(r, docs):
            changed = True
        if changed:
            save(r)
        state = build_state(r, applied_now, docs)
    if url and not err:
        try:
            relay("PUT", "/api/v1/jarvis/state", state, timeout=30)
            st["lastPushAt"] = now_iso()
        except RuntimeError as e:
            err = str(e)
    st["appliedIds"] = applied_ids[-500:]
    st["lastSyncAt"] = now_iso()
    st["lastError"] = err
    write_json(SYNC, st)
    return err or ("pushed" if url else "no relay configured: registry updated locally")


# ---------------------------------------------------------------------------
# Commands

def cmd_seed(args):
    pos, o = parse(args, {"--force": False})
    with Lock():
        if os.path.exists(REG) and not o.get("--force"):
            die("registry already exists at %s (use --force to start over; it is Mia's now)" % REG)
        r = seed_registry()
        save(r)
        write_atomic(README, README_TEXT)
    print("seeded %s (%d companies, %d projects)" % (REG, len(r["companies"]), len(r["projects"])))


def cmd_show(args):
    pos, o = parse(args, {"--json": False})
    r = load()
    if pos:
        p = find_project(r, " ".join(pos))
        if o.get("--json"):
            print(json.dumps(p, indent=2, ensure_ascii=False))
            return
        h = p.get("health") or {}
        print("%s — %s (%s)" % (p["id"], p.get("name"), p.get("company")))
        print("  autonomy: %s" % level_label(p.get("autonomy", 2)))
        print("  health:   %s%s" % (h.get("status", "unchecked"), (" (%s, %sms, %s)" % (h.get("code"), h.get("ms"), h.get("checkedAt"))) if h else ""))
        for l in p.get("links", []):
            print("  link:     %s %s" % (l.get("label"), l.get("url")))
        for m in p.get("metrics", []):
            print("  metric:   %s = %s%s (%s)" % (m.get("label"), m.get("value"), m.get("unit") or "", m.get("at")))
        for i, s in enumerate(p.get("permissions", []), 1):
            print("  permit %d: %s" % (i, s))
        if p.get("notes"):
            print("  notes:    %s" % p["notes"])
        fs = [f for f in read_jsonl(FINDINGS) if f.get("project") == p["id"]][-5:]
        for f in fs:
            print("  %s %-7s %s" % (f.get("at"), f.get("kind"), f.get("text")))
        return
    if o.get("--json"):
        print(json.dumps(r, indent=2, ensure_ascii=False))
        return
    j = r["jarvis"]
    print("Jarvis: %s · pitches %s · health every %s min" % (
        "PAUSED since %s" % j.get("pausedAt") if j.get("paused") else "on", pitch_label(j.get("pitchesPerDay", 1)), j.get("healthEveryMinutes")))
    for c in r["companies"]:
        print("\n%s" % c["name"])
        for p in [p for p in r["projects"] if p.get("company") == c["id"]]:
            h = (p.get("health") or {}).get("status", "-")
            print("  %-22s %-14s %-6s %s" % (p["id"], LEVEL_NAMES.get(p.get("autonomy", 2)), h, p.get("name")))


def cmd_set_level(args):
    if len(args) != 2:
        die("usage: mia jarvis set-level <project> <off|watch|suggest|fix|0-3>")
    with Lock():
        r = load()
        p = find_project(r, args[0])
        lv = parse_level(args[1])
        old = p.get("autonomy", 2)
        p["autonomy"] = lv
        save(r)
        if old != lv:
            add_finding(p["id"], "control", "Autonomy %s → %s" % (LEVEL_NAMES.get(old), LEVEL_NAMES.get(lv)), by="mia")
    print("%s: %s" % (p["id"], level_label(lv)))


def cmd_metric(args):
    pos, o = parse(args, {"--label": True, "--unit": True, "--better": True})
    if len(pos) != 3:
        die("usage: mia jarvis metric <project> <name> <value> [--label L] [--unit U] [--better up|down]")
    if o.get("--better") not in (None, "up", "down"):
        die("--better must be up or down")
    with Lock():
        r = load()
        p = find_project(r, pos[0])
        m = put_metric(p, pos[1], num(pos[2]), label=o.get("--label"), unit=o.get("--unit"), better=o.get("--better"))
        save(r)
    print("%s: %s = %s%s" % (p["id"], m["label"], m["value"], m.get("unit") or ""))


def cmd_finding(args):
    pos, o = parse(args, {"--kind": True})
    if len(pos) < 2:
        die('usage: mia jarvis finding <project|-> "<text>" [--kind found|fixed|shipped|note]')
    kind = o.get("--kind", "found")
    if kind not in FINDING_KINDS:
        die("--kind must be one of %s" % "|".join(FINDING_KINDS))
    text = " ".join(pos[1:]).strip()
    with Lock():
        r = load()
        pid = "" if pos[0] in ("-", "all", "") else find_project(r, pos[0])["id"]
        f = add_finding(pid, kind, text)
    print("logged %s (%s) %s" % (f["id"], kind, pid or "overall"))


def cmd_pause(args, on):
    with Lock():
        r = load()
        moved = do_pause(r) if on else do_resume(r)
        save(r)
        if moved:
            add_finding("", "control", "Jarvis paused" if on else "Jarvis resumed", by="mia")
    j = r["jarvis"]
    if on:
        print("Jarvis paused%s" % ((" (heartbeats off: %s)" % ", ".join(j["pausedHeartbeats"])) if j.get("pausedHeartbeats") else ""))
    else:
        print("Jarvis on")


def cmd_pitch(args):
    if len(args) != 1:
        die("usage: mia jarvis pitch <quieter|louder|per-day number>")
    with Lock():
        r = load()
        v = args[0]
        new = step_pitch(r["jarvis"].get("pitchesPerDay", 1), v) if v in ("quieter", "louder") else step_pitch(num(v), "")
        r["jarvis"]["pitchesPerDay"] = new
        save(r)
    print("pitches: %s" % pitch_label(new))


def cmd_permit(args, add):
    if add and len(args) < 2:
        die('usage: mia jarvis permit <project> "<kind of fix>"')
    if not add and len(args) != 2:
        die("usage: mia jarvis revoke <project> <number from show>")
    with Lock():
        r = load()
        p = find_project(r, args[0])
        if add:
            text = " ".join(args[1:]).strip()
            p["permissions"].append(text)
            add_finding(p["id"], "control", "Standing permission: %s" % text, by="mia")
        else:
            try:
                text = p["permissions"].pop(int(args[1]) - 1)
            except (ValueError, IndexError):
                die("no permission %s on %s" % (args[1], p["id"]))
            add_finding(p["id"], "control", "Permission revoked: %s" % text, by="mia")
        save(r)
    print("%s: %d standing permission(s)" % (p["id"], len(p["permissions"])))


def cmd_set(args):
    fields = ("name", "summary", "notes", "company")
    if len(args) < 3 or args[1] not in fields + ("link", "doc", "check"):
        die("usage: mia jarvis set <project> <name|summary|notes|company> <value>\n"
            "       mia jarvis set <project> link <label> <url> [live|admin|repo]   (url '-' removes)\n"
            "       mia jarvis set <project> doc <library-id>                       (prefix '-' removes)\n"
            "       mia jarvis set <project> check <http-url|ssh:user@host|none>")
    with Lock():
        r = load()
        p = find_project(r, args[0])
        f = args[1]
        if f in fields:
            v = " ".join(args[2:]).strip()
            if f == "company" and v not in [c["id"] for c in r["companies"]]:
                die("no company '%s' (ids: %s)" % (v, ", ".join(c["id"] for c in r["companies"])))
            p[f] = v
        elif f == "link":
            if len(args) < 4:
                die("usage: mia jarvis set <project> link <label> <url> [kind]")
            label, url = args[2], args[3]
            p["links"] = [l for l in p["links"] if l.get("label") != label]
            if url != "-":
                if not re.match(r"^https?://", url):
                    die("link must be an http(s) URL")
                p["links"].append({"label": label, "url": url, "kind": args[4] if len(args) > 4 else "live"})
        elif f == "doc":
            d = re.sub(r"\.md$", "", args[2])
            if d.startswith("-"):
                p["docs"] = [x for x in p["docs"] if x != d[1:]]
            elif d not in p["docs"]:
                p["docs"].append(d)
        elif f == "check":
            v = args[2]
            if v == "none":
                p["healthcheck"] = None
            elif v.startswith("ssh:"):
                p["healthcheck"] = {"type": "ssh", "target": v[4:], "command": " ".join(args[3:]) or "true"}
            elif re.match(r"^https?://", v):
                p["healthcheck"] = http(v)
            else:
                die("check must be an http(s) URL, ssh:user@host [command], or none")
        save(r)
    print("%s: %s updated" % (p["id"], f))


def cmd_health(args):
    pos, o = parse(args, {"--json": False})
    r0 = load()
    only = find_project(r0, pos[0])["id"] if pos else None
    results = gather_health([p for p in r0["projects"] if only is None or p["id"] == only])
    with Lock():
        r = load()
        apply_health(r, results, quiet=bool(o.get("--json")))
        save(r)
    if o.get("--json"):
        print(json.dumps({p["id"]: p.get("health") for p in r["projects"] if p.get("health")}, indent=2))


def cmd_sync(args):
    pos, o = parse(args, {"--loop": True, "--health": False, "--quiet": False})
    if "--loop" not in o:
        print(sync_once(force_health=bool(o.get("--health")), quiet=bool(o.get("--quiet"))))
        return
    every = max(10, int(num(o["--loop"])))
    while True:
        try:
            msg = sync_once(quiet=True)
            if msg != "pushed":
                sys.stderr.write("%s jarvis sync: %s\n" % (now_iso(), msg))
                sys.stderr.flush()
        except Exception as e:  # noqa — the loop must outlive one bad pass
            sys.stderr.write("%s jarvis sync failed: %s\n" % (now_iso(), e))
            sys.stderr.flush()
        time.sleep(every)


AGENT_LABEL = "com.missioncontrol.jarvis"
AGENT_PLIST = os.path.expanduser("~/Library/LaunchAgents/%s.plist" % AGENT_LABEL)


def cmd_agent(args, install):
    uid = os.getuid()
    if not install:
        subprocess.run(["launchctl", "bootout", "gui/%d/%s" % (uid, AGENT_LABEL)], stderr=subprocess.DEVNULL)
        try:
            os.unlink(AGENT_PLIST)
        except OSError:
            pass
        print("removed %s" % AGENT_LABEL)
        return
    pos, o = parse(args, {"--every": True})
    every = str(int(num(o.get("--every", 60))))
    mia = os.path.expanduser("~/.mission-control/bin/mia")
    log = os.path.expanduser("~/Library/Logs/mission-control-jarvis.log")
    plist = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>%s</string><string>jarvis</string><string>sync</string><string>--loop</string><string>%s</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
""" % (AGENT_LABEL, mia, every, log, log)
    write_atomic(AGENT_PLIST, plist)
    subprocess.run(["launchctl", "bootout", "gui/%d/%s" % (uid, AGENT_LABEL)], stderr=subprocess.DEVNULL)
    res = subprocess.run(["launchctl", "bootstrap", "gui/%d" % uid, AGENT_PLIST])
    if res.returncode != 0:
        die("launchctl bootstrap failed (plist written to %s)" % AGENT_PLIST)
    print("installed %s: sync every %ss, log %s" % (AGENT_LABEL, every, log))


def cmd_file(args):
    if len(args) != 2:
        die("usage: mia jarvis file <library-doc-id> <company|project|->   ('-' = back to the match rules)")
    did = re.sub(r"\.md$", "", os.path.basename(args[0]))
    with Lock():
        r = load()
        if args[1] in ("-", "auto"):
            r["libraryOverrides"].pop(did, None)
        else:
            if not resolve_owner(r, args[1]):
                die("no company or project '%s' (companies: %s)" % (args[1], ", ".join(c["id"] for c in r["companies"])))
            r["libraryOverrides"][did] = args[1]
        classify_library(r)
        save(r)
    own = r["library"].get(did)
    if not own:
        die("no Library doc '%s' in %s (filed anyway once it exists)" % (did, LIB), 2)
    print("%s → %s%s (%s)" % (did, own["company"] or "unfiled", ("/" + own["project"]) if own.get("project") else "", own["by"]))


def cmd_library(args):
    pos, o = parse(args, {"--company": True, "--unfiled": False, "--json": False})
    r = load()
    docs = library_docs()
    classify_library(r, docs)
    rows = []
    for d in docs:
        own = r["library"].get(d["id"]) or {}
        if o.get("--unfiled") and own.get("company"):
            continue
        if o.get("--company") and own.get("company") != o["--company"]:
            continue
        rows.append({"id": d["id"], "title": d["title"], "company": own.get("company") or "", "project": own.get("project"), "by": own.get("by")})
    if o.get("--json"):
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return
    for x in rows:
        print("%s\t%s\t%s\t%s\t%s" % (x["id"], x["company"] or "-", x["project"] or "-", x["by"], x["title"]))


def cmd_knowledge(args):
    pos, o = parse(args, {"--json": False})
    r = load()
    docs = library_docs()
    classify_library(r, docs)
    k = knowledge(r, docs)
    if pos:
        if pos[0] not in k:
            die("no company '%s' (ids: %s)" % (pos[0], ", ".join(k)))
        k = {pos[0]: k[pos[0]]}
    if o.get("--json"):
        print(json.dumps(k, indent=2, ensure_ascii=False))
        return
    for cid, facts in k.items():
        print("%s (%d)" % (cid, len(facts)))
        for f in facts:
            s = f["source"]
            src = "%s:%s" % (s["file"], s["line"]) if s["kind"] == "memory" else "doc %s" % s["id"]
            print("  - %s  [%s]" % (f["text"][:140], src))


def cmd_actions(args):
    """mia jarvis actions [<company>] | action add|remove …"""
    pos, o = parse(args, {"--json": False})
    r = load()
    cs = [c for c in r["companies"] if not pos or c["id"] == pos[0]]
    if pos and not cs:
        die("no company '%s'" % pos[0])
    if o.get("--json"):
        print(json.dumps({c["id"]: c.get("actions") or [] for c in cs}, indent=2, ensure_ascii=False))
        return
    for c in cs:
        for a in c.get("actions") or []:
            ins = ",".join(i["name"] for i in a.get("inputs") or [])
            print("%s\t%s\t%s\t%s%s" % (c["id"], a["id"], a.get("tier") or "-", a.get("label"), (" {%s}" % ins) if ins else ""))


def cmd_action(args):
    if not args or args[0] not in ("add", "remove"):
        die('usage: mia jarvis action add <company> <id> --label L --prompt "… {topic} …" [--input name:Label[:placeholder]]… [--project p] [--tier cheap|mid|smart] [--icon i] [--hint h]\n'
            "       mia jarvis action remove <company> <id>")
    sub, rest = args[0], args[1:]
    if sub == "remove":
        if len(rest) != 2:
            die("usage: mia jarvis action remove <company> <id>")
        with Lock():
            r = load()
            c = next((c for c in r["companies"] if c["id"] == rest[0]), None)
            if not c:
                die("no company '%s'" % rest[0])
            before = len(c["actions"])
            c["actions"] = [a for a in c["actions"] if a.get("id") != rest[1]]
            if len(c["actions"]) == before:
                die("no action '%s' on %s" % (rest[1], rest[0]))
            save(r)
        print("removed %s/%s" % (rest[0], rest[1]))
        return
    # add: --input may repeat, so split it out before parse()
    inputs, clean = [], []
    i = 0
    while i < len(rest):
        if rest[i] == "--input" and i + 1 < len(rest):
            name, _, more = rest[i + 1].partition(":")
            label, _, ph = more.partition(":")
            if not re.match(r"^\w+$", name):
                die("--input name must be a word (got %r)" % name)
            inputs.append(I(name, label or name, ph))
            i += 2
            continue
        clean.append(rest[i])
        i += 1
    pos, o = parse(clean, {"--label": True, "--prompt": True, "--project": True, "--tier": True, "--icon": True, "--hint": True})
    if len(pos) != 2 or not o.get("--label") or not o.get("--prompt"):
        die("action add needs <company> <id> --label and --prompt")
    if o.get("--tier") and o["--tier"] not in ACTION_TIERS:
        die("--tier must be cheap, mid or smart")
    if not re.match(r"^[a-z0-9][a-z0-9-]*$", pos[1]):
        die("action id: lowercase letters, digits and dashes")
    missing = set(re.findall(r"\{(\w+)\}", o["--prompt"])) - {x["name"] for x in inputs}
    if missing:
        die("the prompt uses {%s} but no --input defines it" % ", ".join(sorted(missing)))
    with Lock():
        r = load()
        c = next((c for c in r["companies"] if c["id"] == pos[0]), None)
        if not c:
            die("no company '%s'" % pos[0])
        if o.get("--project") and company_of(r, find_project(r, o["--project"])["id"]) != c["id"]:
            die("project %s is not in %s" % (o["--project"], c["id"]))
        a = A(pos[1], o["--label"], o["--prompt"], icon=o.get("--icon") or "sparkles", inputs=inputs,
              project=find_project(r, o["--project"])["id"] if o.get("--project") else None, tier=o.get("--tier"), hint=o.get("--hint") or "")
        c["actions"] = [x for x in c["actions"] if x.get("id") != a["id"]] + [a]
        save(r)
    print("%s/%s: %s" % (c["id"], a["id"], a["label"]))


def cmd_upgrade(args):
    """Add the 0204 keys (actions, memory map, Library filing) to an existing registry."""
    with Lock():
        r = load()
        classify_library(r)
        save(r)
    filed = sum(1 for v in r["library"].values() if v.get("company"))
    print("registry upgraded: %d companies with actions, %d/%d Library docs filed" % (
        sum(1 for c in r["companies"] if c.get("actions")), filed, len(r["library"])))


def cmd_status(args):
    st = read_json(SYNC, {}) or {}
    url, _ = relay_conf()
    print("registry:  %s" % (REG if os.path.exists(REG) else "(none — mia jarvis seed)"))
    print("relay:     %s" % (url or "(none configured)"))
    print("last sync: %s%s" % (st.get("lastSyncAt", "never"), ("  error: " + st["lastError"]) if st.get("lastError") else ""))
    print("last push: %s" % st.get("lastPushAt", "never"))
    print("agent:     %s" % ("installed" if os.path.exists(AGENT_PLIST) else "not installed (mia jarvis install-agent)"))


HELP = """mia jarvis — the registry behind Mission Control's HQ view.

  mia jarvis show [<project>] [--json]           every company/project (or one in detail)
  mia jarvis set-level <project> <level>         off|watch|suggest|fix (0-3)
  mia jarvis metric <project> <name> <value> [--label L] [--unit U] [--better up|down]
  mia jarvis finding <project|-> "<text>" [--kind found|fixed|shipped|note]
  mia jarvis pause | resume                      everything proactive off/on (heartbeats too)
  mia jarvis pitch <quieter|louder|N>            how often to pitch (N per day)
  mia jarvis permit <project> "<kind of fix>"    add a standing permission
  mia jarvis revoke <project> <n>                remove permission n (numbers from show)
  mia jarvis set <project> <field> <value…>      name|summary|notes|company|link|doc|check
  mia jarvis health [<project>] [--json]         run the health checks now
  mia jarvis file <doc-id> <company|project|->   file a Library doc by hand ('-' = back to the rules)
  mia jarvis library [--company c] [--unfiled]   where every Library doc is filed (and why)
  mia jarvis knowledge [<company>] [--json]      what HQ shows as known, with sources
  mia jarvis actions [<company>]                 the action buttons on each company page
  mia jarvis action add <company> <id> --label L --prompt "…{x}…" [--input x:Label[:hint]]
                    [--project p] [--tier cheap|mid|smart]   (action remove <company> <id>)
  mia jarvis upgrade                             add actions/memory/Library filing to an old registry
  mia jarvis sync [--health] [--loop SECONDS]    apply HQ changes from the relay, push state
  mia jarvis install-agent [--every 60]          run the sync loop as a LaunchAgent
  mia jarvis uninstall-agent
  mia jarvis status                              sync/relay/agent state
  mia jarvis seed [--force]                      write the starting registry + README

Projects are named by id, name or a unique prefix. Registry:
$MIA_DIR/jarvis/registry.json (schema in README.md next to it)."""


README_TEXT = """\
# Jarvis registry (Mission Control HQ)

`registry.json` here is the single source of truth for HQ, the control centre
view in the Mission Control panel. Mia maintains it with `mia jarvis …` (see
`mia jarvis help`); Daniel changes it from HQ, and those changes arrive through
the relay and are applied by `mia jarvis sync`. Edit by hand only with the
sync agent stopped, and keep it valid JSON.

## Files

| File | What |
|---|---|
| `registry.json` | companies, projects, autonomy, metrics, health, Jarvis switches |
| `findings.jsonl` | one line per thing found / fixed / shipped, health changes, control changes |
| `sync.json` | sync bookkeeping (last push, applied control ids, last error) |

## registry.json

```json
{
  "version": 1,
  "updatedAt": "2026-10-14T09:00:00Z",
  "jarvis": {
    "paused": false,               // Jarvis pause: nothing proactive
    "pausedAt": null,
    "proactiveHeartbeats": ["hb_scout", "hb_health", "hb_crystal"],
    "pausedHeartbeats": [],        // the ones pause switched off (resume turns them back on)
    "pitchesPerDay": 1,            // 0.14 | 0.5 | 1 | 2 | 3  (quieter/louder steps)
    "healthEveryMinutes": 15,
    "lastHealthAt": "…"
  },
  "companies": [
    { "id": "oblivion", "name": "Oblivion Estates", "tagline": "…",
      "photo": "hq/oblivion.jpg",   // a bundled panel image, or an https:// image URL
      "memory": ["oblivion.md"],    // memory/*.md files about this company (Knowledge tab)
      "keywords": ["mandate"],      // files Library docs that name no project
      "actions": [{                 // buttons on the company page; a tap sends Mia the prompt
        "id": "mandate-targets", "label": "Find mandate targets", "icon": "search",
        "prompt": "Find mandate targets in {area}: …",   // {name} = an input below
        "inputs": [{ "name": "area", "label": "Area", "placeholder": "e.g. Bantry Bay", "required": true }],
        "project": "prospect-engine",   // optional: files the job under a project
        "tier": "cheap|mid|smart",      // optional: the model tier Mia should dispatch on
        "hint": "one line under the label" }] }
  ],
  "sharedMemory": ["other-projects.md"],  // memory files whose lines are filed by match rules
  "library": { "doc-id": { "company": "oblivion", "project": "prospect-engine|null",
               "by": "manual|frontmatter|pinned|rule|none" } },   // recomputed every sync
  "libraryOverrides": { "doc-id": "company-or-project-id" },      // mia jarvis file
  "projects": [
    {
      "id": "dryager-panel",       // stable, lowercase, used by the CLI and HQ
      "name": "Dry-ager panel",
      "company": "dryager",        // a companies[].id
      "summary": "one line",
      "links": [{ "label": "Panel", "url": "https://…", "kind": "live|admin|repo" }],
      "healthcheck": { "type": "http|railway|ssh", "target": "https://… | user@host",
                       "expect": [200, 401], "slowMs": 4000, "command": "ssh only" },
      "probes": [{ "type": "roblox", "universeId": "…" }],   // public numbers, fetched with health
      "health": { "status": "up|slow|down|unknown", "code": 200, "ms": 340,
                  "checkedAt": "…", "since": "…", "error": "", "recent": [["…", 340]] },
      "metrics": [{ "name": "stale_leads", "label": "Stale leads", "unit": "", "better": "down",
                    "value": 12, "at": "…", "source": "mia|probe",
                    "history": [{ "t": "…", "v": 12 }] }],
      "autonomy": 2,               // 0 Off · 1 Watch · 2 Suggest (default) · 3 Fix with undo
      "notes": "free text for Mia",
      "match": { "dirs": ["~/dryager-panel"], "keywords": ["dry-ager"], "fallbackDirs": [] },
      "docs": ["library-doc-id"],  // pinned Library docs (HQ also matches by keyword)
      "permissions": ["Restart the service when it is down"],
      "scoutRequestedAt": null     // set when Daniel taps "Scout this now"
    }
  ]
}
```

Autonomy rules (roadmap §3): never automatic at any level: money, messaging
anyone new, deleting anything, publishing to the public, legal/POPIA.

`match` decides which tasks belong to a project: a task whose folder is under
one of `dirs` (or a `-suffix` worktree of it) wins; then the longest keyword
found in the task title; `fallbackDirs` only when nothing else matches. A task
filed by hand (`mia task add --company <company|project>`) skips the rules.

Library docs are filed the same way (folder in `dir:`, then keywords or the
project/company name in title, subject and tags), after, in order: a manual
`mia jarvis file`, a `company:` line in the doc's frontmatter (`mc-doc new
--company`), a project's pinned `docs`.

Knowledge (pushed, not stored): every bullet of a company's `memory` files and
the answer line of its newest docs, each with its source (file + line, or doc
id). Emails, phone numbers, IPs and anything that looks like a secret are
replaced before it leaves the Mac.

## findings.jsonl

`{"id": "f_…", "at": "…", "project": "dryager-panel" | "", "kind": "found|fixed|shipped|health|control|scout|note|action", "text": "…", "by": "mia|daniel|checker"}`

An `action` line (a company-page button) also has `company`, `action` and `inputs`.

HQ's activity feed shows these together with finished tasks.

## How HQ changes reach Mia

Every control Daniel taps in HQ does two things: the panel sends Mia an
`[MC] Daniel: HQ: …` chat line (so she knows at once), and it queues the
change on the relay. `mia jarvis sync` (the `com.missioncontrol.jarvis`
LaunchAgent, every 60 s) applies queued changes here, runs the health checks
every `healthEveryMinutes`, and pushes the public view of this file (no ssh
targets, no probes) plus findings and recent tasks back to the relay.

Pause/resume also switch the `proactiveHeartbeats` off/on in schedule.json.
"""


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(HELP)
        return
    cmd, rest = argv[0], argv[1:]
    table = {
        "show": cmd_show, "list": cmd_show, "set-level": cmd_set_level, "level": cmd_set_level,
        "metric": cmd_metric, "finding": cmd_finding, "pitch": cmd_pitch, "set": cmd_set,
        "pause": lambda a: cmd_pause(a, True), "resume": lambda a: cmd_pause(a, False),
        "permit": lambda a: cmd_permit(a, True), "revoke": lambda a: cmd_permit(a, False),
        "health": cmd_health, "sync": cmd_sync, "seed": cmd_seed, "status": cmd_status,
        "file": cmd_file, "library": cmd_library, "knowledge": cmd_knowledge,
        "actions": cmd_actions, "action": cmd_action, "upgrade": cmd_upgrade,
        "install-agent": lambda a: cmd_agent(a, True), "uninstall-agent": lambda a: cmd_agent(a, False),
    }
    if cmd not in table:
        die("unknown jarvis command: %s (try: mia jarvis help)" % cmd)
    table[cmd](rest)


if __name__ == "__main__":
    main(sys.argv[1:])
"""#
}
