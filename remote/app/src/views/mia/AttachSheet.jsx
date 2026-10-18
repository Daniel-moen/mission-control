import { useMemo, useState } from 'react';
import { useMC } from '../../lib/store.js';
import { attachToMia, useAttach } from '../../lib/attach.js';
import { fmtAge } from '../../lib/format.js';
import Sheet from '../../ui/Sheet.jsx';
import Segmented from '../../ui/Segmented.jsx';
import Icon from '../../ui/Icon.jsx';

// The chat's paperclip (task 0290): send Mia a file as before, or clip a
// Library report or one of her tasks into the message as a reference chip —
// Mia gets its id, title and where to read it (lib/attach.js).

const KIND_ICON = { research: 'research', plan: 'plan', note: 'note', page: 'page' };
const LIVE = new Set(['queued', 'asking', 'running', 'checking']);

function Row({ icon, title, sub, picked, onPick, pickId }) {
  return (
    <button
      onClick={onPick}
      data-attach-pick={pickId}
      aria-pressed={picked}
      className={`flex w-full items-center gap-3 rounded-xl2 px-3 py-2.5 text-left transition-colors ${picked ? 'bg-white/[0.12]' : 'hover:bg-white/[0.07]'}`}
    >
      <span className="glass-soft grid h-8 w-8 flex-none place-items-center rounded-lg text-ink2">
        <Icon name={icon} size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-ink">{title}</span>
        <span className="block truncate text-[11.5px] text-ink3">{sub}</span>
      </span>
      {picked && <Icon name="check" size={16} className="flex-none text-accent" />}
    </button>
  );
}

export default function AttachSheet({ open, onClose, onFiles }) {
  const docs = useMC((s) => s.docs);
  const tasks = useMC((s) => s.mia?.tasks);
  const refs = useAttach((s) => s.refs);
  const [tab, setTab] = useState('docs');
  const [q, setQ] = useState('');

  const match = (...vals) => {
    const s = q.trim().toLowerCase();
    return !s || vals.some((v) => String(v || '').toLowerCase().includes(s));
  };
  const docList = useMemo(
    () => [...(docs || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [docs],
  );
  const taskList = useMemo(
    () => [...(tasks || [])].sort((a, b) => (LIVE.has(b.status) - LIVE.has(a.status)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
    [tasks],
  );
  const has = (kind, id) => refs.some((r) => r.kind === kind && r.id === id);
  const pick = (ref) => {
    attachToMia(ref);
    onClose?.();
  };

  const shownDocs = docList.filter((d) => match(d.title, d.subject, d.id, (d.tags || []).join(' '))).slice(0, 60);
  const shownTasks = taskList.filter((t) => match(t.title, t.id, t.status)).slice(0, 60);
  const now = Date.now();

  return (
    <Sheet open={open} onClose={onClose} title="Attach" size="md">
      <div className="flex min-h-0 flex-col gap-3" data-attach-sheet>
        <button
          onClick={() => {
            onClose?.();
            onFiles?.();
          }}
          className="glass-soft glass-soft-hover flex items-center gap-3 rounded-xl2 px-3 py-2.5 text-left"
          data-attach-files
        >
          <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-white/[0.08] text-ink2">
            <Icon name="upload" size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-medium text-ink">Photo or file</span>
            <span className="block truncate text-[11.5px] text-ink3">PDF, photo, Office, text or audio — sent to the Mac</span>
          </span>
        </button>
        <div className="flex items-center gap-2">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'docs', label: 'Reports', icon: 'library', count: (docs || []).length || null },
              { value: 'tasks', label: 'Tasks', icon: 'tasks', count: (tasks || []).length || null },
            ]}
          />
        </div>
        <div className="relative">
          <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === 'docs' ? 'Search the Library…' : 'Search tasks…'}
            className="glass-soft h-9 w-full rounded-xl2 pl-8 pr-3 text-[13px] text-ink outline-none placeholder:text-ink3"
          />
        </div>
        <div className="noscroll -mx-1 max-h-[46dvh] min-h-[120px] overflow-y-auto">
          {tab === 'docs'
            ? shownDocs.map((d) => (
                <Row
                  key={d.id}
                  pickId={d.id}
                  icon={KIND_ICON[d.kind] || 'doc'}
                  title={d.title || d.id}
                  sub={[d.kind, d.status, d.updatedAt ? `${fmtAge(now - d.updatedAt * 1000)} ago` : ''].filter(Boolean).join(' · ')}
                  picked={has('doc', d.id)}
                  onPick={() => pick({ kind: 'doc', id: d.id, title: d.title })}
                />
              ))
            : shownTasks.map((t) => (
                <Row
                  key={t.id}
                  pickId={`task:${t.id}`}
                  icon="tasks"
                  title={t.title || `Task ${t.id}`}
                  sub={`#${t.id} · ${t.status}`}
                  picked={has('task', t.id)}
                  onPick={() => pick({ kind: 'task', id: t.id, title: t.title })}
                />
              ))}
          {(tab === 'docs' ? shownDocs : shownTasks).length === 0 && (
            <div className="py-8 text-center text-[12.5px] text-ink3">{q ? 'No matches' : tab === 'docs' ? 'The Library is empty' : 'No tasks yet'}</div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
