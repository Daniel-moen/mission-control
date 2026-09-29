// Markdown → sanitized HTML for the document viewer. Docs come from our own
// agents over the authenticated relay, but they quote arbitrary repo content —
// so everything goes through DOMPurify before it touches the DOM.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

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

export function renderMarkdown(src) {
  const html = marked.parse(String(src || ''));
  const frag = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true });
  shapeTables(frag);
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
