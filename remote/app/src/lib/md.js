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

export function renderMarkdown(src) {
  const html = marked.parse(String(src || ''));
  const frag = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true });
  shapeTables(frag);
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
