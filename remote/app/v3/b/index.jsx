import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, animate, motionValue } from 'motion/react';
import { miaSend, miaAnswer, sendKey, reply } from '../../src/lib/store.js';
import Boot from '../boot.jsx';
import { useLive, useThread, greeting, hhmm, ago, splitName } from '../shared/live.js';
import { useQuality } from '../shared/quality.js';
import { useTilt, tiltX, tiltY, lightX, lightY, touching } from '../shared/tilt.js';
import { useScreen, go } from '../shared/nav.js';
import { talk, useVoice, voice } from '../shared/voice.jsx';
import { createOrb } from './orb.js';

// Direction B — "PRESENCE" (task 0445). Mia isn't a tab; she's the centre of
// the screen — a living thing (orb.js) that breathes, swirls harder when the
// fleet works, warms when she speaks, pulses amber when something waits on
// you, ripples when you type to her. The agents orbit her. Home is her and
// what's in her orbit; tap her to talk in writing (she rises to the top and
// the conversation floats beneath her), hold her to talk out loud.

const phase = { energy: 0, attn: 0, think: 0, pulse: 0, press: 0 };
const orbC = { x: motionValue(0), y: motionValue(0), r: motionValue(100) };
const ringA = motionValue(1);
const ORBIT_T0 = performance.now();
export const bump = (v = 1) => (phase.pulse = Math.min(1.4, phase.pulse + v));

function layout(screen) {
  const W = innerWidth;
  const H = innerHeight;
  const phone = W < 700;
  if (screen === 'mia') return { x: W / 2, y: (phone ? 56 : 70) + 6, r: phone ? 30 : 38, ring: 0 };
  if (phone) return { x: W / 2, y: H * 0.33, r: Math.min(W * 0.27, 120), ring: 1 };
  return { x: W / 2, y: H * 0.4, r: Math.min(H * 0.17, W * 0.13), ring: 1 };
}
const ringSize = (r) => {
  const rx = Math.min(r * 1.9, innerWidth * 0.44);
  return [rx, rx * 0.24];
};

function useOrb(screen, live) {
  const ref = useRef(null);
  const gl = useQuality((s) => s.gl);
  const low = useQuality((s) => s.low);
  const reduce = useQuality((s) => s.reduce);
  const [on, setOn] = useState(false);
  // where she sits: springs between Home (centre) and Mia (top)
  useLayoutEffect(() => {
    const go2 = () => {
      const l = layout(screen);
      const sp = reduce ? { duration: 0 } : { type: 'spring', stiffness: 170, damping: 24, mass: 1 };
      animate(orbC.x, l.x, sp);
      animate(orbC.y, l.y, sp);
      animate(orbC.r, l.r, sp);
      animate(ringA, l.ring, reduce ? { duration: 0 } : { duration: 0.5 });
    };
    go2();
    window.addEventListener('resize', go2);
    return () => window.removeEventListener('resize', go2);
  }, [screen, reduce]);
  useEffect(() => {
    phase.energy = Math.min(1, (live.c.working || 0) / 6) * 0.7 + Math.min(1, (live.s.tokensPerSec || 0) / 300) * 0.3;
    phase.attnTarget = live.items.length ? 1 : 0;
    phase.thinkTarget = live.thinking ? 1 : 0;
  }, [live]);
  useEffect(() => {
    if (!gl || !ref.current) return undefined;
    let orb;
    try {
      orb = createOrb(ref.current, { still: low || reduce });
    } catch (e) {
      console.warn('orb: no shader', e);
      return undefined;
    }
    if (!orb.ok) return undefined;
    setOn(true);
    orb.setFrame((now, dt, set) => {
      const k = Math.min(1, dt / 16.7);
      phase.attn += ((phase.attnTarget || 0) - phase.attn) * 0.03 * k;
      phase.think += ((phase.thinkTarget || 0) - phase.think) * 0.05 * k;
      phase.pulse *= Math.pow(0.93, k);
      phase.press += ((touching.get() && phase.pressing ? 1 : 0) - phase.press) * 0.15 * k;
      const r = orbC.r.get();
      const [rx, ry] = ringSize(r);
      set('u_c', [orbC.x.get(), orbC.y.get()]);
      set('u_r', r);
      set('u_ring', [rx, ry, ringA.get(), 0]);
      set('u_energy', phase.energy);
      set('u_voice', voice.level);
      set('u_attn', phase.attn);
      set('u_think', phase.think);
      set('u_pulse', phase.pulse);
      set('u_press', phase.press);
      set('u_light', [lightX.get(), lightY.get()]);
      set('u_tilt', [tiltX.get(), tiltY.get()]);
    });
    let t = 0;
    if (low || reduce) {
      phase.attn = phase.attnTarget || 0;
      orb.draw();
      // a still portrait that still moves when she moves
      t = setInterval(() => orb.draw(), 120);
    } else orb.start();
    return () => {
      clearInterval(t);
      orb.destroy();
    };
  }, [gl, low, reduce]);
  return { ref, on };
}

// The agents, orbiting her. Positions are written straight to the DOM each
// frame (no React renders); behind her they dim and slip under.
function Orbit({ agents, show }) {
  const box = useRef(null);
  const reduce = useQuality((s) => s.reduce);
  const [pick, setPick] = useState(null);
  const list = agents.slice(0, 10);
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    let raf = 0;
    const tick = (now) => {
      const list = listRef.current;
      const els = box.current?.children || [];
      const r = orbC.r.get();
      const [rx, ry] = ringSize(r);
      const cx = orbC.x.get() + tiltX.get() * 14;
      const cy = orbC.y.get() + tiltY.get() * 10;
      const a0 = ringA.get();
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const a = list[i];
        if (!a) continue;
        const sp = a.status === 'active' ? 0.07 + Math.min(1, (a.tokensPerSec || 0) / 60) * 0.1 : a.status === 'idle' ? 0 : 0.015;
        const ang = (i / list.length) * Math.PI * 2 + 0.6 + (reduce ? 0 : ((now - ORBIT_T0) / 1000) * sp);
        const s = Math.sin(ang);
        const x = cx + Math.cos(ang) * rx;
        const y = cy + s * ry;
        const front = s > 0;
        const behind = !front && Math.abs(x - cx) < r * 1.02;
        const scale = 0.78 + 0.32 * (s + 1) / 2;
        el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${scale})`;
        el.style.opacity = String(a0 * (behind ? 0.08 : front ? 1 : 0.55));
        el.style.zIndex = front ? '3' : '1';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);
  return (
    <div ref={box} className={`pr-orbit ${show ? '' : 'pr-hide'}`} aria-label="Agents">
      {list.map((a) => {
        const { proj, what } = splitName(a);
        const st = a.status === 'idle' ? 'w' : a.status === 'active' ? 'g' : 'd';
        return (
          <button key={a.id} className={`pr-sat pr-sat-${st}`} onClick={() => setPick(pick === a.id ? null : a.id)} data-sat={a.id}>
            <i />
            <span>
              <b>{proj}</b>
              {pick === a.id ? <em>{a.activity || what}</em> : <em>{what}</em>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Her words, arriving one at a time.
function Words({ text, k }) {
  const words = useMemo(() => String(text || '').split(/\s+/).filter(Boolean), [text]);
  return (
    <span key={k} aria-label={text}>
      {words.map((w, i) => (
        <motion.span
          key={i}
          aria-hidden="true"
          className="inline-block"
          initial={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, delay: 0.25 + i * 0.045, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {w}&nbsp;
        </motion.span>
      ))}
    </span>
  );
}

function Need({ it, side, i }) {
  const isMia = it.kind === 'mia';
  const q = it.question;
  const a = it.agent;
  const head = isMia ? `Mia asks${q.taskId ? ` · #${q.taskId}` : ''}` : (() => {
    const n = splitName(a);
    return `${n.proj} asks`;
  })();
  const text = isMia ? q.text : it.prompt?.question || a.activity || 'Waiting for your input';
  const opts = isMia ? (q.options?.length ? q.options : ['Yes', 'No']).map((o) => String(o)) : it.prompt ? it.prompt.options.slice(0, 3).map((o) => o.label) : ['Continue'];
  const pickOpt = (o, j) => {
    bump(0.8);
    if (isMia) miaAnswer(q.questionId, o);
    else if (it.prompt) sendKey(a.id, String(it.prompt.options[j].n));
    else reply(a.id, o);
  };
  return (
    <motion.div
      className={`pr-need pr-need-${side}`}
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: [0, -6, 0] }}
      transition={{ opacity: { duration: 0.6, delay: 0.5 + i * 0.15 }, scale: { type: 'spring', stiffness: 200, damping: 20, delay: 0.5 + i * 0.15 }, y: { duration: 6 + i, repeat: Infinity, ease: 'easeInOut' } }}
      data-question={isMia ? q.questionId : undefined}
      data-ask={isMia ? undefined : a.id}
    >
      <div className="pr-need-head">
        <i />
        {head}
      </div>
      <p>{text}</p>
      <div className="pr-opts">
        {opts.map((o, j) => (
          <motion.button key={j} whileTap={{ scale: 0.92 }} onClick={() => pickOpt(o, j)} className={j === 0 ? 'on' : ''} data-option={o}>
            {o}
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}

// The invisible hand-hold over her: tap = chat (or back), hold = talk.
function OrbHandle({ screen }) {
  const timer = useRef(0);
  const held = useRef(false);
  const [pos, setPos] = useState({ x: 0, y: 0, r: 0 });
  useEffect(() => {
    let raf = 0;
    const f = () => {
      setPos((p) => {
        const n = { x: orbC.x.get(), y: orbC.y.get(), r: orbC.r.get() };
        return Math.abs(n.x - p.x) + Math.abs(n.y - p.y) + Math.abs(n.r - p.r) > 0.5 ? n : p;
      });
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, []);
  const s = Math.max(64, pos.r * 2);
  return (
    <button
      className="pr-handle"
      style={{ left: pos.x - s / 2, top: pos.y - s / 2, width: s, height: s }}
      aria-label={screen === 'home' ? 'Talk with Mia (hold to speak)' : 'Back to Home'}
      data-open-mia={screen === 'home' ? '' : undefined}
      data-back={screen === 'mia' ? '' : undefined}
      onPointerDown={() => {
        phase.pressing = true;
        held.current = false;
        timer.current = setTimeout(() => {
          held.current = true;
          bump(1.2);
          talk();
        }, 480);
      }}
      onPointerUp={() => {
        phase.pressing = false;
        clearTimeout(timer.current);
      }}
      onPointerLeave={() => {
        phase.pressing = false;
        clearTimeout(timer.current);
      }}
      onClick={() => {
        if (held.current) return;
        bump(0.6);
        go(screen === 'home' ? 'mia' : 'home');
      }}
    />
  );
}

const LABEL = { starting: 'Waking…', connecting: 'Connecting…', listening: 'Listening', hearing: 'Listening', transcribing: 'Got it…', thinking: 'Thinking', speaking: 'Speaking', standby: 'Tap to talk', paused: 'Paused', error: 'Mic unavailable' };

function Home() {
  const L = useLive();
  const v = useVoice();
  const d = new Date(L.now);
  const last = L.lastMia;
  const phone = innerWidth < 700;
  const items = L.items.slice(0, 2);
  const lastKey = last?.id || '';
  useEffect(() => {
    if (lastKey) bump(1);
  }, [lastKey]);
  return (
    <div className="pr-home" data-screen="home">
      <motion.header className="pr-top" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
        <div className="pr-greet">
          {greeting(d.getHours())}, Daniel
          <span>{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
        </div>
        <div className="pr-sentence" data-home-sentence>
          <i className={L.items.length ? 'w' : L.c.working ? 'g' : ''} />
          {L.sentence}
        </div>
      </motion.header>

      <div className={`pr-needs ${phone ? 'pr-needs-phone' : ''}`}>
        {items.map((it, i) => (
          <Need key={it.key} it={it} side={i % 2 ? 'r' : 'l'} i={i} />
        ))}
      </div>

      <div className="pr-voice" style={{ top: `calc(${phone ? 33 : 40}% + ${phone ? 150 : 170}px)` }}>
        <div className="pr-who">
          {v.on ? (
            <span className="text-[#ffb27a]">{LABEL[v.phase] || 'Listening'}</span>
          ) : (
            <>
              Mia{L.thinking ? ' · thinking…' : last ? ` · ${ago(Date.parse(last.at), L.now)}` : ''}
              {L.unread > 0 && <b>{L.unread} new</b>}
            </>
          )}
        </div>
        <p className="pr-line">{last ? <Words text={last.text} k={lastKey} /> : 'Tell me what you need.'}</p>
      </div>

      <footer className="pr-foot">
        <div className="pr-stat">
          <b>{Math.round(L.s.tokensPerSec || 0)}</b>
          <span>tokens / s</span>
        </div>
        <div className="pr-stat">
          <b>{L.c.working}<small>/{L.crew.length}</small></b>
          <span>agents in orbit</span>
        </div>
        <motion.button whileTap={{ scale: 0.94 }} className={`pr-talk ${v.on ? 'on' : ''}`} onClick={() => (bump(1.2), talk())} data-talk>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          {v.on ? 'End' : 'Talk'}
        </motion.button>
        <div className="pr-stat">
          <b>{L.tasks.length}</b>
          <span>tasks in flight</span>
        </div>
        <div className="pr-stat">
          <b>${(L.s.totalCost || 0).toFixed(0)}</b>
          <span>today</span>
        </div>
      </footer>
      <div className="pr-hint">Tap Mia to write · hold to speak</div>
    </div>
  );
}

function Row({ r, newest }) {
  if (r.event) return <div className="pr-event">{r.text}</div>;
  if (r.mine)
    return (
      <motion.div className="pr-mine" initial={newest ? { opacity: 0, y: 16, scale: 0.96 } : false} animate={{ opacity: r.pending ? 0.6 : 1, y: 0, scale: 1 }} data-msg="daniel">
        {r.text}
      </motion.div>
    );
  const q = r.m.kind === 'question';
  return (
    <div className={`pr-said ${q ? 'q' : ''} ${r.m.kind === 'notify' ? 'n' : ''}`} data-msg="mia">
      {q && <div className="pr-tag">A question{r.m.taskId ? ` · #${r.m.taskId}` : ''}</div>}
      {r.m.kind === 'notify' && <div className="pr-tag n">Done</div>}
      <p>{newest ? <Words text={r.text} k={r.key} /> : r.text}</p>
      {q && r.open && (
        <div className="pr-opts mt-3">
          {(r.m.options?.length ? r.m.options : ['Yes', 'No']).map((o, j) => (
            <motion.button key={j} whileTap={{ scale: 0.92 }} className={j === 0 ? 'on' : ''} onClick={() => (bump(0.8), miaAnswer(r.m.questionId, String(o)))} data-option={String(o)}>
              {String(o)}
            </motion.button>
          ))}
        </div>
      )}
      {q && !r.open && r.answer && <div className="pr-ans">You: {r.answer}</div>}
      <time>{hhmm(r.ms)}</time>
    </div>
  );
}

function Chat() {
  const { rows } = useThread();
  const v = useVoice();
  const [text, setText] = useState('');
  const sc = useRef(null);
  const n = rows.length;
  const first = useRef(n);
  useLayoutEffect(() => {
    const el = sc.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [n]);
  const send = () => {
    if (miaSend(text)) {
      setText('');
      bump(1.3);
    }
  };
  return (
    <div className="pr-chat" data-screen="mia">
      <div className="pr-chat-name">
        <b>Mia</b>
        <span>{v.on ? LABEL[v.phase] || 'Listening' : 'Tap me to go back'}</span>
      </div>
      <motion.div
        ref={sc}
        className="pr-thread"
        data-thread
        onPanEnd={(e, info) => sc.current && sc.current.scrollTop < 4 && info.offset.y > 90 && go('home')}
      >
        <div className="pr-thread-in">
          {rows.map((r, i) => (
            <Row key={r.key} r={r} newest={i >= first.current - 1 && i === n - 1 && !r.mine} />
          ))}
        </div>
      </motion.div>
      <div className="pr-compose">
        <textarea
          rows={1}
          value={text}
          placeholder="Say something to Mia…"
          aria-label="Message Mia"
          onChange={(e) => {
            setText(e.target.value);
            bump(0.35);
          }}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
          data-composer
        />
        <motion.button whileTap={{ scale: 0.9 }} className={`pr-send ${text.trim() ? 'on' : ''}`} onClick={text.trim() ? send : () => (bump(1.2), talk())} aria-label={text.trim() ? 'Send' : 'Talk'} data-send>
          {text.trim() ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          )}
        </motion.button>
      </div>
    </div>
  );
}

function Presence() {
  const screen = useScreen();
  const live = useLive();
  useTilt();
  const reduce = useQuality((s) => s.reduce);
  const { ref, on } = useOrb(screen, live);
  useEffect(() => {
    window.__v3demo = () => bump(1.4);
  }, []);
  const fade = reduce ? { duration: 0.2 } : { duration: 0.45, ease: [0.2, 0.8, 0.2, 1] };
  return (
    <div className={`pr-root ${on ? '' : 'pr-nogl'}`}>
      <canvas ref={ref} className="pr-canvas" aria-hidden="true" />
      {!on && <div className="pr-orb-css" style={{ left: '50%', top: screen === 'home' ? (innerWidth < 700 ? '33%' : '40%') : 76 }} />}
      <Orbit agents={live.crew} show={screen === 'home'} />
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div key={screen} className="pr-plane" initial={{ opacity: 0, y: screen === 'mia' ? 40 : -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: screen === 'mia' ? 40 : -20 }} transition={fade}>
          {screen === 'home' ? <Home /> : <Chat />}
        </motion.div>
      </AnimatePresence>
      <OrbHandle screen={screen} />
    </div>
  );
}

export default function Page() {
  return <Boot ui="v3b" Direction={Presence} />;
}
