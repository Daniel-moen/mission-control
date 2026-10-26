import PageFrame, { isPageDoc } from '../../src/views/library/PageFrame.jsx';
import { useDocBody } from '../views/docBody.js';
import { Spinner } from '../ui/kit.jsx';

// A Library doc inside the viewer sheet (its own chunk: it brings the
// markdown renderer). Pages run full-bleed in their sandboxed frame.
export default function ViewerDoc({ v }) {
  const { meta, doc, html, setArticle } = useDocBody(v.docId);
  if (isPageDoc(meta)) {
    return (
      <div className="h-[74dvh] overflow-hidden rounded-[18px]" data-reader="viewer-page" data-doc-id={v.docId}>
        <PageFrame docId={v.docId} title={v.title} updatedAt={meta?.updatedAt} stub={doc?.content} />
      </div>
    );
  }
  if (!doc) return <Spinner size={22} className="mx-auto my-12 block text-ink3" />;
  return <article ref={setArticle} className="md pb-6" data-doc-id={v.docId} dangerouslySetInnerHTML={{ __html: html }} />;
}
