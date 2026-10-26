import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform, animate, useDragControls } from 'motion/react';
import { miaAnswer, sendKey } from '../../src/lib/store.js';
import Boot from '../boot.jsx';
import { useThings, KIND_LABEL } from '../shared/model.js';
import { useRoute, openRoute, closeRoute } from '../shared/route.js';
import { Backdrop, NeedBody, AgentBody, DocBody, Thread, Composer, TasksBody, PulseBody, Spark, Dot, useWin, spring, splitName, phaseLabel, answerNeed } from '../shared/parts.jsx';
import { useVoice, talk } from '../../v3/shared/voice.jsx';
import { greeting, ago } from '../../v3/shared/live.js';

// Direction C — "NOW" (task 0446). No places at all: one stack of moments,
// ordered by what needs you. The top of the stack is always the most urgent
// thing; below it what's happening, then what's new. Every card is an action:
//   • swipe right → do it (answer with the first choice, open, reply)
//   • swipe left  → later (it drops out of the stack for an hour)
//   • tap → it opens as a full-screen sheet; pull it down to throw it back
// Pull the whole stack down from the top to talk to Mia. As things change
// on the Mac, cards re-sort themselves live.

const LATER_KEY = 'mc.v4c.later';
const HOUR = 3600e3;
const readLater = () => {
  try {
    const o = JSON.parse(localStorage.getItem(LATER_KEY) || '{}');
    const now = Date.now();
    return Object.fromEntries(Object.entries(o).filter(([, t]) => now - t < HOUR));
  } catch {
    return {};
  }
};

function band(t) {
  if (t.kind === 'need') return 'need';
  if (t.kind === 'mia' && t.unread) return 'need';
  if ((t.kind === 'agent' && t.working) || (t.kind === 'task' && t.task.status === 'running')) return 'now';
  return 'new';
}
const BAND = { need: 'Waiting on you', now: 'Happening now', new: 'New & recent' };

// What a right-swipe does, and what the card says it will do.
function primary(t) {
  if (t.kind === 'need') return t.options.length ? { label: t.options[0], run: () => answerNeed(t, 0), leaves: true } : { label: 'Open', run: () => openRoute('agent', t.id) };
  if (t.kind === 'mia') return { label: 'Reply', run: () => openRoute('mia') };
  if (t.kind === 'agent') return { label: 'Open', run: () => openRoute('agent', t.id) };
  if (t.kind === 'doc') return { label: 'Read', run: () => openRoute('doc', t.id) };
  if (t.kind === 'task') return { label: 'Open', run: () => openRoute('task', t.id) };
  return { label: 'Open', run: () => openRoute('pulse') };
}
const openFor = (t) => (t.kind === 'need' ? (t.from === 'agent' ? ['agent', t.id] : ['need', t.id]) : t.kind === 'mia' ? ['mia'] : t.kind === 'pulse' ? ['pulse'] : [t.kind, t.id]);

function Face({ t, L }) {
  if (t.kind === 'need') return <NeedBody t={t} />;
  if (t.kind === 'mia') return (
    <div className="nw-mia">
      <div className="v4-eyebrow">
        <span className="st-orb nw-orb" />
        {t.eyebrow}
        {t.unread ? <em className="nw-badge">{t.unread} new</em> : null}
      </div>
      <p className="nw-say">{t.title}</p>
    </div>
  );
  if (t.kind === 'agent') return (
    <div className="nw-agent">
      <div className="v4-eyebrow">
        <Dot tone={t.working ? 'g' : 'n'} />
        {t.eyebrow}
      </div>
      <h3 className="v4-h3">{t.title}</h3>
      <div className="nw-row">
        <span className="v4-dim">{t.sub}</span>
        <Spark values={L.tpsOf(t.id)} w={86} h={22} className="v4-green" />
      </div>
    </div>
  );
  if (t.kind === 'doc') return (
    <div>
      <div className="v4-eyebrow">{t.eyebrow} · {ago(t.at, L.now)}</div>
      <h3 className="v4-h3 nw-serif">{t.title}</h3>
    </div>
  );
  if (t.kind === 'task') return (
    <div>
      <div className="v4-eyebrow">
        <Dot tone={t.task.status === 'running' ? 'g' : 'n'} />
        {t.eyebrow}
      </div>
      <h3 className="v4-h3">{t.title}</h3>
    </div>
  );
  return <PulseBody t={t} />;
}

function Moment({ t, L, i, onLater }) {
  const x = useMotionValue(0);
  const p = primary(t);
  const rightO = useTransform(x, [20, 110], [0, 1]);
  const leftO = useTransform(x, [-110, -20], [1, 0]);
  const rot = useTransform(x, [-300, 0, 300], [-4, 0, 4]);
  const moved = useRef(false);
  const [gone, setGone] = useState(0);
  return (
    <motion.div
      layout
      className={`nw-slot nw-slot-${t.kind}`}
      initial={{ opacity: 0, y: 30, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, transition: { duration: 0.28 } }}
      transition={{ ...spring, delay: Math.min(i, 8) * 0.04 }}
      data-moment={t.key}
    >
      <motion.div className="nw-under nw-under-right" style={{ opacity: rightO }}>
        ✓ {p.label}
      </motion.div>
      <motion.div className="nw-under nw-under-left" style={{ opacity: leftO }}>
        Later ⟲
      </motion.div>
      <motion.div
        layoutId={`m-${t.key}`}
        className={`nw-card nw-card-${t.kind} ${band(t) === 'need' ? 'nw-hot' : ''}`}
        style={{ x, rotate: rot }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.9}
        onDragStart={() => (moved.current = true)}
        onDragEnd={(e, info) => {
          const { offset: o, velocity: v } = info;
          if (o.x > 120 || v.x > 700) {
            setGone(1);
            animate(x, innerWidth, { type: 'spring', stiffness: 300, damping: 34, velocity: v.x });
            setTimeout(() => {
              p.run();
              if (p.leaves) onLater(t.key, true);
              else animate(x, 0, spring);
              setGone(0);
            }, 220);
          } else if (o.x < -120 || v.x < -700) {
            setGone(-1);
            animate(x, -innerWidth, { type: 'spring', stiffness: 300, damping: 34, velocity: v.x });
            setTimeout(() => onLater(t.key), 200);
          }
        }}
        onClick={() => {
          if (moved.current) return void (moved.current = false);
          if (t.kind !== 'need' || t.from === 'agent') openRoute(...openFor(t));
        }}
        data-gone={gone || undefined}
      >
        <Face t={t} L={L} />
        <div className="nw-hint">
          <span>→ {p.label}</span>
          <span>← Later</span>
        </div>
      </motion.div>
    </motion.div>
  );
}

// A full-screen sheet with real physics: it rises from its card, follows
// your finger down with rubber-banding, and is thrown away by a flick.
function Sheet({ k, t, L, onClose }) {
  const drag = useDragControls();
  const y = useMotionValue(0);
  const scrim = useTransform(y, [0, 500], [1, 0]);
  return (
    <motion.div className="nw-sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} data-screen={k === 'mia' ? 'mia' : 'sheet'}>
      <motion.div className="nw-scrim" style={{ opacity: scrim }} onClick={onClose} />
      <motion.div
        layoutId={t ? `m-${t.key}` : undefined}
        className="nw-sheet"
        style={{ y }}
        initial={t ? undefined : { y: '100%' }}
        animate={t ? undefined : { y: 0 }}
        exit={t ? undefined : { y: '100%' }}
        transition={spring}
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.04, bottom: 0.9 }}
        onDragEnd={(e, info) => (info.offset.y > 130 || info.velocity.y > 650) && onClose()}
      >
        <div className="st-open-head" onPointerDown={(e) => drag.start(e)} style={{ touchAction: 'none' }}>
          <i className="st-grabber" />
          <span className="st-kind">{k === 'mia' ? 'Mia' : KIND_LABEL[t?.kind] || k}</span>
          <button className="st-close" onClick={onClose} aria-label="Close" data-back>
            ✕
          </button>
        </div>
        <div className="nw-sheet-body">
          <SheetBody k={k} t={t} L={L} />
        </div>
      </motion.div>
    </motion.div>
  );
}

function SheetBody({ k, t, L }) {
  const v = useVoice();
  if (k === 'mia') return (
    <div className="nw-sheet-mia">
      <Thread className="nw-thread" />
      <Composer placeholder={v.on ? `${phaseLabel(v.phase)}…` : 'Message Mia…'} autoFocus={false} />
    </div>
  );
  if (k === 'tasks') return <TasksBody tasks={L.tasks} done={L.doneTasks} />;
  if (!t) return <div className="v4-empty">That’s gone from the stack.</div>;
  if (t.kind === 'need') return (
    <>
      <NeedBody t={t} big />
      {t.agent && <AgentBody a={t.agent} />}
      {t.from === 'mia' && <Thread limit={10} className="nw-thread nw-thread-short" />}
    </>
  );
  if (t.kind === 'agent') return <AgentBody a={t.agent} />;
  if (t.kind === 'doc') return <DocBody id={t.id} />;
  if (t.kind === 'task') return (
    <>
      {t.task && (
        <>
          <div className="v4-eyebrow">{t.eyebrow}</div>
          <h2 className="v4-h2">{t.title}</h2>
          <p className="v4-dim">{t.task.dir}</p>
        </>
      )}
      <TasksBody tasks={L.tasks} done={L.doneTasks} />
    </>
  );
  return <PulseBody t={t} big />;
}

// Pull the stack down past the line → talk mode. Touch events (so a pull at
// the top doesn't fight the native scroll) plus the mouse for desktop.
function usePullToTalk(scroller, pull) {
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    let y0 = null;
    let armed = false;
    const LINE = 110;
    const begin = (y) => {
      y0 = el.scrollTop <= 0 ? y : null;
    };
    const drag = (y, e) => {
      if (y0 == null) return;
      const d = y - y0;
      if (d <= 0) return void pull.set(0);
      if (e?.cancelable) e.preventDefault();
      const r = Math.min(200, d * 0.5);
      pull.set(r);
      armed = r > LINE * 0.5 + 24;
    };
    const end = () => {
      if (y0 == null) return;
      y0 = null;
      if (armed) talk();
      armed = false;
      animate(pull, 0, spring);
    };
    const ts = (e) => begin(e.touches[0].clientY);
    const tm = (e) => drag(e.touches[0].clientY, e);
    const md = (e) => e.pointerType === 'mouse' && !e.target.closest('.nw-card, button, input') && begin(e.clientY);
    const mm = (e) => e.pointerType === 'mouse' && e.buttons && drag(e.clientY);
    const mu = (e) => e.pointerType === 'mouse' && end();
    el.addEventListener('touchstart', ts, { passive: true });
    el.addEventListener('touchmove', tm, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('pointerdown', md);
    window.addEventListener('pointermove', mm);
    window.addEventListener('pointerup', mu);
    return () => {
      el.removeEventListener('touchstart', ts);
      el.removeEventListener('touchmove', tm);
      el.removeEventListener('touchend', end);
      el.removeEventListener('pointerdown', md);
      window.removeEventListener('pointermove', mm);
      window.removeEventListener('pointerup', mu);
    };
  }, [scroller, pull]);
}

function Now() {
  const { L, things, byKey, lookup } = useThings();
  const r = useRoute();
  const win = useWin();
  const v = useVoice();
  const [later, setLater] = useState(readLater);
  const scroller = useRef(null);
  const pull = useMotionValue(0);
  const pullO = useTransform(pull, [10, 80], [0, 1]);
  const pullS = useTransform(pull, [0, 90], [0.6, 1.15]);
  usePullToTalk(scroller, pull);

  // per-agent tok/s history for the card sparklines (kept across snapshots)
  const hist = useRef(new Map());
  useMemo(() => {
    for (const a of L.crew) {
      const h = hist.current.get(a.id) || [];
      h.push(a.tokensPerSec || 0);
      if (h.length > 40) h.shift();
      hist.current.set(a.id, h);
    }
  }, [L.crew]);
  const LL = useMemo(() => ({ ...L, tpsOf: (id) => hist.current.get(id) || [] }), [L]);

  const onLater = (key, done) => {
    setLater((o) => {
      const n = { ...o, [key]: Date.now() };
      if (!done) {
        try {
          localStorage.setItem(LATER_KEY, JSON.stringify(n));
        } catch {}
      }
      return n;
    });
  };
  const list = things.filter((t) => !later[t.key]);
  const groups = ['need', 'now', 'new'].map((b) => [b, list.filter((t) => band(t) === b)]).filter(([, l]) => l.length);
  const hidden = things.length - list.length;

  const sheetKey = r.kind === 'mia' ? 'mia' : r.kind === 'tasks' ? 'tasks' : r.kind === 'pulse' ? 'pulse' : r.kind ? `${r.kind}:${r.id}` : null;
  const sheetThing = !sheetKey || sheetKey === 'mia' ? null : sheetKey === 'pulse' ? byKey.pulse : r.kind === 'agent' ? byKey[`need:${r.id}`] || lookup(`agent:${r.id}`) : lookup(sheetKey);
  const d = new Date(L.now);
  let n = 0;

  return (
    <div className={`nw ${win.phone ? 'nw-phone' : win.w > win.h ? 'nw-land' : 'nw-port'}`} data-screen="home">
      <Backdrop />
      <motion.div className="nw-pull" style={{ opacity: pullO, scale: pullS }} aria-hidden="true">
        <span className="nw-pull-orb" />
        <b>Release to talk to Mia</b>
      </motion.div>
      <motion.div
        ref={scroller}
        className="nw-scroll"
        style={{ y: pull }}
        animate={sheetKey ? { scale: 0.92, opacity: 0.5 } : { scale: 1, opacity: 1 }}
        transition={spring}
        data-feed
      >
        <header className="nw-head">
          <div className="nw-time">{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
          <h1 className="nw-title">{L.sentence}</h1>
          <p className="v4-dim nw-sub">
            {greeting(d.getHours())}, Daniel. Swipe right to do, left for later. Pull down to talk.
          </p>
        </header>
        {groups.map(([b, l]) => (
          <section key={b} className={`nw-band nw-band-${b}`}>
            <h2 className="nw-band-title">
              <span>{BAND[b]}</span>
              <em>{l.length}</em>
            </h2>
            <div className="nw-list">
              <AnimatePresence initial={true} mode="popLayout">
                {l.map((t) => (
                  <Moment key={t.key} t={t} L={LL} i={n++} onLater={onLater} />
                ))}
              </AnimatePresence>
            </div>
          </section>
        ))}
        {!list.length && <div className="nw-clear">You’re clear. Nothing needs you.</div>}
        {hidden > 0 && (
          <button className="nw-restore v4-dim" onClick={() => (setLater({}), localStorage.removeItem(LATER_KEY))} data-restore>
            {hidden} set aside for later · bring back
          </button>
        )}
        <div className="nw-pad" />
      </motion.div>
      <motion.button className="nw-ask" whileTap={{ scale: 0.97 }} onClick={() => openRoute('mia')} data-open-mia>
        <span className={`st-orb nw-orb ${v.on ? 'st-orb-talk' : ''}`} />
        <span>{v.on ? phaseLabel(v.phase) : 'Ask Mia…'}</span>
        <i
          className="nw-ask-mic"
          role="button"
          aria-label="Talk to Mia"
          data-talk
          onClick={(e) => {
            e.stopPropagation();
            talk();
          }}
        >
          🎙
        </i>
      </motion.button>
      <AnimatePresence>{sheetKey && <Sheet key={sheetKey} k={sheetKey} t={sheetThing} L={LL} onClose={closeRoute} />}</AnimatePresence>
    </div>
  );
}

export default function V4C() {
  return <Boot ui="v4c" Direction={Now} />;
}
export { miaAnswer, sendKey, splitName };
