import { create } from 'zustand';
import { useNav, topOf } from '../v2/lib/nav.js';

// v5.3's own UI state (task 0502). Navigation itself is v2's (lib/nav.js:
// one page stack per place); this is only what the chat-first shell adds:
//   mini      the tab bar is minimised (you scrolled into something); the
//             composer moves down beside it, as iOS 26's bottom accessory
//   palette   the command palette (⌘K) is open
//   draft     text a suggestion or a message menu puts in the composer ({ text, n })
//   origin    the rect a pane grows out of (a card in the chat) — shared
//             element, consumed by the pane on its next open
//   last      the pane you closed last (a right-edge swipe brings it back)

export const useV53 = create(() => ({
  mini: false,
  palette: false,
  draft: null,
  origin: null,
  last: null,
}));

const set = (p) => useV53.setState(p);
export const getV53 = () => useV53.getState();

export const setMini = (mini) => getV53().mini !== mini && set({ mini });

export const openPalette = () => set({ palette: true });
export const closePalette = () => getV53().palette && set({ palette: false });

export function setDraft(text) {
  set({ draft: { text, n: (getV53().draft?.n || 0) + 1 } });
}

// The pane is open whenever you're anywhere but the chat itself: a place
// (Home, Fleet, Library) or a page stacked over the chat (a task, a doc,
// HQ, Settings …).
export const paneOpenOf = (s = useNav.getState()) => !(s.tab === 'mia' && s.stacks.mia.length <= 1);
export const usePaneOpen = () => useNav(paneOpenOf);
export const paneTopName = (s = useNav.getState()) => (paneOpenOf(s) ? topOf(s).name : '');

// Remember the rect of the thing you tapped, so the pane grows out of it.
export function growFrom(el) {
  if (!el?.getBoundingClientRect) return;
  const r = el.getBoundingClientRect();
  set({ origin: { left: r.left, top: r.top, width: r.width, height: r.height, at: performance.now() } });
}
export function takeOrigin() {
  const o = getV53().origin;
  if (!o) return null;
  set({ origin: null });
  return performance.now() - o.at < 800 ? o : null;
}

// The pane you just closed: tab + its stack, for the right-edge swipe.
export function rememberPane(snapshot) {
  set({ last: snapshot });
}
