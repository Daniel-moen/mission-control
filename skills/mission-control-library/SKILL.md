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
