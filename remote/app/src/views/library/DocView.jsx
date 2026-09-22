import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, docGet, docSave, docDelete, docMeta, kindLabel, docStatusLabel, toast } from '../../lib/store.js';
import { renderMarkdown, ago } from '../../lib/md.js';
import { useMedia } from '../../lib/hooks.js';
import { fadeUp, fadeIn, press } from '../../lib/motion.js';
import Field from '../../ui/Field.jsx';
import Select from '../../ui/Select.jsx';
import Button from '../../ui/Button.jsx';
import IconButton from '../../ui/IconButton.jsx';
import Icon from '../../ui/Icon.jsx';

// The document workspace: rendered markdown by default, a raw editor on demand,
// and a calm metadata bar for the frontmatter (kind / status / subject / tags /
// folder). Saves write straight back to the file on the Mac.
//
// A live research report streams in here: the host rewrites the file as the
// agent works, its `updatedAt` moves, the store drops the cached body, and the
// fetch effect below re-pulls it — so an `active` doc visibly fills in. The
// header action is kind-aware: a plan gets "Build" (hand it to a fleet), a
// research/note gets "Continue" (pick it up and keep going).
//
// Chromeless: App gives this view a bare glass Window, so the header below is
// the window's header.

const INPUT =
  'glass-soft w-full rounded-xl2 px-3 py-2 text-[13px] text-ink outline-none transition-colors ' +
  'placeholder:text-ink3 focus:border-accent/60 focus:ring-1 focus:ring-accent/40';

const TONE = {
  plan: { icon: 'plan', text: 'text-accent', ring: 'border-accent/35 bg-accent/12 text-accent' },
  research: { icon: 'research', text: 'text-mgr', ring: 'border-mgr/35 bg-mgr/12 text-mgr' },
  note: { icon: 'note', text: 'text-ink2', ring: 'border-glass-line bg-white/[0.07] text-ink2' },
};
const STATUS_CHIP = {
  draft: 'border-glass-line text-ink3',
  active: 'border-accent/40 text-accent',
  done: 'border-ok/40 text-ok',
  archived: 'border-glass-line text-ink3/70',
};

const KIND_OPTIONS = [
  { value: 'plan', label: 'Plan' },
  { value: 'research', label: 'Research' },
  { value: 'note', label: 'Note' },
];
const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Working' },
  { value: 'done', label: 'Done' },
  { value: 'archived', label: 'Archived' },
];

const toTags = (s) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);

export default function DocView({ docId, startEditing = false, onClose, onLaunch }) {
  const meta = useMC((s) => s.docs.find((d) => d.id === docId) || null);
  const doc = useMC((s) => s.docDocs[docId] || null);
  const link = useMC((s) => s.link);
  const now = useMC((s) => s.now);
  const lastSnapshotAt = useMC((s) => s.lastSnapshotAt);

  const kind = meta?.kind || doc?.kind || 'note';
  const tone = TONE[kind] || TONE.note;
  const isActive = meta?.status === 'active';

  // Fetch the body when it's missing — on open, and again whenever a snapshot
  // invalidates the cached copy (the file changed on the Mac; this is how a
  // live research report keeps flowing in). Throttled so a dead host isn't
  // hammered once per snapshot.
  const lastReq = useRef(0);
  useEffect(() => {
    if (doc) return;
    void lastSnapshotAt; // re-run per snapshot until the body lands
    if (link !== 'linked') return;
    if (Date.now() - lastReq.current < 2500) return;
    lastReq.current = Date.now();
    docGet(docId);
  }, [doc, link, lastSnapshotAt, docId]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // A brand-new hand-made doc opens straight into the editor once its body lands.
  const wantEdit = useRef(startEditing);
  useEffect(() => {
    if (!wantEdit.current || !doc) return;
    wantEdit.current = false;
    setDraft(doc.content ?? '');
    setEditing(true);
  }, [doc]);

  function startEdit() {
    setDraft(doc?.content ?? '');
    setEditing(true);
  }
  function save() {
    if (!docSave(docId, draft)) return;
    setEditing(false);
  }
  function cancelEdit() {
    if (draft !== (doc?.content ?? '') && !confirm('Discard your edits?')) return;
    setEditing(false);
  }

  // Two-tap delete: a destructive action on a touch screen never fires on one tap.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(null);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  function armDelete() {
    if (!armed) {
      setArmed(true);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(armTimer.current);
    if (docDelete(docId)) onClose?.();
  }

  // ---- metadata editors -------------------------------------------------------
  // Kind & status commit on change (a select can't drift). Subject, tags and the
  // folder carry a local draft seeded once from the meta and committed on blur,
  // so the ~1 Hz snapshot never yanks the field out from under a typing thumb.
  const [subjectDraft, setSubjectDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [dirDraft, setDirDraft] = useState('');
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !meta) return;
    setSubjectDraft(meta.subject || '');
    setTagsDraft((meta.tags || []).join(', '));
    setDirDraft(meta.dir || '');
    seeded.current = true;
  }, [meta]);

  function commitSubject() {
    const v = subjectDraft.trim();
    if (v === (meta?.subject || '')) return;
    docMeta(docId, { subject: v });
  }
  function commitTags() {
    const next = toTags(tagsDraft);
    if (next.join(' ') === (meta?.tags || []).join(' ')) return;
    docMeta(docId, { tags: next });
  }
  function commitDir() {
    const v = dirDraft.trim();
    if (v === (meta?.dir || '')) return;
    docMeta(docId, { dir: v });
  }

  const title = meta?.title || doc?.title || kindLabel(kind);
  const html = useMemo(() => (doc ? renderMarkdown(doc.content) : ''), [doc]);
  const launchLabel = kind === 'plan' ? 'Build' : 'Continue';
  const launchIcon = kind === 'plan' ? 'launch' : 'bolt';
  function doLaunch() {
    if (!meta) return toast('Still loading this document');
    onLaunch?.(meta, kind === 'plan' ? 'build' : 'continue');
  }

  // Below 640 the actions move to their own row — a phone-width header cannot
  // hold a title AND three pills without crushing one of them.
  const wide = useMedia('(min-width: 640px)');
  const actions = editing ? (
    <Button variant="primary" icon="check" onClick={save} className="flex-none">
      Save
    </Button>
  ) : (
    <>
      <Button icon="edit" onClick={startEdit} disabled={!doc} className="flex-none">
        Edit
      </Button>
      <Button variant="primary" icon={launchIcon} onClick={doLaunch} disabled={!meta} className="flex-none">
        {launchLabel}
      </Button>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* own header — this window is chromeless */}
      <header className="flex-none px-4 pb-3 pt-4 sm:px-5">
        <div className="flex items-center gap-3">
          <IconButton
            icon={editing ? 'close' : 'back'}
            label={editing ? 'Cancel' : 'Close'}
            size="md"
            variant="glass"
            onClick={editing ? cancelEdit : onClose}
          />
          <span className={`grid h-9 w-9 flex-none place-items-center rounded-xl2 border ${tone.ring}`}>
            <Icon name={tone.icon} size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[16px] font-semibold leading-tight tracking-tight text-ink">{title}</h2>
            {/* One line, always: a wrapping metadata strip pushed the title
                out of a phone-width header. */}
            <div className="noscroll mt-0.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-ink3">
              <span className={`flex-none ${tone.text}`}>{kindLabel(kind)}</span>
              {meta && (
                <span
                  className={`flex-none rounded-full border px-1.5 ${STATUS_CHIP[meta.status] || STATUS_CHIP.draft}`}
                >
                  {docStatusLabel(meta.status)}
                </span>
              )}
              {meta?.folder && <span className="truncate">· {meta.folder}</span>}
              {meta && <span className="flex-none">· {ago(meta.updatedAt, now)}</span>}
              {meta?.words ? <span className="tnum flex-none">· {meta.words.toLocaleString()} words</span> : null}
            </div>
          </div>
          {wide && <div className="flex flex-none items-center gap-2">{actions}</div>}
        </div>
        {!wide && <div className="mt-3 flex items-center justify-end gap-2">{actions}</div>}
      </header>

      {/* Below 1024 this window is a full-screen sheet with the dock floating
          over it — content must clear the dock. */}
      <div className="noscroll min-h-0 flex-1 overflow-y-auto pb-24 lg:pb-0">
        <AnimatePresence mode="wait" initial={false}>
          {editing ? (
            <motion.div key="editor" {...fadeIn} className="mx-auto flex h-full max-w-[860px] flex-col px-4 pb-4 sm:px-6">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="noscroll min-h-[60vh] w-full flex-1 resize-none rounded-xl3 border border-glass-line bg-term px-4 py-4 font-mono text-[13px] leading-relaxed text-ink outline-none transition-colors focus:border-accent/60"
              />
              <p className="mt-2 font-mono text-[11px] text-ink3">
                Markdown. Saving writes the file on your Mac (~/.mission-control/library/{docId}).
              </p>
            </motion.div>
          ) : doc ? (
            <motion.div key="reader" {...fadeUp}>
              <div className="mx-auto max-w-[860px] px-5 sm:px-8">
                {isActive && (
                  <div className="mb-4 flex items-center gap-3 rounded-xl2 border border-accent/30 bg-accent/[0.08] px-3.5 py-2.5">
                    <span className="relative flex h-2 w-2 flex-none">
                      <span className="anim-ping absolute inline-flex h-full w-full rounded-full bg-accent/70" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-accent">An agent is writing this now</div>
                      <div className="mt-0.5 text-[11.5px] text-ink3">
                        The document refreshes as new text lands on your Mac
                      </div>
                    </div>
                  </div>
                )}

                {/* metadata bar: calm, muted, never competing with the document */}
                <div className="mb-6 grid grid-cols-2 gap-2.5 rounded-xl3 border border-glass-line bg-white/[0.04] p-3 sm:grid-cols-4">
                  <Field label="Kind">
                    <Select
                      options={KIND_OPTIONS}
                      value={kind}
                      onChange={(v) => docMeta(docId, { kind: v })}
                      aria-label="Kind"
                    />
                  </Field>
                  <Field label="Status">
                    <Select
                      options={STATUS_OPTIONS}
                      value={meta?.status || 'draft'}
                      onChange={(v) => docMeta(docId, { status: v })}
                      aria-label="Status"
                    />
                  </Field>
                  <Field label="Subject">
                    <input
                      value={subjectDraft}
                      onChange={(e) => setSubjectDraft(e.target.value)}
                      onBlur={commitSubject}
                      placeholder="—"
                      className={`${INPUT} h-10 py-0`}
                    />
                  </Field>
                  <Field label="Tags">
                    <input
                      value={tagsDraft}
                      onChange={(e) => setTagsDraft(e.target.value)}
                      onBlur={commitTags}
                      placeholder="comma, separated"
                      className={`${INPUT} h-10 py-0 font-mono text-[12px]`}
                    />
                  </Field>
                  <Field label="Folder" className="col-span-2 sm:col-span-4">
                    <input
                      value={dirDraft}
                      onChange={(e) => setDirDraft(e.target.value)}
                      onBlur={commitDir}
                      placeholder="~/path/to/project"
                      className={`${INPUT} h-10 py-0 font-mono text-[12px]`}
                    />
                  </Field>
                </div>
              </div>

              {/* Sanitized in md.js — docs quote arbitrary repo content. */}
              <article
                className="md mx-auto max-w-[860px] px-5 pb-10 sm:px-8"
                dangerouslySetInnerHTML={{ __html: html }}
              />

              <div className="mx-auto max-w-[860px] px-5 pb-10 sm:px-8">
                <motion.button
                  {...press}
                  onClick={armDelete}
                  className={`pill inline-flex h-10 items-center gap-2 border px-4 text-[13px] font-medium transition-colors ${
                    armed ? 'border-crit bg-crit/15 text-crit' : 'border-glass-line bg-white/[0.05] text-ink3 hover:text-ink2'
                  }`}
                >
                  <Icon name="trash" size={15} />
                  {armed ? 'Tap again to delete' : `Delete ${kindLabel(kind).toLowerCase()}`}
                </motion.button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="loading" {...fadeIn} className="flex h-full flex-col items-center justify-center gap-4 py-20">
              <span className="anim-spin h-12 w-12 rounded-full border-2 border-white/15 border-t-accent" />
              <span className="label">Loading document…</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
