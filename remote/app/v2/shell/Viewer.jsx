import { lazy, Suspense, useEffect, useState } from 'react';
import { useMC, closeViewer } from '../../src/lib/store.js';
import { loadImage, imgEndpoint } from '../../src/lib/thumbs.js';
import Sheet from '../ui/Sheet.jsx';
import { Button, Spinner } from '../ui/kit.jsx';

// What Mia is showing over the panel (`mia panel show-url | show-doc`): a
// framed site, a card for a site that won't be framed, or a Library doc —
// in a tall sheet you pull down to dismiss, with whatever you were on still
// under it. `data-reader="viewer"` / `data-viewer-frame` are what
// `mia panel scroll | scroll-to | highlight` look for (lib/panelCommands.js).

const DocBody = lazy(() => import('./ViewerDoc.jsx'));
const FRAME_TIMEOUT_MS = 12000;
const openOut = (url) => {
  try {
    window.open(url, '_blank', 'noopener');
  } catch {}
};

function Photo({ src, className }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    loadImage(imgEndpoint(src)).then((u) => live && setUrl(u || src));
    return () => {
      live = false;
    };
  }, [src]);
  if (!url) return <div className={`${className} v-skeleton`} />;
  return <img src={url} alt="" referrerPolicy="no-referrer" className={className} onError={(e) => (e.currentTarget.style.display = 'none')} />;
}

function Card({ v }) {
  const c = v.card || {};
  const photos = (c.images || []).slice(0, 12);
  return (
    <div className="md pb-4">
      {photos[0] && <Photo src={photos[0]} className="mb-4 aspect-[3/2] max-h-[52vh] w-full rounded-[18px] object-cover" />}
      <h2 className="!mt-0 !border-0">{c.title || v.host}</h2>
      {c.description && <p>{c.description}</p>}
      <p className="!mt-4">
        <Button tone="primary" icon="share" onClick={() => openOut(v.url)}>
          Open on {v.host}
        </Button>
      </p>
      <p className="text-[0.8rem] text-ink3">
        {c.ok === false || !c.title
          ? `The panel couldn't read this page (${v.why || 'no preview'}).`
          : v.byYou && c.frameable
            ? `Photos from ${v.host}. Open shows the full listing.`
            : `${v.host} doesn't let itself be shown inside another page, so this is its preview.`}
      </p>
      {photos.length > 1 && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.slice(1).map((src) => (
            <Photo key={src} src={src} className="aspect-[4/3] w-full rounded-[14px] object-cover" />
          ))}
        </div>
      )}
    </div>
  );
}

function Frame({ v, onFail }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded) return undefined;
    const t = setTimeout(onFail, FRAME_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [loaded, onFail]);
  return (
    <div className="relative h-[72dvh] overflow-hidden rounded-[18px] bg-white" data-viewer-frame>
      {!loaded && (
        <div className="absolute inset-0 grid place-items-center bg-card text-ink3">
          <Spinner size={26} />
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

export default function Viewer() {
  const v = useMC((s) => s.viewer);
  const [failedN, setFailedN] = useState(0);
  const frameFailed = v && v.kind === 'url' && failedN === v.n;
  const kind = frameFailed ? 'card' : v?.kind;
  const title = v?.kind === 'doc' ? v.title : v?.card?.title || v?.host || '';
  return (
    <Sheet
      open={!!v}
      onClose={closeViewer}
      title={title}
      size="xl"
      height="100%"
      label="Shown by Mia"
      scrollProps={kind === 'doc' ? { 'data-reader': 'viewer', 'data-doc-id': v.docId } : kind === 'card' ? { 'data-reader': 'viewer' } : {}}
      actions={v && v.kind !== 'doc' ? <Button size="sm" icon="share" onClick={() => openOut(v.url)}>Open</Button> : null}
    >
      {v && (
        <div data-viewer={kind}>
          <div className="-mt-2 mb-3 text-[0.78rem] text-ink3">{v.kind === 'doc' ? 'Library · shown by Mia' : `${v.host} · ${v.byYou ? 'listing' : 'shown by Mia'}`}</div>
          {kind === 'doc' && (
            <Suspense fallback={<Spinner size={22} className="mx-auto my-10 block text-ink3" />}>
              <DocBody v={v} />
            </Suspense>
          )}
          {kind === 'url' && <Frame v={v} onFail={() => setFailedN(v.n)} />}
          {kind === 'card' && <Card v={frameFailed ? { ...v, why: 'the page never loaded in the frame' } : v} />}
        </div>
      )}
    </Sheet>
  );
}
