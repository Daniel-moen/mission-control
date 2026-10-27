import { create } from 'zustand';
import { useNav, topOf } from '../v2/lib/nav.js';

// v5.2's own UI state (task 0491). Navigation itself is v2's (lib/nav.js:
// one page stack per place); this is only what the chat-first shell adds:
//   side      the glass side panel is open
//   palette   the command palette (⌘K) is open
//   draft     text a chip or a message menu puts in the composer ({ text, n })
//   origin    the rect a pane grows out of (a card in the chat) — shared
//             element, consumed by the pane on its next open
//   last      the pane you closed last (a right-edge swipe brings it back)

const LS_SIDE = 'mc.v52.side';
const readSide = () => {
  try {
    return localStorage.getItem(LS_SIDE) === '1';
  } catch {
    return false;
  }
};

export const useV52 = create(() => ({
  side: readSide(),
  peek: false, // the side panel shown over the chat although there's no room to pin it (a pane is open)
  palette: false,
  draft: null,
  origin: null,
  last: null,
}));

const set = (p) => useV52.setState(p);
export const getV52 = () => useV52.getState();

export function setSide(open, { remember = true } = {}) {
  if (!open && getV52().peek) set({ peek: false });
  if (getV52().side === open) return;
  set({ side: open });
  if (remember) {
    try {
      localStorage.setItem(LS_SIDE, open ? '1' : '0');
    } catch {
      /* private mode */
    }
  }
}
// `shown`: whether it's on screen now. Hidden to make room for a pane, the
// button (or ⌘\\) brings it back over the chat instead of switching it off.
export function toggleSide(shown = getV52().side) {
  if (shown) return setSide(false);
  set({ peek: true });
  setSide(true);
}
export const endPeek = () => getV52().peek && set({ peek: false });

export const openPalette = () => set({ palette: true });
export const closePalette = () => getV52().palette && set({ palette: false });

export function setDraft(text) {
  set({ draft: { text, n: (getV52().draft?.n || 0) + 1 } });
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
  const o = getV52().origin;
  if (!o) return null;
  set({ origin: null });
  return performance.now() - o.at < 800 ? o : null;
}

// The pane you just closed: tab + its stack, for the right-edge swipe.
export function rememberPane(snapshot) {
  set({ last: snapshot });
}
