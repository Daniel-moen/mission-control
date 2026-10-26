import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useDragControls } from 'motion/react';
import { create } from 'zustand';
import { useMC, miaSend, agentName } from '../../src/lib/store.js';
import Boot from '../boot.jsx';
import { useThings, KIND_LABEL } from '../shared/model.js';
import { useRoute, openRoute, closeRoute } from '../shared/route.js';
import { Backdrop, NeedBody, AgentBody, DocBody, Thread, Composer, TasksBody, PulseBody, Spark, Dot, useWin, spring, soft, splitName, phaseLabel } from '../shared/parts.jsx';
import { useVoice, talk } from '../../v3/shared/voice.jsx';
import { greeting } from '../../v3/shared/live.js';

// Direction A — "STAGE" (task 0446). There is no navigation. There is Mia,
// and a stage. Everything — questions, agents, docs, tasks, the pulse —
// arrives as a live card that Mia brings on (because it needs you, because
// she just mentioned it, because you asked for it, or because she ran
// `mia panel open-…`). Cards are objects, not pages:
//   • flick down (or sideways on iPad) → it leaves the stage
//   • flick up or tap → it opens full-screen; pull it down to put it back
//   • pin → it stays on the stage across visits
// Typing and voice are the only menu: "show agents", "what needs me",
// "open the Fresnaye report", or anything else (that goes to Mia).

const PIN_KEY = 'mc.v4a.pins';
const readPins = () => {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
  } catch {
    return [];
  }
};
const useStage = create(() => ({ keys: [], gone: new Set(), pins: readPins(), said: null, seeded: false }));
const savePins = (pins) => {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  } catch {}
};
function bring(keys, said) {
  const s = useStage.getState();
  const gone = new Set(s.gone);
  keys.forEach((k) => gone.delete(k));
  const rest = s.keys.filter((k) => !keys.includes(k));
  useStage.setState({ keys: [...keys, ...rest], gone, ...(said !== undefined ? { said: said && { text: said, at: Date.now() } } : {}) });
}
function flick(key) {
  const s = useStage.getState();
  const gone = new Set(s.gone);
  gone.add(key);
  const pins = s.pins.filter((k) => k !== key);
  if (pins.length !== s.pins.length) savePins(pins);
  useStage.setState({ keys: s.keys.filter((k) => k !== key), gone, pins });
}
function togglePin(key) {
  const s = useStage.getState();
  const pins = s.pins.includes(key) ? s.pins.filter((k) => k !== key) : [key, ...s.pins];
  savePins(pins);
  useStage.setState({ pins });
}

const norm = (x) => String(x || '').toLowerCase().replace(/[-_·]+/g, ' ').replace(/\s+/g, ' ').trim();

// What Mia's recent words point at → cards.
function mentions(text, things) {
  const t = ` ${norm(text)} `;
  const out = [];
  for (const th of things) {
    if (th.kind === 'task' && (t.includes(` ${th.id} `) || t.includes(`#${th.id}`) || t.includes(` ${norm(th.title)} `))) out.push(th.key);
    else if ((th.kind === 'agent' || (th.kind === 'need' && th.from === 'agent')) && th.agent) {
      const p = norm(splitName(th.agent).proj);
      if (p.length > 3 && t.includes(p)) out.push(th.key);
    } else if (th.kind === 'doc') {
      const words = norm(th.doc.subject).split(' ').filter((w) => w.length > 4);
      if (words.length && words.every((w) => t.includes(w))) out.push(th.key);
    } else if (th.kind === 'pulse' && /\$\d|spent|spend|tokens|allowance/.test(t)) out.push(th.key);
  }
  return out;
}

// Typed/voiced intents the stage answers itself (instantly, no round trip).
// Anything else is a message to Mia.
function intent(text, things) {
  const q = norm(text);
  const of = (k) => things.filter((t) => t.kind === k).map((t) => t.key);
  if (/^(clear|clear the stage|tidy|clean up)$/.test(q)) return { keys: [], clear: true, said: 'Cleared the stage.' };
  if (/\b(need|needs|waiting|questions?)\b/.test(q) && /\b(me|on me|for me|you)\b/.test(q)) {
    const k = of('need');
    return { keys: k, said: k.length ? `${k.length === 1 ? 'One thing is' : `${k.length} things are`} waiting on you.` : 'Nothing is waiting on you.' };
  }
  if (/^(show |open )?(the )?(agents|fleet|who'?s working|workers)\b/.test(q)) return { keys: things.filter((t) => t.agent).map((t) => t.key), said: 'Here’s everyone on the board.' };
  if (/^(show |open )?(the )?(tasks|task board|board)\b/.test(q)) return { keys: ['tasks'], open: 'tasks', said: 'The task board.' };
  if (/^(show |open )?(the )?(library|docs|documents|research|reports|notes)\b/.test(q)) return { keys: of('doc'), said: 'Latest from the Library.' };
  if (/^(show |open )?(the )?(pulse|insights|spend|spending|usage|stats|numbers)\b/.test(q)) return { keys: ['pulse'], open: 'pulse', said: 'Today’s pulse.' };
  const m = /^(?:show|open|bring)(?: me)? (?:the )?(.+)$/.exec(q);
  if (m) {
    const w = m[1].split(' ').filter((x) => x.length > 2 && !['report', 'doc', 'agent', 'task'].includes(x));
    if (!w.length) return null;
    const hit = things.find((t) => {
      const hay = norm(`${t.title} ${t.eyebrow} ${t.id} ${t.agent ? agentName(t.agent) : ''} ${t.doc?.subject || ''}`);
      return w.every((x) => hay.includes(x));
    });
    if (hit) return { keys: [hit.key], open: hit.key, said: `Here’s ${hit.title.length > 48 ? hit.title.slice(0, 46) + '…' : hit.title}.` };
  }
  return null;
}

const SUGGEST = ['What needs me?', 'Show agents', 'Show the library', 'Show tasks', 'Today’s pulse'];

// route ↔ card key
const keyForRoute = (r, byKey) => {
  if (!r.kind || r.kind === 'mia') return null;
  if (r.kind === 'agent') return byKey[`need:${r.id}`] ? `need:${r.id}` : `agent:${r.id}`;
  if (r.kind === 'tasks' || r.kind === 'pulse') return r.kind;
  if (r.kind === 'task') return byKey[`task:${r.id}`] ? `task:${r.id}` : 'tasks';
  return `${r.kind}:${r.id}`;
};
const routeForKey = (k) => {
  if (k === 'tasks' || k === 'pulse') return [k];
  const [kind, ...rest] = k.split(':');
  return [kind, rest.join(':')];
};

function CardFace({ t, L }) {
  if (t.kind === 'need') return <NeedBody t={t} />;
  if (t.kind === 'pulse') return <PulseBody t={t} />;
  if (t.kind === 'tasks') return (
    <div>
      <div className="v4-eyebrow">Tasks · {L.tasks.length} live</div>
      <TasksBody tasks={L.tasks.slice(0, 4)} />
    </div>
  );
  if (t.kind === 'agent') {
    const lines = (t.agent.screen || '').split('\n').filter((x) => x.trim() && !/^[╭╰│─]/.test(x.trim())).slice(-4);
    return (
      <div className="st-agent">
        <div className="v4-eyebrow">
          <Dot tone={t.working ? 'g' : 'n'} />
          {t.eyebrow}
        </div>
        <h3 className="v4-h3">{t.title}</h3>
        <p className="v4-dim st-act">{t.sub}</p>
        {lines.length > 0 && <pre className="st-tail">{lines.join('\n')}</pre>}
        <div className="st-foot">
          <span>{Math.round(t.tps)} tok/s</span>
          <span>${t.cost.toFixed(2)}</span>
        </div>
      </div>
    );
  }
  if (t.kind === 'doc') return (
    <div className="st-doc">
      <div className="v4-eyebrow">{t.eyebrow}</div>
      <h3 className="v4-h3 st-doc-title">{t.title}</h3>
      <p className="v4-dim">Open to read · pull up</p>
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
  return <div className="v4-h3">{t.title}</div>;
}

function Card({ t, L, i, phone, pinned }) {
  const drag = useDragControls();
  const moved = useRef(false);
  const [leaving, setLeaving] = useState(null);
  return (
    <motion.div
      layout
      layoutId={`card-${t.key}`}
      className={`st-card st-card-${t.kind} ${pinned ? 'st-pinned' : ''}`}
      data-card={t.key}
      initial={{ opacity: 0, scale: 0.6, x: phone ? -60 : -260, y: phone ? 80 : 30, rotate: -8 }}
      animate={{ opacity: 1, scale: 1, x: 0, y: 0, rotate: 0 }}
      exit={leaving ? { opacity: 0, x: leaving.x, y: leaving.y, rotate: leaving.x / 30, transition: { duration: 0.32 } } : { opacity: 0, scale: 0.85 }}
      transition={{ ...soft, delay: Math.min(i, 5) * 0.06 }}
      drag={phone ? 'y' : true}
      dragSnapToOrigin
      dragElastic={0.7}
      dragControls={drag}
      whileDrag={{ scale: 1.03, zIndex: 20, cursor: 'grabbing' }}
      onDragStart={() => (moved.current = true)}
      onDragEnd={(e, info) => {
        const { offset: o, velocity: v } = info;
        if (o.y < -90 || v.y < -650) return openRoute(...routeForKey(t.key));
        const away = o.y > 110 || v.y > 700 || (!phone && (Math.abs(o.x) > 160 || Math.abs(v.x) > 800));
        if (away) {
          const dx = !phone && Math.abs(o.x) > Math.abs(o.y) ? Math.sign(o.x) * 700 : 0;
          setLeaving({ x: dx, y: dx ? o.y : 600 });
          setTimeout(() => flick(t.key), 0);
        }
      }}
      onClick={() => {
        if (moved.current) return void (moved.current = false);
        if (t.kind !== 'need') openRoute(...routeForKey(t.key));
      }}
    >
      <div className="st-card-chrome">
        <span className="st-kind">{KIND_LABEL[t.kind] || 'Tasks'}</span>
        <button
          className={`st-pin ${pinned ? 'on' : ''}`}
          aria-label={pinned ? 'Unpin' : 'Pin to the stage'}
          data-pin={t.key}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            togglePin(t.key);
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <CardFace t={t} L={L} />
    </motion.div>
  );
}

// A card pulled out full-screen. Pull it down (from anywhere on its header)
// and it springs back into its place on the stage.
function Open({ t, L }) {
  const drag = useDragControls();
  // Grow out of its card when it's on the stage; otherwise (a deep link, or
  // Mia opening something that wasn't there yet) rise from below.
  const [fromCard] = useState(() => !!document.querySelector(`[data-card="${CSS.escape(t.key)}"]`));
  return (
    <motion.div className="st-open-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="st-scrim" onClick={closeRoute} />
      <motion.div
        layoutId={fromCard ? `card-${t.key}` : undefined}
        initial={fromCard ? undefined : { y: '100%' }}
        animate={fromCard ? undefined : { y: 0 }}
        exit={fromCard ? undefined : { y: '110%' }}
        className={`st-open st-open-${t.kind}`}
        data-open={t.key}
        transition={spring}
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.05, bottom: 0.9 }}
        onDragEnd={(e, info) => (info.offset.y > 120 || info.velocity.y > 600) && closeRoute()}
      >
        <div className="st-open-head" onPointerDown={(e) => drag.start(e)} style={{ touchAction: 'none' }}>
          <i className="st-grabber" />
          <span className="st-kind">{KIND_LABEL[t.kind] || 'Tasks'}</span>
          <button className="st-close" onClick={closeRoute} aria-label="Put it back" data-back>
            ✕
          </button>
        </div>
        <div className="st-open-body">
          {t.kind === 'need' && (
            <>
              <NeedBody t={t} big onDone={() => setTimeout(closeRoute, 350)} />
              {t.agent && <AgentBody a={t.agent} />}
              {t.from === 'mia' && <Thread limit={8} className="st-open-thread" />}
            </>
          )}
          {t.kind === 'agent' && <AgentBody a={t.agent} />}
          {t.kind === 'doc' && <DocBody id={t.id} />}
          {t.kind === 'task' && (
            <div>
              <div className="v4-eyebrow">{t.eyebrow}</div>
              <h2 className="v4-h2">{t.title}</h2>
              <p className="v4-dim">{t.task.dir}</p>
              <TasksBody tasks={L.tasks} done={L.doneTasks} />
            </div>
          )}
          {t.kind === 'tasks' && (
            <>
              <h2 className="v4-h2">Tasks</h2>
              <TasksBody tasks={L.tasks} done={L.doneTasks} />
            </>
          )}
          {t.kind === 'pulse' && <PulseBody t={t} big />}
        </div>
      </motion.div>
    </motion.div>
  );
}

// Mia's voice on the stage: her latest words, large; your last line above.
function Voice({ L, said, onOpenThread, v }) {
  const last = L.lastMia;
  const text = said && (!last || said.at > (last.at > 1e12 ? last.at : 0)) && Date.now() - said.at < 20000 ? said.text : last?.text?.replace(/^\(voice\)\s*/, '') || 'Hi Daniel.';
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const mine = useMemo(() => {
    const ms = L.mia?.messages || [];
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i].from === 'daniel' && ms[i].kind === 'chat') return ms[i].text.replace(/^\(voice\)\s*/, '');
    return '';
  }, [L.mia]);
  return (
    <motion.div
      className="st-voice"
      data-open-mia
      onClick={onOpenThread}
      drag="y"
      dragSnapToOrigin
      dragElastic={0.25}
      dragConstraints={{ top: 0, bottom: 0 }}
      onDragEnd={(e, info) => (info.offset.y < -50 || info.velocity.y < -400) && onOpenThread()}
    >
      <div className="st-who">
        <span className={`st-orb ${L.thinking ? 'st-orb-think' : ''} ${v.on ? 'st-orb-talk' : ''} ${L.items.length ? 'st-orb-attn' : ''}`} />
        <b>Mia</b>
        <span className="v4-dim">{v.on ? phaseLabel(v.phase) : L.thinking ? 'thinking…' : L.online ? 'here' : 'resting'}</span>
      </div>
      {mine && <div className="st-mine">“{mine}”</div>}
      <p className="st-words" key={text}>
        {words.map((w, i) => (
          <motion.span key={i} initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.45, delay: Math.min(i, 40) * 0.035 }}>
            {w}{' '}
          </motion.span>
        ))}
      </p>
      <div className="st-swipe-hint v4-dim">Swipe up for the whole conversation</div>
    </motion.div>
  );
}

function ThreadSheet() {
  const drag = useDragControls();
  return (
    <motion.div className="st-thread-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} data-screen="mia">
      <motion.div
        className="st-thread"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={spring}
        drag="y"
        dragControls={drag}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.05, bottom: 0.9 }}
        onDragEnd={(e, info) => (info.offset.y > 120 || info.velocity.y > 600) && closeRoute()}
      >
        <div className="st-open-head" onPointerDown={(e) => drag.start(e)} style={{ touchAction: 'none' }}>
          <i className="st-grabber" />
          <span className="st-kind">Conversation</span>
          <button className="st-close" onClick={closeRoute} aria-label="Back to the stage" data-back>
            ✕
          </button>
        </div>
        <Thread className="st-thread-list" />
        <Composer className="st-thread-composer" />
      </motion.div>
    </motion.div>
  );
}

function Stage() {
  const { L, things, byKey, lookup } = useThings();
  const r = useRoute();
  const win = useWin();
  const v = useVoice();
  const { keys, gone, pins, said, seeded } = useStage();
  const tasksThing = useMemo(() => ({ key: 'tasks', kind: 'tasks', title: 'Tasks', at: 0, score: 0 }), []);
  const routeKey0 = keyForRoute(r, byKey);
  const extra = routeKey0 && !byKey[routeKey0] ? lookup(routeKey0) : null;
  const all = useMemo(() => ({ ...byKey, tasks: tasksThing, ...(extra ? { [extra.key]: extra } : {}) }), [byKey, tasksThing, extra?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed the stage: what needs you, pinned cards, then her best guesses.
  useEffect(() => {
    if (seeded || !things.length || !L.mia) return;
    const needs = things.filter((t) => t.kind === 'need').map((t) => t.key);
    const lastWords = (L.mia.messages || []).filter((m) => m.from === 'mia').slice(-3).map((m) => m.text).join(' ');
    const ment = mentions(lastWords, things);
    const fill = things.filter((t) => t.kind === 'agent' && t.working).slice(0, 2).map((t) => t.key);
    const k = [...new Set([...needs, ...pins.filter((p) => all[p]), ...ment, ...fill])].slice(0, 7);
    useStage.setState({ keys: k, seeded: true });
  }, [things, L.mia, seeded, pins, all]);

  // New needs and new mentions arrive on their own.
  const lastId = L.lastMia?.id;
  const needKeys = things.filter((t) => t.kind === 'need').map((t) => t.key).join(',');
  useEffect(() => {
    if (!seeded) return;
    const s = useStage.getState();
    const fresh = needKeys.split(',').filter((k) => k && !s.keys.includes(k) && !s.gone.has(k));
    const ment = L.lastMia ? mentions(L.lastMia.text, things).filter((k) => !s.keys.includes(k)) : [];
    if (fresh.length || ment.length) bring([...fresh, ...ment]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKeys, lastId, seeded]);

  // A route (Mia's `mia panel open-…`, a push, a deep link) brings its card.
  const openKey = keyForRoute(r, all);
  useEffect(() => {
    if (openKey && all[openKey] && !useStage.getState().keys.includes(openKey)) bring([openKey]);
    else if (r.kind === 'agents') {
      bring(things.filter((t) => t.agent).map((t) => t.key), 'Here’s everyone on the board.');
      closeRoute();
    } else if (r.kind === 'library') {
      bring(things.filter((t) => t.kind === 'doc').map((t) => t.key), 'Latest from the Library.');
      closeRoute();
    }
  }, [openKey, r.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = (text) => {
    const it = intent(text, things);
    if (!it) return false; // → Mia
    if (it.clear) useStage.setState({ keys: useStage.getState().keys.filter((k) => pins.includes(k)), said: { text: it.said, at: Date.now() } });
    else bring(it.keys, it.said);
    if (it.open) setTimeout(() => openRoute(...routeForKey(it.open)), 450);
    return true;
  };

  const ordered = useMemo(() => {
    const on = keys.filter((k) => all[k] && !gone.has(k));
    return [...on.filter((k) => pins.includes(k)), ...on.filter((k) => !pins.includes(k))];
  }, [keys, gone, pins, all]);
  // on the phone strip, whatever she just brought in slides into view
  const table = useRef(null);
  const first = ordered[0];
  useEffect(() => {
    if (win.phone) table.current?.scrollTo({ left: 0, behavior: 'smooth' });
  }, [first, win.phone]);
  const max = win.phone ? 12 : Math.max(2, Math.floor(((win.w > win.h ? win.h - 90 : win.h * 0.6 - 150)) / 250)) * 2;
  const shown = ordered.slice(0, max);
  const open = openKey && all[openKey] ? all[openKey] : null;
  const d = new Date(L.now);

  return (
    <div className={`st ${win.phone ? 'st-phone' : win.w > win.h ? 'st-land' : 'st-port'}`} data-screen={r.kind === 'mia' ? 'stage-under' : 'home'}>
      <Backdrop />
      <header className="st-top">
        <span>
          {greeting(d.getHours())}, Daniel · <b>{L.sentence}</b>
        </span>
      </header>
      {/* the stage recedes while a card (or the conversation) is pulled out */}
      <motion.div className="st-layer" animate={open || r.kind === 'mia' ? { scale: 0.93, opacity: 0.45, filter: 'blur(4px)' } : { scale: 1, opacity: 1, filter: 'blur(0px)' }} transition={spring}>
      <Voice L={L} said={said} v={v} onOpenThread={() => openRoute('mia')} />
      <div ref={table} className="st-table" data-stage>
        <AnimatePresence mode="popLayout">
          {shown.map((k, i) => (
            <Card key={k} t={all[k]} L={L} i={i} phone={win.phone} pinned={pins.includes(k)} />
          ))}
        </AnimatePresence>
        {!shown.length && (
          <motion.div className="st-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            The stage is clear. Ask for anything.
          </motion.div>
        )}
        {ordered.length > max && <div className="st-more v4-dim">+{ordered.length - max} more — say “show …”</div>}
      </div>
      </motion.div>
      <div className="st-bottom">
        <div className="st-suggest" aria-label="Try saying">
          {SUGGEST.map((s) => (
            <button key={s} onClick={() => onSubmit(s) || miaSend(s)} data-say={s}>
              {s}
            </button>
          ))}
        </div>
        <Composer onSubmit={onSubmit} placeholder={v.on ? `${phaseLabel(v.phase)}…` : 'Ask Mia, or say “show agents”'} />
      </div>
      <AnimatePresence>{open && <Open key={open.key} t={open} L={L} />}</AnimatePresence>
      <AnimatePresence>{r.kind === 'mia' && <ThreadSheet key="thread" />}</AnimatePresence>
    </div>
  );
}

export default function V4A() {
  return <Boot ui="v4a" Direction={Stage} />;
}
export { talk };
