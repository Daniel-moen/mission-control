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
/// The embedded strings mirror, byte for byte, `scripts/mc-doc`, `scripts/mia`
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
EVENTS = os.path.join(D, "events.jsonl")
SCHED = os.path.join(D, "schedule.json")
STATE = os.path.join(D, "state.json")
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


# ---- commands -------------------------------------------------------------

def cmd_say(args):
    pos, o = parse(args, {"--task": True})
    task = norm_id(o["--task"]) if "--task" in o else None
    m = message("chat", text_arg(pos, "message"), task)
    print(m["id"])


def cmd_notify(args):
    pos, o = parse(args, {"--task": True, "--urgent": False})
    task = norm_id(o["--task"]) if "--task" in o else None
    m = message("notify", text_arg(pos, "message"), task, urgent=bool(o.get("--urgent")))
    print(m["id"])


def cmd_ask(args):
    pos, o = parse(args, {"--task": True, "--options": True})
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
        pos, o = parse(rest, {"--detail": True, "--stdin": False, "--dir": True, "--priority": True})
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
            write_json(task_path(tid), t)
        print(tid)
    elif sub == "set":
        if len(rest) < 3:
            die("usage: mia task set <id> <status|dir|priority|result|title> <value>")
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
            else:
                die("field must be one of: status, dir, priority, result, title")
            save_task(t)
        print("%s %s = %s" % (tid, field, t[field]))
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
    pos, o = parse(args, {"--dir": True, "--model": True, "--brief-file": True, "--stdin": False})
    if len(pos) != 1:
        die("usage: mia dispatch <id> [--dir <d>] [--model <m>] --brief-file <f> | --stdin")
    tid = norm_id(pos[0])
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
        if not d:
            die("task %s has no folder; pass --dir" % tid)
        if not os.path.isdir(d):
            die("no such folder: %s" % d)
        brief_path = os.path.join(BRIEFS, tid + ".md")
        write_atomic(brief_path, brief.rstrip("\n") + "\n")
        req = {"taskId": tid, "dir": d, "model": o.get("--model") or None,
               "brief": brief_path, "at": now_iso()}
        write_json(os.path.join(DISPATCH, tid + ".json"), req)
        t["dir"] = d
        t.setdefault("log", []).append({"at": req["at"], "text": "Dispatch requested in " + d})
        save_task(t)
    print("dispatch %s queued in %s" % (tid, d))


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


def open_questions():
    msgs = read_jsonl(MSGS)
    answered = set(m.get("questionId") for m in msgs if m.get("kind") == "answer")
    return [m for m in msgs if m.get("kind") == "question" and m.get("questionId") not in answered]


def cmd_status(args):
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
    qs = open_questions()
    print("Open questions: %s" % ("none" if not qs else len(qs)))
    for q in qs:
        tag = " (task %s)" % q["taskId"] if q.get("taskId") else ""
        opts = "  [%s]" % " | ".join(q.get("options") or []) if q.get("options") else ""
        print("  %s%s %s%s" % (q.get("questionId"), tag, q.get("text", ""), opts))
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


HELP = """mia — Mia's line to Daniel and the Mission Control task list.

  mia say    "<text>" [--task <id>]                 chat message to Daniel (no push)
  mia notify "<text>" [--task <id>] [--urgent]       message + push + Mac banner
  mia ask    "<question>" [--options "A|B|C"] [--task <id>]
                                                    ask Daniel; prints the question id
  mia task list [--status <s>]                      id<TAB>status<TAB>priority<TAB>title
  mia task show <id>                                the task JSON
  mia task add "<title>" [--detail <text>|--stdin] [--dir <d>] [--priority n]
  mia task set <id> <status|dir|priority|result|title> <value>
  mia task note <id> "<text>"                       append to the task's log
  mia dispatch <id> [--dir <d>] [--model <m>] --brief-file <f> | --stdin
                                                    launch an executor for the task
  mia tell <id> "<text>"                            type text into the task's executor
  mia remind --at <ISO-8601|HH:MM|+2h|+30m> "<text>" [--task <id>]
  mia remind list [--all]                           pending reminders (--all: fired too)
  mia remind cancel <reminder-id>
  mia heartbeat list                                id, on/off, when, label, prompt
  mia heartbeat set <id> (--every <min>|--at HH:MM) [--label <l>] [--prompt <p>]
                                                    add or change a recurring prompt
  mia heartbeat enable|disable|remove <id>
  mia inbox [-n 50]                                 recent system events
  mia status                                        tasks, open questions, reminders
  mia help

Statuses: queued, asking, running, checking, done, failed, cancelled.
State lives in $MIA_DIR (default ~/.mission-control/mia)."""


def main(argv):
    if not argv or argv[0] in ("help", "-h", "--help"):
        print(HELP)
        return
    cmd, rest = argv[0], argv[1:]
    table = {"say": cmd_say, "notify": cmd_notify, "ask": cmd_ask, "task": cmd_task,
             "dispatch": cmd_dispatch, "tell": cmd_tell, "remind": cmd_remind,
             "heartbeat": cmd_heartbeat, "inbox": cmd_inbox, "status": cmd_status}
    if cmd not in table:
        die("unknown command: %s (try: mia help)" % cmd)
    table[cmd](rest)


main(sys.argv[1:])
PY

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
mia say    "<text>" [--task <id>]                 chat message to Daniel (no push)
mia notify "<text>" [--task <id>] [--urgent]       message + push + Mac banner
mia ask    "<question>" [--options "A|B|C"] [--task <id>]   prints the question id
mia task list [--status <s>]                      id<TAB>status<TAB>priority<TAB>title
mia task show <id>
mia task add "<title>" [--detail <text>|--stdin] [--dir <d>] [--priority n]
mia task set <id> <status|dir|priority|result|title> <value>
mia task note <id> "<text>"
mia dispatch <id> [--dir <d>] [--model <m>] --brief-file <f> | --stdin
mia tell <id> "<text>"                            type into that task's executor
mia remind --at <ISO-8601|HH:MM|+2h|+30m> "<text>" [--task <id>]
mia remind list [--all] | cancel <reminder-id>
mia heartbeat list                                recurring prompts Mia gets
mia heartbeat set <id> (--every <min>|--at HH:MM) [--label <l>] [--prompt <p>]
mia heartbeat enable|disable|remove <id>
mia inbox [-n 50]                                 recent events delivered to Mia
mia status                                        tasks, open questions, reminders
```

Statuses: `queued → asking → running → checking → done | failed | cancelled`.
Task ids are 4-digit (`0007`); `7` works too.

**If you are an executor** (your prompt starts "You are executing Mission
Control task <id>"): never ask Daniel anything. If blocked, run
`mia task note <id> "BLOCKED: …"` and stop. When finished, write your report to
`~/.mission-control/mia/briefs/<id>.report.md`, run `mia task note <id> "DONE"`,
and end your turn.

**If you are Mia**: never sleep or poll — end your turn and wait for `[MC]`.
"""#
}
