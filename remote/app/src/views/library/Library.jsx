import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  useMC, docCreate, docSearch, research, launch, toast,
  kindLabel, docStatusLabel, allTags, filterDocs, allDirs,
} from '../../lib/store.js';
import { mergeModels, DEFAULT_SOLO } from '../../lib/models.js';
import { dictate, speechSupported } from '../../lib/speech.js';
import { ago } from '../../lib/md.js';
import { spring, fadeUp, press } from '../../lib/motion.js';
import Sheet from '../../ui/Sheet.jsx';
import Field from '../../ui/Field.jsx';
import Select from '../../ui/Select.jsx';
import Segmented from '../../ui/Segmented.jsx';
import Button from '../../ui/Button.jsx';
import IconButton from '../../ui/IconButton.jsx';
import Icon from '../../ui/Icon.jsx';
import EmptyState from '../../ui/EmptyState.jsx';

// The document library — one central directory of markdown files living in
// ~/.mission-control/library on the Mac, written by you OR by agents (a
// research agent streams its report straight into a file here). This view is
// the reading room: filter by kind/status/tag, search titles instantly and
// bodies over the wire, and open any doc into its own window.
//
// Kinds carry a colour the whole app speaks: plan = accent green, research =
// mgr violet, note = neutral ink. The maps below hold FULL Tailwind class
// strings (never interpolated) so the JIT actually emits them.

const OTHER = '__other';

const INPUT =
  'glass-soft w-full rounded-xl2 px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors ' +
  'placeholder:text-ink3 focus:border-accent/60 focus:ring-1 focus:ring-accent/40';

const KIND = {
  plan: { icon: 'plan', text: 'text-accent', ring: 'border-accent/35 bg-accent/12 text-accent', chip: 'border-accent/30 text-accent' },
  research: { icon: 'research', text: 'text-mgr', ring: 'border-mgr/35 bg-mgr/12 text-mgr', chip: 'border-mgr/30 text-mgr' },
  note: { icon: 'note', text: 'text-ink2', ring: 'border-glass-line bg-white/[0.07] text-ink2', chip: 'border-glass-line text-ink3' },
};
const kindOf = (k) => KIND[k] || KIND.note;

const STATUS = {
  draft: 'border-glass-line text-ink3',
  active: 'border-accent/40 text-accent',
  done: 'border-ok/40 text-ok',
  archived: 'border-glass-line text-ink3/70',
};
const statusChip = (s) => STATUS[s] || STATUS.draft;

const KIND_TABS = [
  { value: 'all', label: 'All' },
  { value: 'plan', label: 'Plans' },
  { value: 'research', label: 'Research' },
  { value: 'note', label: 'Notes' },
];
const STATUS_TABS = [
  { value: 'all', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Working' },
  { value: 'done', label: 'Done' },
  { value: 'archived', label: 'Archived' },
];

const toTags = (s) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);
const fixModel = (f) => (f === 'default' ? '' : f);

// Escape agent-authored snippet text BEFORE wrapping query matches in <mark>:
// the snippet is arbitrary repo/body content and must never reach innerHTML raw.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function highlight(snippet, query) {
  const safe = String(snippet).replace(/[&<>"']/g, (c) => ESC[c]);
  const q = (query || '').trim();
  if (!q) return safe;
  const rx = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return safe.replace(rx, '<mark>$1</mark>');
}
// Tailwind arbitrary-variant styling for the injected <mark> elements.
const MARK = '[&_mark]:rounded-[3px] [&_mark]:bg-accent/30 [&_mark]:px-0.5 [&_mark]:text-accent-bright';

// The host's `preview` is a raw slice of the markdown body. Strip the syntax
// that only means something rendered so a card reads as prose, not source.
function cleanPreview(s) {
  return String(s || '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s#{1,6}\s+/g, ' · ')
    .replace(/[`*_>]/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Project drop-down shared by the three forms: host-known folders + this
// device's launch history; "Other folder…" reveals the manual path input.

function DirPicker({ dirs, value, onChange, placeholder = '~/path/to/project' }) {
  const [other, setOther] = useState(false);
  const sel = !other && dirs.includes(value) ? value : OTHER;
  return (
    <>
      {dirs.length > 0 && (
        <Select
          value={sel}
          onChange={(v) => {
            if (v === OTHER) {
              setOther(true);
              onChange('');
            } else {
              setOther(false);
              onChange(v);
            }
          }}
          options={[...dirs.map((d) => ({ value: d, label: d })), { value: OTHER, label: 'Other folder…' }]}
          className="font-mono"
          aria-label="Project folder"
        />
      )}
      {(sel === OTHER || !dirs.length) && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${INPUT} mt-2 font-mono text-[13px]`}
        />
      )}
    </>
  );
}

// A textarea with the inset mic button — the topic/goal hero of both agent forms.
function MicArea({ value, onChange, placeholder, rows = 3 }) {
  const ref = useRef(null);
  const [on, setOn] = useState(false);
  useEffect(() => () => ref.current?.stop(), []);
  const toggle = () => {
    if (ref.current) {
      ref.current.stop();
      return;
    }
    const stop = () => {
      ref.current = null;
      setOn(false);
    };
    ref.current = dictate({ base: value, onText: onChange, onEnd: stop, onError: stop });
    setOn(!!ref.current);
  };
  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={`noscroll min-h-[92px] w-full resize-y rounded-xl3 px-4 py-3 pr-14 text-[15px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink3 ${
          on ? 'glass-soft border-crit/50 ring-1 ring-crit/30' : INPUT
        }`}
      />
      {speechSupported && (
        <motion.button
          {...press}
          onClick={toggle}
          aria-label="Dictate"
          className={`absolute right-2.5 top-2.5 grid h-9 w-9 place-items-center rounded-full border transition-colors ${
            on ? 'border-crit/60 bg-crit/15 text-crit' : 'border-glass-line bg-white/[0.08] text-ink2 hover:text-ink'
          }`}
        >
          {on && <span className="anim-ping absolute inset-0 rounded-full bg-crit/40" />}
          <Icon name="mic" size={16} className="relative" />
        </motion.button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Card({ d, now, onOpen, snippets, q }) {
  const k = kindOf(d.kind);
  return (
    <motion.button
      layout="position"
      {...press}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring.smooth}
      onClick={() => onOpen?.(d.id)}
      className="glass-soft glass-soft-hover flex flex-col gap-2 rounded-xl3 p-4 text-left transition-colors"
    >
      <div className="flex items-start gap-3">
        <span className={`relative grid h-9 w-9 flex-none place-items-center rounded-xl2 border ${k.ring}`}>
          <Icon name={k.icon} size={17} />
          {d.kind === 'research' && d.status === 'active' && (
            <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
              <span className="anim-ping absolute inline-flex h-full w-full rounded-full bg-accent/70" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-semibold leading-tight tracking-tight text-ink">
            {d.title}
          </span>
          {d.subject && <span className={`mt-0.5 block truncate text-[12px] ${k.text}`}>{d.subject}</span>}
        </span>
        <span className={`flex-none rounded-full border px-2 py-px text-[10px] font-medium ${statusChip(d.status)}`}>
          {docStatusLabel(d.status)}
        </span>
      </div>

      {snippets ? (
        <span className="flex flex-col gap-1.5">
          {snippets.slice(0, 3).map((s, i) => (
            <span
              key={i}
              className={`glass-soft line-clamp-2 rounded-lg px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-ink3 ${MARK}`}
              dangerouslySetInnerHTML={{ __html: highlight(s, q) }}
            />
          ))}
        </span>
      ) : (
        d.preview && <span className="line-clamp-2 text-[12.5px] leading-relaxed text-ink3">{cleanPreview(d.preview)}</span>
      )}

      {(d.tags || []).length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {d.tags.slice(0, 4).map((t) => (
            <span key={t} className={`rounded-full border px-2 py-px text-[11px] ${k.chip}`}>
              #{t}
            </span>
          ))}
        </span>
      )}

      <span className="tnum mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink3">
        {d.folder && (
          <span className="flex items-center gap-1">
            <Icon name="folder" size={12} />
            {d.folder}
          </span>
        )}
        <span>{ago(d.updatedAt, now)}</span>
        {d.words ? <span>{d.words.toLocaleString()} words</span> : null}
        <span className={`rounded-full border px-2 py-px ${d.session ? 'border-mgr/30 text-mgr' : 'border-glass-line text-ink3'}`}>
          {d.session ? 'agent' : 'you'}
        </span>
      </span>
    </motion.button>
  );
}

export default function Library({ onOpen, onClose }) {
  const docs = useMC((s) => s.docs);
  const snapshot = useMC((s) => s.snapshot);
  const link = useMC((s) => s.link);
  const now = useMC((s) => s.now);
  const search = useMC((s) => s.search);
  const lastDir = useMC((s) => s.lastDir);
  const hostModels = useMC((s) => s.models);
  const knownDirs = useMC((s) => s.knownDirs);
  const localDirs = useMC((s) => s.localDirs);

  const models = useMemo(() => mergeModels(hostModels), [hostModels]);
  const modelOptions = useMemo(() => models.map((m) => ({ value: m.flag, label: m.label })), [models]);
  const dirs = useMemo(() => allDirs(), [knownDirs, localDirs]);

  // Older Mac hosts predate the whole library — they ship no `docs` field at all.
  const hostTooOld = !!snapshot && !('docs' in snapshot);

  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [q, setQ] = useState('');

  const tags = useMemo(() => allTags(docs), [docs]);

  // Instant local sieve over the metadata every card already shows.
  const localDocs = useMemo(
    () => filterDocs(docs, { kind: kindFilter, status: statusFilter, tag: tagFilter, q }),
    [docs, kindFilter, statusFilter, tagFilter, q],
  );

  // Kind chip counts respect the OTHER active filters (status/tag/query) so a
  // count reads as "how many I'd see if I picked this kind", not a raw total.
  const kindTabs = useMemo(
    () =>
      KIND_TABS.map((t) => ({
        ...t,
        count: filterDocs(docs, { kind: t.value, status: statusFilter, tag: tagFilter, q }).length,
      })),
    [docs, statusFilter, tagFilter, q],
  );

  // Full-text body search over the wire, debounced. The host answers into
  // mc.search; we only trust a result whose `q` still matches what's typed, so a
  // slow reply for an old query can never clobber the current one.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2 || link !== 'linked') return undefined;
    const t = setTimeout(() => docSearch(query), 350);
    return () => clearTimeout(t);
  }, [q, link]);

  // Docs the local sieve missed but the host found deep in a body. Only shown
  // for the CURRENT query, and never duplicating a card already on screen.
  const bodyHits = useMemo(() => {
    const query = q.trim();
    if (query.length < 2 || !search || search.q !== query) return [];
    const shown = new Set(localDocs.map((d) => d.id));
    const out = [];
    for (const hit of search.hits || []) {
      if (shown.has(hit.id)) continue;
      const meta = docs.find((d) => d.id === hit.id);
      if (meta) out.push({ meta, snippets: hit.snippets || [] });
    }
    return out;
  }, [q, search, localDocs, docs]);

  // ---- new document ---------------------------------------------------------
  const [creating, setCreating] = useState(false);
  const [nTitle, setNTitle] = useState('');
  const [nKind, setNKind] = useState('note');
  const [nSubject, setNSubject] = useState('');
  const [nTags, setNTags] = useState('');
  const [nDir, setNDir] = useState('');

  function openCreate() {
    setNTitle('');
    setNKind('note');
    setNSubject('');
    setNTags('');
    setNDir(lastDir || '');
    setCreating(true);
  }
  function submitCreate() {
    const title = nTitle.trim() || `Untitled ${kindLabel(nKind).toLowerCase()}`;
    // Created on the Mac; the docCreate ack carries the id and the shell opens
    // it in the editor (a hand-made doc is empty — you type into it now).
    if (!docCreate({ title, kind: nKind, subject: nSubject.trim(), tags: toTags(nTags), dir: nDir.trim() })) return;
    setCreating(false);
  }

  // ---- research -------------------------------------------------------------
  // One agent researches a topic and writes its report straight into a new
  // library file; you read it here as it lands.
  const [researching, setResearching] = useState(false);
  const [rTopic, setRTopic] = useState('');
  const [rSubject, setRSubject] = useState('');
  const [rTags, setRTags] = useState('');
  const [rDir, setRDir] = useState('');
  const [rModel, setRModel] = useState(DEFAULT_SOLO);

  function openResearch() {
    setRDir((d) => d || lastDir || '');
    setResearching(true);
  }
  function launchResearch() {
    const topic = rTopic.trim();
    if (!topic) return toast('What should the agent research?');
    if (!research({ topic, subject: rSubject.trim(), dir: rDir.trim(), model: fixModel(rModel), tags: toTags(rTags) }))
      return;
    setResearching(false);
    setRTopic('');
    setRSubject('');
    setRTags('');
    toast('Research agent launched — its report lands here');
  }

  // ---- draft a plan with an agent -------------------------------------------
  // A read-only planning agent explores the project and presents a plan with
  // ExitPlanMode; the Mac captures that plan into the library automatically.
  const [drafting, setDrafting] = useState(false);
  const [goal, setGoal] = useState('');
  const [dDir, setDDir] = useState('');
  const [dModel, setDModel] = useState(DEFAULT_SOLO);

  function openDraft() {
    setDDir((d) => d || lastDir || '');
    setDrafting(true);
  }
  function draftMission(g) {
    return (
      'Research this project and draft a thorough implementation plan for the goal below. Do NOT write any code — you are in plan mode. ' +
      'Explore the codebase first, then produce one complete, well-structured markdown plan: a clear title as a # heading, context, a concrete step-by-step approach naming the exact files to touch, risks, and how to verify. ' +
      'Present the finished plan with ExitPlanMode — Mission Control saves it to the library automatically.\n\nGOAL: ' +
      g
    );
  }
  function launchDraft() {
    const g = goal.trim();
    if (!g) return toast('Describe what to plan first');
    if (!launch({ mission: draftMission(g), dir: dDir.trim(), managerModel: null, workerModels: [fixModel(dModel)], planMode: true }))
      return;
    setDrafting(false);
    setGoal('');
    toast('Planning agent launched — its plan lands here when ready');
  }

  const total = docs.length;

  return (
    // Container queries, not viewport ones: App can park this list in a 360px
    // column beside an open doc, where a viewport-sized `xl:grid-cols-3` would
    // shred it.
    <div className="@container flex min-h-0 flex-1 flex-col">
      {/* own header — this window is chromeless */}
      <header className="flex flex-none flex-wrap items-center gap-2 px-4 pb-3 pt-4 sm:px-5">
        <h2 className="display mr-auto flex items-baseline gap-2 text-[20px] font-semibold tracking-tight text-ink">
          Library
          {total > 0 && <span className="tnum text-[13px] font-normal text-ink3">{total}</span>}
        </h2>
        <Button size="sm" icon="research" onClick={openResearch}>
          Research
        </Button>
        {/* A display utility on the Button itself would lose to its own
            `inline-flex` base class, so the breakpoint lives on a wrapper. */}
        <span className="hidden @lg:inline-flex">
          <Button size="sm" icon="bolt" onClick={openDraft}>
            Draft plan
          </Button>
        </span>
        <Button size="sm" variant="primary" icon="plus" onClick={openCreate}>
          New
        </Button>
        {onClose && <IconButton icon="close" label="Close" size="sm" variant="glass" onClick={onClose} />}
      </header>

      {hostTooOld ? (
        <EmptyState
          icon="alert"
          title="Your Mac app is out of date"
          hint="The document library lives on your Mac. Rebuild and relaunch Mission Control there to start syncing plans, research, and notes."
        />
      ) : (
        <>
          {/* one control row: search · kind · status */}
          <div className="flex flex-none flex-wrap items-center gap-2 px-4 pb-3 sm:px-5">
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Icon
                name="search"
                size={15}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink3"
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search titles and full text…"
                className="glass-soft h-10 w-full rounded-full pl-9 pr-9 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink3 focus:border-accent/60 focus:ring-1 focus:ring-accent/40"
              />
              {q.trim() && (
                <button
                  onClick={() => setQ('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full text-ink3 transition-colors hover:bg-white/10 hover:text-ink2"
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
            <Segmented options={kindTabs} value={kindFilter} onChange={setKindFilter} />
            <Select
              options={STATUS_TABS}
              value={statusFilter}
              onChange={setStatusFilter}
              className="w-[132px]"
              aria-label="Status filter"
            />
          </div>

          {tags.length > 0 && (
            <div className="noscroll flex flex-none gap-1.5 overflow-x-auto px-4 pb-3 sm:px-5">
              {tags.map((t) => (
                <motion.button
                  key={t}
                  {...press}
                  onClick={() => setTagFilter((cur) => (cur === t ? 'all' : t))}
                  className={`pill flex-none border px-3 py-1 text-[12px] transition-colors ${
                    tagFilter === t
                      ? 'border-accent/40 bg-accent/12 text-accent'
                      : 'border-glass-line bg-white/[0.05] text-ink3 hover:text-ink2'
                  }`}
                >
                  #{t}
                </motion.button>
              ))}
            </div>
          )}

          {/* Below 1024 the window is a full-screen sheet with the dock
              floating over it — the last card must clear the dock. */}
          <div className="noscroll min-h-0 flex-1 overflow-y-auto px-4 pb-28 sm:px-5 lg:pb-8">
            {!total ? (
              <EmptyState
                icon="library"
                title="Your library is empty"
                hint="A folder of markdown files (~/.mission-control/library) on your Mac — written by you or by agents, readable from anywhere. Send an agent to research a topic, draft a plan, or start a note by hand."
                action={
                  <Button variant="primary" icon="research" onClick={openResearch}>
                    Research something
                  </Button>
                }
              />
            ) : !localDocs.length && !bodyHits.length ? (
              <EmptyState icon="search" title="Nothing matches" hint="Try a different kind, status, tag, or search term." />
            ) : (
              <>
                {localDocs.length > 0 && (
                  <motion.div
                    layout
                    className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3"
                  >
                    <AnimatePresence initial={false} mode="popLayout">
                      {localDocs.map((d) => (
                        <Card key={d.id} d={d} now={now} onOpen={onOpen} />
                      ))}
                    </AnimatePresence>
                  </motion.div>
                )}

                {bodyHits.length > 0 && (
                  <>
                    <div className="mb-3 mt-6 flex items-baseline gap-2">
                      <h3 className="text-[12.5px] font-semibold text-ink2">Found in body</h3>
                      <span className="tnum text-[12.5px] text-ink3">{bodyHits.length}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
                      {bodyHits.map((h) => (
                        <Card key={h.meta.id} d={h.meta} now={now} onOpen={onOpen} snippets={h.snippets} q={q} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* ---- new document ---------------------------------------------------- */}
      <Sheet
        open={creating}
        onClose={() => setCreating(false)}
        title="New document"
        size="sm"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="plus" onClick={submitCreate}>
              Create
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 pt-1">
          <Field label="Title">
            <input
              value={nTitle}
              onChange={(e) => setNTitle(e.target.value)}
              placeholder={`Untitled ${kindLabel(nKind).toLowerCase()}`}
              className={INPUT}
            />
          </Field>
          <div>
            <span className="label mb-1.5 block">Kind</span>
            <Segmented
              value={nKind}
              onChange={setNKind}
              options={[
                { value: 'plan', label: 'Plan', icon: 'plan' },
                { value: 'research', label: 'Research', icon: 'research' },
                { value: 'note', label: 'Note', icon: 'note' },
              ]}
            />
            <p className="mt-2 text-[12px] leading-snug text-ink3">
              {nKind === 'plan'
                ? 'A build plan you can hand to a fleet.'
                : nKind === 'research'
                  ? 'A research file — or send an agent to write one for you.'
                  : 'A free-form note to keep.'}
            </p>
          </div>
          <Field label="Subject">
            <input
              value={nSubject}
              onChange={(e) => setNSubject(e.target.value)}
              placeholder="Company, project, person (optional)"
              className={INPUT}
            />
          </Field>
          <Field label="Tags">
            <input
              value={nTags}
              onChange={(e) => setNTags(e.target.value)}
              placeholder="comma, separated (optional)"
              className={INPUT}
            />
          </Field>
          <Field label="Project">
            <DirPicker dirs={dirs} value={nDir} onChange={setNDir} placeholder="~/path/to/project (optional)" />
          </Field>
        </div>
      </Sheet>

      {/* ---- research -------------------------------------------------------- */}
      <Sheet
        open={researching}
        onClose={() => setResearching(false)}
        title="Research with an agent"
        size="md"
        footer={
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-ink3">
              One agent researches and writes its report straight into the library.
            </p>
            <Button variant="primary" icon="research" onClick={launchResearch} className="flex-none">
              Research
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 pt-1">
          <MicArea value={rTopic} onChange={setRTopic} placeholder="What should the agent research?" />
          <Field label="Subject">
            <input
              value={rSubject}
              onChange={(e) => setRSubject(e.target.value)}
              placeholder="Subject / company (optional)"
              className={INPUT}
            />
          </Field>
          <Field label="Tags">
            <input
              value={rTags}
              onChange={(e) => setRTags(e.target.value)}
              placeholder="comma, separated (optional)"
              className={INPUT}
            />
          </Field>
          <Field label="Project">
            <DirPicker dirs={dirs} value={rDir} onChange={setRDir} placeholder="~/path/to/project (optional)" />
          </Field>
          <Field label="Model">
            <Select options={modelOptions} value={rModel} onChange={setRModel} aria-label="Research model" />
          </Field>
        </div>
      </Sheet>

      {/* ---- draft a plan with an agent -------------------------------------- */}
      <Sheet
        open={drafting}
        onClose={() => setDrafting(false)}
        title="Draft a plan with an agent"
        size="md"
        footer={
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-ink3">
              Read-only plan mode — nothing gets built until you say so.
            </p>
            <Button variant="primary" icon="bolt" onClick={launchDraft} className="flex-none">
              Draft
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 pt-1">
          <MicArea value={goal} onChange={setGoal} placeholder="What should the plan achieve?" />
          <Field label="Project">
            <DirPicker dirs={dirs} value={dDir} onChange={setDDir} />
          </Field>
          <Field label="Model">
            <Select options={modelOptions} value={dModel} onChange={setDModel} aria-label="Planning model" />
          </Field>
        </div>
      </Sheet>
    </div>
  );
}
