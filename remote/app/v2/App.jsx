import { Activity, lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react';
import { animate, motion, MotionConfig, useMotionValue } from 'motion/react';
import { useMC, onPanelCommand, closeViewer, getMC } from '../src/lib/store.js';
import { lightboxOpen, closeLightbox, useLightbox } from '../src/lib/lightbox.js';
import { useUsageSync } from '../src/lib/usage.js';
import { onWake } from '../src/lib/wake.js';
import { startTalk } from '../src/lib/talkSession.js';
import {
  useNav, TABS, topOf, hashFor, applyHash, push, pop, goView, focusTask, openSheet, closeSheet, closeOverlay, openOverlay,
} from './lib/nav.js';
import { usePrefs } from './lib/prefs.js';
import { spring } from './lib/motion.js';
import { useWide } from './ui/hooks.js';
import Stack from './shell/Stack.jsx';
import TabBar from './shell/TabBar.jsx';
import Sheets from './shell/Sheets.jsx';
import Overlays from './shell/Overlays.jsx';
import TalkHost from './shell/TalkHost.jsx';
import { Toast, ConnPill, Gate } from './shell/Chrome.jsx';
import { warmPages } from './shell/pages.js';
import { sheetOpen } from './ui/Sheet.jsx';
import Boundary from './ui/Boundary.jsx';

// v2's root (task 0444). Tabs, each a page stack; one sheet; one overlay; the
// talk session; the toast. All navigation state lives in lib/nav.js — this
// file wires it to the address bar, the keyboard, Mia's panel commands and
// the wake word.

const Diag = lazy(() => import('../src/shell/Diag.jsx'));
const Lightbox = lazy(() => import('../src/shell/Lightbox.jsx'));
const Viewer = lazy(() => import('./shell/Viewer.jsx'));

function TabPane({ tab, active }) {
  const o = useMotionValue(1);
  const s = useMotionValue(1);
  const reduce = usePrefs((st) => st.reduce);
  const [first, setFirst] = useState(true);
  // A tab you switch to fades up into place (never slides — tabs are places,
  // not a sequence).
  useLayoutEffect(() => {
    if (!active) return;
    if (first) return setFirst(false);
    o.set(0);
    animate(o, 1, { duration: 0.2, ease: [0.25, 1, 0.5, 1] });
    if (!reduce) {
      s.set(0.985);
      animate(s, 1, spring.snappy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return (
    <motion.div className="absolute inset-0" style={{ opacity: o, scale: s }} data-tabpane={tab}>
      <Stack tab={tab} active={active} />
    </motion.div>
  );
}

// The on-screen keyboard is up (the visual viewport shrank): the tab bar
// steps aside so the composer gets the room.
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
  const tab = useNav((s) => s.tab);
  const visited = useNav((s) => s.visited);
  const overlay = useNav((s) => s.overlay);
  const topDepth = useNav((s) => s.stacks[s.tab].length - 1);
  const reduce = usePrefs((s) => s.reduce);
  const wide = useWide(700);
  const kb = useKeyboardUp();
  const lightbox = useLightbox((s) => !!s.items);
  // Mia's viewer loads the first time she shows something, then stays.
  const [viewerOn, setViewerOn] = useState(false);
  const viewer = useMC((s) => !!s.viewer);
  useEffect(() => {
    if (viewer) setViewerOn(true);
  }, [viewer]);
  const [diag, setDiag] = useState(location.hash === '#diag');
  useUsageSync();

  // ---- address bar ⇄ navigation ---------------------------------------------
  useEffect(() => {
    if (location.hash && location.hash !== '#diag') applyHash(location.hash, { cold: true });
    const onHash = () => {
      setDiag(location.hash === '#diag');
      if (location.hash !== '#diag') applyHash(location.hash);
    };
    window.addEventListener('hashchange', onHash);
    // replaceState never fires hashchange, so this can't loop.
    const off = useNav.subscribe((s) => {
      if (location.hash === '#diag') return;
      const h = hashFor(s);
      const want = `${location.pathname}${location.search}${h ? '#' + h : ''}`;
      if (location.pathname + location.search + location.hash !== want) history.replaceState(null, '', want);
    });
    warmPages();
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

  // ---- Mia drives the panel (`mia panel …`) -----------------------------------
  useEffect(() => {
    const leaveModes = () => {
      const o = useNav.getState().overlay;
      if (o && (o.name === 'tv' || o.name === 'car')) location.hash = '';
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
        goView(v);
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
        focusTask(id);
      },
      search: (q) => {
        leaveModes();
        openSheet('search', { q });
      },
    };
    // The command runner (and the doc-finding it brings) loads on first use.
    return onPanelCommand((cmd) => import('../src/lib/panelCommands.js')
        .then((m) => m.runPanelCommand(cmd, api))
        .catch((e) => ({ ok: false, detail: `the panel couldn't run that (${e?.message || e})` })));
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

  // ---- keyboard (iPad with a keyboard) ----------------------------------------
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (useNav.getState().sheet?.name === 'search') closeSheet();
        else openSheet('search');
        return;
      }
      if (e.key === 'Escape') {
        if (sheetOpen()) return; // the sheet closes itself
        if (lightboxOpen()) return closeLightbox();
        const o = useNav.getState().overlay;
        if (o) return o.name === 'tv' || o.name === 'car' ? (location.hash = '') : closeOverlay();
        if (getMC().viewer) return closeViewer();
        pop();
        return;
      }
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      const jump = { 1: 'home', 2: 'agents', 3: 'insights', 4: 'library', 5: 'mia', 6: 'hq', 7: 'channels' }[e.key];
      if (jump) {
        e.preventDefault();
        goView(jump);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The tab bar: always on an iPad; on a phone it steps aside on pushed pages
  // (they have Back) and while typing. Pages pad their bottoms by this.
  const barHidden = !!overlay || kb || (!wide && topDepth > 0);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      '--tabbar-space',
      barHidden ? 'calc(env(safe-area-inset-bottom) + 16px)' : `calc(max(10px, env(safe-area-inset-bottom) - 4px) + ${wide ? 84 : 88}px)`,
    );
  }, [barHidden, wide]);

  if (diag)
    return (
      <Suspense fallback={null}>
        <Diag />
      </Suspense>
    );
  if (needsToken) return <Gate />;

  return (
    <MotionConfig reducedMotion={reduce ? 'always' : 'never'}>
      <div className="relative overflow-hidden bg-page" style={{ height: 'calc(100dvh + var(--vgap))' }}>
        <main className="absolute inset-0">
          {TABS.filter((t) => visited[t]).map((t) => (
            <Activity key={t} mode={t === tab ? 'visible' : 'hidden'}>
              <TabPane tab={t} active={t === tab} />
            </Activity>
          ))}
        </main>
        <TabBar hidden={barHidden} />
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
