import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, animate, useScroll, useTransform } from 'motion/react';
import { miaSend, miaAnswer, sendKey, reply } from '../../src/lib/store.js';
import Boot from '../boot.jsx';
import { useLive, useThread, hhmm, ago, splitName } from '../shared/live.js';
import { useQuality } from '../shared/quality.js';
import { useScreen, go } from '../shared/nav.js';
import { talk, useVoice } from '../shared/voice.jsx';

// Direction C — "PRESS" (task 0445). Mission Control as a magazine that is
// printed live: one enormous headline that tells you the state of things,
// set in a variable serif (Fraunces: weight, optical size, softness) whose
// letters animate their weight; the page's whole colour field IS the state
// (amber = something needs you, deep green = working, ink = quiet); numbers
// set huge that count and re-weight when they change; a live wire of what
// the agents are doing runs along the bottom. Mia's chat is "the
// interview" — her words in large serif, yours as the questions.
// Swipe left/right between the cover and the interview.

const WORDS = ['Nothing', 'One thing', 'Two things', 'Three things', 'Four things', 'Five things', 'Six things', 'Seven things', 'Eight things', 'Nine things'];
const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function headline(L) {
  if (L.link !== 'linked') return { lead: L.link === 'relay' ? 'Your Mac' : 'Reconnecting', tail: L.link === 'relay' ? 'is offline.' : 'to your Mac…', tone: 'ink' };
  if (L.items.length) return { lead: WORDS[Math.min(9, L.items.length)], tail: L.items.length === 1 ? 'needs you.' : 'need you.', tone: 'amber' };
  if (L.c.working) return { lead: `${NUM[Math.min(10, L.c.working)]} at work.`, tail: 'Nothing needs you.', tone: 'green' };
  return { lead: 'All quiet.', tail: 'Nothing needs you.', tone: 'ink' };
}

// Letters that arrive heavy-to-light, like ink settling. Weight is the
// variable font's axis — no font swap, no layout jump.
function Kinetic({ text, className = '', delay = 0, italic = false }) {
  const reduce = useQuality((s) => s.reduce);
  // words stay whole (they wrap as words); letters animate inside them
  const words = useMemo(() => String(text).split(/(\s+)/).filter(Boolean), [text]);
  const step = Math.min(0.028, 1.4 / Math.max(1, String(text).length));
  let k = 0;
  return (
    <span className={`ed-kin ${italic ? 'it' : ''} ${className}`} aria-label={text}>
      {words.map((w, wi) =>
        /^\s+$/.test(w) ? (
          ' '
        ) : (
          <span key={wi} className="ed-word" aria-hidden="true">
            {Array.from(w).map((ch) => {
              const i = k++;
              return (
                <span key={i} className={reduce ? '' : 'ed-ch'} style={{ animationDelay: `${delay + i * step}s` }}>
                  {ch}
                </span>
              );
            })}
          </span>
        ),
      )}
    </span>
  );
}

// A number that counts to its new value and flexes its weight as it lands.
function Figure({ value, format = (n) => String(Math.round(n)), className = '' }) {
  const ref = useRef(null);
  const prev = useRef(0);
  const reduce = useQuality((s) => s.reduce);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const from = prev.current;
    prev.current = value;
    if (reduce) {
      el.textContent = format(value);
      return undefined;
    }
    const big = Math.abs(value - from) > Math.max(1, Math.abs(from) * 0.02);
    const a = animate(from, value, { duration: big ? 1.1 : 0.5, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => (el.textContent = format(v)) });
    if (big) el.animate([{ fontVariationSettings: '"wght" 300, "opsz" 144' }, { fontVariationSettings: '"wght" 850, "opsz" 144' }], { duration: 1100, easing: 'cubic-bezier(.16,1,.3,1)' });
    return () => a.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce]);
  return <span ref={ref} className={`ed-fig ${className}`} />;
}

function Answers({ options, onPick }) {
  return (
    <div className="ed-answers">
      {options.map((o, j) => (
        <motion.button key={j} whileTap={{ scale: 0.96 }} onClick={() => onPick(o, j)} data-option={o}>
          {o}
          <span aria-hidden="true">→</span>
        </motion.button>
      ))}
    </div>
  );
}

function Letter({ it, n }) {
  const isMia = it.kind === 'mia';
  const q = it.question;
  const a = it.agent;
  const from = isMia ? `Mia${q.taskId ? `, on #${q.taskId}` : ''}` : `${splitName(a).proj}, ${splitName(a).what}`;
  const text = isMia ? q.text : it.prompt?.question || a.activity || 'Waiting for your input';
  const opts = isMia ? (q.options?.length ? q.options : ['Yes', 'No']).map(String) : it.prompt ? it.prompt.options.slice(0, 3).map((o) => o.label) : ['Continue'];
  const pick = (o, j) => (isMia ? miaAnswer(q.questionId, o) : it.prompt ? sendKey(a.id, String(it.prompt.options[j].n)) : reply(a.id, o));
  return (
    <motion.article className="ed-letter" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 + n * 0.12, type: 'spring', stiffness: 160, damping: 22 }} data-question={isMia ? q.questionId : undefined} data-ask={isMia ? undefined : a.id}>
      <div className="ed-letter-no">{String(n + 1).padStart(2, '0')}</div>
      <div>
        <div className="ed-from">From {from}</div>
        <p className="ed-q">{text}</p>
        <Answers options={opts} onPick={pick} />
      </div>
    </motion.article>
  );
}

function Wire({ agents }) {
  const reduce = useQuality((s) => s.reduce);
  const items = agents.map((a) => {
    const { proj } = splitName(a);
    return { k: a.id, proj, what: a.status === 'idle' ? 'waiting for you' : a.status === 'active' ? a.activity : 'finished', st: a.status };
  });
  const row = (
    <>
      {items.map((x) => (
        <span key={x.k} className={`ed-wire-item ${x.st}`}>
          <b>{x.proj}</b> {x.what}
          <i>✶</i>
        </span>
      ))}
    </>
  );
  return (
    <div className="ed-wire" aria-label="Live from the agents">
      <div className={`ed-wire-track ${reduce ? 'still' : ''}`} style={{ animationDuration: `${Math.max(30, items.length * 7)}s` }}>
        {row}
        {row}
      </div>
    </div>
  );
}

function Cover() {
  const L = useLive();
  const v = useVoice();
  const h = headline(L);
  const d = new Date(L.now);
  const sc = useRef(null);
  const { scrollY } = useScroll({ container: sc });
  const reduce = useQuality((s) => s.reduce);
  // the headline sinks and thins as you read on
  const hy = useTransform(scrollY, [0, 500], [0, reduce ? 0 : 120]);
  const ho = useTransform(scrollY, [0, 420], [1, 0.15]);
  const issue = Math.floor((L.now - Date.UTC(2026, 0, 1)) / 864e5) + 1;
  const last = L.lastMia;
  return (
    <div ref={sc} className={`ed-cover ed-${h.tone}`} data-screen="home" data-tone={h.tone}>
      <header className="ed-mast">
        <span className="ed-mast-title">Mission Control</span>
        <span className="ed-mast-meta">
          No. {issue} · {d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })} · {d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
        </span>
      </header>

      <section className="ed-hero">
        <motion.h1 className="ed-head" style={{ y: hy, opacity: ho }} data-home-sentence>
          <Kinetic text={h.lead} className="ed-lead" />
          <br />
          <Kinetic text={h.tail} italic delay={0.25} className="ed-tail" />
        </motion.h1>
        <div className="ed-side">
          <p className="ed-deck">
            {L.c.working ? `${NUM[Math.min(10, L.c.working)]} agents are at work across ${new Set(L.crew.filter((a) => a.status === 'active').map((a) => a.folder)).size} projects` : 'The fleet is resting'}
            {L.tasks.length ? `; ${L.tasks.length} tasks are in flight.` : '.'} {last ? <>Mia, {ago(Date.parse(last.at), L.now)}: <em>“{last.text}”</em></> : null}
          </p>
          <div className="ed-ctas">
            <motion.button whileTap={{ scale: 0.96 }} className="ed-cta" onClick={() => go('mia')} data-open-mia>
              Talk with Mia {L.unread ? <sup>{L.unread}</sup> : null} <span>→</span>
            </motion.button>
            <motion.button whileTap={{ scale: 0.96 }} className="ed-cta ghost" onClick={() => talk()} data-talk>
              {v.on ? 'Listening…' : 'Speak'}
            </motion.button>
          </div>
        </div>
      </section>

      {L.items.length > 0 && (
        <section className="ed-letters">
          <h2 className="ed-kicker">Waiting on you</h2>
          {L.items.slice(0, 4).map((it, n) => (
            <Letter key={it.key} it={it} n={n} />
          ))}
        </section>
      )}

      <section className="ed-numbers">
        <h2 className="ed-kicker">By the numbers</h2>
        <div className="ed-grid">
          <div className="ed-num">
            <Figure value={L.c.working} />
            <span className="ed-of">of {L.crew.length}</span>
            <p>agents working right now</p>
          </div>
          <div className="ed-num">
            <Figure value={L.s.tokensPerSec || 0} />
            <p>tokens a second, across the fleet</p>
          </div>
          <div className="ed-num">
            <Figure value={L.s.totalCost || 0} format={(n) => `$${n.toFixed(2)}`} />
            <p>spent today</p>
          </div>
          <div className="ed-num">
            <Figure value={L.usage?.pct || 0} format={(n) => `${Math.round(n)}%`} />
            <p>of the {L.usage?.label?.toLowerCase() || 'session'} allowance</p>
          </div>
        </div>
      </section>

      <section className="ed-toc">
        <h2 className="ed-kicker">In this issue</h2>
        {L.tasks.map((t, i) => (
          <div key={t.id} className="ed-toc-row">
            <span className="n">{String(i + 1).padStart(2, '0')}</span>
            <span className="t">{t.title}</span>
            <span className="dots" />
            <span className={`s ${t.status}`}>{t.status === 'asking' ? 'needs you' : t.status}</span>
          </div>
        ))}
      </section>

      <Wire agents={L.crew} />
    </div>
  );
}

function Said({ r, newest }) {
  if (r.event) return <div className="ed-ev">— {r.text} —</div>;
  if (r.mine)
    return (
      <div className={`ed-dan ${r.pending ? 'pending' : ''}`} data-msg="daniel">
        <span className="who">Daniel</span>
        {r.text}
      </div>
    );
  const q = r.m.kind === 'question';
  return (
    <div className={`ed-mia ${newest ? 'newest' : ''} ${q ? 'q' : ''}`} data-msg="mia">
      <span className="who">
        Mia <time>{hhmm(r.ms)}</time>
        {r.m.kind === 'notify' && <em className="done"> · done</em>}
      </span>
      <p>{newest ? <Kinetic text={r.text} /> : r.text}</p>
      {q && r.open && <Answers options={(r.m.options?.length ? r.m.options : ['Yes', 'No']).map(String)} onPick={(o) => miaAnswer(r.m.questionId, o)} />}
      {q && !r.open && r.answer && <div className="ed-said">You answered: {r.answer}</div>}
    </div>
  );
}

function Interview() {
  const { rows, mia } = useThread();
  const v = useVoice();
  const [text, setText] = useState('');
  const sc = useRef(null);
  const n = rows.length;
  useLayoutEffect(() => {
    const el = sc.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [n]);
  const send = () => miaSend(text) && setText('');
  return (
    <div className="ed-iv" data-screen="mia">
      <header className="ed-iv-head">
        <button className="ed-back" onClick={() => go('home')} data-back aria-label="Back to the cover">
          ← Cover
        </button>
        <h1>
          <Kinetic text="Mia" />
          <span className="ed-iv-sub">
            <Kinetic text={v.on ? 'is listening.' : mia?.online ? 'in conversation.' : 'is away.'} italic delay={0.2} />
          </span>
        </h1>
      </header>
      <div ref={sc} className="ed-iv-body" data-thread>
        <div className="ed-iv-in">
          {rows.map((r, i) => (
            <Said key={r.key} r={r} newest={i === n - 1 && !r.mine} />
          ))}
        </div>
      </div>
      <div className="ed-write">
        <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write to Mia…" aria-label="Message Mia" onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())} data-composer />
        <motion.button whileTap={{ scale: 0.94 }} onClick={text.trim() ? send : () => talk()} data-send>
          {text.trim() ? 'Send →' : v.on ? 'Stop' : 'Speak'}
        </motion.button>
      </div>
    </div>
  );
}

function Press() {
  const screen = useScreen();
  const reduce = useQuality((s) => s.reduce);
  const start = useRef(null);
  // A horizontal swipe turns the page (vertical stays scrolling).
  const onDown = (e) => (start.current = { x: e.clientX, y: e.clientY, t: performance.now() });
  const onUp = (e) => {
    const s = start.current;
    start.current = null;
    if (!s || e.target.closest?.('textarea, button')) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) go(dx < 0 ? 'mia' : 'home');
  };
  const t = reduce ? { duration: 0.2 } : { duration: 0.75, ease: [0.76, 0, 0.24, 1] };
  return (
    <div className="ed-root" onPointerDown={onDown} onPointerUp={onUp}>
      <AnimatePresence initial={false}>
        {screen === 'home' ? (
          <motion.div key="cover" className="ed-page" initial={reduce ? { opacity: 0 } : { x: '-30%', opacity: 0.4 }} animate={{ x: 0, opacity: 1 }} exit={reduce ? { opacity: 0 } : { x: '-30%', opacity: 0.4 }} transition={t}>
            <Cover />
          </motion.div>
        ) : (
          <motion.div
            key="iv"
            className="ed-page ed-page-top"
            initial={reduce ? { opacity: 0 } : { clipPath: 'inset(0 0 0 100%)' }}
            animate={{ clipPath: 'inset(0 0 0 0%)', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { clipPath: 'inset(0 0 0 100%)' }}
            transition={t}
          >
            <Interview />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Page() {
  return <Boot ui="v3c" Direction={Press} />;
}
