# Panel v2 ("Quiet") — task 0444

A second front end for the Mission Control panel, served side by side with v1
(`../src`). Same relay, same wire protocol, same store: v2 imports
`../src/lib/*` (store, voice, uploads, panel commands, markdown, push…) and
only replaces what you see and how it moves.

Built with **Next.js 16 (App Router), static export** — `../../next-v2/` is the
Next project (layout, one page, config); the code lives here. No Next server
runs: `build.mjs` exports it and copies it into `dist/` (`dist/v2.html`,
`dist/v2/_next/…`), and the relay serves it like v1's files. The page loads
`boot.jsx` client-only (the store opens a socket and reads localStorage on
import, so it must never run at build time); `build.mjs` adds preload hints for
that chunk and Home's so a phone fetches them alongside Next's own.

## A/B

- v1 stays the default. `?ui=v2` / `?ui=v1` (or Settings › Interface in either
  front end) flips this device; the choice is kept in `localStorage['mc.ui']`
  and the `mc_ui` cookie.
- `server.js` serves `dist/v2.html` instead of `dist/index.html` at every SPA
  URL when the cookie says `v2` (`uiFor()`), so `/#mia` deep links and push
  taps land in whichever front end the device uses. Both HTML files also check
  `localStorage` (dev server, lost cookie).
- `npm run build` (`build.mjs`) builds v1 with Vite, then v2 with Next, with one shared build id
  (`lib/update.js` would otherwise take the other front end for a newer deploy).

## Shape

- `App.jsx` — tabs (Home · Mia · Agents · Library), one sheet, one overlay,
  the talk host; hash ⇄ state, keyboard, `mia panel` commands, wake word.
- `lib/nav.js` — the navigation store: per-tab page stacks, sheets, overlays,
  v1-compatible hashes (`#doc/…`, `#agent/…`, `#fleet`, `#settings`, …).
- `shell/Stack.jsx` — renders a stack as layers: spring push/pop, zoom pushes
  that grow out of the tapped card (`lib/zoom.js`), interactive left-edge
  swipe back, `<Activity>` for pages out of sight (state kept, effects off).
- `shell/Page.jsx` — nav bar + iOS large title + scroll restore.
- `ui/` — the kit (buttons, segmented, toggle, composer…), the draggable
  `Sheet`, hooks.
- `views/` — one lazy chunk per page. HQ/Channels, the terminal console,
  TV/car mode, the talk engine and the lightbox are v1's components hosted
  inside v2 chrome (they read every colour from the theme tokens).

## Look

`v2.css` imports v1's stylesheet (for the markdown reader and the hosted v1
views) and re-points every v1 colour token at the v2 palette, per theme:
`[data-theme=dark|light]` on `<html>`, chosen before first paint by
the inline script in `next-v2/app/layout.jsx`. Sizes are in rem; on iOS the root follows Dynamic Type
(`font: -apple-system-body`). Reduced motion (system or Settings) swaps
slides and zooms for fades.

## Checks

```
npm run build                                             # v1 (Vite) + v2 (Next export) → dist/
PLAYWRIGHT=<playwright pkg> node test/v2-budget.mjs       # first-load bytes, slow-4G time vs v1, lazy-chunk caps
npm run dev:v2                                            # next dev on :3000 (needs the relay for data; prod build is the real test)
PLAYWRIGHT=<playwright pkg> node test/v2-e2e.mjs          # A/B, every view × iPhone/iPad/Stage Manager × dark/light, behaviour, recording
```
