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
