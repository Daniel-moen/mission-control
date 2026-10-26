import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { useMC } from '../../src/lib/store.js';
import { attachToMia, useAttach } from '../../src/lib/attach.js';
import { pickFiles, MAX_BYTES } from '../../src/lib/upload.js';
import { fmtAge } from '../../src/lib/format.js';
import { closeSheet } from '../lib/nav.js';
import { tap } from '../lib/motion.js';
import { Icon, Segmented, SearchField } from '../ui/kit.jsx';

// The chat's paperclip: send Mia a file from the device, or clip a Library
// report / one of her tasks into the message (it travels as a reference line
// she can act on — lib/attach.js).

const KIND_ICON = { research: 'research', plan: 'plan', note: 'note', page: 'page' };
const LIVE = new Set(['queued', 'asking', 'running', 'checking']);

export default function Attach() {
  const docs = useMC((s) => s.docs);
  const tasks = useMC((s) => s.mia?.tasks);
  const refs = useAttach((s) => s.refs);
  const [tab, setTab] = useState('docs');
  const [q, setQ] = useState('');
  const match = (...vals) => {
    const s = q.trim().toLowerCase();
    return !s || vals.some((v) => String(v || '').toLowerCase().includes(s));
  };
  const docList = useMemo(() => [...(docs || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)), [docs]);
  const taskList = useMemo(
    () => [...(tasks || [])].sort((a, b) => LIVE.has(b.status) - LIVE.has(a.status) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
    [tasks],
  );
  const has = (kind, id) => refs.some((r) => r.kind === kind && r.id === id);
  const pick = (ref) => {
    attachToMia(ref);
    closeSheet();
  };
  const rows =
    tab === 'docs'
      ? docList.filter((d) => match(d.title, d.subject, d.id, (d.tags || []).join(' '))).slice(0, 80).map((d) => ({
          key: d.id,
          pickId: d.id,
          icon: KIND_ICON[d.kind] || 'doc',
          title: d.title || d.id,
          sub: [d.kind, d.status, d.updatedAt ? `${fmtAge(Date.now() - d.updatedAt * 1000)} ago` : ''].filter(Boolean).join(' · '),
          on: has('doc', d.id),
          ref: { kind: 'doc', id: d.id, title: d.title },
        }))
      : taskList.filter((t) => match(t.title, t.id, t.status)).slice(0, 80).map((t) => ({
          key: t.id,
          pickId: `task:${t.id}`,
          icon: 'tasks',
          title: t.title || `Task ${t.id}`,
          sub: `#${t.id} · ${t.status}`,
          on: has('task', t.id),
          ref: { kind: 'task', id: t.id, title: t.title },
        }));

  return (
    <div className="flex flex-col gap-3" data-attach-sheet>
      <motion.button
        {...tap}
        onClick={() => {
          closeSheet();
          pickFiles();
        }}
        data-attach-files
        className="flex items-center gap-3.5 rounded-[18px] bg-ink p-3.5 text-left text-page"
      >
        <span className="grid h-10 w-10 flex-none place-items-center rounded-[12px] bg-page/15">
          <Icon name="upload" size={19} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.96rem] font-semibold">Photo or file</span>
          <span className="block truncate text-[0.76rem] opacity-70">PDF, photo, Office, text or audio · up to {MAX_BYTES / 1024 / 1024} MB</span>
        </span>
        <Icon name="chevronRight" size={17} className="opacity-60" />
      </motion.button>
      <Segmented
        full
        value={tab}
        onChange={setTab}
        options={[
          { value: 'docs', label: 'Reports', count: (docs || []).length || null },
          { value: 'tasks', label: 'Tasks', count: (tasks || []).length || null },
        ]}
      />
      <SearchField value={q} onChange={setQ} placeholder={tab === 'docs' ? 'Search the Library' : 'Search tasks'} />
      <div className="-mx-1 flex min-h-[160px] flex-col">
        {rows.map((r) => (
          <motion.button
            key={r.key}
            whileTap={{ scale: 0.985 }}
            onClick={() => pick(r.ref)}
            data-attach-pick={r.pickId}
            aria-pressed={r.on}
            className={`flex min-h-[52px] items-center gap-3 rounded-[14px] px-2 py-2 text-left ${r.on ? 'bg-fill' : ''}`}
          >
            <span className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-fill text-ink2">
              <Icon name={r.icon} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.92rem] font-medium text-ink">{r.title}</span>
              <span className="block truncate text-[0.76rem] text-ink3">{r.sub}</span>
            </span>
            {r.on && <Icon name="check" size={17} className="flex-none text-accent" />}
          </motion.button>
        ))}
        {!rows.length && <div className="py-10 text-center text-[0.86rem] text-ink3">{q ? 'No matches' : tab === 'docs' ? 'The Library is empty' : 'No tasks yet'}</div>}
      </div>
    </div>
  );
}
