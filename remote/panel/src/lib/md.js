// Markdown → sanitized HTML for the plan viewer. Plans come from our own
// agents over the authenticated relay, but they quote arbitrary repo content —
// so everything goes through DOMPurify before it touches the DOM.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(src) {
  const html = marked.parse(String(src || ''));
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

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
