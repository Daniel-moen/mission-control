import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import { useMC, agentStatus, agentName, kindIcon, kindLabel, stopAll } from '../lib/store.js';
import { spring, fadeIn } from '../lib/motion.js';
import Icon from '../ui/Icon.jsx';
import StatusDot from '../ui/StatusDot.jsx';
import Kbd from '../ui/Kbd.jsx';

// ⌘K: jump to any agent, any document, or any action, from anywhere.
// Subsequence match (Raycast-style) — "pfm" finds "PaymentForm" — scored so
// tighter, earlier matches float up.
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

export default function CommandPalette({ open, onClose, onOpenAgent, onNav, onLaunch, onSettings, onOpenDoc }) {
  const { agents, docs } = useMC(useShallow((s) => ({ agents: s.agents, docs: s.docs })));
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
      // Autofocus after the scaleIn starts, or Safari steals it back.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const actions = useMemo(
    () => [
      { id: 'a:launch', label: 'Launch an agent', icon: 'launch', run: () => onLaunch?.() },
      { id: 'a:fleet', label: 'Open fleet', icon: 'agents', run: () => onNav?.('fleet') },
      { id: 'a:insights', label: 'Open insights', icon: 'overview', run: () => onNav?.('insights') },
      { id: 'a:library', label: 'Open library', icon: 'library', run: () => onNav?.('library') },
      { id: 'a:settings', label: 'Settings', icon: 'settings', run: () => onSettings?.() },
      { id: 'a:tv', label: 'TV mode', icon: 'tv', run: () => { location.hash = '#tv'; } },
      { id: 'a:car', label: 'Car mode', icon: 'car', run: () => { location.hash = '#car'; } },
      { id: 'a:stop', label: 'Stop all agents', icon: 'stop', run: () => stopAll() },
    ],
    [onLaunch, onNav, onSettings],
  );

  const groups = useMemo(() => {
    const rank = (rows) =>
      rows
        .map((r) => ({ ...r, s: score(r.hay, q) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s);

    const ag = rank(
      agents.map((a) => ({
        id: `g:${a.id}`,
        hay: `${agentName(a)} ${a.folder || ''} ${a.branch || ''} ${a.activity || ''}`,
        agent: a,
        run: () => onOpenAgent?.(a.id),
      })),
    ).slice(0, 8);

    const dc = rank(
      (docs || []).map((d) => ({
        id: `d:${d.id}`,
        hay: `${d.title || ''} ${d.subject || ''} ${(d.tags || []).join(' ')}`,
        doc: d,
        run: () => onOpenDoc?.(d.id),
      })),
    ).slice(0, 6);

    const ac = rank(actions.map((a) => ({ ...a, hay: a.label }))).slice(0, 8);

    return [
      { key: 'agents', title: 'Agents', rows: ag },
      { key: 'docs', title: 'Library', rows: dc },
      { key: 'actions', title: 'Actions', rows: ac },
    ].filter((g) => g.rows.length);
  }, [agents, docs, actions, q, onOpenAgent, onOpenDoc]);

  const flat = groups.flatMap((g) => g.rows);
  const active = flat[Math.min(cursor, flat.length - 1)];

  useEffect(() => setCursor(0), [q]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, q]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) {
        active.run();
        onClose?.();
      }
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          {...fadeIn}
          // Blur the scene behind, so the palette's own glass has something
          // soft to sample instead of legible page text.
          className="fixed inset-0 z-[92] flex items-start justify-center bg-overlay px-4 pt-[12vh] backdrop-blur-lg"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={spring.smooth}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="glass-strong flex max-h-[68vh] w-full max-w-[620px] flex-col overflow-hidden"
          >
            <div className="flex flex-none items-center gap-3 border-b border-glass-line px-4">
              <Icon name="search" size={17} className="flex-none text-ink3" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                placeholder="Jump to an agent, a document, or an action…"
                className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink3"
              />
              <Kbd className="flex-none">esc</Kbd>
            </div>

            <div ref={listRef} className="noscroll min-h-0 flex-1 overflow-y-auto p-2">
              {!flat.length && (
                <div className="px-3 py-10 text-center text-[13px] text-ink3">Nothing matches “{q}”.</div>
              )}
              {groups.map((g) => (
                <div key={g.key} className="mb-1">
                  <div className="label px-3 pb-1 pt-2">{g.title}</div>
                  {g.rows.map((r) => {
                    const on = r === active;
                    return (
                      <button
                        key={r.id}
                        data-active={on}
                        onMouseMove={() => setCursor(flat.indexOf(r))}
                        onClick={() => {
                          r.run();
                          onClose?.();
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl2 px-3 py-2.5 text-left transition-colors ${
                          on ? 'bg-white/[0.12]' : 'hover:bg-white/[0.06]'
                        }`}
                      >
                        {r.agent ? (
                          <StatusDot status={agentStatus(r.agent)} size={8} />
                        ) : (
                          <Icon
                            name={r.doc ? kindIcon(r.doc.kind) : r.icon}
                            size={16}
                            className="flex-none text-ink3"
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-ink">
                            {r.agent ? agentName(r.agent) : r.doc ? r.doc.title || 'Untitled' : r.label}
                          </span>
                          {(r.agent?.activity || r.doc) && (
                            <span className="block truncate text-[11.5px] text-ink3">
                              {r.agent ? r.agent.activity : `${kindLabel(r.doc.kind)}${r.doc.subject ? ' · ' + r.doc.subject : ''}`}
                            </span>
                          )}
                        </span>
                        {on && <Kbd className="flex-none">⏎</Kbd>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
