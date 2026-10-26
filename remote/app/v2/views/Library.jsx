import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMC, docSearch, docStatusLabel, allTags, filterDocs } from '../../src/lib/store.js';
import { useHQ, useHQSync } from '../../src/lib/hq.js';
import { openSheet } from '../lib/nav.js';
import { zoomTo } from '../lib/zoom.js';
import { spring, tap } from '../lib/motion.js';
import { useWide, useSize } from '../ui/hooks.js';
import { Chip, Empty, Icon, IconBtn, SearchField, Segmented, Select } from '../ui/kit.jsx';
import Page from '../shell/Page.jsx';

// The Library: every plan, report, note and page on the Mac, newest first.
// Filter by kind, status, company and tag; titles filter as you type and the
// Mac searches full text when you pause. The list is virtualised — a
// thousand documents scroll like ten. A document grows out of its row.

const KIND = {
  plan: { icon: 'plan', tone: 'bg-accent/15 text-accent' },
  research: { icon: 'research', tone: 'bg-mgr/15 text-mgr' },
  note: { icon: 'note', tone: 'bg-fill2 text-ink2' },
  page: { icon: 'page', tone: 'bg-s4/15 text-s4' },
};
const kindOf = (k) => KIND[k] || KIND.note;
const STATUS_DOT = { draft: 'bg-ink3', active: 'bg-accent', done: 'bg-ok', archived: 'bg-ink3/50' };
const KIND_TABS = [
  { value: 'all', label: 'All' },
  { value: 'plan', label: 'Plans' },
  { value: 'research', label: 'Research' },
  { value: 'note', label: 'Notes' },
  { value: 'page', label: 'Pages' },
];
const STATUS_OPTS = [
  { value: 'all', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Working' },
  { value: 'done', label: 'Done' },
  { value: 'archived', label: 'Archived' },
];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function mark(snippet, q) {
  const safe = String(snippet).replace(/[&<>"']/g, (c) => ESC[c]);
  const s = (q || '').trim();
  if (!s) return safe;
  return safe.replace(new RegExp('(' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
}
// "2m ago" — md.js has the same, but importing it here would pull the whole
// markdown renderer into the Library's chunk.
function ago(t, now = Date.now()) {
  if (!t) return '';
  const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const cleanPreview = (s) => String(s || '').replace(/^#{1,6}\s+/, '').replace(/\s#{1,6}\s+/g, ' · ').replace(/[`*_>]/g, '').trim();

const DocRow = memo(function DocRow({ d, now, snippets, q, company }) {
  const k = kindOf(d.kind);
  const live = d.kind === 'research' && d.status === 'active';
  return (
    <motion.button
      whileTap={{ scale: 0.985 }}
      onClick={zoomTo('doc', { id: d.id })}
      data-zoom={`doc:${d.id}`}
      data-doc={d.id}
      className="flex w-full items-start gap-3.5 rounded-[20px] px-3 py-3.5 text-left hover:bg-fill"
    >
      <span className={`relative grid h-11 w-11 flex-none place-items-center rounded-[13px] ${k.tone}`}>
        <Icon name={k.icon} size={19} />
        {live && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
            <span className="anim-ping absolute inline-flex h-full w-full rounded-full bg-accent/70" />
            <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-page bg-accent" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[1rem] font-semibold tracking-[-0.01em] text-ink">{d.title || d.id}</span>
        {snippets ? (
          <span
            className="mt-0.5 line-clamp-2 text-[0.84rem] leading-snug text-ink3 [&_mark]:rounded-[3px] [&_mark]:bg-accent/25 [&_mark]:px-0.5 [&_mark]:text-ink"
            dangerouslySetInnerHTML={{ __html: mark(snippets[0] || '', q) }}
          />
        ) : (
          <span className="mt-0.5 line-clamp-2 text-[0.84rem] leading-snug text-ink3">{d.subject ? `${d.subject} — ` : ''}{cleanPreview(d.preview)}</span>
        )}
        <span className="v-num mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.72rem] font-medium text-ink3">
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[d.status] || STATUS_DOT.draft}`} />
            {docStatusLabel(d.status)}
          </span>
          <span>{ago(d.updatedAt, now)}</span>
          {company && <span>{company}</span>}
          {d.words ? <span>{d.words.toLocaleString()} words</span> : null}
          {(d.tags || []).slice(0, 3).map((t) => (
            <span key={t}>#{t}</span>
          ))}
          <span>{d.session ? 'by an agent' : 'by you'}</span>
        </span>
      </span>
    </motion.button>
  );
});

function NewMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  const item = (icon, label, hint, sheet) => (
    <motion.button
      {...tap}
      key={sheet}
      onClick={() => {
        setOpen(false);
        openSheet(sheet);
      }}
      data-new={sheet}
      className="flex items-center gap-3 rounded-[12px] px-3 py-2.5 text-left hover:bg-fill"
    >
      <span className="grid h-9 w-9 flex-none place-items-center rounded-[10px] bg-fill text-ink2">
        <Icon name={icon} size={17} />
      </span>
      <span className="min-w-0">
        <span className="block text-[0.9rem] font-semibold text-ink">{label}</span>
        <span className="block text-[0.74rem] text-ink3">{hint}</span>
      </span>
    </motion.button>
  );
  return (
    <div ref={box} className="relative">
      <IconBtn icon="plus" label="New" tone="primary" onClick={() => setOpen((v) => !v)} data-library-new />
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={spring.snappy}
            style={{ transformOrigin: 'top right' }}
            className="v-card v-menu absolute right-0 top-12 z-40 flex w-[260px] flex-col p-1.5" data-no-lens
          >
            {item('note', 'New document', 'A note or plan you write', 'newdoc')}
            {item('research', 'Research', 'An agent writes a report', 'research')}
            {item('bolt', 'Draft a plan', 'An agent plans, read-only', 'draft')}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Library() {
  const docs = useMC((s) => s.docs);
  const snapshot = useMC((s) => s.snapshot);
  const link = useMC((s) => s.link);
  const now = useMC((s) => s.now);
  const search = useMC((s) => s.search);
  const wide = useWide(700);
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const [tag, setTag] = useState('all');
  const [co, setCo] = useState('all');
  const [q, setQ] = useState('');
  const tags = useMemo(() => allTags(docs), [docs]);
  const hostTooOld = !!snapshot && !('docs' in snapshot);

  useHQSync();
  const hqState = useHQ((s) => s.resp?.state);
  const filing = useMemo(() => {
    const idx = Array.isArray(hqState?.docs) ? hqState.docs : null;
    if (!idx) return null;
    const of = new Map(idx.map((d) => [String(d.id).replace(/\.md$/, ''), d.company || '']));
    const names = Object.fromEntries((hqState.registry?.companies || []).map((c) => [c.id, c.name]));
    return { of: (id) => of.get(String(id).replace(/\.md$/, '')) ?? '', names, order: (hqState.registry?.companies || []).map((c) => c.id) };
  }, [hqState]);
  const coTabs = useMemo(() => {
    if (!filing) return [];
    const n = {};
    for (const d of docs) {
      const c = filing.of(d.id);
      n[c] = (n[c] || 0) + 1;
    }
    return [...filing.order.filter((c) => n[c]).map((c) => ({ value: c, label: filing.names[c] || c, count: n[c] })), ...(n[''] ? [{ value: '', label: 'Not filed', count: n[''] }] : [])];
  }, [filing, docs]);

  const sorted = useMemo(() => [...docs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)), [docs]);
  const local = useMemo(() => {
    const out = filterDocs(sorted, { kind, status, tag, q });
    return filing && co !== 'all' ? out.filter((d) => filing.of(d.id) === co) : out;
  }, [sorted, kind, status, tag, q, filing, co]);
  const kindTabs = useMemo(
    () => KIND_TABS.filter((t) => t.value !== 'page' || docs.some((d) => d.kind === 'page')).map((t) => ({ ...t, count: t.value === 'all' ? null : filterDocs(docs, { kind: t.value, status, tag, q }).length || null })),
    [docs, status, tag, q],
  );

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2 || link !== 'linked') return undefined;
    const t = setTimeout(() => docSearch(query), 350);
    return () => clearTimeout(t);
  }, [q, link]);
  const bodyHits = useMemo(() => {
    const query = q.trim();
    if (query.length < 2 || !search || search.q !== query) return [];
    const shown = new Set(local.map((d) => d.id));
    return (search.hits || []).filter((h) => !shown.has(h.id)).map((h) => ({ d: docs.find((x) => x.id === h.id), snippets: h.snippets || [] })).filter((x) => x.d);
  }, [q, search, local, docs]);

  const rows = useMemo(() => {
    const r = local.map((d) => ({ key: d.id, d }));
    if (bodyHits.length) {
      r.push({ key: '__body', header: `In the text of ${bodyHits.length} more` });
      for (const h of bodyHits) r.push({ key: `b:${h.d.id}`, d: h.d, snippets: h.snippets });
    }
    return r;
  }, [local, bodyHits]);

  // Virtualised against the page's own scroller.
  const scroller = useRef(null);
  const listBox = useRef(null);
  const [offset, setOffset] = useState(0);
  const { w } = useSize(listBox);
  useEffect(() => {
    if (listBox.current && scroller.current) setOffset(listBox.current.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top + scroller.current.scrollTop);
  }, [w, tags.length, coTabs.length, wide]);
  const cols = w >= 1000 ? 2 : 1;
  const lines = useMemo(() => {
    if (cols === 1) return rows.map((r) => [r]);
    const out = [];
    let cur = [];
    for (const r of rows) {
      if (r.header) {
        if (cur.length) out.push(cur);
        out.push([r]);
        cur = [];
        continue;
      }
      cur.push(r);
      if (cur.length === cols) {
        out.push(cur);
        cur = [];
      }
    }
    if (cur.length) out.push(cur);
    return out;
  }, [rows, cols]);
  const v = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 104,
    overscan: 6,
    scrollMargin: offset,
    getItemKey: (i) => lines[i].map((r) => r.key).join('|'),
  });

  const companyName = (id) => (filing ? filing.names[filing.of(id)] || '' : '');

  return (
    <Page
      ref={scroller}
      title="Library"
      subtitle={docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : null}
      actions={<NewMenu />}
      toolbar={
        !hostTooOld && (
          <div className="flex flex-col gap-3">
            <SearchField value={q} onChange={setQ} placeholder="Search titles and full text" />
            <div className="flex items-center gap-2">
              <div className="v-scroll-x min-w-0 flex-1">
                <Segmented value={kind} onChange={setKind} options={kindTabs} size={wide ? 'md' : 'sm'} />
              </div>
              <Select label="Status" value={status} onChange={setStatus} options={STATUS_OPTS} className="!h-9 w-[124px] flex-none" />
            </div>
            {coTabs.length > 0 && (
              <div className="v-scroll-x -mx-4 flex gap-1.5 px-4 sm:mx-0 sm:px-0" data-company-filter>
                {[{ value: 'all', label: 'All companies', count: docs.length }, ...coTabs].map((t) => (
                  <Chip key={t.value || 'unfiled'} on={co === t.value} onClick={() => setCo((cur) => (cur === t.value && t.value !== 'all' ? 'all' : t.value))} data-co={t.value || 'unfiled'}>
                    {t.label}
                    <span className="v-num text-[0.7rem] opacity-60">{t.count}</span>
                  </Chip>
                ))}
              </div>
            )}
            {tags.length > 0 && (
              <div className="v-scroll-x -mx-4 flex gap-1.5 px-4 sm:mx-0 sm:px-0">
                {tags.map((t) => (
                  <Chip key={t} on={tag === t} onClick={() => setTag((cur) => (cur === t ? 'all' : t))}>
                    #{t}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        )
      }
    >
      {hostTooOld ? (
        <Empty icon="alert" title="Your Mac app is out of date" hint="The Library lives on your Mac. Update Mission Control there to sync plans, research and notes." />
      ) : !docs.length ? (
        <Empty icon="library" title="Your Library is empty" hint="Plans, research and notes on your Mac — written by you or by agents, readable anywhere. Start one with +." />
      ) : !rows.length ? (
        <Empty icon="search" title="Nothing matches" hint="Try another word, or clear a filter." />
      ) : (
        <div ref={listBox} className="relative -mx-3" style={{ height: v.getTotalSize() }} data-library-list>
          {v.getVirtualItems().map((it) => {
            const line = lines[it.index];
            return (
              <div
                key={it.key}
                data-index={it.index}
                ref={v.measureElement}
                className={`absolute left-0 top-0 w-full ${cols > 1 && !line[0].header ? 'grid grid-cols-2 gap-x-2' : ''}`}
                style={{ transform: `translateY(${it.start - v.options.scrollMargin}px)` }}
              >
                {line.map((r) =>
                  r.header ? (
                    <div key={r.key} className="v-eyebrow px-3 pb-1 pt-5">{r.header}</div>
                  ) : (
                    <DocRow key={r.key} d={r.d} now={now} snippets={r.snippets} q={q} company={companyName(r.d.id)} />
                  ),
                )}
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
