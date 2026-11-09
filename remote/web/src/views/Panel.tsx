'use client';
// The app: scene behind, five panes (kept mounted, so switching never pops
// in), the floating glass dock, one sheet on top, toasts, talk mode.

import { AnimatePresence, animate, motion, useDragControls, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { energy, initGlassPrefs, photoTransform, sceneTime, setScenePhoto, useGlassPrefs } from '@/lib/glass';
import { GlassLayer } from '@/ui/GlassLayer';
import { boot, getMC, panelDone, saveToken, useMC } from '@/lib/store';
import { TABS, close, go, open, readHash, setTalk, useNav, type Tab } from '@/lib/nav';
import { Glass, Icon, liquidSpring, pressSpring, sheetSpring, spring } from '@/ui/kit';
import { Now, useAttention } from './Now';
import { Tasks } from './Tasks';
import { MiaChat } from './MiaChat';
import { Library } from './Library';
import { Fleet } from './Fleet';
import { SheetBody } from './Sheets';
import { Talk } from './Talk';
import { Liquid } from '@/ui/Liquid';

const LABEL: Record<Tab, string> = { now: 'Now', tasks: 'Tasks', mia: 'Mia', library: 'Library', fleet: 'Fleet' };
const ICON: Record<Tab, string> = { now: 'now', tasks: 'tasks', mia: 'mia', library: 'library', fleet: 'fleet' };

function Scene() {
  const [photo, setPhoto] = useState('');
  const [mode, setMode] = useState('photo');
  const calm = useGlassPrefs((s) => s.calm);
  const gl = useGlassPrefs((s) => s.gl);
  const photoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const m = localStorage.getItem('mc6_scene') || 'photo';
    setMode(m);
    const h = new Date().getHours();
    const n = String((Math.floor(h / 2.4) % 10) + 1).padStart(2, '0');
    const url = `/bg/${localStorage.getItem('mc6_bg') || n}.jpg`;
    const img = new Image();
    img.onload = () => {
      setPhoto(url);
      setScenePhoto(m === 'gradient' ? null : img, m === 'gradient' ? 'gradient' : 'photo');
    };
    img.src = url;
    if (m === 'gradient') setScenePhoto(null, 'gradient');
  }, []);
  // the photo's drift is driven from the scene clock (not CSS) so the glass
  // lenses refract exactly what's on screen
  useEffect(() => {
    let raf = 0, last = 0;
    const el = photoRef.current;
    if (!el) return;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden || now - last < 32) return;
      last = now;
      el.style.transform = photoTransform(sceneTime(now));
    };
    if (calm) el.style.transform = photoTransform(0);
    else raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [calm]);
  return (
    <div className={`scene ${mode === 'gradient' ? 'gradient' : ''} ${gl ? '' : 'nogl'}`} aria-hidden>
      <div ref={photoRef} className={`scene-photo ${photo ? 'on' : ''}`} style={photo ? { backgroundImage: `url(${photo})` } : undefined} />
      <div className="blob a" />
      <div className="blob b" />
      <div className="blob c" />
      <SceneLiquid photo={mode !== 'gradient'} />
      <div className="scene-tint" />
    </div>
  );
}

function SceneLiquid({ photo }: { photo: boolean }) {
  const n = useMC((s) => s.agents.filter((a) => a.status === 'active').length + (s.mia?.jobs?.jobs || []).filter((j) => j.status === 'running').length);
  useEffect(() => {
    energy.target = Math.min(1, n / 6);
  }, [n]);
  return <Liquid photo={photo} />;
}

// The selected-tab pill is a drop of liquid: its leading edge races ahead and
// the trailing edge catches up, so it stretches (and thins) as it slides, then
// settles with a little wobble. Pressing a tab swells it like iOS 26.
function DockPill({ index, btns, pressed }: { index: number; btns: React.MutableRefObject<(HTMLButtonElement | null)[]>; pressed: boolean }) {
  const left = useMotionValue(0);
  const right = useMotionValue(0);
  const width = useTransform([left, right], ([l, r]: number[]) => Math.max(0, r - l));
  const base = useRef(0);
  const scaleY = useTransform(width, (w) => (base.current ? Math.max(0.84, Math.min(1, 1 - ((w - base.current) / base.current) * 0.14)) : 1));
  const prev = useRef(-1);
  useLayoutEffect(() => {
    const place = (instant: boolean) => {
      const b = btns.current[index];
      if (!b) return;
      const L = b.offsetLeft, R = b.offsetLeft + b.offsetWidth;
      base.current = b.offsetWidth;
      if (instant || prev.current < 0) {
        left.set(L);
        right.set(R);
      } else {
        const toRight = index > prev.current;
        const fast = { type: 'spring' as const, stiffness: 620, damping: 34 };
        const slow = { type: 'spring' as const, stiffness: 230, damping: 22, mass: 1 };
        animate(left, L, toRight ? slow : fast);
        animate(right, R, toRight ? fast : slow);
      }
      prev.current = index;
    };
    place(false);
    const r = () => place(true);
    addEventListener('resize', r);
    return () => removeEventListener('resize', r);
  }, [index, btns, left, right]);
  return (
    <motion.span
      className="sel"
      style={{ left, width, scaleY }}
      animate={{ scale: pressed ? 1.12 : 1 }}
      transition={pressSpring}
      aria-hidden
    />
  );
}

function Dock() {
  const tab = useNav((s) => s.tab);
  const { qs, asks } = useAttention();
  const badge = qs.length + asks.length;
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const [pressed, setPressed] = useState(false);
  return (
    <>
    <div className="edge-bottom" aria-hidden />
    <div className="dock-wrap">
      <Glass lens className="dock" radius={999} animate={{ scale: pressed ? 1.018 : 1 }} transition={pressSpring} onPointerDown={() => { setPressed(true); const up = () => { setPressed(false); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); }; addEventListener('pointerup', up); addEventListener('pointercancel', up); }}>
        {TABS.map((t, i) => (
          <button key={t} ref={(el) => { btns.current[i] = el; }} className={tab === t ? 'on' : ''} onClick={() => go(t)} aria-label={LABEL[t]} data-tab={t}>
            <Icon name={ICON[t]} size={22} style={{ position: 'relative' }} />
            <span style={{ position: 'relative' }}>{LABEL[t]}</span>
            {t === 'now' && badge ? <span className="badge num">{badge}</span> : null}
          </button>
        ))}
        <DockPill index={TABS.indexOf(tab)} btns={btns} pressed={pressed} />
      </Glass>
      <Glass lens as="button" className="talk-fab" radius={999} onClick={() => setTalk(true)} aria-label="Talk to Mia" initial={{ x: -70, scale: 0.5 }} animate={{ x: 0, scale: 1 }} transition={{ ...liquidSpring, delay: 0.35 }} whileTap={{ scale: 1.1, transition: pressSpring }}>
        <Icon name="wave" size={24} />
      </Glass>
    </div>
    </>
  );
}

function Panes() {
  const tab = useNav((s) => s.tab);
  const idx = TABS.indexOf(tab);
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set(['now']));
  useEffect(() => setSeen((s) => (s.has(tab) ? s : new Set([...s, tab]))), [tab]);
  return (
    <>
      {TABS.map((t, i) => {
        const on = t === tab;
        return (
          <motion.div
            key={t}
            className="pane"
            data-pane={t}
            initial={false}
            animate={on ? { opacity: 1, x: 0, scale: 1, visibility: 'visible' } : { opacity: 0, x: i < idx ? -28 : 28, scale: 0.985, transitionEnd: { visibility: 'hidden' } }}
            transition={{ ...spring, opacity: { duration: 0.22 } }}
            style={{ pointerEvents: on ? 'auto' : 'none', zIndex: on ? 2 : 1 }}
            aria-hidden={!on}
          >
            {seen.has(t) || on ? (
              t === 'now' ? <Now /> : t === 'tasks' ? <Tasks /> : t === 'mia' ? <MiaChat active={on} /> : t === 'library' ? <Library /> : <Fleet />
            ) : null}
          </motion.div>
        );
      })}
    </>
  );
}

function Sheet() {
  const sheet = useNav((s) => s.sheet);
  const origin = useNav((s) => s.origin);
  const drag = useDragControls();
  const key = sheet ? `${sheet.kind}:${'id' in sheet ? sheet.id : ''}` : '';
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
  return (
    <AnimatePresence>
      {sheet ? (
        <motion.div key="scrim" className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} onClick={close} />
      ) : null}
      {sheet ? (
        <div key={`host-${key}`} className="sheet-host">
          <Glass
            variant="deep"
            className="sheet"
            layoutId={origin || undefined}
            style={{ borderRadius: 34 }}
            initial={origin ? undefined : { y: '100%', opacity: 0.6, scaleX: 0.92 }}
            animate={origin ? undefined : { y: 0, opacity: 1, scaleX: 1 }}
            exit={origin ? { opacity: 0, transition: { duration: 0.2 } } : { y: '100%', opacity: 0.4 }}
            transition={sheetSpring}
            drag="y"
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, i) => (i.offset.y > 110 || i.velocity.y > 600) && close()}
            data-sheet={sheet.kind}
          >
            <div className="grabber" onPointerDown={(e) => drag.start(e)} style={{ touchAction: 'none' }} />
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: origin ? 0.12 : 0, duration: 0.25 }} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }} onPointerDown={(e) => (e.target as HTMLElement).closest('.sheet-head') && drag.start(e)}>
              <SheetBody sheet={sheet} />
            </motion.div>
          </Glass>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function Toast() {
  const t = useMC((s) => s.toast);
  return (
    <div className="toast-host">
      <AnimatePresence>
        {t ? (
          <Glass key={t.n} className="toast control" radius={999} initial={{ y: -30, opacity: 0, scale: 0.9 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: -20, opacity: 0, scale: 0.95 }} transition={spring}>
            {t.text}
          </Glass>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Gate() {
  const reason = useMC((s) => s.gateReason);
  const verifying = useMC((s) => s.verifying);
  const [t, setT] = useState('');
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'grid', placeItems: 'center', padding: 24 }}>
      <Glass variant="deep" radius={32} style={{ padding: 28, width: 'min(420px, 100%)' }} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring}>
        <div className="title-l">Mission Control</div>
        <div className="small" style={{ margin: '6px 0 18px' }}>Enter your relay token to connect to Mia and your agents.</div>
        <form onSubmit={(e) => { e.preventDefault(); saveToken(t); }} className="col gap12">
          <input className="input" type="password" autoComplete="current-password" value={t} onChange={(e) => setT(e.target.value)} placeholder="MC token" autoFocus />
          {reason ? <div className="small" style={{ color: 'var(--red)' }}>{reason}</div> : null}
          <button className="pill primary" disabled={!t || verifying}>{verifying ? 'Checking…' : 'Connect'}</button>
        </form>
      </Glass>
    </div>
  );
}

// `mia panel …` — Mia can drive the panel (navigation only).
function usePanelCommands() {
  const cmd = useMC((s) => s.panelCmd);
  useEffect(() => {
    if (!cmd) return;
    const ok = (d = '') => panelDone(cmd, true, d);
    const a = cmd.arg;
    switch (cmd.action) {
      case 'view': {
        const v = a === 'home' || a === 'hq' ? 'now' : a === 'insights' ? 'fleet' : a === 'settings' ? null : a;
        if (a === 'settings') open({ kind: 'settings' });
        else if (v && (TABS as string[]).includes(v)) go(v as Tab);
        return ok();
      }
      case 'open-task':
        open({ kind: 'task', id: a.replace(/^#/, '') });
        return ok();
      case 'open-agent':
        open({ kind: 'agent', id: a });
        return ok();
      case 'open-doc':
      case 'show-doc':
        open({ kind: 'doc', id: a });
        return ok();
      case 'close':
        close();
        setTalk(false);
        return ok();
      case 'search':
        go('library');
        sessionStorage.setItem('mc6_search', a);
        return ok();
      default:
        return panelDone(cmd, false, `v6 panel doesn't do ${cmd.action} yet`);
    }
  }, [cmd?.n]); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function Panel() {
  const needsToken = useMC((s) => s.needsToken);
  const booted = useMC((s) => s.booted);
  const talk = useNav((s) => s.talk);
  const calm = useGlassPrefs((s) => s.calm);
  usePanelCommands();
  useEffect(() => {
    initGlassPrefs();
    readHash(location.hash);
    const f = () => readHash(location.hash);
    window.addEventListener('hashchange', f);
    boot();
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'mc-open') readHash(String(e.data.url || '#mia').replace(/^[^#]*/, '') || '#mia');
      });
    }
    return () => window.removeEventListener('hashchange', f);
  }, []);
  useMemo(() => getMC, []);
  return (
    <>
      <Scene />
      <div className="app">
        {booted ? <Panes /> : null}
      </div>
      <div className="edge-top" aria-hidden />
      {booted && !needsToken ? <Dock /> : null}
      {booted && !needsToken && !calm ? <GlassLayer /> : null}
      <Sheet />
      <Toast />
      <AnimatePresence>{talk ? <Talk key="talk" /> : null}</AnimatePresence>
      {needsToken ? <Gate /> : null}
    </>
  );
}
