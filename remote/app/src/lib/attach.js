// References Daniel clips into a message for Mia (task 0290): a Library doc
// or one of her tasks, shown as a chip in the composer. They travel inside the
// message text — one plain line each that Mia can act on (id, title, where the
// file is, how to read it) — so no Mac app change is needed, and the thread
// turns those lines back into chips.
//
//   📎 Report "Raw Incident: hooks" (doc raw-incident-hooks.md · ~/.mission-control/library/raw-incident-hooks.md · read: mc-doc get raw-incident-hooks.md)
//   📎 Task "Cut the Phoenix intro" (task 0701 · read: mia task show 0701)

import { create } from 'zustand';

const LIB = '~/.mission-control/library';
const MAX = 6;

export const useAttach = create(() => ({ refs: [] })); // [{ kind: 'doc' | 'task', id, title }]

const same = (a, b) => a.kind === b.kind && a.id === b.id;
const cleanTitle = (t) => String(t || '').replace(/["\n\r]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 120);

export function attachToMia(ref) {
  if (!ref?.id || (ref.kind !== 'doc' && ref.kind !== 'task')) return;
  const r = { kind: ref.kind, id: String(ref.id), title: cleanTitle(ref.title) || String(ref.id) };
  useAttach.setState((s) => ({ refs: s.refs.some((x) => same(x, r)) ? s.refs : [...s.refs, r].slice(-MAX) }));
}
export const detachRef = (ref) => useAttach.setState((s) => ({ refs: s.refs.filter((x) => !same(x, ref)) }));
export const clearRefs = () => useAttach.setState({ refs: [] });

export function refLine(r) {
  if (r.kind === 'task') return `📎 Task "${cleanTitle(r.title)}" (task ${r.id} · read: mia task show ${r.id})`;
  return `📎 Report "${cleanTitle(r.title)}" (doc ${r.id} · ${LIB}/${r.id} · read: mc-doc get ${r.id})`;
}

// The message Mia receives: what Daniel typed, then one line per reference.
export function withRefs(text, refs) {
  const t = String(text || '').trim();
  if (!refs?.length) return t;
  return [t, ...refs.map(refLine)].filter(Boolean).join('\n');
}

// The other way: a thread message → its text without the reference lines, and
// the references as chips. The Mac may have flattened the newlines, so no
// anchors.
const RE = /📎 (Report|Task) "([^"]*)" \((doc|task) ([^\s·)]+)[^)]*\)/g;
export function splitRefs(text) {
  const s = String(text || '');
  if (!s.includes('📎')) return { text: s, refs: [] };
  const refs = [];
  const body = s.replace(RE, (_, _label, title, kind, id) => {
    refs.push({ kind, id, title });
    return '';
  });
  return { text: refs.length ? body.replace(/[ \t]*\n[ \t]*(?=\n|$)/g, '').trim() : s, refs };
}
