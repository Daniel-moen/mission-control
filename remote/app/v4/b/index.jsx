import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, animate, motionValue, useMotionValueEvent, useDragControls } from 'motion/react';
import Boot from '../boot.jsx';
import { useThings } from '../shared/model.js';
import { useRoute, openRoute, closeRoute } from '../shared/route.js';
import { Backdrop, NeedBody, AgentBody, DocBody, Thread, Composer, TasksBody, PulseBody, MicButton, Spark, Dot, useWin, spring, splitName, phaseLabel } from '../shared/parts.jsx';
import { useVoice } from '../../v3/shared/voice.jsx';
import { useQuality } from '../../v3/shared/quality.js';
import { greeting } from '../../v3/shared/live.js';

// Direction B — "ATLAS" (task 0446). The panel is a place, not a set of
// pages. Six rooms — Mia, Waiting on you, Agents, Library, Tasks, Pulse — sit
// on one surface, each the size of your screen. Opening shows the whole map,
// every room live at once (semantic zoom: from afar a room shows its one big
// fact; up close, the real thing). Pinch, scroll or tap to fly into a room and
// it becomes your screen; swipe sideways to slide over to the next room;
// pinch out (or tap the minimap) to rise back to the map. Tap a tile in a
// room — an agent, a doc — and the camera dives into it and it opens as a
// window. Like an OS's Mission Control, which is apt.

const ROOMS = ['mia', 'needs', 'agents', 'library', 'tasks', 'pulse'];
const TITLE = { mia: 'Mia', needs: 'Waiting on you', agents: 'Agents', library: 'Library', tasks: 'Tasks', pulse: 'Pulse' };

// Camera: world → screen = translate(x, y) scale(s).
const cam = { x: motionValue(0), y: motionValue(0), s: motionValue(0.3) };
let flying = [];
function stop() {
  flying.forEach((a) => a.stop());
  flying = [];
}
// While the camera moves the world is one GPU layer (no repaints per frame);
// at rest it's re-rasterised at the new scale so text is crisp again.
let worldEl = null;
let restT = 0;
function moving() {
  clearTimeout(restT);
  if (worldEl) worldEl.style.willChange = 'transform';
}
function rest() {
  clearTimeout(restT);
  restT = setTimeout(() => worldEl && (worldEl.style.willChange = 'auto'), 120);
}
function fly(to, opt) {
  stop();
  const reduce = document.documentElement.dataset.reduce === '1';
  const t = reduce ? { duration: 0 } : opt || { type: 'spring', stiffness: 120, damping: 22, mass: 1 };
  moving();
  flying = [animate(cam.x, to.x, t), animate(cam.y, to.y, t), animate(cam.s, to.s, t)];
  const done = Promise.all(flying);
  done.then(rest, rest);
  return done;
}
// Fit a world rect into the screen, inside insets (pad = number or {t,r,b,l}).
const fit = (r, vw, vh, pad = 0) => {
  const p = typeof pad === 'number' ? { t: pad, r: pad, b: pad, l: pad } : pad;
  const w = vw - p.l - p.r;
  const h = vh - p.t - p.b;
  const s = Math.min(w / r.w, h / r.h, 1);
  return { s, x: p.l + w / 2 - (r.x + r.w / 2) * s, y: p.t + h / 2 - (r.y + r.h / 2) * s };
};

// The rooms are laid out as a 3×2 grid on a landscape screen, 2×3 on a
// portrait one; each is exactly one screen in size, so "in a room" is scale 1
// and text is crisp.
// (On a phone a room is a little shorter than the screen, so the map reads
// at a usable size and, inside a room, its neighbours peek above and below.)
function layout(vw, vh) {
  const land = vw > vh;
  const phone = vw < 700;
  const cols = land ? 3 : 2;
  const rw = vw;
  const rh = phone ? Math.round(vh * 0.74) : vh;
  const gap = Math.round(Math.min(vw, vh) * (land ? 0.08 : 0.1));
  const rooms = {};
  ROOMS.forEach((k, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    rooms[k] = { x: c * (rw + gap), y: r * (rh + gap), w: rw, h: rh };
  });
  const rows = Math.ceil(ROOMS.length / cols);
  return { rooms, world: { x: 0, y: 0, w: cols * rw + (cols - 1) * gap, h: rows * rh + (rows - 1) * gap }, cols };
}

function useCamera(win) {
  const geo = useMemo(() => layout(win.w, win.h), [win.w, win.h]);
  const overview = useMemo(() => fit(geo.world, win.w, win.h, win.phone ? { t: 96, r: 14, b: 26, l: 14 } : { t: 96, r: 40, b: 40, l: 40 }), [geo, win]);
  return { geo, overview };
}

// Far ↔ near (semantic zoom) flips a class only when the scale crosses it.
function useFar() {
  const [far, setFar] = useState(true);
  useMotionValueEvent(cam.s, 'change', (s) => {
    const f = s < 0.62;
    setFar((p) => (p === f ? p : f));
  });
  return far;
}

function RoomFar({ k, L, things }) {
  if (k === 'mia') return (
    <div className="at-far at-far-mia">
      <span className={`st-orb at-orb ${L.thinking ? 'st-orb-think' : ''} ${L.items.length ? 'st-orb-attn' : ''}`} />
      <p>{(L.lastMia?.text || 'Here when you need me.').replace(/^\(voice\)\s*/, '')}</p>
    </div>
  );
  if (k === 'needs') {
    const needs = things.filter((t) => t.kind === 'need');
    return (
      <div className={`at-far ${needs.length ? 'at-far-amber' : ''}`}>
        <div className="at-num">{needs.length}</div>
        <b>{needs.length === 1 ? 'thing waits on you' : 'things wait on you'}</b>
        {needs.slice(0, 2).map((t) => (
          <p key={t.key} className="at-far-line">
            {t.title}
          </p>
        ))}
      </div>
    );
  }
  if (k === 'agents') return (
    <div className="at-far">
      <b>
        <em className="at-em">{L.c.working}</em> working
      </b>
      <div className="at-chips">
        {L.crew.slice(0, innerWidth < 700 ? 6 : 8).map((a) => {
          const n = splitName(a);
          const st = a.status === 'active' ? 'g' : a.status === 'idle' ? 'a' : 'n';
          return (
            <div key={a.id} className={`at-chip at-chip-${st}`}>
              <span>{n.proj}</span>
              <i style={{ transform: `scaleX(${Math.min(1, (a.tokensPerSec || 0) / 70)})` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
  if (k === 'library') return (
    <div className="at-far">
      <b>
        <em className="at-em">{L.docs.length}</em> docs
      </b>
      {L.recentDocs.slice(0, 3).map((d) => (
        <p key={d.id} className="at-far-line at-serif">
          {d.title}
        </p>
      ))}
    </div>
  );
  if (k === 'tasks') return (
    <div className="at-far">
      <b>
        <em className="at-em">{L.tasks.length}</em> live
      </b>
      {L.tasks.slice(0, 3).map((t) => (
        <p key={t.id} className="at-far-line">
          <Dot tone={t.status === 'running' ? 'g' : t.status === 'asking' ? 'a' : 'n'} /> {t.title}
        </p>
      ))}
    </div>
  );
  return (
    <div className="at-far">
      <div className="at-num">${(L.s.totalCost || 0).toFixed(0)}</div>
      <b>today · {Math.round(L.s.tokensPerSec || 0)} tok/s</b>
      <Spark values={L.tps} w={300} h={60} stretch className="v4-green" />
    </div>
  );
}

function RoomNear({ k, L, things, pulse, onTile }) {
  const v = useVoice();
  if (k === 'mia') return (
    <div className="at-near at-mia">
      <Thread className="at-thread" />
      <Composer placeholder={v.on ? `${phaseLabel(v.phase)}…` : 'Message Mia…'} />
    </div>
  );
  if (k === 'needs') {
    const needs = things.filter((t) => t.kind === 'need');
    return (
      <div className="at-near at-scroll">
        {needs.map((t) => (
          <div key={t.key} className="at-tile at-tile-need" data-tile={t.key}>
            <NeedBody t={t} />
            {t.agent && (
              <button className="at-link" onClick={(e) => onTile(e, 'agent', t.agent.id)}>
                Open {splitName(t.agent).proj} →
              </button>
            )}
          </div>
        ))}
        {!needs.length && <div className="v4-empty">Nothing waits on you.</div>}
      </div>
    );
  }
  if (k === 'agents') return (
    <div className="at-near at-scroll at-grid">
      {L.crew.map((a) => {
        const n = splitName(a);
        return (
          <motion.button key={a.id} whileTap={{ scale: 0.97 }} className="at-tile at-agent" data-tile={`agent:${a.id}`} data-agent-tile={a.id} onClick={(e) => onTile(e, 'agent', a.id)}>
            <div className="v4-eyebrow">
              <Dot tone={a.status === 'active' ? 'g' : a.status === 'idle' ? 'a' : 'n'} />
              {n.proj}
            </div>
            <b>{n.what}</b>
            <span className="v4-dim">{a.activity}</span>
            <div className="st-foot">
              <span>{Math.round(a.tokensPerSec || 0)} tok/s</span>
              {a.cost ? <span>${a.cost.toFixed(2)}</span> : null}
            </div>
          </motion.button>
        );
      })}
    </div>
  );
  if (k === 'library') return (
    <div className="at-near at-scroll at-grid">
      {L.recentDocs.concat(L.docs.filter((d) => !L.recentDocs.includes(d)).slice(0, 10)).map((d) => (
        <motion.button key={d.id} whileTap={{ scale: 0.97 }} className="at-tile at-doc" data-tile={`doc:${d.id}`} data-doc-tile={d.id} onClick={(e) => onTile(e, 'doc', d.id)}>
          <div className="v4-eyebrow">
            {d.kind || 'note'}
            {d.subject ? ` · ${d.subject}` : ''}
          </div>
          <b>{d.title || d.id}</b>
        </motion.button>
      ))}
    </div>
  );
  if (k === 'tasks') return (
    <div className="at-near at-scroll">
      <TasksBody tasks={L.tasks} done={L.doneTasks} />
    </div>
  );
  return (
    <div className="at-near">
      <PulseBody t={pulse} big />
    </div>
  );
}

function Room({ k, r, far, L, things, pulse, onEnter, onTile, here }) {
  return (
    <div
      className={`at-room at-room-${k} ${here ? 'at-here' : ''}`}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      data-room={k}
      data-open-mia={k === 'mia' && far ? '' : undefined}
      onClick={() => far && onEnter(k)}
    >
      <div className="at-room-glass">
        <div className="at-room-title">
          <span>{TITLE[k]}</span>
          {k === 'needs' && things.some((t) => t.kind === 'need') && <Dot tone="a" />}
        </div>
        <div className={`at-layer at-layer-far ${far ? 'on' : ''}`} aria-hidden={!far}>
          <RoomFar k={k} L={L} things={things} />
        </div>
        <div className={`at-layer at-layer-near ${far ? '' : 'on'}`} aria-hidden={far}>
          {here && <RoomNear k={k} L={L} things={things} pulse={pulse} onTile={onTile} />}
        </div>
      </div>
    </div>
  );
}

// The minimap: every room as a tiny tile and where you are on it. Tap a
// room to fly there; tap the map itself to rise to the overview.
function Minimap({ geo, win, onRoom, onOverview, things }) {
  const view = useRef(null);
  const W = win.phone ? 50 : 104;
  const k = W / geo.world.w;
  const H = geo.world.h * k;
  useEffect(() => {
    const up = () => {
      const s = cam.s.get();
      const el = view.current;
      if (!el) return;
      el.style.transform = `translate(${(-cam.x.get() / s) * k}px, ${(-cam.y.get() / s) * k}px)`;
      el.style.width = `${(win.w / s) * k}px`;
      el.style.height = `${(win.h / s) * k}px`;
    };
    up();
    const u = [cam.x.on('change', up), cam.y.on('change', up), cam.s.on('change', up)];
    return () => u.forEach((f) => f());
  }, [k, win.w, win.h]);
  return (
    <div className="at-mini" style={{ width: W + 12, height: H + 12 }} onClick={onOverview} data-minimap aria-label="Map — tap to see everything">
      <div className="at-mini-in" style={{ width: W, height: H }}>
        {ROOMS.map((r) => {
          const g = geo.rooms[r];
          return (
            <button
              key={r}
              className={`at-mini-room ${r === 'needs' && things.some((t) => t.kind === 'need') ? 'at-mini-amber' : ''}`}
              style={{ left: g.x * k, top: g.y * k, width: g.w * k, height: g.h * k }}
              onClick={(e) => {
                e.stopPropagation();
                onRoom(r);
              }}
              aria-label={TITLE[r]}
              data-mini={r}
            />
          );
        })}
        <i ref={view} className="at-mini-view" />
      </div>
    </div>
  );
}

// A tile opened as a window: it grows out of where the tile sat on screen
// while the camera dives in behind it; pull it down to fly back out.
function Window({ route, things, L, from }) {
  const drag = useDragControls();
  const vw = innerWidth;
  const vh = innerHeight;
  const r = from || { left: vw * 0.3, top: vh * 0.3, width: vw * 0.4, height: vh * 0.4 };
  const init = { x: r.left + r.width / 2 - vw / 2, y: r.top + r.height / 2 - vh / 2, scaleX: r.width / vw, scaleY: r.height / vh, opacity: 0.4, borderRadius: 28 };
  const need = route.kind === 'agent' ? things.find((t) => t.key === `need:${route.id}`) : null;
  const a = route.kind === 'agent' ? L.crew.find((x) => x.id === route.id) || L.agents.find((x) => x.id === route.id) : null;
  return (
    <motion.div
      className="at-window"
      data-window={`${route.kind}:${route.id}`}
      initial={init}
      animate={{ x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, borderRadius: 0 }}
      exit={{ ...init, opacity: 0, transition: { type: 'spring', stiffness: 260, damping: 30 } }}
      transition={{ type: 'spring', stiffness: 220, damping: 28 }}
      drag="y"
      dragControls={drag}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.05, bottom: 0.85 }}
      onDragEnd={(e, info) => (info.offset.y > 120 || info.velocity.y > 600) && closeRoute()}
    >
      <div className="st-open-head" onPointerDown={(e) => drag.start(e)} style={{ touchAction: 'none' }}>
        <i className="st-grabber" />
        <span className="st-kind">{route.kind === 'agent' ? 'Agent' : 'Library'}</span>
        <button className="st-close" onClick={closeRoute} aria-label="Back out" data-back>
          ✕
        </button>
      </div>
      <div className="at-window-body">
        {route.kind === 'agent' && (
          <>
            {need && <NeedBody t={need} big />}
            <AgentBody a={a} prompt={need?.prompt} />
          </>
        )}
        {route.kind === 'doc' && <DocBody id={route.id} />}
      </div>
    </motion.div>
  );
}

function Atlas() {
  const { L, things, byKey } = useThings();
  const win = useWin();
  const r = useRoute();
  const v = useVoice();
  const reduce = useQuality((s) => s.reduce);
  const { geo, overview } = useCamera(win);
  const far = useFar();
  const [here, setHere] = useState(null); // the room you're in (null = the map)
  const [from, setFrom] = useState(null);
  const box = useRef(null);
  const world = useRef(null);
  const pulse = byKey.pulse;
  document.documentElement.dataset.reduce = reduce ? '1' : '0';

  // Camera → the world's transform, without React renders.
  useLayoutEffect(() => {
    const el = world.current;
    worldEl = el;
    const up = () => {
      el.style.transform = `translate3d(${cam.x.get()}px, ${cam.y.get()}px, 0) scale(${cam.s.get()})`;
    };
    up();
    const u = [cam.x.on('change', up), cam.y.on('change', up), cam.s.on('change', up)];
    return () => u.forEach((f) => f());
  }, []);

  // A room's live contents mount once the camera has arrived (mounting a
  // terminal mid-flight would cost a frame).
  const [ready, setReady] = useState(null);
  const enter = (k, opt) => {
    setHere(k);
    if (ready !== k) setReady(null);
    fly(fit(geo.rooms[k], win.w, win.h), opt).then(() => setReady(k), () => setReady(k));
  };
  const toMap = () => {
    setHere(null);
    fly(overview);
  };

  // First frame: the map, settled in from slightly farther out.
  const started = useRef(false);
  useLayoutEffect(() => {
    if (!started.current) {
      started.current = true;
      cam.s.set(overview.s * 0.82);
      cam.x.set(overview.x + (geo.world.w * overview.s * 0.18) / 2);
      cam.y.set(overview.y + (geo.world.h * overview.s * 0.18) / 2);
      requestAnimationFrame(() => (here ? enter(here) : fly(overview, { type: 'spring', stiffness: 90, damping: 20 })));
    } else if (here) fly(fit(geo.rooms[here], win.w, win.h));
    else fly(overview);
  }, [geo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Routes: #mia / #tasks / #pulse / #agents / #library / #need fly to a room;
  // #agent/<id> / #doc/<id> open a window from that tile.
  const winRoute = r.kind === 'agent' || r.kind === 'doc' ? r : null;
  useEffect(() => {
    const room = { mia: 'mia', tasks: 'tasks', task: 'tasks', pulse: 'pulse', agents: 'agents', library: 'library', need: 'needs' }[r.kind];
    if (room) enter(room);
    if (winRoute) {
      const home = winRoute.kind === 'doc' ? 'library' : byKey[`need:${winRoute.id}`] && here === 'needs' ? 'needs' : 'agents';
      if (here !== home) setHere(home);
      setReady(home);
      const tile = document.querySelector(`[data-tile="${winRoute.kind}:${CSS.escape(winRoute.id)}"]`);
      const rect = tile?.getBoundingClientRect();
      if (rect && rect.width) setFrom({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      // dive: the camera pushes in toward the tile behind the window
      const target = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: win.w / 2, y: win.h / 2 };
      const base = fit(geo.rooms[home], win.w, win.h);
      const z = 1.6;
      fly({ s: base.s * z, x: target.x - (target.x - base.x) * z, y: target.y - (target.y - base.y) * z }, { type: 'spring', stiffness: 140, damping: 26 });
    } else if (!room && here && !r.kind) fly(fit(geo.rooms[here], win.w, win.h));
  }, [r.kind, r.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTile = (e, kind, id) => {
    e.stopPropagation();
    const rect = e.currentTarget.closest('[data-tile]')?.getBoundingClientRect() || e.currentTarget.getBoundingClientRect();
    setFrom({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    openRoute(kind, id);
  };

  // ---- gestures: pan, pinch, wheel, swipe between rooms ------------------
  useEffect(() => {
    const el = box.current;
    const pts = new Map();
    let g = null; // { mode: 'pan'|'pinch'|'swipe', ... }
    let vel = { x: 0, y: 0, t: 0 };
    const hereRef = () => box.current?.dataset.here || '';
    const start = () => {
      const p = [...pts.values()];
      stop();
      moving();
      if (p.length >= 2) {
        const [a, b] = p;
        g = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), s0: cam.s.get(), x0: cam.x.get(), y0: cam.y.get(), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      } else if (p.length === 1) {
        g = { mode: 'maybe', sx: p[0].x, sy: p[0].y, x0: cam.x.get(), y0: cam.y.get() };
      }
    };
    const down = (e) => {
      if (e.target.closest('[data-minimap], .at-window, input, textarea, .v4-switch, [data-talk]')) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      start();
    };
    const move = (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = performance.now();
      const dt = Math.max(1, now - (vel.t || now - 16));
      vel = { x: ((e.clientX - prev.x) / dt) * 1000, y: ((e.clientY - prev.y) / dt) * 1000, t: now };
      const p = [...pts.values()];
      if (g.mode === 'pinch' && p.length >= 2) {
        const [a, b] = p;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const s = Math.max(overview.s * 0.7, Math.min(2.2, (g.s0 * d) / g.d0));
        // keep the world point under the fingers' midpoint under it
        const wx = (g.mx - g.x0) / g.s0;
        const wy = (g.my - g.y0) / g.s0;
        cam.s.set(s);
        cam.x.set(mx - wx * s);
        cam.y.set(my - wy * s);
        return;
      }
      if (g.mode === 'maybe') {
        const dx = e.clientX - g.sx;
        const dy = e.clientY - g.sy;
        if (Math.hypot(dx, dy) < 8) return;
        // In a room, vertical drags scroll its content natively; sideways
        // drags slide the camera toward the next room.
        if (hereRef()) g.mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'swipe' : 'none';
        else g.mode = 'pan';
        if (g.mode !== 'none') el.setPointerCapture?.(e.pointerId);
      }
      if (g.mode === 'pan') {
        cam.x.set(g.x0 + (e.clientX - g.sx));
        cam.y.set(g.y0 + (e.clientY - g.sy));
      } else if (g.mode === 'swipe') {
        cam.x.set(g.x0 + (e.clientX - g.sx));
      }
    };
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      const was = g;
      if (pts.size) return start();
      g = null;
      rest();
      if (!was) return;
      // a drag is not a tap: swallow the click that follows it
      if (was.mode !== 'maybe' && was.mode !== 'none') {
        swallow = true;
        setTimeout(() => (swallow = false), 60);
      }
      if (was.mode === 'pinch') {
        const s = cam.s.get();
        const h = hereRef();
        if (h && s < 0.85) toMap();
        else if (!h && s > 0.75) {
          // zoomed into whatever room is most on screen → enter it
          const cx = (win.w / 2 - cam.x.get()) / s;
          const cy = (win.h / 2 - cam.y.get()) / s;
          let best = 'mia';
          let bd = Infinity;
          for (const k of ROOMS) {
            const q = geo.rooms[k];
            const d = Math.hypot(q.x + q.w / 2 - cx, q.y + q.h / 2 - cy);
            if (d < bd) (bd = d), (best = k);
          }
          enter(best);
        } else if (h) enter(h);
        else if (s < overview.s) fly(overview);
      } else if (was.mode === 'pan') {
        // glide, then settle back if the map left the screen
        const t = { type: 'inertia', power: 0.35, timeConstant: 260 };
        moving();
        flying = [animate(cam.x, cam.x.get(), { ...t, velocity: vel.x }), animate(cam.y, cam.y.get(), { ...t, velocity: vel.y })];
        Promise.all(flying).then(rest, rest);
      } else if (was.mode === 'swipe') {
        const h = hereRef();
        const dx = e.clientX - was.sx;
        const i = ROOMS.indexOf(h);
        const dir = dx < -60 || vel.x < -500 ? 1 : dx > 60 || vel.x > 500 ? -1 : 0;
        const next = ROOMS[Math.max(0, Math.min(ROOMS.length - 1, i + dir))];
        enter(next, { type: 'spring', stiffness: 200, damping: 28, velocity: vel.x });
      }
    };
    const wheel = (e) => {
      if (e.target.closest('.at-window, [data-minimap]')) return;
      const h = hereRef();
      if (!e.ctrlKey && h) return; // scrolling inside a room
      e.preventDefault();
      stop();
      if (e.ctrlKey) {
        const s0 = cam.s.get();
        const s = Math.max(overview.s * 0.7, Math.min(2.2, s0 * Math.exp(-e.deltaY * 0.01)));
        const wx = (e.clientX - cam.x.get()) / s0;
        const wy = (e.clientY - cam.y.get()) / s0;
        cam.s.set(s);
        cam.x.set(e.clientX - wx * s);
        cam.y.set(e.clientY - wy * s);
        clearTimeout(wheel.t);
        wheel.t = setTimeout(() => up({ pointerId: 'wheel', clientX: e.clientX }), 160);
        pts.set('wheel', { x: e.clientX, y: e.clientY });
        g = { mode: 'pinch' };
      } else {
        cam.x.set(cam.x.get() - e.deltaX);
        cam.y.set(cam.y.get() - e.deltaY);
      }
    };
    let swallow = false;
    const click = (e) => {
      if (swallow) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const noZoom = (e) => e.preventDefault(); // Safari's own page pinch
    el.addEventListener('click', click, true);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('gesturestart', noZoom);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('click', click, true);
      document.removeEventListener('gesturestart', noZoom);
    };
  }, [geo, overview, win]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = new Date(L.now);
  return (
    <div className={`at ${win.phone ? 'at-phone' : ''} ${far ? 'at-is-far' : 'at-is-near'}`} data-screen={here === 'mia' ? 'mia' : 'home'}>
      <Backdrop blur />
      <div ref={box} className="at-viewport" data-here={here || ''} style={{ touchAction: here ? 'pan-y' : 'none' }}>
        <div ref={world} className="at-world" style={{ width: geo.world.w, height: geo.world.h }}>
          {ROOMS.map((k) => (
            <Room key={k} k={k} r={geo.rooms[k]} far={far} L={L} things={things} pulse={pulse} here={here === k && ready === k} onEnter={(x) => enter(x)} onTile={onTile} />
          ))}
        </div>
      </div>
      <AnimatePresence>
        {!here && (
          <motion.header className="at-top" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            <b>
              {greeting(d.getHours())}, Daniel.
            </b>
            <span>{L.sentence} Pinch or tap a room.</span>
          </motion.header>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {here && !winRoute && (
          <motion.button className="at-back" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} onClick={toMap} data-back data-to-map>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="2" fill="currentColor" />
              <rect x="14" y="3" width="7" height="7" rx="2" fill="currentColor" opacity=".6" />
              <rect x="3" y="14" width="7" height="7" rx="2" fill="currentColor" opacity=".6" />
              <rect x="14" y="14" width="7" height="7" rx="2" fill="currentColor" opacity=".6" />
            </svg>
            Map
          </motion.button>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {here && !winRoute && (
          <motion.div key="mini" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}>
            <Minimap geo={geo} win={win} things={things} onRoom={(k) => enter(k)} onOverview={toMap} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="at-mic">
        {v.on && <span className="at-mic-label">{phaseLabel(v.phase)}</span>}
        <MicButton on={v.on} phase={v.phase} big />
      </div>
      <AnimatePresence>{winRoute && <Window key={`${winRoute.kind}:${winRoute.id}`} route={winRoute} things={things} L={L} from={from} />}</AnimatePresence>
    </div>
  );
}

export default function V4B() {
  return <Boot ui="v4b" Direction={Atlas} />;
}
