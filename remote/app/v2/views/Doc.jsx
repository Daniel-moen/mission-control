import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, docSave, docDelete, docMeta, kindLabel, docStatusLabel, toast } from '../../src/lib/store.js';
import { ago } from '../../src/lib/md.js';
import { attachToMia } from '../../src/lib/attach.js';
import PageFrame, { isPageDoc } from '../../src/views/library/PageFrame.jsx';
import { openSheet, setTab, pop } from '../lib/nav.js';
import { spring, tap } from '../lib/motion.js';
import { useWide } from '../ui/hooks.js';
import { Button, Icon, IconBtn, Segmented, Spinner, useArm } from '../ui/kit.jsx';
import Sheet from '../ui/Sheet.jsx';
import Page from '../shell/Page.jsx';
import { usePage } from '../shell/Stack.jsx';
import { useDocBody } from './docBody.js';
import DownloadSheet from './Download.jsx';

// A Library document. Reading first: the rendered markdown, full width for
// tables, prose capped near 72ch, images that open in the lightbox. Edit is
// the raw markdown; details (kind, status, subject, tags, folder) live in a
// sheet so the page is the document. "Ask Mia" clips it into her chat; a
// plan can be handed straight to a fleet with "Build". A research report an
// agent is still writing refreshes in place as the file changes on the Mac.

const KIND_TONE = { plan: 'bg-accent/15 text-accent', research: 'bg-mgr/15 text-mgr', note: 'bg-fill2 text-ink2', page: 'bg-s4/15 text-s4' };
const toTags = (s) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);

function Details({ open, onClose, docId, meta, kind }) {
  const [subject, setSubject] = useState('');
  const [tags, setTags] = useState('');
  const [dir, setDir] = useState('');
  const [armed, fire] = useArm();
  useEffect(() => {
    if (!open || !meta) return;
    setSubject(meta.subject || '');
    setTags((meta.tags || []).join(', '));
    setDir(meta.dir || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const commit = () => {
    if (!meta) return;
    const patch = {};
    if (subject.trim() !== (meta.subject || '')) patch.subject = subject.trim();
    if (toTags(tags).join(' ') !== (meta.tags || []).join(' ')) patch.tags = toTags(tags);
    if (dir.trim() !== (meta.dir || '')) patch.dir = dir.trim();
    if (Object.keys(patch).length) docMeta(docId, patch);
  };
  const L = ({ children }) => <div className="v-eyebrow mb-2 mt-5 first:mt-0">{children}</div>;
  return (
    <Sheet open={open} onClose={() => (commit(), onClose())} title="Details" size="sm">
      <div data-doc-meta>
        <L>Kind</L>
        <Segmented full value={kind} onChange={(v) => docMeta(docId, { kind: v })} options={[{ value: 'plan', label: 'Plan' }, { value: 'research', label: 'Research' }, { value: 'note', label: 'Note' }]} />
        <L>Status</L>
        <Segmented full size="sm" value={meta?.status || 'draft'} onChange={(v) => docMeta(docId, { status: v })} options={[{ value: 'draft', label: 'Draft' }, { value: 'active', label: 'Working' }, { value: 'done', label: 'Done' }, { value: 'archived', label: 'Archived' }]} />
        <L>Subject</L>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={commit} placeholder="—" aria-label="Subject" className="v-field h-11 w-full px-4 text-[0.92rem]" />
        <L>Tags</L>
        <input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={commit} placeholder="comma, separated" aria-label="Tags" className="v-field h-11 w-full px-4 font-mono text-[0.84rem]" />
        <L>Folder</L>
        <input value={dir} onChange={(e) => setDir(e.target.value)} onBlur={commit} placeholder="~/path/to/project" aria-label="Folder" className="v-field h-11 w-full px-4 font-mono text-[0.84rem]" />
        <p className="mt-2 px-1 font-mono text-[0.7rem] text-ink3">~/.mission-control/library/{docId}</p>
        <motion.button
          {...tap}
          onClick={() =>
            fire(() => {
              if (docDelete(docId)) {
                onClose();
                pop();
              }
            })
          }
          className={`mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-full text-[0.9rem] font-semibold ${armed ? 'bg-crit text-white' : 'bg-crit/10 text-crit'}`}
          data-doc-delete
        >
          <Icon name="trash" size={16} />
          {armed ? 'Tap again to delete' : `Delete ${kindLabel(kind).toLowerCase()}`}
        </motion.button>
      </div>
    </Sheet>
  );
}

export default function Doc({ params }) {
  const docId = params.id;
  const { meta, doc, html, setArticle } = useDocBody(docId);
  const now = useMC((s) => s.now);
  const { active } = usePage();
  const wide = useWide(640);
  const kind = meta?.kind || doc?.kind || 'note';
  const page = isPageDoc(meta) || kind === 'page';
  const title = meta?.title || doc?.title || kindLabel(kind);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [details, setDetails] = useState(false);
  const [download, setDownload] = useState(false);

  // A note just created here opens straight in the editor once its body lands.
  const wantEdit = useRef(!!params.edit);
  useEffect(() => {
    if (!wantEdit.current || !doc) return;
    wantEdit.current = false;
    setDraft(doc.content ?? '');
    setEditing(true);
  }, [doc]);

  const startEdit = () => {
    setDraft(doc?.content ?? '');
    setEditing(true);
  };
  const save = () => docSave(docId, draft) && setEditing(false);
  const cancel = () => {
    if (draft !== (doc?.content ?? '') && !confirm('Discard your edits?')) return;
    setEditing(false);
  };
  const askMia = () => {
    if (!meta) return toast('Still loading this document');
    attachToMia({ kind: 'doc', id: docId, title });
    setTab('mia');
  };
  const build = () => {
    if (!meta) return toast('Still loading this document');
    openSheet('launch', { doc: { ...meta, mode: 'build' } });
  };

  const actions = editing ? (
    <>
      <Button size="sm" tone="ghost" onClick={cancel}>
        Cancel
      </Button>
      <Button size="sm" tone="primary" icon="check" onClick={save}>
        Save
      </Button>
    </>
  ) : (
    <>
      {!page && <IconBtn icon="download" label="Download" tone="ghost" onClick={() => setDownload(true)} disabled={!meta} />}
      {!page && <IconBtn icon="edit" label="Edit" tone="ghost" onClick={startEdit} disabled={!doc} />}
      {!page && <IconBtn icon="more" label="Details" tone="ghost" onClick={() => setDetails(true)} data-doc-details />}
      {kind === 'plan' && (wide ? <Button size="sm" icon="launch" onClick={build}>Build</Button> : <IconBtn icon="launch" label="Build" tone="ghost" onClick={build} />)}
      <Button size="sm" tone="primary" icon="mia" onClick={askMia} disabled={!meta} data-doc-to-mia>
        {wide ? 'Ask Mia' : 'Mia'}
      </Button>
    </>
  );

  if (page && !editing) {
    return (
      <Page scroll={false} title={title} actions={actions}>
        <div className="min-h-0 flex-1" data-reader="page" data-doc-id={docId} style={{ paddingBottom: 'var(--tabbar-space)' }}>
          <PageFrame docId={docId} title={title} updatedAt={meta?.updatedAt} stub={doc?.content} />
        </div>
      </Page>
    );
  }

  return (
    <>
      <Page title={title} large={false} actions={actions} maxW={1400} scrollProps={{ 'data-reader': 'doc', 'data-doc-id': docId }}>
        <div className="mb-5 mt-2 flex flex-wrap items-center gap-2 text-[0.8rem] text-ink3" data-doc-head>
          <span className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 font-semibold ${KIND_TONE[kind] || KIND_TONE.note}`}>{kindLabel(kind)}</span>
          {meta && <span className="font-semibold text-ink2">{docStatusLabel(meta.status)}</span>}
          {meta?.subject && <span>· {meta.subject}</span>}
          {meta?.folder && <span>· {meta.folder}</span>}
          {meta && <span>· {ago(meta.updatedAt, now)}</span>}
          {meta?.words ? <span className="v-num">· {meta.words.toLocaleString()} words</span> : null}
        </div>
        {meta?.status === 'active' && (
          <div className="mb-6 flex items-center gap-3 rounded-[18px] bg-accent/10 px-4 py-3">
            <span className="relative flex h-2.5 w-2.5 flex-none">
              <span className="anim-ping absolute inline-flex h-full w-full rounded-full bg-accent/70" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
            </span>
            <div className="min-w-0">
              <div className="text-[0.9rem] font-semibold text-accent">An agent is writing this now</div>
              <div className="text-[0.76rem] text-ink3">It refreshes as new text lands on your Mac</div>
            </div>
          </div>
        )}
        <AnimatePresence mode="wait" initial={false}>
          {editing ? (
            <motion.div key="edit" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="pb-8">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Markdown"
                className="v-field v-scroll min-h-[62vh] w-full resize-none p-4 font-mono text-[0.84rem] leading-relaxed"
              />
              <p className="mt-2 font-mono text-[0.7rem] text-ink3">Markdown. Saving writes the file on your Mac.</p>
            </motion.div>
          ) : doc ? (
            <motion.div key="read" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring.layout}>
              <article ref={setArticle} className="md pb-12" data-doc-id={docId} dangerouslySetInnerHTML={{ __html: html }} />
            </motion.div>
          ) : (
            <motion.div key="load" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-3 pb-10" aria-busy="true">
              {[92, 100, 84, 96, 60].map((w, i) => (
                <div key={i} className="v-skeleton h-4" style={{ width: `${w}%` }} />
              ))}
              <span className="mt-3 flex items-center gap-2 text-[0.8rem] text-ink3">
                <Spinner size={14} /> Loading from your Mac…
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </Page>
      {active && <Details open={details} onClose={() => setDetails(false)} docId={docId} meta={meta} kind={kind} />}
      {active && <DownloadSheet open={download} onClose={() => setDownload(false)} docId={docId} meta={meta} title={title} />}
    </>
  );
}
