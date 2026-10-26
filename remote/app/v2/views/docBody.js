import { useEffect, useMemo, useRef, useState } from 'react';
import { useMC, docGet } from '../../src/lib/store.js';
import { renderMarkdown } from '../../src/lib/md.js';
import { useDocImages } from '../../src/lib/thumbs.js';

// A Library doc's body: fetched on demand, re-fetched whenever the Mac
// rewrites the file (a research report streaming in), rendered + sanitised by
// the shared md.js, images wired to the lightbox by thumbs.js.
export function useDocBody(docId) {
  const meta = useMC((s) => s.docs.find((d) => d.id === docId) || null);
  const doc = useMC((s) => s.docDocs[docId] || null);
  const link = useMC((s) => s.link);
  const lastSnapshotAt = useMC((s) => s.lastSnapshotAt);
  const lastReq = useRef(0);
  useEffect(() => {
    if (doc || link !== 'linked') return;
    void lastSnapshotAt; // retry per snapshot until the body lands
    if (Date.now() - lastReq.current < 2500) return;
    lastReq.current = Date.now();
    docGet(docId);
  }, [doc, link, lastSnapshotAt, docId]);
  const html = useMemo(() => (doc ? renderMarkdown(doc.content, { docId }) : ''), [doc, docId]);
  const [article, setArticle] = useState(null);
  useDocImages(article, html);
  return { meta, doc, html, setArticle };
}
