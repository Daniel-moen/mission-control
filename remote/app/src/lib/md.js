// Markdown → sanitized HTML for the document viewer. Docs come from our own
// agents over the authenticated relay, but they quote arbitrary repo content —
// so everything goes through DOMPurify before it touches the DOM.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

// ---- layout blocks (task 0124) ----------------------------------------------
// Small containers that read fine as plain markdown anywhere else:
//
//   :::pair            two (or more) images side by side; stacks on a phone
//   :::gallery         a grid of images; tap one for the lightbox
//   :::facts           a list of "Label: value" lines → label/value chips
//   :::pills           a list of "[ok] text" lines → verdict/confidence pills
//   :::callout warn Title   a toned box (ok | warn | bad | info) around markdown
//   :::
//
// `:::compare` is another name for `:::pair`. Blocks don't nest. Images take
// their caption from the title: ![alt](assets/x.jpg "Listing | Drive, north").
// The text before " | " is a small tag ("Listing", "Street View").
const BLOCK_KINDS = { pair: 'pair', compare: 'pair', gallery: 'gallery', facts: 'facts', pills: 'pills', callout: 'callout' };
const BLOCK_RE = /^:::[ \t]*([A-Za-z]+)[ \t]*([^\n]*)\n([\s\S]*?)(?:^|\n):::[ \t]*(?:\n|$)/;
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
marked.use({
  extensions: [
    {
      name: 'mdBlock',
      level: 'block',
      start(src) {
        const m = src.match(/^:::[ \t]*[A-Za-z]/m);
        return m ? m.index : undefined;
      },
      tokenizer(src) {
        const m = BLOCK_RE.exec(src);
        if (!m) return undefined;
        const kind = BLOCK_KINDS[m[1].toLowerCase()];
        if (!kind) return undefined;
        const token = { type: 'mdBlock', raw: m[0], kind, args: m[2].trim(), tokens: [] };
        this.lexer.blockTokens(m[3], token.tokens);
        return token;
      },
      renderer(t) {
        return `<div class="mdb mdb-${t.kind}" data-block="${t.kind}" data-args="${attr(t.args)}">${this.parser.parse(t.tokens)}</div>\n`;
      },
    },
  ],
});

// Tables get a horizontal-scroll wrapper (a wide table scrolls instead of
// squashing its columns to one word each), and short cells are marked
// no-wrap so "R 19 999 000" or "Option 3" never breaks mid-value. Long cells
// get a sensible minimum width instead (app.css, .md-table).
const SHORT_CELL = 28;

function shapeTables(root) {
  for (const t of root.querySelectorAll('table')) {
    const wrap = t.ownerDocument.createElement('div');
    wrap.className = 'md-table';
    t.replaceWith(wrap);
    wrap.appendChild(t);
    for (const c of t.querySelectorAll('th, td')) {
      const n = c.textContent.trim().length;
      c.classList.add(n <= SHORT_CELL ? 'nw' : n > 90 ? 'long' : 'mid');
    }
  }
}

// Listing photos (task 0070). A link to a property page gets a small photo
// button in front of it; lib/thumbs.js fills it through the relay
// (/api/v1/thumb) and removes it when the page has no photo, leaving the plain
// link. External images (![](…)) load through the relay too (/api/v1/img):
// no hotlink blocks, no mixed content. Nothing loads from here — md.js only
// marks the elements.
const LISTING_HOSTS =
  /(^|\.)(property24\.com|privateproperty\.co\.za|remax\.co\.za|seeff\.com|pamgolding\.co\.za|sothebysrealty\.(com|co\.za)|greeff\.co\.za|lancerealestate\.co|marion-taylor\.com|tysonprop\.co\.za|jawitz\.co\.za|dgproperties\.co\.za|chaseveritt\.co\.za|jamesedition\.com|rawson\.co\.za|harcourts\.co\.za|engelvoelkers\.com|knightfrank\.co\.za|leapfrog\.co\.za|fineandcountry\.co\.za|realnet\.co\.za|kwsa\.co\.za|airbnb\.[a-z.]+|booking\.com|zillow\.com|rightmove\.co\.uk|zoopla\.co\.uk|idealista\.com)$/i;
// Any other site's listing-shaped path: /for-sale/…, /property-details/…
const LISTING_PATH = /\/(for-sale|to-rent|for-rent|property-for-sale|property-details|results\/residential|listings?|property|properties|homedetails)\//i;

export function thumbFor(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol) || u.pathname.replace(/\/+$/, '') === '') return false; // a bare home page has no one photo
  return LISTING_HOSTS.test(u.hostname) || LISTING_PATH.test(u.pathname);
}

function decorate(root) {
  const doc = root.ownerDocument;
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    // A link to another Library doc ("other-doc.md", task 0124) opens it in
    // the panel (App's #doc/<id> deep link) instead of a dead relative URL.
    const docLink = /^(?:\.\/)?([A-Za-z0-9][A-Za-z0-9._-]*\.md)(#.*)?$/.exec(href || '');
    if (docLink && !docLink[1].includes('..')) {
      a.setAttribute('href', `#doc/${encodeURIComponent(docLink[1])}`);
      a.classList.add('md-doclink');
      continue;
    }
    if (!/^https?:\/\//i.test(href)) continue;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    if (!thumbFor(href) || a.querySelector('img')) continue;
    const wrap = doc.createElement('span');
    wrap.className = 'md-listing';
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'md-thumb';
    b.setAttribute('data-thumb', href.replace(/^http:/i, 'https:'));
    b.setAttribute('aria-label', `Photos: ${a.textContent.trim() || 'listing'}`);
    const img = doc.createElement('img');
    img.alt = '';
    img.setAttribute('draggable', 'false');
    b.appendChild(img);
    a.replaceWith(wrap);
    wrap.append(b, a);
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!/^https?:\/\//i.test(src)) continue;
    img.removeAttribute('src');
    img.setAttribute('data-img', src);
    img.setAttribute('loading', 'lazy');
    img.classList.add('md-img');
  }
}

// ---- images and blocks (task 0124) ------------------------------------------

// A doc's own images: ![](assets/x.jpg) (also ./assets/…, <stem>.assets/…).
// They load through the relay's doc-asset store (lib/thumbs.js), never from
// the panel's origin — so the src goes, data-asset holds the name.
const ASSET_RE = /^(?:\.\/)?(?:[A-Za-z0-9][A-Za-z0-9._-]*\.)?assets\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|gif|webp|avif))$/i;
export const assetName = (src) => {
  const m = ASSET_RE.exec(String(src || '').trim());
  return m && !m[1].includes('..') ? m[1] : '';
};
export const docStem = (docId) => String(docId || '').replace(/\.md$/i, '');

// "Listing | Drive, north" → { tag: 'Listing', caption: 'Drive, north' }
export function splitTitle(t) {
  const s = String(t || '').trim();
  const i = s.indexOf('|');
  if (i < 0) return { tag: '', caption: s };
  return { tag: s.slice(0, i).trim(), caption: s.slice(i + 1).trim() };
}

// A tag's colour: the listing side warm, the map/street side cool-neutral.
const TONE_A = /\b(listing|photo|agent|before|ours|brochure|interior|claimed)\b/i;
const TONE_B = /\b(street ?view|satellite|map|aerial|google|after|actual|deeds|survey)\b/i;
function tagTone(tag, idx) {
  if (TONE_A.test(tag)) return 'a';
  if (TONE_B.test(tag)) return 'b';
  return idx === 0 ? 'a' : idx === 1 ? 'b' : 'n';
}
const PILL_TONES = { ok: 'ok', good: 'ok', yes: 'ok', high: 'ok', warn: 'warn', maybe: 'warn', medium: 'warn', mid: 'warn', bad: 'bad', no: 'bad', low: 'bad', risk: 'bad', crit: 'bad', info: 'info', note: 'info' };

function prepImages(root, stem) {
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const name = assetName(src);
    if (name) {
      img.removeAttribute('src');
      img.setAttribute('data-asset', name);
      if (stem) img.setAttribute('data-stem', stem);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.classList.add('md-img');
    } else if (src && !/^https?:\/\//i.test(src)) {
      // A path the panel can't resolve (an unattached ./photo.jpg): never let
      // the browser try it against the panel's own origin.
      img.removeAttribute('src');
      img.classList.add('md-img');
      img.setAttribute('data-state', 'failed');
    }
  }
}

function figureFor(img, idx, toned) {
  const doc = img.ownerDocument;
  const fig = doc.createElement('figure');
  fig.className = 'md-fig';
  const { tag, caption } = splitTitle(img.getAttribute('title'));
  img.removeAttribute('title');
  const frame = doc.createElement('span');
  frame.className = 'md-fig-frame';
  img.replaceWith(fig);
  frame.appendChild(img);
  fig.appendChild(frame);
  if (tag || caption) {
    const cap = doc.createElement('figcaption');
    if (tag) {
      const t = doc.createElement('span');
      t.className = 'md-tag';
      t.setAttribute('data-tone', toned ? tagTone(tag, idx) : 'n');
      t.textContent = tag;
      cap.appendChild(t);
    }
    if (caption) {
      const c = doc.createElement('span');
      c.className = 'md-cap';
      c.textContent = caption;
      cap.appendChild(c);
    }
    fig.appendChild(cap);
  }
  return fig;
}

// A paragraph that holds nothing but images (and the whitespace / <br>s
// between them).
const onlyImages = (p) =>
  p.querySelector('img') &&
  [...p.childNodes].every((n) => (n.nodeType === 3 && !n.textContent.trim()) || n.nodeName === 'IMG' || n.nodeName === 'BR');

function shapeImageBlock(block, kind) {
  const doc = block.ownerDocument;
  const imgs = [...block.querySelectorAll('img')].filter((i) => !i.closest('a, table'));
  if (!imgs.length) return;
  const grid = doc.createElement('div');
  grid.className = kind === 'pair' ? 'mdb-grid' : 'mdb-gallery-grid';
  // The grid goes where the first image was; the paragraphs that only held
  // images go; any prose in the block stays above/below as written.
  const firstP = imgs[0].closest('p') || imgs[0];
  firstP.before(grid);
  imgs.forEach((img, i) => {
    const holder = img.parentElement;
    grid.appendChild(figureFor(img, i, kind === 'pair'));
    if (holder && holder.nodeName === 'P' && holder !== block && !holder.querySelector('img') && !holder.textContent.trim()) holder.remove();
  });
  if (kind === 'pair') block.style.setProperty('--n', String(Math.min(imgs.length, 3)));
}

function shapeFacts(block) {
  const doc = block.ownerDocument;
  const items = [...block.querySelectorAll(':scope > ul > li, :scope > ol > li')];
  if (!items.length) return;
  const row = doc.createElement('div');
  row.className = 'mdb-facts-row';
  for (const li of items) {
    const fact = doc.createElement('div');
    fact.className = 'mdb-fact';
    const label = doc.createElement('span');
    const value = doc.createElement('b');
    // Split at the first ":" in the item's text; links etc. stay in the value.
    let split = false;
    for (const n of [...li.childNodes]) {
      if (!split && n.nodeType === 3 && n.textContent.includes(':')) {
        const i = n.textContent.indexOf(':');
        label.textContent += n.textContent.slice(0, i);
        const rest = n.textContent.slice(i + 1).replace(/^\s+/, '');
        if (rest) value.appendChild(doc.createTextNode(rest));
        split = true;
      } else if (!split) label.appendChild(n);
      else value.appendChild(n);
    }
    if (!split) {
      value.append(...label.childNodes);
      label.textContent = '';
    }
    if (label.textContent.trim()) fact.appendChild(label);
    fact.appendChild(value);
    row.appendChild(fact);
  }
  block.replaceChildren(row);
}

function shapePills(block) {
  const doc = block.ownerDocument;
  const items = [...block.querySelectorAll(':scope > ul > li, :scope > ol > li')];
  if (!items.length) return;
  const row = doc.createElement('div');
  row.className = 'mdb-pills-row';
  for (const li of items) {
    const pill = doc.createElement('span');
    pill.className = 'mdb-pill';
    let tone = 'n';
    const first = li.firstChild;
    if (first && first.nodeType === 3) {
      const m = /^\s*\[([a-z]+)\]\s*/i.exec(first.textContent);
      if (m && PILL_TONES[m[1].toLowerCase()]) {
        tone = PILL_TONES[m[1].toLowerCase()];
        first.textContent = first.textContent.slice(m[0].length);
      }
    }
    pill.setAttribute('data-tone', tone);
    pill.append(...li.childNodes);
    row.appendChild(pill);
  }
  block.replaceChildren(row);
}

function shapeCallout(block) {
  const doc = block.ownerDocument;
  const args = (block.getAttribute('data-args') || '').trim();
  const m = /^([a-z]+)\b\s*(.*)$/i.exec(args);
  let tone = 'info';
  let title = args;
  if (m && PILL_TONES[m[1].toLowerCase()]) {
    tone = PILL_TONES[m[1].toLowerCase()];
    title = m[2];
  }
  block.setAttribute('data-tone', tone);
  if (title) {
    const h = doc.createElement('div');
    h.className = 'mdb-callout-title';
    h.textContent = title;
    block.prepend(h);
  }
}

function shapeBlocks(root) {
  for (const block of root.querySelectorAll('.mdb[data-block]')) {
    const kind = block.getAttribute('data-block');
    if (kind === 'pair' || kind === 'gallery') shapeImageBlock(block, kind);
    else if (kind === 'facts') shapeFacts(block);
    else if (kind === 'pills') shapePills(block);
    else if (kind === 'callout') shapeCallout(block);
  }
  // Loose images on their own line become captioned figures; several in one
  // paragraph sit side by side (wrapping on a phone).
  for (const p of [...root.querySelectorAll('p')]) {
    if (p.closest('.mdb, table, li, blockquote') || !onlyImages(p)) continue;
    const imgs = [...p.querySelectorAll('img')];
    const wrap = p.ownerDocument.createElement('div');
    wrap.className = imgs.length > 1 ? 'md-figs' : 'md-figs md-figs-1';
    p.replaceWith(wrap);
    imgs.forEach((img, i) => {
      wrap.appendChild(img);
      wrap.appendChild(figureFor(img, i, false));
    });
  }
}

// `opts.docId` lets relative asset refs (assets/x.jpg) resolve to that doc.
export function renderMarkdown(src, opts = {}) {
  const html = marked.parse(String(src || ''));
  const frag = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true });
  prepImages(frag, docStem(opts.docId));
  shapeTables(frag);
  shapeBlocks(frag);
  decorate(frag);
  const box = document.createElement('div');
  box.appendChild(frag);
  return box.innerHTML;
}

// Short alias — `render(md)` reads better at the call site.
export const render = renderMarkdown;

// "3m ago" style age from an epoch-seconds or ms timestamp.
export function ago(t, now = Date.now()) {
  if (!t) return '';
  const ms = t > 1e12 ? t : t * 1000;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
