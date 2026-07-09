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
/// The embedded strings mirror, byte for byte, `scripts/mc-doc` and
/// `skills/mission-control-library/SKILL.md` in the repo. Those are the
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
# dir, session, created — with subject/tags/dir/session omitted when empty.

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

trim() { printf '%s' "$1" | sed -e 's/^[ \t]*//' -e 's/[ \t]*$//'; }

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
  local kind="" title="" subject="" tags="" dir="" bodyfile="" stdin=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) require_val "$1" "${2:-}"; kind=$2; shift 2 ;;
      --title) require_val "$1" "${2:-}"; title=$2; shift 2 ;;
      --subject) subject=${2:-}; shift 2 ;;
      --tags) tags=${2:-}; shift 2 ;;
      --dir) dir=${2:-}; shift 2 ;;
      --body-file) require_val "$1" "${2:-}"; bodyfile=$2; shift 2 ;;
      --stdin) stdin=1; shift ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  [ -n "$kind" ] || die "new needs --kind"
  [ -n "$title" ] || die "new needs --title"
  case "$kind" in plan|research|note) ;; *) die "kind must be plan|research|note" ;; esac

  ensure_root
  local slug id n
  slug=$(slugify "$title")
  id="$slug.md"; n=2
  while [ -e "$LIB/$id" ]; do id="$slug-$n.md"; n=$((n+1)); done

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

  F_kind=$kind
  F_status=draft
  F_subject=$(trim "$subject")
  F_tags=$(normalize_tags "$tags")
  F_dir=$(trim "$dir")
  F_session=""
  F_created=$(now_iso)
  emit_doc "$body_tmp" | replace_file "$id"
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
  F_dir=$(front_val "$id" dir)
  F_session=$(front_val "$id" session)
  F_created=$(front_val "$id" created)
  [ -n "$F_kind" ] || { [ -n "$F_session" ] && F_kind=plan || F_kind=note; }
  [ -n "$F_status" ] || F_status=draft
  [ -n "$F_created" ] || F_created=$(now_iso)

  case "$key" in
    kind)   case "$value" in plan|research|note) ;; *) die "kind must be plan|research|note" ;; esac; F_kind=$value ;;
    status) case "$value" in draft|active|done|archived) ;; *) die "status must be draft|active|done|archived" ;; esac; F_status=$value ;;
    subject) F_subject=$(trim "$value") ;;
    tags)    F_tags=$(normalize_tags "$value") ;;
    dir)     F_dir=$(trim "$value") ;;
    *) die "cannot set '$key' (only kind, status, subject, tags, dir)" ;;
  esac
  emit_doc "$body_tmp" | replace_file "$id"
}

cmd_write() {
  local id="${1:-}"; shift || true
  require_id "$id"
  local bodyfile="" stdin=0
  while [ $# -gt 0 ]; do
    case "$1" in
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
  # Frontmatter is preserved verbatim — only the body changes.
  { get_head "$id"; cat "$body_tmp"; } | replace_file "$id"
}

cmd_help() {
  cat <<'EOF'
mc-doc — command-line handle on the Mission Control document library.

Library root: ${MC_LIBRARY:-$HOME/.mission-control/library}

  mc-doc new --kind <plan|research|note> --title <t>
             [--subject <s>] [--tags a,b] [--dir <path>]
             [--body-file <f> | --stdin]
        Create a doc; prints its absolute path (and nothing else).

  mc-doc path <id>                 Absolute path of <id> (exit 1 if missing).
  mc-doc list [--kind k] [--status s] [--tag t]
                                   One "id<TAB>kind<TAB>status<TAB>title" per line.
  mc-doc get  <id>                 Print the body (frontmatter stripped).
  mc-doc write <id> [--stdin | --body-file f]
                                   Replace the body, keep frontmatter verbatim.
  mc-doc set  <id> <key> <value>   Rewrite one of kind|status|subject|tags|dir.
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
    help|-h|--help) cmd_help ;;
    *) die "unknown command: $cmd (try: mc-doc help)" ;;
  esac
}

main "$@"
"""#

    private static let skill = #"""
---
name: mission-control-library
description: Save and retrieve research, plans, and notes in the Mission Control document library — the user's central directory that the Mission Control web panel reads live. Use this whenever the user asks you to research something and keep/save/file the findings; write a report, plan, or note somewhere they can read later; or when they refer to "the library", "my plans", "my research", "my notes", or "the central directory". Also use it to look up or update a document that already lives there.
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

- `kind` is `plan`, `research`, or `note`.
- `status` is `draft`, `active`, `done`, or `archived`.
- `subject` is the company/product/thing it is about; `tags` is a comma list.

**Never hand-edit or hand-write the frontmatter block, and never create these
files with the Write tool.** The frontmatter is managed by the CLI below; the
slug, ids, and byte format must match exactly or the panel misreads the file.
Use the tool for everything.

## The tool

`~/.mission-control/bin/mc-doc` is a self-contained CLI. Commands:

- `mc-doc new --kind <plan|research|note> --title <t> [--subject <s>] [--tags a,b] [--dir <path>] [--stdin | --body-file <f>]`
  — creates the doc and prints its absolute path (and nothing else). New docs
  start at `status: draft`. There is no `--status` flag; set status with `set`.
- `mc-doc list [--kind k] [--status s] [--tag t]` — one `id<TAB>kind<TAB>status<TAB>title` per line.
- `mc-doc path <id>` — absolute path of a doc (exit 1 if it does not exist).
- `mc-doc get <id>` — print the body (frontmatter stripped).
- `mc-doc write <id> [--stdin | --body-file f]` — replace the body, keep frontmatter.
- `mc-doc set <id> <key> <value>` — rewrite one of `kind`, `status`, `subject`, `tags`, `dir`.

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
}
