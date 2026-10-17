import { useEffect, useRef, useState } from 'react';
import { useMC, closeViewer } from '../../lib/store.js';
import { renderMarkdown } from '../../lib/md.js';
import { openLightbox } from '../../lib/lightbox.js';

// A Library *page* (task 0126): a full HTML page Mia published with `mc-doc
// new --kind page`, shown full-bleed like a Claude artifact. The relay serves
// it from /p/<capability>/<stem>/ (relay docpages.js); this asks for a fresh
// capability link with the panel token, then frames it.
//
// Isolation: sandbox="allow-scripts" WITHOUT allow-same-origin, so the page
// runs in an opaque origin — it can't read this panel's localStorage (the
// token), its DOM, or call /api as us; the relay's CSP also limits it to the
// CDN allowlist and its own images, with no fetch/XHR at all. The page and
// the panel only talk by postMessage, and everything that comes back is
// checked: an image for the lightbox must sit under this page's own path (and
// is shown by plain <img>, never fetched with the token); a doc link must be
// a doc id.

export const isPageDoc = (d) => !!d && (d.kind === 'page' || (d.tags || []).includes('page'));

const stemOf = (id) => String(id || '').replace(/\.md$/i, '');
const IMG_RE = /\.(jpe?g|png|gif|webp|avif)$/i;
const DOC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

// The panel is dark-only today; a light theme sets <html data-theme="light">.
const panelTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

// The page's capability link, re-asked whenever the doc changes on the Mac
// (mc-doc page bumps the stub, so its updatedAt moves).
export function usePageLink(docId, updatedAt) {
  const token = useMC((s) => s.token);
  const [st, setSt] = useState({ state: 'loading', url: '' });
  useEffect(() => {
    let live = true;
    setSt((p) => (p.url ? p : { state: 'loading', url: '' }));
    fetch(`/api/v1/doc-pages/${encodeURIComponent(stemOf(docId))}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!live) return;
        if (r.status === 404) return setSt({ state: 'missing', url: '' });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.url || !j.url.startsWith('/p/')) return setSt({ state: 'error', url: '' });
        setSt({ state: 'ok', url: j.url, v: j.sha256 || '' });
      })
      .catch(() => live && setSt({ state: 'error', url: '' }));
    return () => {
      live = false;
    };
  }, [docId, updatedAt, token]);
  return st;
}

export default function PageFrame({ docId, title, updatedAt, stub }) {
  const link = usePageLink(docId, updatedAt);
  const frame = useRef(null);
  const [loaded, setLoaded] = useState(false);

  // Messages from the page: only from OUR frame, only the two shapes we know.
  useEffect(() => {
    if (link.state !== 'ok') return;
    const base = new URL(link.url, location.origin);
    const own = (src) => {
      try {
        const u = new URL(String(src), location.origin);
        return u.origin === location.origin && u.pathname.startsWith(base.pathname) && IMG_RE.test(u.pathname) && !u.pathname.includes('..')
          ? u.href
          : '';
      } catch {
        return '';
      }
    };
    const onMsg = (e) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.mc === 'lightbox' && Array.isArray(d.items)) {
        const items = [];
        let at = 0;
        d.items.slice(0, 400).forEach((x, i) => {
          const src = own(x?.src);
          if (!src) return;
          if (i === d.at) at = items.length;
          items.push({
            full: '', // shown as a plain <img>: never fetched with the token
            preview: src,
            alt: String(x.alt || '').slice(0, 300),
            caption: String(x.caption || '').slice(0, 300),
            tag: '',
          });
        });
        if (!items.length) return;
        // A tap inside the frame left keyboard focus there: take it back, so
        // arrows / Escape reach the lightbox (App's key handler).
        if (document.activeElement === frame.current) frame.current.blur();
        window.focus();
        openLightbox(items, at);
      } else if (d.mc === 'open-doc' && typeof d.id === 'string' && DOC_RE.test(d.id) && !d.id.includes('..')) {
        closeViewer();
        location.hash = `#doc/${encodeURIComponent(d.id)}`;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [link.state, link.url]);

  // Keep the page's theme in step with the panel's.
  useEffect(() => {
    if (!loaded) return;
    const send = () => frame.current?.contentWindow?.postMessage({ mc: 'theme', theme: panelTheme() }, '*');
    send();
    const mo = new MutationObserver(send);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [loaded]);

  if (link.state === 'missing' || link.state === 'error') {
    return (
      <div className="mx-auto max-w-[860px] px-5 py-6 sm:px-8">
        <div className="mb-5 rounded-xl2 border border-warn/35 bg-warn/[0.08] px-3.5 py-3 text-[13px] text-ink2">
          {link.state === 'missing'
            ? `This page hasn't reached the relay yet. On the Mac: mc-doc sync ${docId}`
            : "The relay didn't answer for this page. It will try again when the doc changes, or reopen it."}
        </div>
        {stub ? <article className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(stub, { docId }) }} /> : null}
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-[60vh] w-full" data-page-frame>
      {!loaded && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="anim-spin h-10 w-10 rounded-full border-2 border-white/15 border-t-accent" />
        </div>
      )}
      {link.state === 'ok' && (
        <iframe
          ref={frame}
          key={`${link.url}#${link.v}`}
          title={title || 'Library page'}
          src={`${link.url}?theme=${panelTheme()}`}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          allow="fullscreen"
          onLoad={() => setLoaded(true)}
          className={`absolute inset-0 h-full w-full border-0 transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  );
}
