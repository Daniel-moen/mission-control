// Navigation: five places (no sidebar) and one sheet on top. Mirrored in the
// URL hash so a push notification (#mia), a `mia panel` command or a shared
// link lands in the right spot:  #now  #tasks  #mia  #library  #fleet
//   #task/0612  #agent/<sessionId>  #job/<id>  #doc/<id>  #settings  #new  #talk

import { create } from 'zustand';

export type Tab = 'now' | 'tasks' | 'mia' | 'library' | 'fleet';
export const TABS: Tab[] = ['now', 'tasks', 'mia', 'library', 'fleet'];
export type Sheet =
  | { kind: 'task'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'job'; id: string }
  | { kind: 'doc'; id: string }
  | { kind: 'settings' }
  | { kind: 'new'; text?: string }
  | null;

interface Nav {
  tab: Tab;
  sheet: Sheet;
  talk: boolean;
  // where a sheet grew from (shared-element transition key)
  origin: string;
}

export const useNav = create<Nav>(() => ({ tab: 'now', sheet: null, talk: false, origin: '' }));

function hashOf(n: Nav): string {
  const s = n.sheet;
  if (s) return s.kind === 'settings' || s.kind === 'new' ? `#${s.kind}` : `#${s.kind}/${encodeURIComponent(s.id)}`;
  return `#${n.tab}`;
}

function write() {
  if (typeof window === 'undefined') return;
  const h = hashOf(useNav.getState());
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}

export function go(tab: Tab) {
  useNav.setState({ tab, sheet: null });
  write();
}
export function open(sheet: NonNullable<Sheet>, origin = '') {
  useNav.setState({ sheet, origin });
  write();
}
export function close() {
  useNav.setState({ sheet: null });
  write();
}
export function setTalk(on: boolean) {
  useNav.setState({ talk: on });
}

export function readHash(h: string) {
  const raw = h.replace(/^#/, '');
  const [kind, ...rest] = raw.split('/');
  const id = decodeURIComponent(rest.join('/'));
  if ((TABS as string[]).includes(kind)) return useNav.setState({ tab: kind as Tab, sheet: null });
  if ((kind === 'task' || kind === 'agent' || kind === 'job' || kind === 'doc') && id) return useNav.setState({ sheet: { kind, id } as Sheet, origin: '' });
  if (kind === 'settings') return useNav.setState({ sheet: { kind: 'settings' } });
  if (kind === 'new') return useNav.setState({ sheet: { kind: 'new' } });
  if (kind === 'talk') return useNav.setState({ talk: true });
}
