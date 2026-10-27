import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, MotionConfig, motion, useMotionValue, useTransform } from 'motion/react';
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
import { useV53, getV53, setMini, openPalette, closePalette, paneOpenOf } from './state.js';
import Stage from './Stage.jsx';
import Pane, { closePane } from './Pane.jsx';
import TabBar, { place, BAR_H, MINI } from './TabBar.jsx';
import { ComposerBar } from './Chat.jsx';
import Palette from './Palette.jsx';
import Ambient from './Ambient.jsx';

// v5.3's root (task 0502). Daniel on v5.2: "I love the Liquid Glass
// aesthetic play into it a bit more go back to bottom bar tho also it feels a
// bit childish in its current form I love the moving gradients".
//
//   the scene      the photo with the moving light inside it (Scene.jsx,
//                  lens.js, ambient.js): everything below is glass over it
//   the chat       Stage.jsx: one big pane of shader glass, the home screen,
//                  from the top down to the composer
//   the composer   the tab bar's accessory (iOS 26): its own row of glass
//                  over the photo, just above the bar; when the bar
//                  minimises it slides down beside it
//   the tab bar    TabBar.jsx: a floating capsule of glass at the foot —
//                  Chat, Home, Tasks, Fleet, Library, and search beside it
//   the pane       Pane.jsx: every other place and page — beside the chat
//                  on an iPad in landscape, over it (down to the bar) on an
//                  iPhone or an iPad in portrait
//   on top         sheets, the viewer, overlays, the palette, menus, the toast
//
// The bar, the composer and the chat never overlap: each is its own piece of
// glass over the photo, so the shader draws them all for real (a shader
// pane must never have DOM scroll under it). Navigation is v2's (lib/nav.js)
// in its chat-first mode, so the v1 hashes, Back and every `mia panel`
// command keep working.

const Diag = lazy(() => import('../src/shell/Diag.jsx'));
const Lightbox = lazy(() => import('../src/shell/Lightbox.jsx'));
const Viewer = lazy(() => import('../v2/shell/Viewer.jsx'));
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

// the home indicator's inset, in px (0 outside an iPhone / iPad)
function safeBottom() {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none';
  document.body.appendChild(el);
  const h = el.offsetHeight;
  el.remove();
  return h;
}

function useViewport() {
  const read = () => ({ W: window.innerWidth, H: window.innerHeight, sb: safeBottom() });
  const [v, setV] = useState(read);
  useEffect(() => {
    const f = () => setV(read());
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return v;
}

// Where everything sits. Wide (iPad landscape, a Mac window): the pane at the
// right (~56%) when open, the chat — with its composer and the tab bar under
// it — at the left. Narrow (iPhone, iPad portrait, Stage Manager small): the
// chat fills the screen; the pane comes over it, down to the tab bar.
function geometry({ W, sb }, pane) {
  const wide = W >= 1000;
  const narrow = W < 600;
  const G = wide ? 12 : narrow ? 8 : 10;
  const paneW = wide ? Math.max(440, Math.min(880, Math.round(W * 0.56))) : W - 2 * G;
  const left = G;
  const right = G + (wide && pane ? paneW + G : 0);
  return {
    W,
    wide,
    narrow,
    G,
    paneW,
    left,
    right,
    stageW: Math.max(280, W - left - right),
    // the tab bar's bottom edge: clear of the home indicator, no further
    b0: Math.max(G, sb - 12),
    top: `calc(env(safe-area-inset-top) + ${G}px)`,
    radius: narrow ? 30 : 24,
    // narrow (task 0503, Daniel: "maximise space"): the chat's glass fills the
    // screen edge to edge, top to bottom; the header, suggestions, composer and
    // bar float over it, iOS 26 style, the thread fading out under them
    full: !wide,
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

// Scroll into something and the bar minimises (iOS 26's onScrollDown): in
// the chat that's scrolling UP into the history, in a page scrolling down.
// Back to rest (the newest message, a page's top) or a firm scroll the
// other way and it grows back.
function useMinimise() {
  useEffect(() => {
    const tops = new WeakMap();
    let run = 0;
    let owner = null;

    const onScroll = (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      const thread = el.matches('[data-v53-stage] [data-reader="thread"]');
      if (!thread && !el.closest('[data-v53-pane="open"]')) return;
      // only what sits over the bar counts: a chat covered by the pane (narrow)
      // doesn't, and neither does a page beside the chat (wide — it runs the
      // full height, so the bar has nothing to give it)
      const narrow = !!el.closest('[data-v53-shell][data-layout="narrow"]');
      if (thread && narrow && document.querySelector('[data-v53-shell][data-pane-open="true"]')) return;
      if (!thread && !narrow) return;

      const st = el.scrollTop;
      const prev = tops.get(el);
      tops.set(el, st);
      if (prev == null || st === prev) return;
      // once minimised, only the scroller that did it brings the bar back (the
      // chat beside a page settles itself when it gets the room — that's not you)
      if (getV53().mini && owner && owner !== el) return;
      const d = st - prev;
      const rest = thread ? el.scrollHeight - st - el.clientHeight < 24 : st < 8;
      if (rest) {
        run = 0;
        return void setMini(false);
      }
      const into = thread ? d < 0 : d > 0;
      run = into === run > 0 ? run + (into ? 1 : -1) * Math.abs(d) : (into ? 1 : -1) * Math.abs(d);
      if (run > 28) {
        owner = el;
        setMini(true);
      } else if (run < -40) setMini(false);
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, []);
}

export default function App() {
  const needsToken = useMC((s) => s.needsToken);
  const reduce = usePrefs((s) => s.reduce);
  const mini = useV53((s) => s.mini);
  const pane = useNav(paneOpenOf);
  const tab = useNav((s) => s.tab);
  const vp = useViewport();
  const geo = geometry(vp, pane);
  const geoRef = useRef(geo);
  geoRef.current = geo;
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
  useMinimise();
  // a new place starts with the bar at full size
  useEffect(() => {
    setMini(false);
  }, [pane, tab]);

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

  // ---- the foot: tab bar ⇄ minimised, the composer above it or beside it --------
  const m = useMotionValue(0);
  useEffect(() => {
    const a = animate(m, mini ? 1 : 0, reduce ? { duration: 0.18 } : { type: 'spring', stiffness: 340, damping: 34, mass: 0.9 });
    return () => a.stop();
  }, [mini, reduce, m]);
  const AH = useMotionValue(46); // the composer row's height (it grows with text, attachments)
  const showAcc = !(pane && !geo.wide);
  const barHidden = kb && !geo.wide;
  const pad = geo.narrow ? 8 : 12;
  // the composer takes its final width at once (no text reflow per frame while
  // the pane opens beside it); only its position follows the chat on the spring
  const accFull = Math.min(720, geo.W - geo.left - geo.right - 2 * pad);
  const accLeft = useTransform(() => {
    const zl = L.get();
    const zw = geo.W - zl - R.get();
    return zl + (zw - accFull) / 2 + (barHidden ? 0 : m.get() * (MINI + 8));
  });
  const accW = useTransform(() => accFull - (barHidden ? 0 : m.get() * (MINI + 8)));

  const accBottom = useTransform(() => geo.b0 + (barHidden ? 0 : (1 - m.get()) * (BAR_H + 10)));
  // a chat covered by the pane (narrow) holds still: no relayout under the pane
  const covered = pane && !geo.wide;
  const stageBottom = useTransform(() => (covered ? geo.b0 + BAR_H + 10 + AH.get() + 10 : accBottom.get() + AH.get() + 10));

  // the pane keeps its height when the bar minimises (it would gain 12 px, not
  // worth relaying out a page every frame of the morph)
  const paneBottom = geo.wide ? geo.G : geo.b0 + BAR_H + 10;

  const acc = useRef(null);
  const [ah, setAh] = useState(46);
  // full-bleed: how far up from the screen's foot the floating chrome reaches.
  // The thread pads by it (a React value: it changes on a minimise, not per
  // frame); the suggestions ride on stageBottom itself, as a transform.
  const chrome = geo.full ? (covered ? geo.b0 + BAR_H + 10 : geo.b0 + (barHidden || mini ? 0 : BAR_H + 10)) + ah + 10 : 0;
  useEffect(() => {
    const el = acc.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => (AH.set(el.offsetHeight), setAh(el.offsetHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [AH, needsToken]);
  const paneRect = geo.wide ? { right: geo.G, top: geo.top, bottom: paneBottom, width: geo.paneW } : { left: geo.G, right: geo.G, top: geo.top, bottom: paneBottom };
  const mia = useMC((s) => s.mia);

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
          const tops = [...document.querySelectorAll('[data-v53-pane="open"] [data-page][data-top="true"]')].filter((e) => e.getClientRects().length);
          const top = tops.pop();
          const sc = top && [...top.querySelectorAll('.v-scroll, [data-reader]')].filter((e) => e.scrollHeight > e.clientHeight + 8).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
          return sc || null;
        }
        return document.querySelector('[data-v53-stage] [data-reader="thread"]');
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

  // ---- the right edge: the pane you just closed comes back ----------------------
  const reopen = useCallback(() => {
    const last = getV53().last;
    if (!last || paneOpenOf()) return;
    const s = useNav.getState();
    useNav.setState({ tab: last.tab, stacks: { ...s.stacks, [last.tab]: last.stack }, visited: { ...s.visited, [last.tab]: true } });
  }, []);
  useEdgeSwipe(reopen);

  // ---- keyboard (iPad with a keyboard, a Mac) ------------------------------------
  useEffect(() => {
    const typing = () => {
      const el = document.activeElement;
      return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const findField = () => {
      const tops = [...document.querySelectorAll('[data-v53-pane="open"] [data-page][data-top="true"]')].filter((el) => el.getClientRects().length);
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
        if (getV53().palette) closePalette();
        else openPalette();
        return;
      }
      // ⌘\\: minimise or restore the tab bar
      if (cmd && e.key === '\\') {
        e.preventDefault();
        setMini(!getV53().mini);
        return;
      }
      if (cmd && !e.altKey && !e.shiftKey) {
        // ⌘1–8: the tab bar's five, then the ··· menu's three
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
        if (getV53().palette) return closePalette();
        if (sheetOpen()) return;
        if (document.querySelector('[data-msg-menu]')) return;
        if (lightboxOpen()) return closeLightbox();
        const o = useNav.getState().overlay;
        if (o) return o.name === 'tv' || o.name === 'car' ? (location.hash = '') : closeOverlay();
        if (getMC().viewer) return closeViewer();
        if (back()) return;
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
    r.setProperty('--win-pad-bottom', '18px');
    r.setProperty('--tabbar-space', '18px');
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
        data-v53-shell
        data-layout={geo.wide ? 'wide' : 'narrow'}
        data-pane-open={pane ? 'true' : 'false'}
        data-kb={kb ? 'up' : 'down'}
      >
        <Ambient thinking={thinking} />
        <main className="absolute inset-0">
          <Stage geo={geo} L={L} R={R} bottom={stageBottom} chrome={chrome} back={back} onThinking={setThinking} />
          <motion.div
            ref={acc}
            className="v53-acc"
            style={{ left: accLeft, width: accW, bottom: accBottom, opacity: showAcc ? 1 : 0, y: showAcc ? 0 : 14, pointerEvents: showAcc ? 'auto' : 'none', transition: 'opacity .2s, transform .3s cubic-bezier(.25,1,.5,1)' }}
            inert={showAcc ? undefined : true}
            data-v53-acc
          >
            <ComposerBar mia={mia} />
          </motion.div>
          <Pane wide={geo.wide} rect={paneRect} back={back} />
        </main>
        <TabBar geo={geo} L={L} R={R} m={m} mini={mini} hidden={barHidden} chat={!pane || geo.wide} />
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

// From the right edge of the chat (a touch swipe): the pane you closed last
// comes back — iOS's swipe-forward.
function useEdgeSwipe(onReopen) {
  useEffect(() => {
    const EDGE = 24;
    const down = (e) => {
      if (e.button > 0 || e.pointerType === 'mouse') return;
      if (!e.target.closest?.('[data-v53-stage]') || e.target.closest('textarea, input, [data-msg-menu]')) return;
      if (e.clientX < innerWidth - EDGE) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let on = false;
      let lastX = x0;
      let lastT = performance.now();
      let v = 0;
      const move = (ev) => {
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!on) {
          if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) return done();
          if (Math.abs(dx) < 10) return undefined;
          on = true;
        }
        const t = performance.now();
        v = ((ev.clientX - lastX) / Math.max(1, t - lastT)) * 1000;
        lastX = ev.clientX;
        lastT = t;
        return undefined;
      };
      const done = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', done);
        window.removeEventListener('pointercancel', done);
        if (!on || !ev) return;
        if (ev.clientX - x0 < -60 || v < -500) onReopen?.();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', done);
      window.addEventListener('pointercancel', done);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [onReopen]);
}
