import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, agentName, agentStatus } from '../src/lib/store.js';
import { openSheet, push, openOverlay } from '../v2/lib/nav.js';
import { usePrefs, setTheme, setGlass } from '../v2/lib/prefs.js';
import { spring } from '../v2/lib/motion.js';
import { Icon } from '../v2/ui/kit.jsx';
import { startVoice } from '../v2/shell/TalkHost.jsx';
import { useV53, closePalette, setDraft, setMini, getV53 } from './state.js';
import { place } from './TabBar.jsx';
import { refreshNow } from '../v5/ux.jsx';

// The command palette (task 0491, a "cool thing"): ⌘K, or the search circle
// beside the tab bar. One field that goes anywhere and does anything:
// places, Mia's tasks, the Library, the fleet, and the actions (launch, a
// new doc, research, talk, theme, glass, the tab bar). Fuzzy — "fl" finds
// Fleet, "crys ret" finds "Crystal Garden: come back tomorrow". Arrow keys
// and Return; nothing typed shows the places and the live tasks. The last
// row always hands the words to full Search (or to Mia).

const score = (q, text) => {
  if (!q) return 1;
  const t = String(text || '').toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i === 0) s += 3;
    else if (i > 0) s += t[i - 1] === ' ' ? 2.4 : 1.6;
    else {
      // in order, with gaps (fl → fleet, lbr → library)
      let k = 0;
      for (const ch of t) if (ch === w[k]) k++;
      if (k < w.length) return 0;
      s += 0.6;
    }
  }
  return s / words.length;
};

function useItems(q) {
  const docs = useMC((s) => s.docs);
  const tasks = useMC((s) => s.mia?.tasks);
  const agents = useMC((s) => s.agents);
  const dark = usePrefs((s) => s.dark);
  const lite = usePrefs((s) => s.lite);
  return useMemo(() => {
    const places = [
      ['chat', 'Chat with Mia', 'mia'],
      ['home', 'Home', 'sparkles'],
      ['tasks', 'Tasks', 'tasks'],
      ['fleet', 'Fleet', 'agents'],
      ['library', 'Library', 'library'],
      ['hq', 'HQ', 'hq'],
      ['channels', 'Channels', 'video'],
      ['insights', 'Insights', 'gauge'],
      ['settings', 'Settings', 'settings'],
    ].map(([k, label, icon]) => ({ key: `p:${k}`, group: 'Go to', label, icon, run: () => place(k) }));
    const actions = [
      { key: 'a:launch', label: 'Launch an agent', icon: 'launch', hint: '⌘L', run: () => openSheet('launch') },
      { key: 'a:new', label: 'New document', icon: 'edit', hint: '⌘N', run: () => openSheet('newdoc') },
      { key: 'a:research', label: 'Research something', icon: 'research', run: () => openSheet('research') },
      { key: 'a:talk', label: 'Talk to Mia', icon: 'mic', run: () => startVoice() },
      { key: 'a:bar', label: 'Minimise or restore the tab bar', icon: 'minus', hint: '⌘\\', run: () => setMini(!getV53().mini) },
      { key: 'a:theme', label: dark ? 'Light appearance' : 'Dark appearance', icon: 'eye', run: () => setTheme(dark ? 'light' : 'dark') },
      { key: 'a:glass', label: lite ? 'Full glass (live refraction)' : 'Lite glass (easier on the battery)', icon: 'sparkles', run: () => setGlass(lite ? 'full' : 'lite') },
      { key: 'a:refresh', label: 'Refresh', icon: 'refresh', hint: '⌘R', run: () => refreshNow() },
      { key: 'a:console', label: 'Open the console', icon: 'terminal', run: () => openOverlay('console', {}) },
    ].map((a) => ({ ...a, group: 'Actions' }));
    const liveT = (tasks || []).filter((t) => ['queued', 'asking', 'running', 'checking'].includes(t.status));
    const taskItems = (q ? tasks || [] : liveT).map((t) => ({ key: `t:${t.id}`, group: 'Tasks', label: t.title || `Task ${t.id}`, icon: 'tasks', hint: `#${t.id}`, extra: t.id, run: () => push('task', { id: t.id }) }));
    const agentItems = (agents || []).map((a) => ({ key: `g:${a.id}`, group: 'Fleet', label: agentName(a), icon: 'agents', hint: agentStatus(a) === 'waiting' ? 'needs you' : agentStatus(a) === 'working' ? 'working' : '', extra: a.folder, run: () => push('agent', { id: a.id }) }));
    const docItems = q ? (docs || []).map((d) => ({ key: `d:${d.id}`, group: 'Library', label: d.title || d.id, icon: d.kind === 'research' ? 'research' : d.kind === 'plan' ? 'plan' : 'doc', extra: `${d.id} ${d.subject || ''} ${(d.tags || []).join(' ')}`, run: () => push('doc', { id: d.id }) })) : [];
    const all = [...places, ...taskItems, ...agentItems, ...docItems, ...actions];
    const ranked = q
      ? all
          .map((it) => ({ it, s: Math.max(score(q, it.label), score(q, it.extra) * 0.8) + (it.group === 'Go to' ? 0.3 : it.group === 'Actions' ? 0.15 : 0) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 14)
          .map((x) => x.it)
      : [...places, ...taskItems.slice(0, 4), ...actions.slice(0, 4)];
    if (q.trim()) {
      ranked.push({ key: 'x:search', group: 'More', label: `Search everything for “${q.trim()}”`, icon: 'search', run: () => openSheet('search', { q: q.trim() }) });
      ranked.push({ key: 'x:ask', group: 'More', label: `Ask Mia: “${q.trim()}”`, icon: 'mia', run: () => setDraft(q.trim()) });
    }
    return ranked;
  }, [q, docs, tasks, agents, dark, lite]);
}

export default function Palette() {
  const open = useV53((s) => s.palette);
  return createPortal(<AnimatePresence>{open && <Body key="palette" />}</AnimatePresence>, document.body);
}

function Body() {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const items = useItems(q);
  const field = useRef(null);
  const list = useRef(null);
  useEffect(() => {
    requestAnimationFrame(() => field.current?.focus());
  }, []);
  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-pal-i="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const run = (it) => {
    if (!it) return;
    closePalette();
    // the palette leaves before the pane arrives
    requestAnimationFrame(() => it.run());
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setAt((i) => Math.min(items.length - 1, i + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setAt((i) => Math.max(0, i - 1)));
    else if (e.key === 'Enter') (e.preventDefault(), run(items[at]));
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), closePalette());
  };
  let lastGroup = '';
  return (
    <motion.div className="fixed inset-0 z-[92] flex justify-center px-3" style={{ paddingTop: 'calc(env(safe-area-inset-top) + min(14vh, 120px))' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onPointerDown={(e) => e.target === e.currentTarget && closePalette()} data-palette>
      <div className="absolute inset-0 bg-black/25" aria-hidden="true" />
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: -14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: -8 }}
        transition={spring.sheet}
        className="v-menu v5-menu v53-palette relative flex h-fit max-h-[min(70vh,560px)] w-full max-w-[620px] flex-col overflow-hidden"
        role="dialog"
        aria-label="Search and commands"
      >
        <div className="flex items-center gap-3 border-b border-hair px-4">
          <Icon name="search" size={19} className="flex-none text-ink3" />
          <input
            ref={field}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Go anywhere, find anything, do anything"
            className="h-14 min-w-0 flex-1 bg-transparent text-[1.05rem] text-ink outline-none placeholder:text-ink3"
            aria-label="Search and commands"
            data-palette-input
          />
          <kbd className="hidden rounded-md bg-fill px-1.5 py-0.5 text-[0.7rem] font-semibold text-ink3 sm:block">esc</kbd>
        </div>
        <div ref={list} className="v-scroll min-h-0 flex-1 p-1.5" role="listbox">
          {items.map((it, i) => {
            const head = it.group !== lastGroup;
            lastGroup = it.group;
            return (
              <div key={it.key}>
                {head && <div className="px-3 pb-1 pt-2.5 text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-ink3">{it.group}</div>}
                <button
                  role="option"
                  aria-selected={i === at}
                  onPointerMove={() => i !== at && setAt(i)}
                  onClick={() => run(it)}
                  className={`relative flex h-11 w-full items-center gap-3 rounded-[12px] px-3 text-left text-[0.94rem] ${i === at ? 'text-ink' : 'text-ink2'}`}
                  data-pal-i={i}
                  data-pal-key={it.key}
                >
                  {i === at && <motion.span layoutId="v53-pal-hi" transition={spring.snappy} className="absolute inset-0 rounded-[12px] bg-fill2" />}
                  <Icon name={it.icon} size={17} className="relative flex-none text-ink3" />
                  <span className="relative min-w-0 flex-1 truncate font-medium">{it.label}</span>
                  {it.hint && <span className="relative flex-none text-[0.74rem] text-ink3">{it.hint}</span>}
                </button>
              </div>
            );
          })}
          {!items.length && <div className="px-4 py-8 text-center text-[0.9rem] text-ink3">Nothing matches.</div>}
        </div>
      </motion.div>
    </motion.div>
  );
}

