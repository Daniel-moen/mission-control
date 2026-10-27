import { Activity, lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react';
import { animate, motion, MotionConfig, useMotionValue } from 'motion/react';
import { useMC, onPanelCommand, closeViewer, getMC } from '../src/lib/store.js';
import { lightboxOpen, closeLightbox, useLightbox } from '../src/lib/lightbox.js';
import { useUsageSync } from '../src/lib/usage.js';
import { onWake } from '../src/lib/wake.js';
import { startTalk } from '../src/lib/talkSession.js';
import { useNav, TABS, topOf, hashFor, applyHash, push, pop, goView, openSheet, closeSheet, closeOverlay, openOverlay } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring } from '../v2/lib/motion.js';
import { useWide } from '../v2/ui/hooks.js';
import Stack from '../v2/shell/Stack.jsx';
import Sheets from '../v2/shell/Sheets.jsx';
import Overlays from '../v2/shell/Overlays.jsx';
import TalkHost from '../v2/shell/TalkHost.jsx';
import { Toast, ConnPill, Gate } from '../v2/shell/Chrome.jsx';
import { warmPages } from '../v2/shell/pages.js';
import { sheetOpen } from '../v2/ui/Sheet.jsx';
import Boundary from '../v2/ui/Boundary.jsx';
import { TopBar, Dock, place, goSettings } from './Chrome.jsx';
import { PullToRefresh, ContextMenus, ShortcutsHUD, useRemembered, refreshNow } from './ux.jsx';

// v5's root (task 0483): Mission Control's ORIGINAL structure — v1's — in
// v4's Lens glass. The photograph is the room and Home is its resting state
// (greeting, one true sentence, the useful button, figures, what waits on
// you). Every other place — Mia, Fleet, Library, Insights, HQ, Settings, a
// doc, an agent, a task — opens as a window of glass over it, from the dock
// or the top bar. Library is a normal vertical page; a doc opens in its own
// window (the reader), Back returns to the list. No sidebars.
//
// Under the hood it is v2's navigation (lib/nav.js: one page stack per
// place, Back/swipe-back, the v1 hashes in the address bar) and v2's pages
// (v1's information and flows, rebuilt without v1's components), so the
// protocol, store and `mia panel` commands are the same as v1/v2/v4.

const Diag = lazy(() => import('../src/shell/Diag.jsx'));
const Lightbox = lazy(() => import('../src/shell/Lightbox.jsx'));
const Viewer = lazy(() => import('../v2/shell/Viewer.jsx'));
// The scene loads right after first paint — content first, the photo a beat later.
const LensScene = lazy(() => import('./Scene.jsx'));
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

// Tabs don't close (an iOS tab bar is always there) — except Mia's chat,
// which hides the tab bar (v1's rule, 0290), so it keeps a close button.
function TabPane({ tab, active }) {
  const o = useMotionValue(1);
  const s = useMotionValue(1);
  const reduce = usePrefs((st) => st.reduce);
  const [first, setFirst] = useState(true);
  // A place you switch to rises into view (places, not a sequence).
  useLayoutEffect(() => {
    if (!active) return;
    if (first) return setFirst(false);
    o.set(0);
    animate(o, 1, { duration: 0.2, ease: [0.25, 1, 0.5, 1] });
    if (!reduce) {
      s.set(0.97);
      animate(s, 1, spring.snappy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return (
    <motion.div className="absolute inset-0" style={{ opacity: o, scale: s }} data-tabpane={tab}>
      <Stack tab={tab} active={active} onClose={tab === 'mia' ? () => goView('home') : null} />
    </motion.div>
  );
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

// Which dock button is lit: the place you're in.
// HQ is a tab that opens over Home (Insights and Settings are Home's pages).
function activeOf(s) {
  if (s.tab === 'home' && s.stacks.home[1]?.name === 'hq') return 'hq';
  if (s.tab === 'agents') return 'fleet';
  return s.tab;
}

export default function App() {
  const needsToken = useMC((s) => s.needsToken);
  const tab = useNav((s) => s.tab);
  const visited = useNav((s) => s.visited);
  const overlay = useNav((s) => s.overlay);
  const topName = useNav((s) => topOf(s).name);
  const active = useNav(activeOf);
  const reduce = usePrefs((s) => s.reduce);
  const wide = useWide(700);
  const kb = useKeyboardUp();
  const lightbox = useLightbox((s) => !!s.items);
  const [viewerOn, setViewerOn] = useState(false);
  const viewer = useMC((s) => !!s.viewer);
  useEffect(() => {
    if (viewer) setViewerOn(true);
  }, [viewer]);
  const [diag, setDiag] = useState(location.hash === '#diag');
  useUsageSync();
  useRemembered();

  // ---- address bar ⇄ navigation (v1's hashes) ---------------------------------
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
    warmPages(['mia', 'agents', 'library', 'doc', 'agent', 'task', 'insights', 'settings', 'hq']);
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

  // ---- Mia drives the panel (`mia panel …`) — every door opens in v5 glass ----
  useEffect(() => {
    const leaveModes = () => {
      const o = useNav.getState().overlay;
      if (o && (o.name === 'tv' || o.name === 'car')) location.hash = '';
      else if (o) closeOverlay();
    };
    const api = {
      docId: () => {
        const t = topOf();
        return t.name === 'doc' ? t.params.id : null;
      },
      closeDoc: () => topOf().name === 'doc' && pop(),
      view: (v) => {
        closeViewer();
        leaveModes();
        closeSheet();
        place(v === 'agents' ? 'fleet' : v);
      },
      openDoc: (id) => {
        closeViewer();
        leaveModes();
        closeSheet();
        push('doc', { id });
      },
      openAgent: (id) => {
        closeViewer();
        leaveModes();
        closeSheet();
        push('agent', { id });
      },
      openTask: (id) => {
        closeViewer();
        leaveModes();
        closeSheet();
        push('task', { id });
      },
      search: (q) => {
        leaveModes();
        openSheet('search', { q });
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

  // ---- keyboard (iPad with a keyboard): v1's keys ------------------------------
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    // the field to find in: the top page's search box (Library, Fleet), else Search
    const findField = () => {
      const tops = [...document.querySelectorAll('[data-page][data-top="true"]')].filter((el) => el.getClientRects().length);
      return tops.pop()?.querySelector('input[type="search"], input[placeholder^="Search"]') || null;
    };
    const onKey = (e) => {
      const cmd = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (cmd && k === 'k') {
        e.preventDefault();
        if (useNav.getState().sheet?.name === 'search') closeSheet();
        else openSheet('search');
        return;
      }
      // iPadOS conventions (task 0486): ⌘1–5 the tabs, ⌘[ back, ⌘F find,
      // ⌘N new, ⌘L launch, ⌘R refresh, ⌘, settings, ⌘I insights
      if (cmd && !e.altKey && !e.shiftKey) {
        const tabKey = { 1: 'home', 2: 'mia', 3: 'fleet', 4: 'library', 5: 'hq' }[e.key];
        const find = () => {
          const f = findField();
          if (f) (f.focus(), f.select());
          else openSheet('search');
        };
        const acts = { '[': () => pop() || (useNav.getState().tab !== 'home' && goView('home')), f: find, n: () => openSheet('newdoc'), l: () => openSheet('launch'), r: () => refreshNow(), ',': () => goSettings(), i: () => place('insights') };
        const act = tabKey ? () => place(tabKey) : acts[k];
        if (act) {
          if (typing() && (k === 'f' || k === 'r' || k === '[')) return; // the field's own find/undo
          e.preventDefault();
          act();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (sheetOpen()) return; // the sheet closes itself
        if (lightboxOpen()) return closeLightbox();
        const o = useNav.getState().overlay;
        if (o) return o.name === 'tv' || o.name === 'car' ? (location.hash = '') : closeOverlay();
        if (getMC().viewer) return closeViewer();
        // Back, and from a place's first page, back to Home (v1: Esc closes the window)
        if (!pop() && useNav.getState().tab !== 'home') goView('home');
        return;
      }
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      // v1's single keys, kept for its muscle memory
      const jump = { 1: 'home', 2: 'fleet', 3: 'insights', 4: 'library', 5: 'mia', 6: 'hq', 7: 'channels' }[e.key];
      if (jump) {
        e.preventDefault();
        place(jump);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- the frame: v1's chrome rules (task 0290) -------------------------------
  // Mia's chat is just the chat (no dock, no top bar); a report keeps a
  // compact dock and loses the top bar, so the document gets the height.
  // On a phone a window covers the top bar; on an iPad it sits below it.
  const home = tab === 'home' && topName === 'home';
  const dock = overlay || kb ? 'none' : topName === 'mia' ? 'none' : topName === 'doc' ? 'compact' : 'full';
  const topBar = !overlay && (home || (wide && dock === 'full'));
  useLayoutEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--win-top', topBar ? 'calc(env(safe-area-inset-top) + 62px)' : `calc(env(safe-area-inset-top) + ${wide ? 14 : 6}px)`);
    r.setProperty('--win-x', wide ? '16px' : '6px');
    // v5.1 (task 0486): a window runs to the bottom edge and its content
    // scrolls on under the floating tab bar (iOS 26), instead of stopping
    // short of it on a band of photo.
    r.setProperty('--win-bottom', `max(${wide ? 14 : 6}px, env(safe-area-inset-bottom))`);
    r.setProperty('--win-pad-bottom', dock === 'full' ? `calc(${wide ? 72 : 84}px + max(0px, env(safe-area-inset-bottom) - 6px))` : dock === 'compact' ? 'calc(58px + env(safe-area-inset-bottom))' : '18px');
    r.setProperty('--home-bottom', 'calc(env(safe-area-inset-bottom) + 96px)');
    // v2's pages pad for its tab bar with this; inside a v5 window it's local (v5.css)
    r.setProperty('--tabbar-space', 'calc(env(safe-area-inset-bottom) + 84px)');
  }, [topBar, dock, wide]);

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
      <div className="relative overflow-hidden" style={{ height: 'calc(100dvh + var(--vgap))' }} data-v5-shell data-dock-mode={dock}>
        <main className="absolute inset-0">
          {TABS.filter((t) => visited[t]).map((t) => (
            <Activity key={t} mode={t === tab ? 'visible' : 'hidden'}>
              <TabPane tab={t} active={t === tab} />
            </Activity>
          ))}
        </main>
        {topBar && <TopBar />}
        <Dock mode={dock} active={active} wide={wide} />
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
