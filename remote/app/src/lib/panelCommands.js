import { getMC, toast, agentName, docGet, linkPreview, showViewer, closeViewer } from './store.js';
import { offerLink } from './announce.js';

// `mia panel …` — what the panel does with a {type:'panel'} frame from Mia
// (docs/mia.md §8.2). Navigation and view actions only, from this allow-list;
// nothing here edits, sends or deletes. Each returns { ok, detail } and the
// store reports it back to the relay → Mac → Mia (failures reach her as an
// [MC] event). `nav` is App's set of doors (App.jsx, panelApi).

const VIEWS = { home: 'Home', hq: 'HQ', fleet: 'Fleet', library: 'Library', mia: 'Mia', insights: 'Insights', settings: 'Settings' };

const norm = (s) => String(s || '').toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);
const when = (d) => Date.parse(d?.updatedAt || d?.created || '') || 0;

// A Library id (the filename), with or without .md — or failing that, the
// best title match, so "the Oblivion report" can still land.
export function resolveDoc(arg, docs = getMC().docs || []) {
  const a = String(arg || '').trim();
  if (!a) return null;
  const exact = docs.find((d) => d.id === a || d.id === `${a}.md` || d.id.toLowerCase() === a.toLowerCase());
  if (exact) return exact;
  const n = norm(a);
  const byTitle = docs.filter((d) => norm(d.title) === n || norm(d.id) === n);
  if (byTitle.length) return byTitle.sort((x, y) => when(y) - when(x))[0];
  const w = words(a);
  if (!w.length) return null;
  const hits = docs.filter((d) => {
    const hay = ` ${norm(d.title)} ${norm(d.id)} ${norm(d.subject)} ${(d.tags || []).map(norm).join(' ')} `;
    return w.every((x) => hay.includes(x));
  });
  return hits.sort((x, y) => when(y) - when(x))[0] || null;
}

export function resolveAgent(arg, agents = getMC().agents || []) {
  const a = String(arg || '').trim();
  if (!a) return null;
  const byId = agents.find((x) => x.id === a || x.sessionId === a);
  if (byId) return byId;
  const n = norm(a);
  const named = agents.filter((x) => norm(agentName(x)) === n || norm(x.folder) === n);
  const pool = named.length ? named : agents.filter((x) => norm(agentName(x)).includes(n) || norm(x.folder).includes(n));
  // Prefer one that's alive over an exited run in the same folder.
  return pool.sort((x, y) => (y.status === 'exited' ? -1 : 0) - (x.status === 'exited' ? -1 : 0))[0] || null;
}

// ---- finding things on the page ------------------------------------------
// Mia names what to show in her own words: a heading copied with its
// punctuation, "Option 3", a phrase from a paragraph, a name in a table. So
// matching folds case, accents, emoji and punctuation away, then tries, in
// order: headings (exact, prefix, substring, the heading inside a longer ask),
// then the smallest paragraph / list item / table row containing the text,
// then a fuzzy word match (prefixes and one-letter typos), headings first.

export const fold = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const BLOCKS = 'p,li,tr,blockquote,pre,dt,dd,figcaption,td';
const textOf = (el) =>
  el.tagName === 'TR' ? [...el.cells].map((c) => c.textContent).join(' ') : el.textContent;

// Edit distance where swapping two neighbouring letters is ONE edit
// (optimal-string-alignment Damerau–Levenshtein), so "tabel" is as near to
// "table" as "tabl" is. Gives up early once the distance must exceed `max`.
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let pp = null;
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + cost);
      if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      c.push(v);
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
    pp = p;
    p = c;
  }
  return p[b.length];
}

// One edit apart (a typo or a swapped pair), for words long enough to mean
// something.
export const near = (a, b) => Math.min(a.length, b.length) >= 5 && editDistance(a, b, 1) <= 1;
const wordHit = (q, words) =>
  words.some((w) => w === q || (q.length >= 3 && w.startsWith(q)) || (w.length >= 4 && q.startsWith(w)) || near(q, w));

function fuzzyScore(qw, text) {
  const words = text.split(' ');
  const hit = qw.filter((q) => wordHit(q, words)).length;
  return hit / qw.length;
}

export function findTarget(root, query) {
  const q = fold(query);
  if (!root || !q) return null;
  const heads = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((el) => ({ el, t: fold(el.textContent) })).filter((h) => h.t);
  const tests = [
    (t) => t === q,
    (t) => t.startsWith(q),
    (t) => t.includes(q),
    (t) => t.length >= 4 && q.startsWith(t) && t.length >= q.length * 0.5,
  ];
  for (const test of tests) {
    const h = heads.find((x) => test(x.t));
    if (h) return { el: h.el, how: 'heading' };
  }
  // Any text: the innermost block holding it (a list item, not its list).
  const blocks = [...root.querySelectorAll(BLOCKS)].map((el) => ({ el, t: fold(textOf(el)) }));
  const holding = blocks.filter((b) => b.t.includes(q));
  const inner = holding.filter((b) => !holding.some((o) => o !== b && b.el.contains(o.el) && o.el.tagName !== 'TD'));
  if (inner.length) {
    // The same words can sit in several places ("over four years unsold" in
    // one table, "Four years unsold is…" in the next): prefer the block or
    // cell that STARTS with them, then the tightest fit, then document order.
    const rank = (b) => (b.t.startsWith(q) ? 0 : 1) * 1e6 + (b.t.length - q.length);
    const pick = inner.reduce((best, b) => (rank(b) < rank(best) ? b : best), inner[0]);
    const el = pick.el.tagName === 'TD' ? pick.el.closest('tr') || pick.el : pick.el;
    return { el, how: 'text' };
  }
  // Fuzzy: most of the words (prefixes / typos allowed), headings first.
  const qw = q.split(' ');
  let best = null;
  for (const [pool, min, bias] of [
    [heads, qw.length <= 2 ? 1 : 0.6, 0.05],
    [blocks.filter((b) => b.el.tagName !== 'TD'), qw.length <= 2 ? 1 : 0.75, 0],
  ]) {
    for (const x of pool) {
      const sc = fuzzyScore(qw, x.t);
      if (sc >= min && (!best || sc + bias > best.sc)) best = { el: x.el, sc: sc + bias };
    }
  }
  return best ? { el: best.el, how: 'fuzzy' } : null;
}

// ---- what's on screen -----------------------------------------------------
// The thing Mia is talking about, topmost first: the viewer she opened over
// the panel, else the doc that's open (by id — an old doc window can still be
// animating out, and a stale one must never be searched), else the biggest
// scrolling area in view (the Mia thread, the Library list…).

const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

function biggestScroller() {
  let best = null;
  let area = 0;
  for (const el of document.querySelectorAll('main div, body > div div')) {
    if (el.scrollHeight <= el.clientHeight + 8) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    const r = el.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (a > area) {
      area = a;
      best = el;
    }
  }
  return best;
}

function onScreen(nav) {
  const viewer = [...document.querySelectorAll('[data-reader="viewer"]')].pop();
  if (viewer) return { scroller: viewer, root: viewer, what: 'the page Mia is showing' };
  if (document.querySelector('[data-viewer-frame]')) return { frame: true };
  const id = nav?.docId?.();
  if (id) {
    const sc = [...document.querySelectorAll(`[data-reader="doc"][data-doc-id="${esc(id)}"]`)].pop();
    // root stays null until the body renders, so callers wait for it.
    if (sc) return { scroller: sc, root: sc.querySelector('article.md'), what: 'the open doc' };
  }
  // a front end that knows what's in front (v5.2's pane over the chat) says so
  const own = nav?.scroller?.();
  if (own) return { scroller: own, root: own, what: 'the view' };
  const sc = biggestScroller();
  return sc ? { scroller: sc, root: sc, what: 'the view' } : null;
}

// Wait for fn() to return something, counting only time the page is visible:
// a panel in the background (iPad asleep, another app) doesn't render, and
// the doc Mia opened lands when he comes back — not a false "no document".
function waitFor(fn, visibleMs, capMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let seen = 0;
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      if (document.visibilityState !== 'hidden') seen += now - last;
      last = now;
      let v = null;
      try {
        v = fn();
      } catch {}
      if (v) return resolve(v);
      if (seen > visibleMs || now - t0 > capMs) return resolve(null);
      setTimeout(tick, 150);
    };
    tick();
  });
}

function reveal(scroller, el, { mark = false, block = 'start' } = {}) {
  const sr = scroller.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const off = er.top - sr.top + scroller.scrollTop;
  const top = block === 'center' ? off - Math.max(16, (scroller.clientHeight - er.height) / 2) : off - 16;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  const wrap = el.closest('.md-table');
  if (wrap) wrap.scrollTo({ left: 0, behavior: 'smooth' });
  const cls = mark ? 'mia-mark' : 'mia-flash';
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), mark ? 6000 : 2400);
}

const clip = (s, n = 70) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Scroll whatever is on screen to `text` (docs/mia.md §8.2 scroll-to /
// highlight / open-doc --at). A doc Mia just opened is still loading, so
// this waits for its body, then keeps looking briefly while it settles.
export async function scrollToText(text, nav, { mark = false, docId = null, where = null, visibleMs = 15000 } = {}) {
  const pick = () => {
    if (where) {
      const w = where();
      return w && { scroller: w, root: w.querySelector('article.md') || w, what: 'the page' };
    }
    return onScreen(docId ? { docId: () => docId } : nav);
  };
  const ready = await waitFor(() => {
    const s = pick();
    if (s?.frame) return s;
    return s && s.root && s.root.textContent.trim().length > 0 ? s : null;
  }, visibleMs);
  if (!ready) return { ok: false, detail: docId ? `the doc didn't finish loading on the panel` : 'nothing is open to scroll' };
  if (ready.frame) return { ok: false, detail: "the page is a framed site; the panel can't scroll inside it (Daniel can swipe)" };
  const hit = await waitFor(() => {
    const s = pick();
    const t = s && !s.frame ? findTarget(s.root, text) : null;
    return t && { s, t };
  }, 2500);
  if (!hit) return { ok: false, detail: `nothing matching "${clip(text, 80)}" in ${ready.what}` };
  reveal(hit.s.scroller, hit.t.el, { mark, block: hit.t.how === 'heading' ? 'start' : 'center' });
  const found = clip(textOf(hit.t.el));
  return hit.t.how === 'fuzzy'
    ? { ok: true, tell: true, detail: `no exact match; went to the closest: “${found}”` }
    : { ok: true, detail: found };
}

export function scrollPage(dir, nav) {
  const s = onScreen(nav);
  if (!s) return { ok: false, detail: 'nothing on screen scrolls' };
  if (s.frame) return { ok: false, detail: "the page is a framed site; the panel can't scroll inside it (Daniel can swipe)" };
  const el = s.scroller;
  const max = el.scrollHeight - el.clientHeight;
  const step = Math.round(el.clientHeight * 0.85);
  const from = el.scrollTop;
  const to = dir === 'top' ? 0 : dir === 'bottom' ? max : Math.max(0, Math.min(max, from + (dir === 'up' ? -step : step)));
  if (Math.abs(to - from) < 2) {
    return { ok: true, tell: true, detail: `already at the ${dir === 'up' || dir === 'top' ? 'top' : 'bottom'} of ${s.what}` };
  }
  el.scrollTo({ top: to, behavior: 'smooth' });
  const pct = max > 0 ? Math.round((to / max) * 100) : 100;
  return { ok: true, detail: `${s.what}: ${pct}% down` };
}

// Opening a link on the device. window.open hands https links to Safari and
// universal links (Zoom, Meet, Teams) to their apps. Without a tap it may be
// blocked: the Home Screen app then navigates to the link (iOS shows it over
// the app, or passes it to the meeting app); a browser tab must not lose the
// panel, so it offers the link in the top-bar pill for one tap instead.
const standalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
function openUrl(url, host) {
  let w = null;
  try {
    w = window.open(url, '_blank', 'noopener');
  } catch {}
  if (w) return 'opened';
  if (standalone()) {
    try {
      location.assign(url);
      return 'opened';
    } catch {}
  }
  offerLink(url, host);
  return 'offered';
}

// The show-url viewer: framed when the site allows it, else a card with its
// photos. `byYou` (a tapped listing photo, lib/thumbs.js) goes straight to the
// card when the page has photos — that's what the tap asked to see.
export async function showUrl(url, { byYou = false } = {}) {
  let host = '';
  try {
    host = new URL(url).host.replace(/^www\./, '');
  } catch {
    return { ok: false, detail: 'not a valid link' };
  }
  toast(byYou ? `Opening ${host}…` : `Mia is opening ${host}…`);
  const p = await linkPreview(url);
  if (p?.frameable && !(byYou && p.images?.length)) {
    showViewer({ kind: 'url', url: p.finalUrl || url, host, card: p, byYou });
    return { ok: true, tell: true, detail: `framed — ${host} is showing inside the panel (he can scroll it himself; scroll commands can't reach inside a framed site)` };
  }
  const why = p ? p.why || p.error || 'the site could not be framed' : "the relay couldn't fetch it";
  showViewer({ kind: 'card', url: p?.finalUrl || url, host, card: p, why, byYou });
  const has = [p?.title && 'title', p?.images?.length > 1 ? `${p.images.length} photos` : p?.image && 'photo', p?.description && 'summary']
    .filter(Boolean)
    .join(', ');
  return { ok: true, tell: true, detail: `card — ${why}; showing a card (${has || 'link only'}) with an Open button that opens it in Safari` };
}

export async function runPanelCommand(cmd, nav) {
  const arg = typeof cmd.arg === 'string' ? cmd.arg.trim() : '';
  switch (cmd.action) {
    case 'view': {
      if (!VIEWS[arg]) return { ok: false, detail: `unknown view "${arg}"` };
      nav.view(arg);
      toast(`Mia opened ${VIEWS[arg]}`);
      return { ok: true };
    }
    case 'open-doc': {
      const d = resolveDoc(arg);
      if (!d) return { ok: false, detail: `no Library doc matches "${arg}"` };
      nav.openDoc(d.id);
      toast(`Mia opened “${d.title || d.id}”`);
      if (cmd.heading) {
        const r = await scrollToText(cmd.heading, nav, { docId: d.id });
        return r.ok ? { ...r, detail: r.tell ? `opened ${d.id}; ${r.detail}` : d.id } : { ok: false, detail: `opened ${d.id}, but ${r.detail}` };
      }
      return { ok: true, detail: d.id };
    }
    case 'show-doc': {
      const d = resolveDoc(arg);
      if (!d) return { ok: false, detail: `no Library doc matches "${arg}"` };
      if (!getMC().docDocs[d.id]) docGet(d.id);
      showViewer({ kind: 'doc', docId: d.id, title: d.title || d.id });
      toast(`Mia is showing “${d.title || d.id}”`);
      if (cmd.heading) {
        const where = () => [...document.querySelectorAll(`[data-reader="viewer"][data-doc-id="${esc(d.id)}"]`)].pop();
        const r = await scrollToText(cmd.heading, nav, { where });
        return r.ok ? { ...r, detail: r.tell ? `showing ${d.id}; ${r.detail}` : d.id } : { ok: false, detail: `showing ${d.id}, but ${r.detail}` };
      }
      return { ok: true, detail: d.id };
    }
    case 'show-url': {
      if (!/^https:\/\/\S+$/i.test(arg)) return { ok: false, detail: 'only https links can be shown' };
      return showUrl(arg);
    }
    case 'close': {
      if (getMC().viewer) {
        closeViewer();
        return { ok: true };
      }
      if (nav.docId?.()) {
        nav.closeDoc();
        return { ok: true, detail: 'closed the doc' };
      }
      return { ok: false, detail: 'nothing is open to close' };
    }
    case 'scroll': {
      if (!['up', 'down', 'top', 'bottom'].includes(arg)) return { ok: false, detail: `scroll takes up, down, top or bottom` };
      return scrollPage(arg, nav);
    }
    case 'highlight': {
      if (!arg) return { ok: false, detail: 'no text given' };
      const r = await scrollToText(arg, nav, { mark: true, visibleMs: 8000 });
      if (r.ok) toast(`Mia highlighted “${clip(arg, 50)}”`);
      return r;
    }
    case 'open-task': {
      const id = /^\d+$/.test(arg) ? String(Number(arg)).padStart(4, '0') : arg;
      const t = (getMC().mia?.tasks || []).find((x) => x.id === id);
      if (!t) return { ok: false, detail: `task ${id} isn't on the board` };
      nav.openTask(id);
      toast(`Mia opened task ${id}`);
      return { ok: true };
    }
    case 'open-agent': {
      const a = resolveAgent(arg);
      if (!a) return { ok: false, detail: `no agent matches "${arg}"` };
      nav.openAgent(a.id);
      toast(`Mia opened ${agentName(a) || 'an agent'}`);
      return { ok: true, detail: a.id };
    }
    case 'open-url': {
      if (!/^https:\/\/\S+$/i.test(arg)) return { ok: false, detail: 'only https links can be opened' };
      let host = '';
      try {
        host = new URL(arg).host;
      } catch {
        return { ok: false, detail: 'not a valid link' };
      }
      const how = openUrl(arg, host);
      toast(how === 'opened' ? `Mia opened ${host}` : `Mia sent a link — tap to open ${host}`);
      return { ok: true, detail: how };
    }
    case 'search': {
      if (!arg) return { ok: false, detail: 'empty search' };
      nav.search(arg.slice(0, 200));
      toast(`Mia searched for “${arg.slice(0, 60)}”`);
      return { ok: true };
    }
    case 'scroll-to': {
      if (!arg) return { ok: false, detail: 'no text given' };
      const r = await scrollToText(arg, nav, { visibleMs: 8000 });
      if (r.ok) toast(`Mia jumped to “${clip(r.tell ? arg : r.detail, 60)}”`);
      return r;
    }
    default:
      return { ok: false, detail: `"${cmd.action}" isn't something the panel does` };
  }
}
