import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, agentStatus, agentName, kindLabel, stopAll, docSearch } from '../../src/lib/store.js';
import { pickFiles } from '../../src/lib/upload.js';
import { push, goView, openSheet, closeSheet, openOverlay, focusTask } from '../lib/nav.js';
import { setTheme, usePrefs, switchUi } from '../lib/prefs.js';
import { Dot, Icon } from '../ui/kit.jsx';
import { startVoice } from '../shell/TalkHost.jsx';

// Search: one field that finds an agent, a Library doc (titles at once, full
// text from the Mac as you pause), one of Mia's tasks, or an action. Arrow
// keys + Enter on an iPad keyboard; a tap anywhere else. `mia panel search`
// opens it pre-filled.

function score(hay, q) {
  if (!q) return 0;
  const h = hay.toLowerCase();
  const n = q.toLowerCase();
  const direct = h.indexOf(n);
  if (direct >= 0) return 1000 - direct * 2 - h.length * 0.05;
  let i = 0;
  let last = -1;
  let gaps = 0;
  for (const ch of n) {
    const at = h.indexOf(ch, i);
    if (at < 0) return -1;
    if (last >= 0) gaps += at - last - 1;
    last = at;
    i = at + 1;
  }
  return 400 - gaps - h.length * 0.05;
}

const KIND_ICON = { plan: 'plan', research: 'research', note: 'note', page: 'page' };

export default function Search({ initial = '' }) {
  const { agents, docs, tasks, search, link } = useMC(
    useShallow((s) => ({ agents: s.agents, docs: s.docs, tasks: s.mia?.tasks || [], search: s.search, link: s.link })),
  );
  const dark = usePrefs((s) => s.dark);
  const [q, setQ] = useState(initial);
  const [cursor, setCursor] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => setQ(initial), [initial]);

  // Full-text over the wire once the typing pauses.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2 || link !== 'linked') return undefined;
    const t = setTimeout(() => docSearch(query), 320);
    return () => clearTimeout(t);
  }, [q, link]);

  const go = (fn) => () => {
    closeSheet();
    fn();
  };

  const actions = useMemo(
    () => [
      { id: 'a:launch', label: 'Launch an agent', icon: 'launch', run: () => setTimeout(() => openSheet('launch'), 0) },
      { id: 'a:talk', label: 'Talk to Mia', icon: 'mic', run: () => startVoice() },
      { id: 'a:mia', label: 'Open Mia', icon: 'mia', run: () => goView('mia') },
      { id: 'a:tasks', label: 'Mia’s tasks', icon: 'tasks', run: () => focusTask(null) },
      { id: 'a:upload', label: 'Send a file to Mia', icon: 'attach', run: () => { pickFiles(); goView('mia'); } },
      { id: 'a:agents', label: 'Agents', icon: 'agents', run: () => goView('agents') },
      { id: 'a:library', label: 'Library', icon: 'library', run: () => goView('library') },
      { id: 'a:insights', label: 'Insights', icon: 'overview', run: () => goView('insights') },
      { id: 'a:hq', label: 'HQ — companies and channels', icon: 'hq', run: () => goView('hq') },
      { id: 'a:console', label: 'Terminal console', icon: 'terminal', run: () => openOverlay('console', { id: null }) },
      { id: 'a:settings', label: 'Settings', icon: 'settings', run: () => goView('settings') },
      { id: 'a:theme', label: dark ? 'Light appearance' : 'Dark appearance', icon: 'eye', run: () => setTheme(dark ? 'light' : 'dark') },
      { id: 'a:v1', label: 'Switch to the classic interface (v1)', icon: 'undo', run: () => switchUi('v1') },
      { id: 'a:tv', label: 'TV mode', icon: 'tv', run: () => (location.hash = '#tv') },
      { id: 'a:car', label: 'Car mode', icon: 'car', run: () => (location.hash = '#car') },
      { id: 'a:stop', label: 'Stop all agents', icon: 'stop', run: () => stopAll() },
    ],
    [dark],
  );

  const groups = useMemo(() => {
    const rank = (rows, n) =>
      rows
        .map((r) => ({ ...r, s: score(r.hay, q) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, n);
    const ag = rank(
      agents.map((a) => ({ id: `g:${a.id}`, hay: `${agentName(a)} ${a.folder || ''} ${a.branch || ''} ${a.activity || ''}`, agent: a, run: () => push('agent', { id: a.id }) })),
      q ? 8 : 4,
    );
    const titleHits = rank(
      (docs || []).map((d) => ({ id: `d:${d.id}`, hay: `${d.title || ''} ${d.subject || ''} ${(d.tags || []).join(' ')}`, doc: d, run: () => push('doc', { id: d.id }) })),
      q ? 8 : 4,
    );
    const seen = new Set(titleHits.map((r) => r.doc.id));
    const body = q.trim().length >= 2 && search.q === q.trim()
      ? (search.hits || [])
          .filter((h) => !seen.has(h.id))
          .map((h) => {
            const d = docs.find((x) => x.id === h.id);
            return d && { id: `b:${d.id}`, doc: d, snippet: (h.snippets || [])[0], run: () => push('doc', { id: d.id }) };
          })
          .filter(Boolean)
          .slice(0, 6)
      : [];
    const tk = q ? rank(tasks.map((t) => ({ id: `t:${t.id}`, hay: `${t.title || ''} ${t.id} ${t.status}`, task: t, run: () => focusTask(t.id) })), 6) : [];
    const ac = rank(actions.map((a) => ({ ...a, hay: a.label })), q ? 6 : 8);
    return [
      { key: 'actions', title: q ? 'Actions' : 'Go to', rows: ac },
      { key: 'agents', title: 'Agents', rows: ag },
      { key: 'docs', title: 'Library', rows: [...titleHits, ...body] },
      { key: 'tasks', title: 'Mia’s tasks', rows: tk },
    ].filter((g) => g.rows.length);
  }, [agents, docs, tasks, actions, q, search]);

  const flat = groups.flatMap((g) => g.rows);
  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = flat[Math.min(cursor, flat.length - 1)];
      if (r) go(r.run)();
    }
  };

  let i = -1;
  return (
    <div className="flex min-h-0 flex-col" data-search>
      <div className="sticky top-0 z-10 bg-card pb-3">
        <div className="relative">
          <Icon name="search" size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink3" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Agents, documents, tasks, actions"
            enterKeyHint="go"
            aria-label="Search"
            className="v-field h-12 w-full pl-11 pr-4 text-[1.02rem]"
          />
        </div>
      </div>
      <div ref={list} className="flex flex-col gap-4 pb-2">
        {!flat.length && <div className="py-10 text-center text-[0.9rem] text-ink3">Nothing matches “{q}”.</div>}
        {groups.map((g) => (
          <section key={g.key}>
            <div className="v-eyebrow mb-1.5 px-2">{g.title}</div>
            <div className="flex flex-col">
              {g.rows.map((r) => {
                i += 1;
                const on = i === cursor;
                return (
                  <motion.button
                    key={r.id}
                    whileTap={{ scale: 0.985 }}
                    onClick={go(r.run)}
                    onPointerMove={() => setCursor(flat.indexOf(r))}
                    data-active={on ? 'true' : 'false'}
                    data-result={r.id}
                    className={`flex min-h-[48px] w-full items-center gap-3 rounded-[14px] px-2.5 py-2 text-left ${on ? 'bg-fill' : ''}`}
                  >
                    <span className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-fill text-ink2">
                      {r.agent ? <Dot status={agentStatus(r.agent)} size={9} /> : <Icon name={r.doc ? KIND_ICON[r.doc.kind] || 'doc' : r.task ? 'tasks' : r.icon} size={17} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.94rem] font-medium text-ink">
                        {r.agent ? agentName(r.agent) : r.doc ? r.doc.title || r.doc.id : r.task ? r.task.title : r.label}
                      </span>
                      {(r.agent || r.doc || r.task) && (
                        <span className="block truncate text-[0.78rem] text-ink3">
                          {r.agent
                            ? r.agent.activity || r.agent.folder
                            : r.doc
                              ? r.snippet || [kindLabel(r.doc.kind), r.doc.subject].filter(Boolean).join(' · ')
                              : `#${r.task.id} · ${r.task.status}`}
                        </span>
                      )}
                    </span>
                    {on && <Icon name="enter" size={15} className="hidden flex-none text-ink3 sm:block" />}
                  </motion.button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
