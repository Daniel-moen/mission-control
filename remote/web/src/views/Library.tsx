'use client';
// Library: Mia's reports, research, plans and pages. Search first; kinds sit
// in a quiet segmented filter (tags stay out of the way — search covers them).
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { docSearch, useMC } from '@/lib/store';
import { open } from '@/lib/nav';
import { ago } from '@/lib/model';
import { TopBar } from './Now';
import { Glass, Icon, spring } from '@/ui/kit';

const KINDS = [
  ['all', 'All'],
  ['research', 'Research'],
  ['plan', 'Plans'],
  ['page', 'Pages'],
  ['note', 'Notes'],
] as const;

export function Library() {
  const docs = useMC((s) => s.docs);
  const search = useMC((s) => s.search);
  const now = useMC((s) => s.now);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<string>('all');
  useEffect(() => {
    const pre = sessionStorage.getItem('mc6_search');
    if (pre) {
      sessionStorage.removeItem('mc6_search');
      setQ(pre);
    }
  }, []);
  useEffect(() => {
    if (q.trim().length < 3) return;
    const t = setTimeout(() => docSearch(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    const deep = new Set(search.q.toLowerCase() === query ? search.hits.map((h) => h.id) : []);
    return [...docs]
      .filter((d) => kind === 'all' || d.kind === kind)
      .filter((d) => !query || deep.has(d.id) || `${d.title} ${d.subject} ${(d.tags || []).join(' ')} ${d.preview}`.toLowerCase().includes(query))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [docs, q, kind, search]);
  return (
    <div className="wrap" style={{ maxWidth: 900 }}>
      <TopBar title="Library" />
      <Glass lens radius={23} className="row" style={{ padding: '0 14px', height: 46, marginBottom: 12 }}>
        <Icon name="search" size={18} className="dim" />
        <input className="field grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${docs.length} documents`} aria-label="Search the library" />
        {q ? <button onClick={() => setQ('')} aria-label="Clear"><Icon name="close" size={16} /></button> : null}
      </Glass>
      <div className="seg" style={{ marginBottom: 14 }}>
        {KINDS.map(([k, l]) => (
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {kind === k ? <motion.span layoutId="lib-thumb" className="thumb" transition={spring} /> : null}
            {l}
          </button>
        ))}
      </div>
      <Glass radius={24} style={{ padding: 6 }}>
        <AnimatePresence initial={false}>
          {list.slice(0, 150).map((d) => (
            <motion.button
              key={d.id}
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="row"
              style={{ width: '100%', textAlign: 'left', padding: '11px 12px', borderRadius: 16, gap: 12 }}
              onClick={() => open({ kind: 'doc', id: d.id })}
              data-doc={d.id}
            >
              <div className="well" style={{ width: 36, height: 36, borderRadius: 11, display: 'grid', placeItems: 'center', flex: 'none' }}>
                <Icon name={d.kind === 'research' ? 'research' : d.kind === 'plan' ? 'plan' : d.kind === 'page' ? 'page' : 'doc'} size={18} />
              </div>
              <div className="grow">
                <div className="title-s trunc">{d.title || d.id}</div>
                <div className="tiny trunc">{[d.subject, d.status === 'active' ? 'Being written' : '', d.updatedAt ? ago(d.updatedAt * 1000, now) : ''].filter(Boolean).join(' · ')}</div>
              </div>
              {d.status === 'active' ? <span className="dot green live" /> : null}
              <Icon name="chevron" size={16} className="dim" />
            </motion.button>
          ))}
        </AnimatePresence>
        {!list.length ? <div className="small" style={{ padding: 24, textAlign: 'center' }}>{docs.length ? 'Nothing matches.' : 'The library is empty.'}</div> : null}
      </Glass>
    </div>
  );
}
