import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, MotionConfig, useMotionValue } from 'motion/react';
import { useMC, onPanelCommand, closeViewer, getMC } from '../src/lib/store.js';
import { lightboxOpen, closeLightbox, useLightbox } from '../src/lib/lightbox.js';
import { useUsageSync } from '../src/lib/usage.js';
import { onWake } from '../src/lib/wake.js';
import { startTalk } from '../src/lib/talkSession.js';
import { useNav, topOf, hashFor, applyHash, push, pop, openSheet, closeSheet, closeOverlay, openOverlay } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring } from '../v2/lib/motion.js';
import Sheets from '../v2/shell/Sheets.jsx';
import Overlays from '../v2/shell/Overlays.jsx';
import TalkHost from '../v2/shell/TalkHost.jsx';
import { Toast, ConnPill, Gate } from '../v2/shell/Chrome.jsx';
import { warmPages } from '../v2/shell/pages.js';
import { sheetOpen } from '../v2/ui/Sheet.jsx';
import Boundary from '../v2/ui/Boundary.jsx';
import { PullToRefresh, ContextMenus, ShortcutsHUD, useRemembered, refreshNow } from '../v5/ux.jsx';
import { useV52, getV52, setSide, toggleSide, endPeek, openPalette, closePalette, paneOpenOf } from './state.js';
import Stage from './Stage.jsx';
import Pane, { closePane } from './Pane.jsx';
import Side, { place, useEdgeSwipes } from './Side.jsx';
import Palette from './Palette.jsx';
import Ambient from './Ambient.jsx';

// v5.2's root (task 0491) — chat first. Daniel: "make the chat the focus,
// then have a side panel that accesses the other things, make it all Liquid
// Glass smooth with sick animations".
//
//   the photo      v5's Lens scene (the refracting shader) under everything,
//                  with the ambient light (Ambient.jsx) drifting over it
//   the chat       Stage.jsx: one big pane of glass, the home screen
//   the side panel Side.jsx: a floating glass panel — over the chat on an
//                  iPhone, beside it on an iPad in landscape
//   the pane       Pane.jsx: every other place and page, beside the chat
//                  (iPad landscape) or as a sheet over it
//   on top         sheets, the viewer, overlays (voice, console, TV/car),
//                  the command palette, menus, the toast — CSS glass
//
// Navigation is v2's (lib/nav.js) in its chat-first mode: the Mia place is
// the chat; anything stacked on it, or any other place, is the pane. So the
// v1 hashes, Back/swipe-back and every `mia panel` command keep working.

const Diag = lazy(() => import('../src/shell/Diag.jsx'));
const Lightbox = lazy(() => import('../src/shell/Lightbox.jsx'));
const Viewer = lazy(() => import('../v2/shell/Viewer.jsx'));
const LensScene = lazy(() => import('../v5/Scene.jsx'));
function Scene() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
    const cancel = window.cancelIdleCallback || clearTimeout;
    const id = idle(() => setOn(true), { timeout: 600 });
    return () => cancel(id);
  }, []);
  return on ? (
    <Suspense fallback={null}>
      <LensScene />
    </Suspense>
  ) : null;
}

function useViewport() {
  const read = () => ({ W: window.innerWidth, H: window.innerHeight });
  const [v, setV] = useState(read);
  useEffect(() => {
    const f = () => setV(read());
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return v;
}

// Where everything sits. Wide (iPad landscape, a Mac window): the side panel
// pinned at the left (~a quarter), the pane at the right (~56%), the chat
// between — and when all three won't fit, the side panel steps aside while a
// pane is open. Narrow (iPhone, iPad portrait, Stage Manager small): the chat
// fills the screen; the side panel and the pane come over it.
function geometry({ W }, side, pane, peek = false) {
  const wide = W >= 1000;
  const narrow = W < 600;
  const G = wide ? 12 : narrow ? 6 : 10;
  const sideW = wide ? Math.min(300, Math.max(256, Math.round(W * 0.22))) : Math.min(Math.round(W * 0.84), 340);
  const paneW = wide ? Math.max(440, Math.min(880, Math.round(W * 0.56))) : W - 2 * G;
  const tight = wide && pane && side && W - sideW - paneW - 4 * G < 420;
  const pinned = wide && side && !tight;
  const left = G + (pinned ? sideW + G : 0);
  const right = G + (wide && pane ? paneW + G : 0);
  return {
    wide,
    narrow,
    G,
    sideW,
    paneW,
    pinned,
    sideShown: side && (!tight || peek),
    left,
    right,
    stageW: Math.max(280, W - left - right),
    top: `calc(env(safe-area-inset-top) + ${G}px)`,
    bottom: `${G}px`,
    radius: narrow ? 28 : 32,
    pane: wide
      ? { right: G, top: `calc(env(safe-area-inset-top) + ${G}px)`, bottom: G, width: paneW }
      : { left: G, right: G, top: `calc(env(safe-area-inset-top) + ${G + (narrow ? 8 : 14)}px)`, bottom: G },
  };
}

function useKeyboardUp() {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const f = () => setUp(window.innerHeight - vv.height > 150);
    vv.addEventListener('resize', f);
    return () => vv.removeEventListener('resize', f);
  }, []);
  return up;
}

export default function App() {
  const needsToken = useMC((s) => s.needsToken);
  const reduce = usePrefs((s) => s.reduce);
  const side = useV52((s) => s.side);
  const peek = useV52((s) => s.peek);
  const pane = useNav(paneOpenOf);
  const vp = useViewport();
  const geo = geometry(vp, side, pane, peek);
  const geoRef = useRef(geo);
  geoRef.current = geo;
  // a side panel brought over a pane goes back once you've picked (or the pane closes)
  useEffect(() => {
    if (!pane) endPeek();
  }, [pane]);
  const kb = useKeyboardUp();
  const lightbox = useLightbox((s) => !!s.items);
  const [viewerOn, setViewerOn] = useState(false);
  const viewer = useMC((s) => !!s.viewer);
  const [thinking, setThinking] = useState(false);
  useEffect(() => {
    if (viewer) setViewerOn(true);
  }, [viewer]);
  const [diag, setDiag] = useState(location.hash === '#diag');
  useUsageSync();
  useRemembered();

  // a phone never starts with the panel over the chat
  useLayoutEffect(() => {
    if (window.innerWidth < 1000 && getV52().side) setSide(false, { remember: false });
  }, []);

  // ---- the chat's frame follows the layout on a spring --------------------------
  const L = useMotionValue(geo.left);
  const R = useMotionValue(geo.right);
  const back = useMotionValue(0);
  useEffect(() => {
    const sp = reduce ? { duration: 0.2 } : spring.sheet;
    const a = animate(L, geo.left, sp);
    const b = animate(R, geo.right, sp);
    return () => (a.stop(), b.stop());
  }, [geo.left, geo.right, reduce, L, R]);

  // ---- address bar ⇄ navigation (v1's hashes; no hash = the chat) ----------------
  useEffect(() => {
    if (location.hash && location.hash !== '#diag') applyHash(location.hash, { cold: true });
    const onHash = () => {
      setDiag(location.hash === '#diag');
      if (location.hash !== '#diag') applyHash(location.hash);
    };
    window.addEventListener('hashchange', onHash);
    const off = useNav.subscribe((s) => {
      if (location.hash === '#diag') return;
      const h = hashFor(s);
      const want = `${location.pathname}${location.search}${h ? '#' + h : ''}`;
      if (location.pathname + location.search + location.hash !== want) history.replaceState(null, '', want);
    });
    warmPages(['task', 'doc', 'agent', 'home', 'agents', 'library', 'tasks', 'insights', 'settings', 'hq']);
    return () => {
      window.removeEventListener('hashchange', onHash);
      off();
    };
  }, []);

  // ---- a doc just created (New / Research): open it --------------------------
  const lastCreated = useMC((s) => s.lastCreatedDocId);
  const docs = useMC((s) => s.docs);
  useEffect(() => {
    if (!lastCreated) return;
    const meta = (docs || []).find((d) => d.id === lastCreated);
    if (!meta) return;
    useMC.setState({ lastCreatedDocId: '' });
    push('doc', { id: lastCreated, edit: meta.kind !== 'research' });
  }, [lastCreated, docs]);

  // ---- Mia drives the panel (`mia panel …`): every door lands in the pane ------
  useEffect(() => {
    const leaveModes = () => {
      const o = useNav.getState().overlay;
      if (o && (o.name === 'tv' || o.name === 'car')) location.hash = '';
      else if (o) closeOverlay();
    };
    const clear = () => {
      closeViewer();
      leaveModes();
      closeSheet();
      closePalette();
    };
    const api = {
      docId: () => {
        const t = topOf();
        return paneOpenOf() && t.name === 'doc' ? t.params.id : null;
      },
      closeDoc: () => topOf().name === 'doc' && pop(),
      view: (v) => {
        clear();
        place(v === 'agents' ? 'fleet' : v);
      },
      openDoc: (id) => (clear(), push('doc', { id })),
      openAgent: (id) => (clear(), push('agent', { id })),
      openTask: (id) => (clear(), push('task', { id })),
      search: (q) => {
        leaveModes();
        closePalette();
        openSheet('search', { q });
      },
      // what "the view" is for scroll / scroll-to / highlight: the pane's top
      // page when it's open, else the chat
      scroller: () => {
        if (paneOpenOf()) {
          const tops = [...document.querySelectorAll('[data-v52-pane="open"] [data-page][data-top="true"]')].filter((e) => e.getClientRects().length);
          const top = tops.pop();
          const sc = top && [...top.querySelectorAll('.v-scroll, [data-reader]')].filter((e) => e.scrollHeight > e.clientHeight + 8).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
          return sc || null;
        }
        return document.querySelector('[data-v52-stage] [data-reader="thread"]');
      },
    };
    return onPanelCommand((cmd) =>
      import('../src/lib/panelCommands.js')
        .then((m) => m.runPanelCommand(cmd, api))
        .catch((e) => ({ ok: false, detail: `the panel couldn't run that (${e?.message || e})` })),
    );
  }, []);

  // ---- "Hey Mia" ---------------------------------------------------------------
  useEffect(
    () =>
      onWake(() => {
        startTalk({ prime: false });
        openOverlay('voice');
      }),
    [],
  );

  // ---- edge swipes: left = the side panel, right = the pane you just closed -----
  const reopen = useCallback(() => {
    const last = getV52().last;
    if (!last || paneOpenOf()) return;
    const s = useNav.getState();
    useNav.setState({ tab: last.tab, stacks: { ...s.stacks, [last.tab]: last.stack }, visited: { ...s.visited, [last.tab]: true } });
  }, []);
  useEdgeSwipes({ width: geo.sideW, onReopen: reopen });

  // ---- keyboard (iPad with a keyboard, a Mac) ------------------------------------
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const findField = () => {
      const tops = [...document.querySelectorAll('[data-v52-pane="open"] [data-page][data-top="true"]')].filter((el) => el.getClientRects().length);
      return tops.pop()?.querySelector('input[type="search"], input[placeholder^="Search"]') || null;
    };
    // Back: down the pane's stack; from its first page, the pane closes
    const back = () => {
      const s = useNav.getState();
      if (!paneOpenOf(s)) return false;
      if (s.stacks[s.tab].length <= (s.tab === 'mia' ? 2 : 1)) closePane();
      else pop();
      return true;
    };
    const onKey = (e) => {
      const cmd = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (cmd && k === 'k') {
        e.preventDefault();
        if (getV52().palette) closePalette();
        else openPalette();
        return;
      }
      if (cmd && e.key === '\\') {
        e.preventDefault();
        toggleSide(geoRef.current.sideShown);
        return;
      }
      if (cmd && !e.altKey && !e.shiftKey) {
        // ⌘1–8: the side panel's order
        const key = { 1: 'chat', 2: 'home', 3: 'tasks', 4: 'fleet', 5: 'library', 6: 'hq', 7: 'insights', 8: 'settings' }[e.key];
        const find = () => {
          const f = findField();
          if (f) (f.focus(), f.select());
          else openPalette();
        };
        const acts = { '[': () => back(), f: find, n: () => openSheet('newdoc'), l: () => openSheet('launch'), r: () => refreshNow(), ',': () => place('settings'), i: () => place('insights'), j: () => document.querySelector('[data-composer]')?.focus() };
        const act = key ? () => place(key) : acts[k];
        if (act) {
          if (typing() && (k === 'f' || k === 'r' || k === '[')) return;
          e.preventDefault();
          act();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (getV52().palette) return closePalette();
        if (sheetOpen()) return;
        if (document.querySelector('[data-msg-menu]')) return;
        if (lightboxOpen()) return closeLightbox();
        const o = useNav.getState().overlay;
        if (o) return o.name === 'tv' || o.name === 'car' ? (location.hash = '') : closeOverlay();
        if (getMC().viewer) return closeViewer();
        if (back()) return;
        if (getV52().side && window.innerWidth < 1000) return setSide(false, { remember: false });
        return;
      }
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      // '/' starts a message, as in a chat app
      if (e.key === '/') {
        e.preventDefault();
        document.querySelector('[data-composer]')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- frame variables for the pages (inside the pane) and floating pieces ----------
  useLayoutEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--win-top', '0px');
    r.setProperty('--win-x', '0px');
    r.setProperty('--win-bottom', '0px');
    r.setProperty('--win-pad-bottom', 'calc(18px + env(safe-area-inset-bottom))');
    r.setProperty('--tabbar-space', 'calc(18px + env(safe-area-inset-bottom))');
    r.setProperty('--home-bottom', '24px');
  }, []);

  if (diag)
    return (
      <Suspense fallback={null}>
        <Diag />
      </Suspense>
    );
  if (needsToken)
    return (
      <>
        <Scene />
        <Gate />
      </>
    );

  return (
    <MotionConfig reducedMotion={reduce ? 'always' : 'never'}>
      <Scene />
      <div
        className="relative overflow-hidden"
        style={{ height: 'calc(100dvh + var(--vgap))' }}
        data-v5-shell
        data-v52-shell
        data-layout={geo.wide ? 'wide' : 'narrow'}
        data-pane-open={pane ? 'true' : 'false'}
        data-kb={kb ? 'up' : 'down'}
      >
        <Ambient thinking={thinking} />
        <main className="absolute inset-0">
          <Stage geo={geo} L={L} R={R} back={back} onThinking={setThinking} />
          <Pane wide={geo.wide} rect={geo.pane} back={back} />
        </main>
        <Side width={geo.sideW} shown={geo.sideShown} pinned={geo.pinned} wide={geo.wide} />
        <ConnPill />
        <Boundary>
          <Sheets />
        </Boundary>
        {viewerOn && (
          <Boundary>
            <Suspense fallback={null}>
              <Viewer />
            </Suspense>
          </Boundary>
        )}
        <Boundary>
          <Overlays />
        </Boundary>
        <TalkHost />
        <PullToRefresh />
        <ContextMenus />
        <ShortcutsHUD />
        <Palette />
        {lightbox && (
          <Suspense fallback={null}>
            <Lightbox />
          </Suspense>
        )}
        <Toast />
      </div>
    </MotionConfig>
  );
}

