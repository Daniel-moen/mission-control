import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'motion/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMC, docSearch, docMeta, filterDocs, toast } from '../src/lib/store.js';
import { attachToMia } from '../src/lib/attach.js';
import { useHQ, useHQSync } from '../src/lib/hq.js';
import { openSheet, setTab } from '../v2/lib/nav.js';
import { zoomTo } from '../v2/lib/zoom.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring, tap } from '../v2/lib/motion.js';
import { useWide, useSize } from '../v2/ui/hooks.js';
import { Empty, IconBtn, SearchField } from '../v2/ui/kit.jsx';
import Sheet from '../v2/ui/Sheet.jsx';
import Page from '../v2/shell/Page.jsx';
import { haptic, Icon } from './ux.jsx';

// The Library, v5.1 (task 0486). Daniel: "I saw a thousand different tags —
// I don't need to search by tags, I can just search the report. Put those
// tags under a menu." So, as Apple would (Notes, Files, Mail):
//   • one search field — titles as you type, the Mac's full-text search when
//     you pause — is the tool;
//   • kind, status, company and tags live in ONE Filter menu (a glass
//     pull-down on an iPad, a sheet on a phone), out of sight until wanted;
//     what's active shows as small tokens you can clear;
//   • rows say only what helps you pick a document: what it is, its title,
//     when, the first line, the company — and "Writing…" while an agent is;
//   • newest first, in date sections (Today, Yesterday, Previous 7 Days…);
//   • swipe a row left for Ask Mia and Archive; long-press for everything;
//   • filters are remembered on this device, the search for the session.
// The list is still virtualised: a thousand documents scroll like ten.

const KIND = {
  plan: { icon: 'plan', tone: 'bg-accent/15 text-accent', label: 'Plans' },
  research: { icon: 'research', tone: 'bg-mgr/15 text-mgr', label: 'Research' },
  note: { icon: 'note', tone: 'bg-fill2 text-ink2', label: 'Notes' },
  page: { icon: 'page', tone: 'bg-s4/15 text-s4', label: 'Pages' },
};
const kindOf = (k) => KIND[k] || KIND.note;
const STATUS = [
  { value: 'all', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Being written' },
  { value: 'done', label: 'Done' },
  { value: 'archived', label: 'Archived' },
];
const SORTS = [
  { value: 'recent', label: 'Date edited' },
  { value: 'title', label: 'Title' },
];
const NONE = {
  kind: 'all',
  status: 'all',
  co: 'all',
  tag: 'all',
  sort: 'recent',
};
const LS = 'mc.v5.library';
const SS = 'mc.v5.library.q';

const load = (store, k, d) => {
  try {
    return { ...d, ...(JSON.parse(store.getItem(k)) || {}) };
  } catch {
    return d;
  }
};
const save = (store, k, v) => {
  try {
    store.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

const ESC = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function mark(snippet, q) {
  const safe = String(snippet).replace(/[&<>"']/g, (c) => ESC[c]);
  const s = (q || '').trim();
  if (!s) return safe;
  return safe.replace(new RegExp('(' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
}
const msOf = (t) => (!t ? 0 : typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t) || 0);
const dayStart = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
// Notes' date column: a time today, "Yesterday", a weekday this week, else a date.
function when(t, now) {
  const ms = msOf(t);
  if (!ms) return '';
  const today = dayStart(now);
  if (ms >= today)
    return new Date(ms).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  if (ms >= today - 864e5) return 'Yesterday';
  if (ms >= today - 6 * 864e5) return new Date(ms).toLocaleDateString([], { weekday: 'long' });
  return new Date(ms).toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric',
  });
}
function section(t, now) {
  const ms = msOf(t);
  const today = dayStart(now);
  if (ms >= today) return 'Today';
  if (ms >= today - 864e5) return 'Yesterday';
  if (ms >= today - 7 * 864e5) return 'Previous 7 Days';
  if (ms >= today - 30 * 864e5) return 'Previous 30 Days';
  return new Date(ms || now).toLocaleDateString([], {
    month: 'long',
    year: 'numeric',
  });
}
const firstLine = (s) =>
  String(s || '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s#{1,6}\s+/g, ' · ')
    .replace(/[`*_>]/g, '')
    .trim();

// ---- a row, and its swipe actions ---------------------------------------------------
let closeOpenRow = null; // one row open at a time, as in Mail

function SwipeRow({ id, archived, title, children }) {
  const x = useMotionValue(0);
  const reveal = useTransform(x, (v) => Math.max(0, -v));
  const dragged = useRef(false);
  const box = useRef(null);
  const reduce = usePrefs((s) => s.reduce);
  const OPEN = -152;
  const close = () => animate(x, 0, spring.snappy);
  useEffect(() => () => closeOpenRow === close && (closeOpenRow = null));
  const act = (what) => {
    close();
    if (what === 'archive') {
      docMeta(id, { status: archived ? 'done' : 'archived' });
      toast(archived ? 'Moved back to the Library' : 'Archived');
    } else {
      attachToMia({ kind: 'doc', id, title });
      setTab('mia');
    }
  };
  return (
    <div ref={box} className="relative overflow-hidden rounded-[18px]" data-swipe-row={id}>
      <motion.div className="absolute inset-y-0 right-0 flex overflow-hidden rounded-r-[18px]" style={{ width: reveal }} aria-hidden={x.get() === 0}>
        <button
          onClick={() => act('mia')}
          className="v5-swipe-act flex min-w-0 flex-1 flex-col items-center justify-center gap-1 overflow-hidden whitespace-nowrap bg-mgr text-[0.72rem] font-semibold"
          data-swipe-action="mia"
        >
          <Icon name="mia" size={18} />
          Ask Mia
        </button>
        <button
          onClick={() => act('archive')}
          className="v5-swipe-act flex min-w-0 flex-1 flex-col items-center justify-center gap-1 overflow-hidden whitespace-nowrap bg-warn text-[0.72rem] font-semibold"
          data-swipe-action="archive"
        >
          <Icon name={archived ? 'unarchive' : 'archive'} size={18} />
          {archived ? 'Unarchive' : 'Archive'}
        </button>
      </motion.div>
      <motion.div
        drag={reduce ? false : 'x'}
        dragDirectionLock
        dragConstraints={{ left: -400, right: 0 }}
        dragElastic={{ left: 0.12, right: 0.04 }}
        dragMomentum={false}
        style={{ x, touchAction: 'pan-y' }}
        onDragStart={() => {
          dragged.current = true;
          if (closeOpenRow && closeOpenRow !== close) closeOpenRow();
        }}
        onDragEnd={(_, info) => {
          const w = box.current?.offsetWidth || 360;
          const v = x.get();
          // a long, fast swipe archives straight away (Mail's full swipe)
          if (v < -w * 0.62 || (info.velocity.x < -1400 && v < -80)) {
            haptic(box.current, 'heavy');
            animate(x, -w, { duration: 0.18 }).then(() => act('archive'));
          } else if (v < OPEN / 2 || info.velocity.x < -500) {
            animate(x, OPEN, spring.snappy);
            closeOpenRow = close;
          } else close();
          setTimeout(() => (dragged.current = false), 0);
        }}
        onClickCapture={(e) => {
          // a tap on an open row closes it; a drag isn't a tap
          if (dragged.current || x.get() < -4) {
            e.preventDefault();
            e.stopPropagation();
            if (!dragged.current) close();
          }
        }}
        className="relative"
      >
        {children}
      </motion.div>
    </div>
  );
}

const DocRow = memo(function DocRow({ d, now, snippets, q, company }) {
  const k = kindOf(d.kind);
  const writing = d.status === 'active';
  const line = snippets ? null : [d.subject, firstLine(d.preview)].filter(Boolean).join(' — ');
  return (
    <motion.button
      whileTap={{ scale: 0.985 }}
      onClick={zoomTo('doc', { id: d.id })}
      data-zoom={`doc:${d.id}`}
      data-doc={d.id}
      className="flex w-full items-center gap-3.5 rounded-[18px] px-3 py-3 text-left hover:bg-fill"
    >
      <span className={`relative grid h-10 w-10 flex-none place-items-center rounded-[12px] ${k.tone}`} title={k.label}>
        <Icon name={k.icon} size={18} />
        {writing && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
            <span className="anim-ping absolute inline-flex h-full w-full rounded-full bg-accent/70" />
            <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-page bg-accent" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[1rem] font-semibold tracking-[-0.01em] text-ink">{d.title || d.id}</span>
        <span className="mt-0.5 flex min-w-0 items-baseline gap-2 text-[0.84rem] leading-snug">
          <span className="v-num flex-none font-medium text-ink2">{writing ? <span className="text-accent">Writing…</span> : when(d.updatedAt, now)}</span>
          {snippets ? (
            <span
              className="min-w-0 truncate text-ink3 [&_mark]:rounded-[3px] [&_mark]:bg-accent/25 [&_mark]:px-0.5 [&_mark]:text-ink"
              dangerouslySetInnerHTML={{ __html: mark(snippets[0] || '', q) }}
            />
          ) : (
            <span className="min-w-0 truncate text-ink3">{line}</span>
          )}
        </span>
        {company && (
          <span className="mt-1 flex items-center gap-1.5 text-[0.74rem] font-medium text-ink3" data-row-company>
            <Icon name="hq" size={12} />
            {company}
          </span>
        )}
      </span>
    </motion.button>
  );
});

// ---- New ------------------------------------------------------------------------------
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
      <IconBtn icon="plus" label="New — ⌘N" tone="primary" onClick={() => setOpen((v) => !v)} data-library-new />
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={spring.snappy}
            style={{ transformOrigin: 'top right' }}
            className="v-card v-menu absolute right-0 top-12 z-40 flex w-[260px] flex-col p-1.5"
            data-no-lens
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

// ---- the Filter menu ------------------------------------------------------------------
function Choice({ on, label, count, onClick, ...rest }) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      role="menuitemradio"
      aria-checked={on}
      className="flex h-11 w-full items-center gap-3 rounded-[12px] px-3 text-left text-[0.94rem] text-ink hover:bg-fill"
      {...rest}
    >
      <span className="grid w-4 flex-none place-items-center text-accent">{on && <Icon name="check" size={16} strokeWidth={2.6} />}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && <span className="v-num flex-none text-[0.82rem] text-ink3">{count}</span>}
    </motion.button>
  );
}
function Section({ title, children, more }) {
  return (
    <section className="py-1" data-filter-section={title}>
      <div className="flex items-center px-3 pb-1 pt-2.5">
        <span className="text-[0.74rem] font-semibold uppercase tracking-[0.05em] text-ink3">{title}</span>
        {more}
      </div>
      {children}
    </section>
  );
}

function FilterFooter({ f, set, onDone, active, shown, sticky = false }) {
  return (
    <div className={`flex items-center gap-2 ${sticky ? 'v5-filter-foot sticky bottom-0 -mx-1.5 -mb-1.5 mt-1 px-2.5 py-2' : 'w-full'}`}>
      <span className="v-num flex-1 px-1 text-[0.8rem] text-ink3">{shown} shown</span>
      {active > 0 && (
        <motion.button {...tap} onClick={() => set({ ...NONE, sort: f.sort })} className="h-10 rounded-full px-4 text-[0.88rem] font-semibold text-ink2 hover:bg-fill" data-filter-reset>
          Reset
        </motion.button>
      )}
      <motion.button {...tap} onClick={onDone} className="h-10 rounded-full bg-ink px-5 text-[0.88rem] font-semibold text-page" data-filter-done>
        Done
      </motion.button>
    </div>
  );
}

function FilterBody({ f, set, kinds, statuses, companies, tags, onDone, active, shown, inlineFooter = true }) {
  const [allTags, setAllTags] = useState(false);
  const [tq, setTq] = useState('');
  const pick = (k, v) => {
    haptic(null);
    set({ ...f, [k]: f[k] === v && v !== 'all' && k !== 'sort' ? 'all' : v });
  };
  const tagList = tags.filter((t) => !tq || t.tag.toLowerCase().includes(tq.toLowerCase()));
  const visibleTags = allTags || tq ? tagList : tagList.slice(0, 6);
  return (
    <div className="flex flex-col" role="menu" aria-label="Filter the Library" data-filter-menu>
      <Section title="Show">
        <Choice on={f.kind === 'all'} label="All documents" onClick={() => pick('kind', 'all')} data-filter="kind" data-value="all" />
        {kinds.map((o) => (
          <Choice key={o.value} on={f.kind === o.value} label={o.label} count={o.count} onClick={() => pick('kind', o.value)} data-filter="kind" data-value={o.value} />
        ))}
      </Section>
      <Section title="Status">
        {statuses.map((o) => (
          <Choice key={o.value} on={f.status === o.value} label={o.label} count={o.count} onClick={() => pick('status', o.value)} data-filter="status" data-value={o.value} />
        ))}
      </Section>
      {companies.length > 0 && (
        <Section title="Company">
          <Choice on={f.co === 'all'} label="All companies" onClick={() => pick('co', 'all')} data-filter="co" data-value="all" />
          {companies.map((o) => (
            <Choice key={o.value || 'unfiled'} on={f.co === o.value} label={o.label} count={o.count} onClick={() => pick('co', o.value)} data-filter="co" data-value={o.value || 'unfiled'} />
          ))}
        </Section>
      )}
      {tags.length > 0 && (
        <Section title={`Tags · ${tags.length}`}>
          {tags.length > 10 && (
            <div className="px-2 pb-1">
              <SearchField value={tq} onChange={setTq} placeholder="Find a tag" data-tag-search />
            </div>
          )}
          <Choice on={f.tag === 'all'} label="Any tag" onClick={() => pick('tag', 'all')} data-filter="tag" data-value="all" />
          {visibleTags.map((o) => (
            <Choice key={o.tag} on={f.tag === o.tag} label={`#${o.tag}`} count={o.count} onClick={() => pick('tag', o.tag)} data-filter="tag" data-value={o.tag} />
          ))}
          {!tq && tagList.length > 6 && (
            <button onClick={() => setAllTags((v) => !v)} className="h-10 w-full px-3 pl-10 text-left text-[0.88rem] font-semibold text-accent" data-all-tags>
              {allTags ? 'Show fewer' : `Show all ${tagList.length} tags`}
            </button>
          )}
        </Section>
      )}
      <Section title="Sort by">
        {SORTS.map((o) => (
          <Choice key={o.value} on={f.sort === o.value} label={o.label} onClick={() => pick('sort', o.value)} data-filter="sort" data-value={o.value} />
        ))}
      </Section>
      {inlineFooter && <FilterFooter f={f} set={set} onDone={onDone} active={active} shown={shown} sticky />}
    </div>
  );
}

function FilterMenu({ open, setOpen, wide, ...body }) {
  const box = useRef(null);
  useEffect(() => {
    if (!open || !wide) return undefined;
    const off = (e) => box.current && !box.current.contains(e.target) && !e.target.closest?.('[data-filter-button]') && setOpen(false);
    const esc = (e) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false));
    document.addEventListener('pointerdown', off);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', off);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open, wide, setOpen]);
  if (!wide)
    return (
      <Sheet open={open} onClose={() => setOpen(false)} title="Filter" size="sm" label="Filter the Library" footer={<FilterFooter {...body} onDone={() => setOpen(false)} />}>
        <FilterBody {...body} inlineFooter={false} onDone={() => setOpen(false)} />
      </Sheet>
    );
  // iPad: a glass pull-down under the button
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={box}
          initial={{ opacity: 0, scale: 0.92, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={spring.sheet}
          style={{
            transformOrigin: 'top right',
            maxHeight: 'min(70vh, 640px)',
          }}
          className="v-menu v5-menu v-scroll absolute right-0 top-12 z-40 w-[300px] overflow-y-auto p-1.5"
          data-no-lens
        >
          <FilterBody {...body} onDone={() => setOpen(false)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---- the page --------------------------------------------------------------------------
export default function Library() {
  const docs = useMC((s) => s.docs);
  const snapshot = useMC((s) => s.snapshot);
  const link = useMC((s) => s.link);
  const now = useMC((s) => s.now) || Date.now();
  const search = useMC((s) => s.search);
  const wide = useWide(700);
  const [f, setF] = useState(() => load(localStorage, LS, NONE));
  const [q, setQ] = useState(() => load(sessionStorage, SS, { q: '' }).q || '');
  const [menu, setMenu] = useState(false);
  const hostTooOld = !!snapshot && !('docs' in snapshot);
  useEffect(() => save(localStorage, LS, f), [f]);
  useEffect(() => save(sessionStorage, SS, { q }), [q]);

  useHQSync();
  const hqState = useHQ((s) => s.resp?.state);
  const filing = useMemo(() => {
    const idx = Array.isArray(hqState?.docs) ? hqState.docs : null;
    if (!idx) return null;
    const of = new Map(idx.map((d) => [String(d.id).replace(/\.md$/, ''), d.company || '']));
    const names = Object.fromEntries((hqState.registry?.companies || []).map((c) => [c.id, c.name]));
    return {
      of: (id) => of.get(String(id).replace(/\.md$/, '')) ?? '',
      names,
      order: (hqState.registry?.companies || []).map((c) => c.id),
    };
  }, [hqState]);

  // Archived documents stay out of the way unless you ask for them (Mail's Archive).
  const base = useMemo(() => (f.status === 'archived' ? docs : docs.filter((d) => d.status !== 'archived')), [docs, f.status]);
  const sorted = useMemo(
    () => [...base].sort(f.sort === 'title' ? (a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)) : (a, b) => msOf(b.updatedAt) - msOf(a.updatedAt)),
    [base, f.sort],
  );
  const coOf = (d) => (filing ? filing.of(d.id) : '');
  const local = useMemo(() => {
    const out = filterDocs(sorted, {
      kind: f.kind,
      status: f.status,
      tag: f.tag,
      q,
    });
    return filing && f.co !== 'all' ? out.filter((d) => filing.of(d.id) === (f.co === 'unfiled' ? '' : f.co)) : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, f, q, filing]);

  // what the menu offers, with counts
  const kinds = useMemo(() => {
    const n = {};
    for (const d of base) n[d.kind || 'note'] = (n[d.kind || 'note'] || 0) + 1;
    return Object.keys(KIND)
      .filter((k) => n[k])
      .map((k) => ({ value: k, label: KIND[k].label, count: n[k] }));
  }, [base]);
  const statuses = useMemo(
    () =>
      STATUS.map((s) => ({
        ...s,
        count: s.value === 'all' ? null : docs.filter((d) => d.status === s.value).length || null,
      })),
    [docs],
  );
  const companies = useMemo(() => {
    if (!filing) return [];
    const n = {};
    for (const d of base) {
      const c = filing.of(d.id);
      n[c] = (n[c] || 0) + 1;
    }
    return [...filing.order.filter((c) => n[c]).map((c) => ({ value: c, label: filing.names[c] || c, count: n[c] })), ...(n[''] ? [{ value: 'unfiled', label: 'Not filed', count: n[''] }] : [])];
  }, [filing, base]);
  const tags = useMemo(() => {
    const n = new Map();
    for (const d of base) for (const t of d.tags || []) if (t) n.set(t, (n.get(t) || 0) + 1);
    return [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [base]);
  const active = ['kind', 'status', 'co', 'tag'].filter((k) => f[k] !== 'all').length;

  // full text: the Mac searches inside the documents when you pause
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2 || link !== 'linked') return undefined;
    const t = setTimeout(() => docSearch(query), 350);
    return () => clearTimeout(t);
  }, [q, link]);
  useEffect(() => {
    const again = () => q.trim().length >= 2 && docSearch(q.trim());
    window.addEventListener('v5:refresh', again);
    return () => window.removeEventListener('v5:refresh', again);
  }, [q]);
  const bodyHits = useMemo(() => {
    const query = q.trim();
    if (query.length < 2 || !search || search.q !== query) return [];
    const shown = new Set(local.map((d) => d.id));
    const ok = new Set(filterDocs(base, { kind: f.kind, status: f.status, tag: f.tag }).map((d) => d.id));
    return (search.hits || [])
      .filter((h) => !shown.has(h.id) && ok.has(h.id))
      .map((h) => ({
        d: docs.find((x) => x.id === h.id),
        snippets: h.snippets || [],
      }))
      .filter((x) => x.d && (!filing || f.co === 'all' || filing.of(x.d.id) === (f.co === 'unfiled' ? '' : f.co)));
  }, [q, search, local, docs, base, f, filing]);

  const searching = q.trim().length > 0;
  const rows = useMemo(() => {
    const r = [];
    let last = '';
    for (const d of local) {
      if (!searching && f.sort === 'recent') {
        const sec = section(d.updatedAt, now);
        if (sec !== last) r.push({ key: `__${sec}`, header: sec });
        last = sec;
      }
      r.push({ key: d.id, d });
    }
    if (searching && local.length) r.unshift({ key: '__titles', header: 'Top hits' });
    if (bodyHits.length) {
      r.push({ key: '__body', header: `In the text · ${bodyHits.length}` });
      for (const h of bodyHits) r.push({ key: `b:${h.d.id}`, d: h.d, snippets: h.snippets });
    }
    return r;
    // `now` ticks every second; sections only need the day
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, bodyHits, searching, f.sort, dayStart(now)]);

  // Virtualised against the page's own scroller.
  const scroller = useRef(null);
  const listBox = useRef(null);
  const [offset, setOffset] = useState(0);
  const { w } = useSize(listBox);
  useEffect(() => {
    if (listBox.current && scroller.current) setOffset(listBox.current.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top + scroller.current.scrollTop);
  }, [w, active, wide, rows.length > 0]);
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
    estimateSize: (i) => (lines[i]?.[0]?.header ? 44 : 76),
    overscan: 8,
    scrollMargin: offset,
    getItemKey: (i) => lines[i].map((r) => r.key).join('|'),
  });

  const companyName = (d) => (filing ? filing.names[coOf(d)] || '' : '');
  const tokens = [
    f.kind !== 'all' && { k: 'kind', label: KIND[f.kind]?.label || f.kind },
    f.status !== 'all' && {
      k: 'status',
      label: STATUS.find((s) => s.value === f.status)?.label || f.status,
    },
    f.co !== 'all' && {
      k: 'co',
      label: f.co === 'unfiled' ? 'Not filed' : filing?.names[f.co] || f.co,
    },
    f.tag !== 'all' && { k: 'tag', label: `#${f.tag}` },
  ].filter(Boolean);
  const shownCount = local.length + bodyHits.length;
  const total = base.length;

  return (
    <Page
      ref={scroller}
      title="Library"
      subtitle={total ? (active || searching ? `${shownCount} of ${total} documents` : `${total} document${total === 1 ? '' : 's'}`) : null}
      actions={
        <div className="relative flex items-center gap-1.5">
          {!hostTooOld && docs.length > 0 && (
            <motion.button
              {...tap}
              onClick={() => setMenu((o) => !o)}
              aria-label={active ? `Filter, ${active} on` : 'Filter'}
              aria-expanded={menu}
              title="Filter"
              data-filter-button
              data-active={active}
              className={`relative grid h-10 w-10 place-items-center rounded-full ${active ? 'bg-accent text-accent-ink' : 'text-ink hover:bg-fill'}`}
            >
              <Icon name="filter" size={18} strokeWidth={2.1} />
              {active > 0 && <span className="v-num absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-ink px-1 text-[0.6rem] font-bold text-page">{active}</span>}
            </motion.button>
          )}
          <NewMenu />
          {wide && <FilterMenu open={menu} setOpen={setMenu} wide f={f} set={setF} kinds={kinds} statuses={statuses} companies={companies} tags={tags} active={active} shown={shownCount} />}
        </div>
      }
      toolbar={
        !hostTooOld &&
        docs.length > 0 && (
          <div className="flex flex-col gap-2.5">
            <SearchField value={q} onChange={setQ} placeholder="Search all documents" aria-label="Search all documents" data-library-search />
            <AnimatePresence initial={false}>
              {tokens.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={spring.layout}
                  className="flex flex-wrap items-center gap-1.5"
                  data-filter-tokens
                >
                  {tokens.map((t) => (
                    <motion.button
                      {...tap}
                      key={t.k}
                      onClick={() => setF({ ...f, [t.k]: 'all' })}
                      className="flex h-8 items-center gap-1.5 rounded-full bg-accent/15 pl-3 pr-2 text-[0.8rem] font-semibold text-accent"
                      aria-label={`Remove filter ${t.label}`}
                      data-filter-token={t.k}
                    >
                      {t.label}
                      <Icon name="close" size={13} strokeWidth={2.4} />
                    </motion.button>
                  ))}
                  {tokens.length > 1 && (
                    <button onClick={() => setF({ ...NONE, sort: f.sort })} className="h-8 px-2 text-[0.8rem] font-semibold text-ink3 hover:text-ink">
                      Clear all
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      }
    >
      {!wide && <FilterMenu open={menu} setOpen={setMenu} wide={false} f={f} set={setF} kinds={kinds} statuses={statuses} companies={companies} tags={tags} active={active} shown={shownCount} />}
      {hostTooOld ? (
        <Empty icon="alert" title="Your Mac app is out of date" hint="The Library lives on your Mac. Update Mission Control there to sync plans, research and notes." />
      ) : !docs.length ? (
        <Empty
          icon="library"
          title="Your Library is empty"
          hint="Plans, research and notes on your Mac — written by you or by agents, readable anywhere."
          action={
            <motion.button {...tap} onClick={() => openSheet('newdoc')} className="h-11 rounded-full bg-ink px-5 text-[0.9rem] font-semibold text-page">
              New document
            </motion.button>
          }
        />
      ) : !rows.length ? (
        searching ? (
          <Empty
            icon="search"
            title={`No results for “${q.trim()}”`}
            hint={active ? 'Your filters may be hiding it — or check the spelling.' : 'Check the spelling or try a new search.'}
            action={active > 0 && <ClearBtn onClick={() => setF({ ...NONE, sort: f.sort })} />}
          />
        ) : (
          <Empty icon="filter" title="No documents match these filters" hint="Loosen a filter, or clear them all." action={<ClearBtn onClick={() => setF({ ...NONE, sort: f.sort })} />} />
        )
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
                style={{
                  transform: `translateY(${it.start - v.options.scrollMargin}px)`,
                }}
              >
                {line.map((r) =>
                  r.header ? (
                    <h2 key={r.key} className="px-3 pb-1.5 pt-5 text-[1.05rem] font-bold tracking-[-0.01em] text-ink" data-library-section>
                      {r.header}
                    </h2>
                  ) : (
                    <SwipeRow key={r.key} id={r.d.id} archived={r.d.status === 'archived'} title={r.d.title}>
                      <DocRow d={r.d} now={now} snippets={r.snippets} q={q} company={f.co === 'all' ? companyName(r.d) : ''} />
                    </SwipeRow>
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

function ClearBtn({ onClick }) {
  return (
    <motion.button {...tap} onClick={onClick} className="h-11 rounded-full bg-fill px-5 text-[0.9rem] font-semibold text-ink" data-filter-clear>
      Clear filters
    </motion.button>
  );
}
