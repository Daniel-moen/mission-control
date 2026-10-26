import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useTransform, animate, useMotionValue } from 'motion/react';
import { miaSend, miaAnswer, sendKey, reply } from '../../src/lib/store.js';
import Boot from '../boot.jsx';
import { useLive, useThread, greeting, hhmm, ago, splitName } from '../shared/live.js';
import { useQuality } from '../shared/quality.js';
import { useTilt, tiltX, tiltY, lightX, lightY, touching } from '../shared/tilt.js';
import { useScreen, go } from '../shared/nav.js';
import { talk, useVoice, voice } from '../shared/voice.jsx';
import { createLens, photoCanvas, gradientCanvas, typeCanvas, MAX } from './lens.js';

// Direction A — "LENS" (task 0445). Spatial glass, taken literally: the panes
// are lenses over a photograph and the time, rendered in one WebGL pass
// (lens.js). Depth comes from parallax (the device's tilt moves the photo,
// the type and the glass by different amounts), from shadows the panes cast,
// and from depth of field — opening Mia pulls focus off Home. Light follows
// your finger. Home → Mia is a vertical move through planes: drag the Mia
// slab up, drag the conversation down.

const spring = { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 };
const isPhone = () => innerWidth < 700;

function useLensScene(screen) {
  const ref = useRef(null);
  const low = useQuality((s) => s.low);
  const reduce = useQuality((s) => s.reduce);
  const gl = useQuality((s) => s.gl);
  const dof = useMotionValue(0);
  const [on, setOn] = useState(false);
  useEffect(() => {
    animate(dof, screen === 'mia' ? 2.6 : 0, reduce ? { duration: 0 } : { type: 'spring', stiffness: 120, damping: 24 });
  }, [screen, reduce, dof]);
  useEffect(() => {
    if (!gl || !ref.current) return undefined;
    let lens;
    try {
      lens = createLens(ref.current);
    } catch (e) {
      console.warn('lens: no shader', e);
      return undefined;
    }
    if (!lens.ok) return undefined;
    setOn(true);
    document.documentElement.classList.add('lens-on');
    // Backdrop: ?bg=NN, else a photo for the time of day (v1's set).
    const pick = new URLSearchParams(location.search).get('bg');
    const h = new Date().getHours();
    const file = pick ? `${pick.padStart(2, '0')}.jpg` : ['05.jpg', '01.jpg', '03.jpg', '06.jpg', '01.jpg'][h < 6 ? 0 : h < 10 ? 1 : h < 16 ? 2 : h < 20 ? 3 : 4];
    lens.texture('u_tex', gradientCanvas(), 0);
    const img = new Image();
    img.onload = () => lens.texture('u_tex', photoCanvas(img, innerWidth, innerHeight), 0);
    img.src = `/bg/${file}`;
    const drawType = () => {
      const d = new Date();
      lens.texture('u_type', typeCanvas(innerWidth, innerHeight, {
        time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        date: d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
        phone: isPhone(),
      }), 1);
    };
    document.fonts?.ready.then(drawType);
    drawType();
    const clock = setInterval(drawType, 15000);
    const onResize = () => {
      drawType();
      if (img.complete && img.naturalWidth) lens.texture('u_tex', photoCanvas(img, innerWidth, innerHeight), 0);
    };
    window.addEventListener('resize', onResize);

    // Every frame: the panes' rects (post-transform) → uniforms.
    const rects = new Float32Array(MAX * 4);
    const meta = new Float32Array(MAX * 4);
    const alpha = new Float32Array(MAX);
    const glow = { t: 0 };
    lens.set('u_typeA', 1);
    const frame = (_now, _dt, set) => {
      const els = document.querySelectorAll('[data-lens]');
      let n = 0;
      const H = innerHeight;
      for (let i = 0; i < els.length && n < MAX; i++) {
        const el = els[i];
        const r = el.getBoundingClientRect();
        if (r.bottom < -40 || r.top > H + 40 || r.width < 4) continue;
        // fade with the plane it sits on (Home/Mia cross-fade)
        const plane = el.__plane || (el.__plane = el.closest('.lens-plane'));
        const op = plane ? parseFloat(plane.style.opacity || '1') : 1;
        if (op < 0.02) continue;
        alpha[n] = op;
        rects.set([r.left, r.top, r.width, r.height], n * 4);
        meta.set([+(el.dataset.r || 26), +(el.dataset.frost || 0), el.dataset.amber ? 1 : 0, +(el.dataset.depth || 0.7)], n * 4);
        n++;
      }
      set('u_rects', rects);
      set('u_meta', meta);
      set('u_alpha', alpha, '1fv');
      set('u_count', n);
      glow.t += ((touching.get() ? 1 : 0) - glow.t) * 0.12;
      set('u_touch', Math.min(1, glow.t + voice.level * 1.5));
      set('u_light', [lightX.get(), lightY.get()]);
      set('u_tilt', [tiltX.get(), tiltY.get()]);
      set('u_dof', dof.get());
    };
    lens.set('u_count', 0);
    lens.setFrame(frame);
    if (low || reduce) {
      // Still frames: redraw only when something moves (scroll/resize) — and
      // a slow tick for the clock.
      const redraw = () => lens.draw();
      redraw();
      const t = setInterval(redraw, 250);
      window.addEventListener('scroll', redraw, true);
      return () => {
        clearInterval(t);
        clearInterval(clock);
        window.removeEventListener('scroll', redraw, true);
        window.removeEventListener('resize', onResize);
        lens.destroy();
        document.documentElement.classList.remove('lens-on');
      };
    }
    lens.start();
    return () => {
      clearInterval(clock);
      window.removeEventListener('resize', onResize);
      lens.destroy();
      document.documentElement.classList.remove('lens-on');
    };
  }, [gl, low, reduce, dof]);
  return { ref, on };
}

// A pane of glass. `depth` = how far it floats above the scene (parallax and
// shadow); `amber` = it's waiting on you.
function Pane({ children, className = '', r = 26, depth = 0.7, amber = false, frost = 0, style, onClick, as = 'div', wrap = '', ...rest }) {
  const reduce = useQuality((s) => s.reduce);
  const x = useTransform(tiltX, (v) => (reduce ? 0 : v * depth * 9));
  const y = useTransform(tiltY, (v) => (reduce ? 0 : v * depth * 7));
  const M = as === 'button' ? motion.button : motion.div;
  // Outer: parallax. Inner: the glass itself (its rect feeds the shader) and
  // its own enter/press motion.
  return (
    <motion.div className={`lens-wrap ${wrap}`} style={{ x, y }}>
      <M
        data-lens=""
        data-r={r}
        data-depth={depth}
        data-frost={frost}
        data-amber={amber ? '1' : undefined}
        className={`lens ${amber ? 'lens-amber' : ''} ${className}`}
        style={{ borderRadius: r, ...style }}
        whileTap={onClick ? { scale: 0.975 } : undefined}
        onClick={onClick}
        {...rest}
      >
        {children}
      </M>
    </motion.div>
  );
}

function Options({ options, onPick, small }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o, i) => (
        <motion.button
          key={`${i}${o}`}
          whileTap={{ scale: 0.95 }}
          onClick={(e) => (e.stopPropagation(), onPick(o, i))}
          className={`lens-opt ${i === 0 ? 'lens-opt-primary' : ''} ${small ? 'h-9 px-4 text-[0.84rem]' : 'h-11 px-5 text-[0.95rem]'}`}
          data-option={String(o)}
        >
          {String(o)}
        </motion.button>
      ))}
    </div>
  );
}

function NeedPane({ it, i }) {
  if (it.kind === 'mia') {
    const q = it.question;
    return (
      <Pane amber depth={0.85} className="p-5" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.12 + i * 0.06 }} data-question={q.questionId}>
        <div className="lens-eyebrow text-[#ffc46b]">Mia asks{q.taskId ? ` · #${q.taskId}` : ''}</div>
        <p className="mt-1.5 text-[1.12rem] font-medium leading-snug tracking-[-0.01em] text-white">{q.text}</p>
        <div className="mt-4">
          <Options options={q.options?.length ? q.options : ['Yes', 'No']} onPick={(o) => miaAnswer(q.questionId, String(o))} />
        </div>
      </Pane>
    );
  }
  const a = it.agent;
  const { proj, what } = splitName(a);
  return (
    <Pane amber depth={0.85} className="p-5" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.12 + i * 0.06 }} data-ask={a.id}>
      <div className="lens-eyebrow text-[#ffc46b]">{proj} · {what}</div>
      <p className="mt-1.5 text-[1.12rem] font-medium leading-snug tracking-[-0.01em] text-white">{it.prompt?.question || a.activity || 'Waiting for your input'}</p>
      <div className="mt-4">
        {it.prompt ? (
          <Options small options={it.prompt.options.slice(0, 4).map((o) => o.label)} onPick={(o, j) => sendKey(a.id, String(it.prompt.options[j].n))} />
        ) : (
          <Options small options={['Continue', 'Yes']} onPick={(o) => reply(a.id, String(o))} />
        )}
      </div>
    </Pane>
  );
}

function Bars({ agents }) {
  // one bar per agent, height = its live tokens/sec; colour = state
  const max = Math.max(60, ...agents.map((a) => a.tokensPerSec || 0));
  return (
    <div className="flex h-10 items-end gap-[5px]">
      {agents.slice(0, 12).map((a) => {
        const st = a.status === 'idle' ? 'w' : a.status === 'active' ? 'g' : 'd';
        return (
          <motion.span
            key={a.id}
            className={`lens-bar lens-bar-${st}`}
            initial={false}
            animate={{ height: `${Math.max(12, ((a.tokensPerSec || 0) / max) * 100)}%` }}
            transition={{ type: 'spring', stiffness: 140, damping: 18 }}
          />
        );
      })}
    </div>
  );
}

function Home({ glOn }) {
  const L = useLive();
  const v = useVoice();
  const d = new Date(L.now);
  const items = L.items.slice(0, 2);
  const last = L.lastMia;
  const enter = (i) => ({ initial: { opacity: 0, y: 26, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { ...spring, delay: 0.05 + i * 0.05 } });
  return (
    <div className="lens-home" data-screen="home">
      {!glOn && (
        <div className="lens-clock-fallback">
          <div className="t">{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
          <div className="d">{d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        </div>
      )}
      <div className="lens-col">
        <Pane depth={1} className="p-6 sm:p-7" {...enter(0)}>
          <div className="flex items-center gap-2 text-[0.82rem] font-semibold text-white/70">
            <span className={`lens-dot ${L.link === 'linked' ? (L.items.length ? 'w' : L.c.working ? 'g' : '') : 'x'}`} />
            {L.link === 'linked' ? 'Your Mac · live' : L.link === 'relay' ? 'Mac offline' : 'Reconnecting'}
          </div>
          <h1 className="mt-3 text-[2.4rem] font-semibold leading-[1.02] tracking-[-0.045em] text-white sm:text-[3.1rem]">{greeting(d.getHours())}, Daniel.</h1>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p key={L.sentence} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="mt-2 text-[1.08rem] font-medium text-white/75 sm:text-[1.22rem]" data-home-sentence>
              {L.sentence}
            </motion.p>
          </AnimatePresence>
          <div className="mt-5 flex gap-2.5">
            <motion.button whileTap={{ scale: 0.95 }} onClick={() => talk()} className="lens-cta" data-talk>
              <MicGlyph live={v.on} />
              {v.on ? 'Listening…' : 'Talk to Mia'}
            </motion.button>
            <motion.button whileTap={{ scale: 0.95 }} onClick={() => go('mia')} className="lens-opt h-12 px-5 text-[0.95rem]">
              Open chat
            </motion.button>
          </div>
        </Pane>

        {items.map((it, i) => (
          <NeedPane key={it.key} it={it} i={i} />
        ))}

      </div>

      <div className="lens-tiles">
        <div className="grid grid-cols-3 gap-3">
          <Pane depth={0.6} r={24} className="lens-tile" {...enter(3)} data-tile="agents">
            <span className="lens-eyebrow">Agents</span>
            <span className="lens-big">
              {L.c.working}
              <small>/{L.crew.length}</small>
            </span>
            <Bars agents={L.crew} />
          </Pane>
          <Pane depth={0.6} r={24} className="lens-tile" {...enter(4)} data-tile="tasks">
            <span className="lens-eyebrow">Tasks</span>
            <span className="lens-big">{L.tasks.length}</span>
            <span className="lens-sub">{L.tasks.find((t) => t.status === 'running')?.title || 'nothing in flight'}</span>
          </Pane>
          <Pane depth={0.6} r={24} className="lens-tile" {...enter(5)} data-tile="spend">
            <span className="lens-eyebrow">Today</span>
            <span className="lens-big">${(L.s.totalCost || 0).toFixed(2)}</span>
            <span className="lens-sub">{Math.round(L.s.tokensPerSec || 0)} tok/s · {L.usage ? `${Math.round(L.usage.pct)}% ${L.usage.label}` : 'usage —'}</span>
          </Pane>
        </div>
      </div>

      {/* Mia's slab: her last words; drag it up (or tap) to talk with her */}
      <motion.div
        className="lens-dock-wrap"
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.5, bottom: 0.08 }}
        onDragEnd={(e, info) => (info.offset.y < -50 || info.velocity.y < -400) && go('mia')}
        {...enter(6)}
      >
        <Pane depth={0.35} r={30} className="lens-dock" onClick={() => go('mia')} as="button" data-open-mia>
          <span className="lens-grip" />
          <span className="flex items-center gap-3">
            <MiaMark on={L.online} />
            <span className="min-w-0 flex-1 text-left">
              <span className="flex items-baseline gap-2 text-[0.8rem] font-semibold text-white/60">
                <span className="text-white">Mia</span>
                {L.thinking ? 'thinking…' : last ? ago(Date.parse(last.at), L.now) : ''}
                {L.unread > 0 && <span className="lens-badge">{L.unread}</span>}
              </span>
              <span className="mt-0.5 line-clamp-2 block text-[1rem] font-medium leading-snug text-white/90">{last ? last.text : 'Tell Mia what you need.'}</span>
            </span>
          </span>
        </Pane>
      </motion.div>
    </div>
  );
}

function useNarrow() {
  const [n, setN] = useState(isPhone());
  useEffect(() => {
    const f = () => setN(isPhone());
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return n;
}

const MicGlyph = ({ live }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" fill={live ? 'currentColor' : 'none'} />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const MiaMark = ({ on }) => (
  <span className={`lens-mia ${on ? 'on' : ''}`} aria-hidden="true">
    <span />
  </span>
);

function Msg({ r, i, n }) {
  const age = n - 1 - i; // 0 = newest
  if (r.event)
    return (
      <div className="lens-event" data-msg="event">
        {r.text} · {hhmm(r.ms)}
      </div>
    );
  if (r.mine)
    return (
      <motion.div layout="position" initial={{ opacity: 0, y: 18, scale: 0.96 }} animate={{ opacity: r.pending ? 0.6 : 1, y: 0, scale: 1 }} transition={spring} className="lens-mine" data-msg="daniel">
        {r.voice && <MicGlyph />}
        {r.text}
      </motion.div>
    );
  const q = r.m.kind === 'question';
  // Mia's words are glass. Only the newest few are live lenses (the shader
  // takes ${MAX}); older ones are drawn frosted by CSS.
  const live = age < 6;
  const Body = (
    <>
      {r.m.kind === 'notify' && <div className="lens-eyebrow text-[#9be7b8]">Done</div>}
      {q && <div className="lens-eyebrow text-[#ffc46b]">Question{r.m.taskId ? ` · #${r.m.taskId}` : ''}</div>}
      <p className="text-[1.04rem] leading-relaxed text-white/92">{r.text}</p>
      {q && r.open && (
        <div className="mt-3">
          <Options options={r.m.options?.length ? r.m.options : ['Yes', 'No']} onPick={(o) => miaAnswer(r.m.questionId, String(o))} />
        </div>
      )}
      {q && !r.open && r.answer && <div className="mt-2 text-[0.84rem] font-semibold text-white/55">You said “{r.answer}”</div>}
      <div className="mt-1.5 text-[0.7rem] font-medium text-white/40">{hhmm(r.ms)}</div>
    </>
  );
  return live ? (
    <Pane depth={0.5} r={24} amber={q && r.open} className="lens-msg" initial={{ opacity: 0, y: 22, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring} data-msg="mia">
      {Body}
    </Pane>
  ) : (
    <div className="lens-msg lens-frosted" data-msg="mia">
      {Body}
    </div>
  );
}

function Chat() {
  const { rows, mia } = useThread();
  const v = useVoice();
  const [text, setText] = useState('');
  const sc = useRef(null);
  const n = rows.length;
  useLayoutEffect(() => {
    const el = sc.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [n]);
  const send = () => {
    if (miaSend(text)) setText('');
  };
  return (
    <div className="lens-chat" data-screen="mia">
      <motion.div
        className="lens-chat-head"
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.05, bottom: 0.6 }}
        onDragEnd={(e, info) => (info.offset.y > 60 || info.velocity.y > 500) && go('home')}
      >
        <Pane depth={0.9} r={30} className="flex items-center gap-3 px-3 py-2.5">
          <motion.button whileTap={{ scale: 0.9 }} onClick={() => go('home')} className="lens-round" aria-label="Back to Home" data-back>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 15l6-6 6 6" transform="rotate(180 12 12)" /></svg>
          </motion.button>
          <MiaMark on={!!mia?.online} />
          <span className="min-w-0 flex-1">
            <span className="block text-[1.05rem] font-semibold tracking-[-0.02em] text-white">Mia</span>
            <span className="block text-[0.76rem] font-medium text-white/55">{v.on ? 'Listening' : mia?.online ? 'Online · Opus 5.5' : 'Offline'}</span>
          </span>
          <motion.button whileTap={{ scale: 0.94 }} onClick={() => talk()} className="lens-cta h-10 px-4 text-[0.86rem]" data-talk>
            <MicGlyph live={v.on} />
            {v.on ? 'End' : 'Talk'}
          </motion.button>
        </Pane>
      </motion.div>
      <div ref={sc} className="lens-thread" data-thread>
        <div className="lens-thread-in">
          {rows.map((r, i) => (
            <Msg key={r.key} r={r} i={i} n={n} />
          ))}
        </div>
      </div>
      <div className="lens-compose-wrap">
        <Pane depth={0.9} r={30} className="lens-compose">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
            rows={1}
            placeholder="Message Mia"
            aria-label="Message Mia"
            data-composer
          />
          <motion.button whileTap={{ scale: 0.9 }} onClick={text.trim() ? send : () => talk()} className={`lens-send ${text.trim() ? 'on' : ''}`} aria-label={text.trim() ? 'Send' : 'Talk'} data-send>
            {text.trim() ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
            ) : (
              <MicGlyph live={v.on} />
            )}
          </motion.button>
        </Pane>
      </div>
    </div>
  );
}

function Lens() {
  const screen = useScreen();
  useTilt();
  const reduce = useQuality((s) => s.reduce);
  const { ref, on } = useLensScene(screen);
  const t = reduce ? { duration: 0.2 } : spring;
  return (
    <div className={`lens-root ${on ? '' : 'lens-off'}`}>
      <canvas ref={ref} className="lens-canvas" aria-hidden="true" />
      {!on && <div className="lens-photo" />}
      <AnimatePresence initial={false}>
        {screen === 'home' ? (
          <motion.div
            key="home"
            className="lens-plane"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -40 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -50, transition: { duration: 0.32, ease: [0.3, 0, 0.2, 1] } }}
            transition={t}
          >
            <Home glOn={on} />
          </motion.div>
        ) : (
          <motion.div
            key="mia"
            className="lens-plane"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: '70%' }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: '60%', transition: { duration: 0.3, ease: [0.4, 0, 1, 1] } }}
            transition={t}
          >
            <Chat />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Page() {
  return <Boot ui="v3a" Direction={Lens} />;
}
