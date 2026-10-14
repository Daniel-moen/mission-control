import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, closeViewer, docGet } from '../lib/store.js';
import { renderMarkdown } from '../lib/md.js';
import { useDocImages, loadImage, imgEndpoint } from '../lib/thumbs.js';
import { sheetUp } from '../lib/motion.js';
import IconButton from '../ui/IconButton.jsx';
import Button from '../ui/Button.jsx';
import PageFrame, { isPageDoc } from '../views/library/PageFrame.jsx';

// What Mia is showing Daniel over the panel (`mia panel show-url|show-doc`,
// docs/mia.md §8.2): a page, a card for a page that won't be framed, or a
// Library doc — on top of whatever he was looking at, with Back to return to
// it. `data-reader="viewer"` marks the scroller `mia panel scroll`,
// `scroll-to` and `highlight` act on (lib/panelCommands.js).
//
// Framing: the relay checked the site's headers first (preview.js), so an
// iframe only appears for sites that allow it. Sandboxed without
// allow-top-navigation — a page can't navigate the panel away. If it never
// loads, the card takes over.

const FRAME_TIMEOUT_MS = 12000;

function openOut(url) {
  try {
    window.open(url, '_blank', 'noopener');
  } catch {}
}

function Header({ title, sub, url, onClose }) {
  return (
    <header className="flex flex-none items-center gap-3 border-b border-glass-line px-3 py-2.5 sm:px-4">
      <IconButton icon="back" label="Back" size="md" variant="glass" onClick={onClose} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold leading-tight tracking-tight text-ink">{title}</div>
        {sub && <div className="truncate text-[11.5px] text-ink3">{sub}</div>}
      </div>
      {url && (
        <Button icon="share" onClick={() => openOut(url)} className="flex-none">
          Open
        </Button>
      )}
    </header>
  );
}

// A card photo through the relay's image cache (thumbs.js): listing CDNs
// often refuse hotlinks. The original URL if the relay can't get it.
function Photo({ src, className, lazy }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    loadImage(imgEndpoint(src)).then((u) => live && setUrl(u || src));
    return () => {
      live = false;
    };
  }, [src]);
  if (!url) return <div className={`${className} bg-white/[0.06]`} />;
  return (
    <img
      src={url}
      alt=""
      loading={lazy ? 'lazy' : undefined}
      referrerPolicy="no-referrer"
      className={className}
      onError={(e) => (e.currentTarget.style.display = 'none')}
    />
  );
}

function Card({ v }) {
  const c = v.card || {};
  const photos = (c.images || []).slice(0, 12);
  return (
    <div className="noscroll min-h-0 flex-1 overflow-y-auto" data-reader="viewer">
      <div className="md mx-auto max-w-[1100px] px-4 pb-28 pt-4 sm:px-6 lg:pb-8">
        {photos[0] && (
          <Photo src={photos[0]} className="mb-4 aspect-[3/2] max-h-[52vh] w-full rounded-xl3 object-cover" />
        )}
        <h2 className="!mt-0 !border-0">{c.title || v.host}</h2>
        {c.description && <p>{c.description}</p>}
        <p className="!mt-4">
          <Button variant="primary" icon="share" onClick={() => openOut(v.url)}>
            Open on {v.host}
          </Button>
        </p>
        <p className="text-[12.5px] text-ink3">
          {c.ok === false || !c.title
            ? `The panel couldn't read this page (${v.why || 'no preview'}).`
            : v.byYou && c.frameable
              ? `Photos from ${v.host}. Open shows the full listing.`
              : `${v.host} doesn't let itself be shown inside another page, so this is its preview.`}
        </p>
        {photos.length > 1 && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {photos.slice(1).map((src) => (
              <Photo key={src} src={src} lazy className="aspect-[4/3] w-full rounded-xl2 object-cover" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Frame({ v, onFail }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded) return;
    const t = setTimeout(onFail, FRAME_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [loaded, onFail]);
  return (
    <div className="relative min-h-0 flex-1 bg-white" data-viewer-frame>
      {!loaded && (
        <div className="absolute inset-0 grid place-items-center bg-bg">
          <span className="anim-spin h-10 w-10 rounded-full border-2 border-white/15 border-t-accent" />
        </div>
      )}
      <iframe
        title={v.card?.title || v.host}
        src={v.url}
        onLoad={() => setLoaded(true)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="h-full w-full border-0"
      />
    </div>
  );
}

function DocBody({ v }) {
  const doc = useMC((s) => s.docDocs[v.docId] || null);
  const meta = useMC((s) => s.docs.find((d) => d.id === v.docId) || null);
  const link = useMC((s) => s.link);
  const lastSnapshotAt = useMC((s) => s.lastSnapshotAt);
  const lastReq = useRef(0);
  // Same fetch-until-it-lands loop as DocView.
  useEffect(() => {
    if (doc || link !== 'linked') return;
    void lastSnapshotAt;
    if (Date.now() - lastReq.current < 2500) return;
    lastReq.current = Date.now();
    docGet(v.docId);
  }, [doc, link, lastSnapshotAt, v.docId]);
  const html = useMemo(() => (doc ? renderMarkdown(doc.content, { docId: v.docId }) : ''), [doc, v.docId]);
  const [article, setArticle] = useState(null);
  useDocImages(article, html);
  // A Library page (task 0126): full-bleed in its sandboxed frame.
  if (isPageDoc(meta)) {
    return (
      <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]" data-reader="viewer-page" data-doc-id={v.docId}>
        <PageFrame docId={v.docId} title={v.title} updatedAt={meta?.updatedAt} stub={doc?.content} />
      </div>
    );
  }
  return (
    <div className="noscroll min-h-0 flex-1 overflow-y-auto" data-reader="viewer" data-doc-id={v.docId}>
      {doc ? (
        <article
          ref={setArticle}
          className="md mx-auto max-w-[1600px] px-5 pb-28 pt-5 sm:px-8 lg:pb-10"
          data-doc-id={v.docId}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-4 py-20">
          <span className="anim-spin h-10 w-10 rounded-full border-2 border-white/15 border-t-accent" />
          <span className="label">Loading document…</span>
        </div>
      )}
    </div>
  );
}

export default function Viewer() {
  const v = useMC((s) => s.viewer);
  const [failedN, setFailedN] = useState(0);

  // Escape is App's (one handler, topmost overlay first).
  const frameFailed = v && v.kind === 'url' && failedN === v.n;
  const kind = frameFailed ? 'card' : v?.kind;
  const title = v?.kind === 'doc' ? v.title : v?.card?.title || v?.host || '';
  const sub = v?.kind === 'doc' ? 'Library · shown by Mia' : v ? `${v.host} · ${v.byYou ? 'listing' : 'shown by Mia'}` : '';

  return createPortal(
    <AnimatePresence>
      {v && (
        <motion.div
          key={`viewer:${v.n}`}
          {...sheetUp}
          className="to-screen-bottom glass-strong fixed inset-0 z-[88] flex flex-col overflow-hidden"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
          role="dialog"
          aria-label={title}
        >
          <Header title={title} sub={sub} url={v.kind === 'doc' ? null : v.url} onClose={closeViewer} />
          {kind === 'doc' && <DocBody v={v} />}
          {kind === 'url' && <Frame v={v} onFail={() => setFailedN(v.n)} />}
          {kind === 'card' && <Card v={frameFailed ? { ...v, why: 'the page never loaded in the frame' } : v} />}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
