import { create } from 'zustand';

// v2 navigation: four tabs, each with its own page stack (iOS style — a tab
// remembers where you were in it), plus one sheet and one full-screen
// overlay on top. Pages are plain records; the shell renders them.
//
//   route   { name, params, key, origin? }   origin = the rect a zoom grew from
//   tabs    home · mia · agents · library
//   sheets  search · launch · attach · newdoc · research · draft · more · task · download · docmeta
//   overlays console · tv · car · voice
//
// The address bar mirrors where you are with v1's hashes, so deep links,
// pushes (/#mia) and the e2e suites mean the same thing in both front ends.

export const TABS = ['home', 'mia', 'agents', 'library'];
// v5 (task 0483) gives a task its own page (#task/<id>); v2 opens it on the
// board. Set once, before anything renders.
export const navOpts = { taskPage: false, placeRoots: null };
// v5.1 (task 0486): pages that are a tab of their own although they open over
// Home (HQ) — their Page shows no Back, as a tab's root doesn't.
const ROOT = { home: 'home', mia: 'mia', agents: 'agents', library: 'library' };
// Where a page lives when it's opened cold (a deep link at launch).
const OWNER = { agent: 'agents', doc: 'library', insights: 'home', hq: 'home', settings: 'home', task: 'mia' };

let seq = 0;
const mk = (name, params = {}, extra = {}) => ({ name, params, key: `${name}:${++seq}`, ...extra });

export const useNav = create(() => ({
  tab: 'home',
  stacks: Object.fromEntries(TABS.map((t) => [t, [mk(ROOT[t])]])),
  sheet: null, // { name, params, n }
  overlay: null, // { name, params }
  miaSeg: 'chat', // the Mia page on narrow screens: 'chat' | 'tasks'
  focusTask: null, // { id, n } — a task to scroll to and flash
  visited: { home: true }, // tabs mounted so far (kept mounted after)
}));

const get = () => useNav.getState();
const set = (p) => useNav.setState(p);

export const topOf = (s = get()) => {
  const st = s.stacks[s.tab];
  return st[st.length - 1];
};

export function setTab(tab) {
  const s = get();
  if (!TABS.includes(tab)) return;
  if (s.tab === tab) {
    // Tapping the tab you're on goes back to its root.
    if (s.stacks[tab].length > 1) set({ stacks: { ...s.stacks, [tab]: [s.stacks[tab][0]] } });
    return;
  }
  set({ tab, visited: { ...s.visited, [tab]: true } });
}

// Two routes are the same page when name + identifying params match (how it
// was opened — zoom origin, straight into the editor — doesn't count).
const ident = (r) => {
  // eslint-disable-next-line no-unused-vars
  const { zoomId, edit, ...p } = r.params || {};
  return JSON.stringify(p);
};
const same = (a, b) => a && b && a.name === b.name && ident(a) === ident(b);

export function push(name, params = {}, { origin = null, tab = null } = {}) {
  const s = get();
  const t = tab || s.tab;
  const stack = s.stacks[t];
  const r = mk(name, params, origin ? { origin } : {});
  if (same(stack[stack.length - 1], r)) {
    if (t !== s.tab) set({ tab: t, visited: { ...s.visited, [t]: true } });
    return;
  }
  // The same page already sits lower in this stack: go back to it instead of
  // stacking a second copy (Mia opening a doc you navigated away from).
  const at = stack.findIndex((x) => same(x, r));
  const next = at > 0 ? stack.slice(0, at + 1) : [...stack, r];
  set({ tab: t, stacks: { ...s.stacks, [t]: next }, visited: { ...s.visited, [t]: true } });
}

export function pop() {
  const s = get();
  const stack = s.stacks[s.tab];
  if (stack.length <= 1) return false;
  set({ stacks: { ...s.stacks, [s.tab]: stack.slice(0, -1) } });
  return true;
}

// Replace the params of the top page (HQ's company / channel drill-down).
export function patchTop(params) {
  const s = get();
  const stack = s.stacks[s.tab];
  const top = stack[stack.length - 1];
  set({ stacks: { ...s.stacks, [s.tab]: [...stack.slice(0, -1), { ...top, params: { ...top.params, ...params } }] } });
}

export function openSheet(name, params = {}) {
  set({ sheet: { name, params, n: (get().sheet?.n || 0) + 1 } });
}
export function closeSheet() {
  if (get().sheet) set({ sheet: null });
}
export function openOverlay(name, params = {}) {
  set({ overlay: { name, params } });
}
export function closeOverlay() {
  if (get().overlay) set({ overlay: null });
}

export function setMiaSeg(miaSeg) {
  set({ miaSeg });
}
export function focusTask(id) {
  if (navOpts.taskPage && id) return push('task', { id });
  const s = get();
  set({ focusTask: { id, n: (s.focusTask?.n || 0) + 1 }, miaSeg: 'tasks' });
  setTab('mia');
  // Back at the board's own page, not something stacked over it.
  const st = get().stacks.mia;
  if (st.length > 1) set({ stacks: { ...get().stacks, mia: [st[0]] } });
}

// Open a "view" by name (dock keys, `mia panel view`, v1 hashes).
export function goView(v) {
  closeSheet();
  if (v === 'home' || v === 'mia' || v === 'library') return toRoot(v);
  if (v === 'fleet' || v === 'agents') return toRoot('agents');
  if (v === 'insights' || v === 'hq' || v === 'settings') return push(v, {});
  if (v === 'channels') return push('hq', { section: 'channels' });
  return undefined;
}
function toRoot(tab) {
  const s = get();
  set({ tab, stacks: { ...s.stacks, [tab]: [s.stacks[tab][0]] }, visited: { ...s.visited, [tab]: true } });
}

// ---- hash ⇄ state -----------------------------------------------------------

export function hashFor(s = get()) {
  if (s.overlay) {
    const o = s.overlay;
    if (o.name === 'tv' || o.name === 'car') return o.name;
    if (o.name === 'console') return o.params.id ? `console/${o.params.id}` : 'console';
  }
  if (s.sheet?.name === 'launch') return 'launch';
  const top = topOf(s);
  switch (top.name) {
    case 'home':
      return '';
    case 'mia':
      return 'mia';
    case 'agents':
      return 'fleet';
    case 'library':
      return 'library';
    case 'agent':
      return `agent/${top.params.id}`;
    case 'doc':
      return `doc/${top.params.id}`;
    case 'insights':
      return 'insights';
    case 'settings':
      return 'settings';
    case 'task':
      return `task/${top.params.id}`;
    case 'hq': {
      const p = top.params || {};
      if (p.section === 'channels') return p.channel ? `channels/${p.channel}` : 'channels';
      return p.company ? `hq/${p.company}` : 'hq';
    }
    default:
      return '';
  }
}

// Apply a hash. `cold` (the first load) files a page under its home tab so
// Back leads somewhere sensible; later hash changes stack on the current tab.
export function applyHash(raw, { cold = false } = {}) {
  const h = decodeURIComponent(String(raw || '').replace(/^#/, ''));
  const [head, ...rest] = h.split('/');
  const id = rest.join('/');
  const s = get();
  if (head === 'tv' || head === 'car') return openOverlay(head);
  if (s.overlay && (s.overlay.name === 'tv' || s.overlay.name === 'car')) closeOverlay();
  if (head === 'console') return openOverlay('console', { id: id || null });
  if (head === 'launch') return openSheet('launch');
  const page = (name, params) => push(name, params, cold ? { tab: OWNER[name] } : {});
  if (head === 'agent' && id) return page('agent', { id });
  if (head === 'doc' && id) return page('doc', { id });
  if (head === 'task' && id) return navOpts.taskPage ? page('task', { id }) : focusTask(id);
  if (head === 'insights') return page('insights', {});
  if (head === 'settings') return page('settings', {});
  if (head === 'hq') return page('hq', id ? { company: id } : {});
  if (head === 'channels') return page('hq', id ? { section: 'channels', channel: id } : { section: 'channels' });
  if (head === 'mia' || head === 'library') return toRoot(head);
  if (head === 'fleet') return toRoot('agents');
  if (!head) {
    closeSheet();
    return toRoot('home');
  }
  return undefined;
}
