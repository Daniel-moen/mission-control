import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useMC, miaSend, miaAnswer, sendKey, reply, cleanScreen, screenInfoFor, fmtTokens } from '../../src/lib/store.js';
import { ansiToHtml } from '../../src/lib/ansi.js';
import { useScreen, useWatch } from '../../src/lib/hooks.js';
import { useThread, hhmm, ago, splitName, toMs } from '../../v3/shared/live.js';
import { talk, useVoice } from '../../v3/shared/voice.jsx';
import { useDocBody } from '../../v2/views/docBody.js';

// v4 (task 0446): the building blocks every direction composes — the live
// bodies of a question, an agent, a doc, the conversation, the tasks, the
// pulse. Where they appear and how you get to them is each direction's job.

export const spring = { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 };
export const soft = { type: 'spring', stiffness: 220, damping: 28 };

export function answerNeed(t, j) {
  const o = t.options[j];
  if (t.from === 'mia') return miaAnswer(t.q.questionId, o);
  if (t.prompt) return sendKey(t.agent.id, String(t.prompt.options[j].n));
  return reply(t.agent.id, o || '');
}

// The photo the glass sits on (v1's set), chosen for the time of day like
// Lens; ?bg=NN picks one. `blur` pre-blurs it once (a static layer) so panes
// over it can be cheap translucent fills instead of live backdrop blurs.
export function Backdrop({ blur = false }) {
  const file = useMemo(() => {
    const pick = new URLSearchParams(location.search).get('bg');
    const h = new Date().getHours();
    return pick ? `${pick.padStart(2, '0')}.jpg` : ['05.jpg', '01.jpg', '03.jpg', '06.jpg', '01.jpg'][h < 6 ? 0 : h < 10 ? 1 : h < 16 ? 2 : h < 20 ? 3 : 4];
  }, []);
  return (
    <div className={`v4-backdrop ${blur ? 'v4-backdrop-blur' : ''}`} aria-hidden="true">
      <div className="v4-photo" style={{ backgroundImage: `url(/bg/${file})` }} />
      <div className="v4-veil" />
    </div>
  );
}

export const Dot = ({ tone = 'g' }) => <i className={`v4-dot v4-dot-${tone}`} />;

export function Spark({ values = [], w = 120, h = 28, className = '', stretch = false }) {
  const d = useMemo(() => {
    const v = values.length > 1 ? values : [0, 0];
    const max = Math.max(1, ...v);
    return v.map((x, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - (x / max) * (h - 4)).toFixed(1)}`).join('');
  }, [values, w, h]);
  return (
    <svg className={`v4-spark ${className}`} viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio={stretch ? 'none' : undefined} aria-hidden="true">
       <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// A question waiting on Daniel, answered in one tap.
export function NeedBody({ t, big = false, onDone }) {
  const [picked, setPicked] = useState(null);
  return (
    <div className={`v4-need ${big ? 'v4-need-big' : ''}`} data-question={t.from === 'mia' ? t.id : undefined} data-ask={t.from === 'agent' ? t.id : undefined}>
      <div className="v4-eyebrow v4-amber">
        <Dot tone="a" />
        {t.eyebrow}
      </div>
      <p className="v4-need-q">{t.title}</p>
      {!!t.options.length && (
        <div className="v4-opts">
          {t.options.map((o, j) => (
            <motion.button
              key={j}
              whileTap={{ scale: 0.94 }}
              className={`v4-opt ${j === 0 ? 'v4-opt-main' : ''} ${picked === j ? 'v4-opt-picked' : ''}`}
              data-option={o}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setPicked(j);
                answerNeed(t, j);
                onDone?.(j);
              }}
            >
              {o}
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}

// The live terminal of an agent (a watch lease while it's on screen), its
// menu as buttons when it's asking, and a line to reply.
export function AgentBody({ a, prompt, compact = false }) {
  useWatch(compact ? null : a?.id);
  useScreen(a?.id);
  const info = a ? screenInfoFor(a) : { text: '' };
  const html = useMemo(() => {
    const c = cleanScreen(info.text) || '';
    const lines = c.split('\n');
    return ansiToHtml((lines.length > 300 ? lines.slice(-300) : lines).join('\n'));
  }, [info.text]);
  const pre = useRef(null);
  useLayoutEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [html]);
  const [text, setText] = useState('');
  if (!a) return <div className="v4-empty">This agent has left the board.</div>;
  const n = splitName(a);
  const st = a.status === 'active' ? 'g' : a.status === 'idle' ? 'a' : 'n';
  return (
    <div className={`v4-agent ${compact ? 'v4-agent-compact' : ''}`} data-agent={a.id}>
      <div className="v4-agent-head">
        <div>
          <div className="v4-eyebrow">
            <Dot tone={st} />
            {n.proj}
          </div>
          <h2 className="v4-h2">{n.what || n.proj}</h2>
          <div className="v4-meta">
            {a.activity && <span>{a.activity}</span>}
            <span>{Math.round(a.tokensPerSec || 0)} tok/s</span>
            {a.tokens ? <span>{fmtTokens(a.tokens)} tokens</span> : null}
            {a.cost ? <span>${a.cost.toFixed(2)}</span> : null}
          </div>
        </div>
      </div>
      <pre ref={pre} className="v4-term" dangerouslySetInnerHTML={{ __html: html || '<span class="v4-dim">No output yet.</span>' }} />
      {prompt && (
        <div className="v4-opts v4-agent-opts">
          {prompt.options.slice(0, 5).map((o) => (
            <motion.button key={o.n} whileTap={{ scale: 0.95 }} className="v4-opt" data-option={o.label} onClick={() => sendKey(a.id, String(o.n))}>
              <b>{o.n}</b> {o.label}
            </motion.button>
          ))}
        </div>
      )}
      {!compact && a.controllable !== false && (
        <form
          className="v4-line"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) reply(a.id, text.trim());
            setText('');
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Tell ${n.proj}…`} aria-label="Reply to agent" />
          <button type="submit" disabled={!text.trim()} aria-label="Send">
            ↑
          </button>
        </form>
      )}
    </div>
  );
}

export function DocBody({ id, compact = false }) {
  const { meta, doc, html, setArticle } = useDocBody(id);
  return (
    <div className={`v4-doc ${compact ? 'v4-doc-compact' : ''}`} data-doc={id}>
      <div className="v4-eyebrow">
        {meta?.kind || 'doc'}
        {meta?.subject ? ` · ${meta.subject}` : ''}
        {meta?.updatedAt ? ` · ${ago(toMs(meta.updatedAt))}` : ''}
      </div>
      {!doc && <h2 className="v4-h2">{meta?.title || id}</h2>}
      {doc ? <article ref={setArticle} className="v4-md" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="v4-loading">Opening…</div>}
    </div>
  );
}

// The conversation with Mia: her words, Daniel's, questions with one-tap
// answers. Follows the newest line.
export function Thread({ limit = 0, className = '' }) {
  const { rows } = useThread();
  const shown = limit ? rows.slice(-limit) : rows;
  const box = useRef(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  return (
    <div ref={box} className={`v4-thread ${className}`} data-thread>
      {shown.map((r) =>
        r.event ? (
          <div key={r.key} className="v4-msg-event">
            {r.text}
          </div>
        ) : (
          <div key={r.key} className={`v4-msg ${r.mine ? 'v4-msg-me' : 'v4-msg-mia'} ${r.pending ? 'v4-msg-pending' : ''} ${r.m.kind === 'question' ? 'v4-msg-q' : ''}`}>
            <div className="v4-msg-text">
              {r.voice && <span className="v4-voice-tag">🎙 </span>}
              {r.text}
            </div>
            {r.m.kind === 'question' &&
              (r.open ? (
                <div className="v4-opts">
                  {(r.m.options?.length ? r.m.options : ['Yes', 'No']).map((o, j) => (
                    <motion.button key={j} whileTap={{ scale: 0.94 }} className={`v4-opt ${j === 0 ? 'v4-opt-main' : ''}`} data-option={o} onClick={() => miaAnswer(r.m.questionId, String(o))}>
                      {String(o)}
                    </motion.button>
                  ))}
                </div>
              ) : r.answer ? (
                <div className="v4-msg-answer">You said “{r.answer}”</div>
              ) : null)}
            <div className="v4-msg-at">{hhmm(r.ms)}</div>
          </div>
        ),
      )}
    </div>
  );
}

// Type to Mia, or hold/tap the mic to talk. The only "menu" Stage has.
export function Composer({ placeholder = 'Ask Mia anything…', onSubmit, autoFocus = false, className = '' }) {
  const [text, setText] = useState('');
  const v = useVoice();
  const send = (e) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t) return;
    if (!onSubmit?.(t)) miaSend(t);
    setText('');
  };
  return (
    <form className={`v4-composer ${className}`} onSubmit={send} data-composer>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="Message Mia" autoFocus={autoFocus} enterKeyHint="send" />
      {text.trim() ? (
        <motion.button type="submit" className="v4-send" whileTap={{ scale: 0.9 }} aria-label="Send">
          ↑
        </motion.button>
      ) : (
        <MicButton on={v.on} phase={v.phase} />
      )}
    </form>
  );
}

const PHASE = { starting: 'Waking', connecting: 'Connecting', listening: 'Listening', hearing: 'Listening', transcribing: 'Got it', thinking: 'Thinking', speaking: 'Speaking', standby: 'Tap to talk', paused: 'Paused', error: 'No mic' };
export const phaseLabel = (p) => PHASE[p] || '';

export function MicButton({ on, phase, className = '', big = false }) {
  return (
    <motion.button
      type="button"
      className={`v4-mic ${on ? 'v4-mic-on' : ''} ${big ? 'v4-mic-big' : ''} ${className}`}
      whileTap={{ scale: 0.88 }}
      onClick={talk}
      aria-label={on ? `Talk mode: ${phaseLabel(phase)} — tap to stop` : 'Talk to Mia'}
      data-talk
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      </svg>
    </motion.button>
  );
}

export function TasksBody({ tasks, done = [] }) {
  return (
    <div className="v4-tasks" data-tasks>
      {tasks.map((t) => (
        <div key={t.id} className="v4-task">
          <Dot tone={t.status === 'running' ? 'g' : t.status === 'asking' ? 'a' : 'n'} />
          <div>
            <b>{t.title}</b>
            <span>
              #{t.id} · {t.status}
            </span>
          </div>
        </div>
      ))}
      {done.slice(-4).reverse().map((t) => (
        <div key={t.id} className="v4-task v4-task-done">
          <Dot tone="n" />
          <div>
            <b>{t.title}</b>
            <span>#{t.id} · done</span>
          </div>
        </div>
      ))}
      {!tasks.length && !done.length && <div className="v4-empty">No tasks on the board.</div>}
    </div>
  );
}

export function PulseBody({ t, big = false }) {
  return (
    <div className={`v4-pulse ${big ? 'v4-pulse-big' : ''}`} data-pulse>
      <div className="v4-eyebrow">Pulse · {t.working} working</div>
      <div className="v4-pulse-row">
        <div>
          <div className="v4-big-num">${t.cost.toFixed(2)}</div>
          <span className="v4-dim">spent today</span>
        </div>
        <div>
          <div className="v4-big-num">{Math.round(t.tps.at(-1) || 0)}</div>
          <span className="v4-dim">tokens / sec</span>
        </div>
      </div>
      <Spark values={t.tps} w={big ? 520 : 240} h={big ? 80 : 36} stretch className="v4-green" />
      {t.usage && (
        <div className="v4-usage">
          <div className="v4-usage-bar">
            <i style={{ width: `${Math.min(100, t.usage.pct)}%` }} />
          </div>
          <span className="v4-dim">
            {Math.round(t.usage.pct)}% of {t.usage.label}
          </span>
        </div>
      )}
    </div>
  );
}

// Window size class, kept live (Stage Manager windows resize).
export function useWin() {
  const get = () => ({ w: innerWidth, h: innerHeight, phone: innerWidth < 700, wide: innerWidth >= 1000 });
  const [s, set] = useState(get);
  useEffect(() => {
    const f = () => set(get());
    addEventListener('resize', f);
    return () => removeEventListener('resize', f);
  }, []);
  return s;
}

export { useMC, ago, hhmm, splitName, toMs };
