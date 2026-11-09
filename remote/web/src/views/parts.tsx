'use client';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { open, go } from '@/lib/nav';
import { STAGES, cleanTitle, elapsed, money, ago, type CrewMember, type TaskCard } from '@/lib/model';
import { getMC, miaAnswer, miaDismiss, miaSend, reply, sendKey, useMC } from '@/lib/store';
import type { Agent, MiaQuestion } from '@/lib/types';
import { parsePrompt } from '@/lib/screen';
import { Glass, Icon, LiveText, ModelChip, Num, spring } from '@/ui/kit';
import { ActivityBars, AgentOrb, ProgressRing, Sparkline } from '@/ui/charts';

const usd = (n: number) => money(n);

// ---- stage rail ----------------------------------------------------------------
export function StageRail({ card }: { card: TaskCard }) {
  const idx = STAGES.indexOf(card.stage);
  const cls = card.asking ? 'ask' : card.stage === 'checking' ? 'check' : '';
  return (
    <div className={`stages ${cls}`} aria-label={`Stage: ${card.stage}`}>
      {STAGES.map((s, i) => {
        const done = card.stage === 'done' ? true : i < idx;
        const now = card.stage !== 'done' && i === idx && (card.stage !== 'queued' || card.asking);
        return <i key={s} className={now ? 'now' : done ? 'on' : ''} style={card.failed && card.stage === 'done' ? { background: 'var(--red)' } : card.cancelled ? { background: 'rgba(255,255,255,.25)' } : undefined} />;
      })}
    </div>
  );
}

function statusChip(c: TaskCard) {
  if (c.asking) return <span className="chip amber">Needs you</span>;
  if (c.failed) return <span className="chip red">Failed</span>;
  if (c.cancelled) return <span className="chip">Cancelled</span>;
  if (c.stage === 'running') return <span className="chip green"><span className="dot green live" style={{ width: 6, height: 6 }} />Running</span>;
  if (c.stage === 'checking') return <span className="chip violet">Checking</span>;
  if (c.stage === 'done') return <span className="chip">Done</span>;
  return <span className="chip">Queued</span>;
}

// ---- a task, as a living card ---------------------------------------------------
export function TaskCardView({ card, scope, compact = false }: { card: TaskCard; scope: string; compact?: boolean }) {
  const now = useMC((s) => s.now);
  const lid = `${scope}:task:${card.id}`;
  const active = card.stage === 'running' || card.stage === 'checking';
  return (
    <Glass
      as="button"
      layoutId={lid}
      layout="position"
      className="card"
      style={{ borderRadius: 24 }}
      transition={spring}
      onClick={() => open({ kind: 'task', id: card.id }, lid)}
      data-task={card.id}
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="tiny num" style={{ fontWeight: 650 }}>#{card.id}</span>
        {statusChip(card)}
        <span className="grow" />
        <ModelChip model={card.model} />
      </div>
      <div className={`title-s ${compact ? 'clamp2' : 'clamp3'}`} style={{ marginBottom: 10 }}>{card.title}</div>
      <StageRail card={card} />
      {active || card.asking ? (
        <div className="row" style={{ marginTop: 10 }}>
          <LiveText text={card.now || '…'} className="small grow" />
        </div>
      ) : null}
      <div className="row tiny" style={{ marginTop: active ? 4 : 10, gap: 12 }}>
        {card.startedAt ? <span className="num">{card.stage === 'done' ? ago(card.finishedAt || card.updatedAt, now) : elapsed(card.startedAt, now)}</span> : <span>{card.priority <= 2 ? 'High priority' : 'Waiting for a slot'}</span>}
        {card.cost > 0 ? <Num value={card.cost} format={usd} /> : null}
        {card.attempts > 1 ? <span>run {card.attempts}</span> : null}
        <span className="grow" />
        {card.live ? <CrewSpark k={`j:${card.live.id}`} tone={card.stage === 'checking' ? 'violet' : 'green'} /> : null}
      </div>
    </Glass>
  );
}

function CrewSpark({ k, tone }: { k: string; tone: string }) {
  const data = useMC((s) => (k ? s.hist[k] : undefined));
  if (!data || data.length < 3 || Math.max(...data) === Math.min(...data)) return null;
  return <Sparkline data={data} width={72} height={18} tone={tone} />;
}

// ---- crew member: one agent working right now ----------------------------------
export function CrewTile({ m, scope }: { m: CrewMember; scope: string }) {
  const now = useMC((s) => s.now);
  const lid = `${scope}:crew:${m.key}`;
  const tone = m.state === 'waiting' ? 'amber' : m.state === 'exited' ? 'red' : m.state === 'paused' ? '' : 'green';
  const onClick = () => {
    if (m.taskId) open({ kind: 'task', id: m.taskId }, lid);
    else if (m.agent) open({ kind: 'agent', id: m.agent.id }, lid);
    else if (m.job) open({ kind: 'job', id: String(m.job.id) }, lid);
  };
  return (
    <Glass as="button" layoutId={lid} layout="position" className="card" style={{ borderRadius: 24 }} transition={spring} onClick={onClick} data-crew={m.key}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <AgentOrb model={m.model} size={38} working={m.state === 'working'} state={m.state} seed={m.name} />
        <div className="grow">
          <div className="title-s clamp2">{m.name}</div>
          <div className="row tiny" style={{ marginTop: 3, gap: 8 }}>
            <span className={`dot ${tone} ${m.state === 'working' ? 'live' : ''}`} style={{ width: 6, height: 6 }} />
            <span>{m.kind === 'executor' ? `Executor${m.taskId ? ` · #${m.taskId}` : ''}` : 'Session'}</span>
          </div>
        </div>
        <ModelChip model={m.model} />
      </div>
      <div className="well dark row" style={{ marginTop: 12, padding: '9px 12px', borderRadius: 14, gap: 10 }}>
        <LiveText text={m.doing} className="small grow" />
        {m.state === 'working' ? <ActivityBars level={m.tps ? Math.min(1, m.tps / 60) : 0.55} tone={tone || 'white'} /> : null}
      </div>
      {m.progress ? (
        <div style={{ marginTop: 10 }}>
          <div className="bar"><motion.i animate={{ scaleX: m.progress.done / Math.max(1, m.progress.total) }} initial={false} transition={spring} /></div>
        </div>
      ) : null}
      <div className="row tiny" style={{ marginTop: 10, gap: 12 }}>
        {m.progress ? <ProgressRing value={m.progress.done / Math.max(1, m.progress.total)} size={18} stroke={2.6} tone={tone || 'white'} /> : null}
        {m.startedAt ? <span className="num">{elapsed(m.startedAt, now)}</span> : null}
        {m.cost > 0 ? <Num value={m.cost} format={usd} /> : null}
        {m.progress ? <span className="num">{m.progress.done}/{m.progress.total} steps</span> : null}
        {m.tps > 0 ? <span className="num">{Math.round(m.tps)} tok/s</span> : null}
        <span className="grow" />
        <CrewSpark k={m.job ? `j:${m.job.id}` : m.agent ? `a:${m.agent.id}` : ''} tone={tone || 'white'} />
      </div>
    </Glass>
  );
}

// ---- a question from Mia: answer in one tap -------------------------------------
export function QuestionCard({ q, scope }: { q: MiaQuestion; scope: string }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const task = useMC((s) => (q.taskId ? s.mia?.tasks.find((t) => t.id === q.taskId) : undefined));
  const answer = (a: string) => {
    if (!a.trim()) return;
    setPicked(a);
    setTimeout(() => miaAnswer(q.questionId, a.trim()), 260);
  };
  return (
    <Glass layout className="card" style={{ borderRadius: 24 }} transition={spring} data-question={q.questionId}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="dot amber" />
        <span className="eyebrow" style={{ color: 'var(--amber)' }}>Mia asks</span>
        {task ? (
          <button className="chip trunc" style={{ maxWidth: '46%', display: 'inline-block', lineHeight: '22px' }} onClick={() => open({ kind: 'task', id: task.id })}>#{task.id} · {cleanTitle(task.title)}</button>
        ) : null}
        <span className="grow" />
        <span className="tiny" style={{ whiteSpace: 'nowrap' }}>{q.askedAt ? ago(Date.parse(q.askedAt), getMC().now) : ''}</span>
        <button className="icon-btn" style={{ width: 30, height: 30, color: 'var(--ink-3)' }} aria-label="Dismiss" onClick={() => miaDismiss([q.questionId])}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div style={{ fontSize: 16.5, lineHeight: 1.42, fontWeight: 500, marginBottom: 12 }}>{q.text}</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {(q.options || []).map((o) => (
          <motion.button
            key={o}
            className={`pill ${picked === o ? 'primary' : ''}`}
            style={{ height: 'auto', minHeight: 38, padding: '8px 15px', whiteSpace: 'normal', textAlign: 'left', lineHeight: 1.25 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => answer(o)}
            disabled={!!picked}
          >
            {picked === o ? <Icon name="check" size={16} /> : null}
            {o}
          </motion.button>
        ))}
        {!typing ? (
          <button className="pill" style={{ color: 'var(--ink-2)' }} onClick={() => setTyping(true)} disabled={!!picked}>
            Something else…
          </button>
        ) : null}
      </div>
      <AnimatePresence>
        {typing ? (
          <motion.form
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="row"
            style={{ marginTop: 10, overflow: 'hidden' }}
            onSubmit={(e) => {
              e.preventDefault();
              answer(text);
            }}
          >
            <input className="input grow" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={`Answer ${scope === 'mia' ? '' : 'Mia'}…`} />
            <button className="pill primary" type="submit" disabled={!text.trim()}>Send</button>
          </motion.form>
        ) : null}
      </AnimatePresence>
    </Glass>
  );
}

// ---- a session that stopped at a prompt -------------------------------------------
export function AgentAskCard({ agent }: { agent: Agent }) {
  const screen = useMC((s) => s.screens[agent.id]?.text || agent.screen || '');
  const prompt = useMemo(() => parsePrompt(screen), [screen]);
  const [text, setText] = useState('');
  const exited = agent.alive === false && agent.status !== 'done';
  return (
    <Glass layout className="card" style={{ borderRadius: 24 }} transition={spring} data-ask={agent.id}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`dot ${exited ? 'red' : 'amber'}`} />
        <button className="eyebrow trunc" style={{ color: exited ? 'var(--red)' : 'var(--amber)' }} onClick={() => open({ kind: 'agent', id: agent.id })}>
          {agent.name || agent.folder} {exited ? 'exited' : 'is waiting'}
        </button>
        <span className="grow" />
        <button className="pill small" onClick={() => open({ kind: 'agent', id: agent.id })}>Open</button>
      </div>
      {prompt ? (
        <>
          <div style={{ fontSize: 15.5, fontWeight: 500, marginBottom: 10 }} className="clamp3">{prompt.question || 'Choose an option'}</div>
          <div className="col gap6">
            {prompt.options.slice(0, 6).map((o) => (
              <motion.button key={o.n} whileTap={{ scale: 0.98 }} className="well" style={{ padding: '9px 12px', textAlign: 'left', borderRadius: 14 }} onClick={() => sendKey(agent.id, String(o.n))}>
                <div className="row gap8">
                  <span className="tiny num" style={{ width: 14 }}>{o.n}</span>
                  <span className="grow small" style={{ color: 'var(--ink)' }}>{o.label}</span>
                </div>
                {o.desc ? <div className="tiny" style={{ marginLeft: 22, marginTop: 2 }}>{o.desc}</div> : null}
              </motion.button>
            ))}
          </div>
        </>
      ) : exited ? (
        <div className="small">The process ended before it reported done.</div>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply(agent.id, text)) setText('');
          }}
        >
          <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply to this session…" />
          <button className="pill primary" disabled={!text.trim()}>Send</button>
        </form>
      )}
    </Glass>
  );
}

// ---- Mia's composer (Now + Mia) ---------------------------------------------------
export function Composer({ placeholder = 'Tell Mia what to do…', onSent, autoFocus = false }: { placeholder?: string; onSent?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (miaSend(text)) {
      setText('');
      onSent?.();
    }
  };
  return (
    <Glass lens radius={26} className="row composer" style={{ padding: '6px 6px 6px 16px', alignItems: 'flex-end' }}>
      <textarea
        className="field grow"
        rows={1}
        value={text}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const el = e.target;
          el.style.height = 'auto';
          el.style.height = `${Math.min(160, el.scrollHeight)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        style={{ padding: '9px 0', maxHeight: 160 }}
        aria-label="Message Mia"
      />
      <AnimatePresence mode="popLayout" initial={false}>
        {text.trim() ? (
          <motion.button key="send" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={spring} className="icon-btn" style={{ background: '#fff', color: '#141216', width: 38, height: 38 }} onClick={submit} aria-label="Send">
            <Icon name="send" size={19} stroke={2.2} />
          </motion.button>
        ) : (
          <motion.button key="talk" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={spring} className="icon-btn" style={{ width: 38, height: 38, background: 'rgba(255,255,255,.1)' }} onClick={() => import('@/lib/nav').then((n) => n.setTalk(true))} aria-label="Talk to Mia">
            <Icon name="wave" size={19} />
          </motion.button>
        )}
      </AnimatePresence>
    </Glass>
  );
}

// ---- the four-stage flow strip ---------------------------------------------------------
export function FlowStrip({ counts, onPick }: { counts: Record<string, number>; onPick?: (s: string) => void }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
      {STAGES.map((s, i) => (
        <Glass key={s} as="button" variant="thin" radius={20} style={{ padding: '12px 12px 11px', textAlign: 'left' }} onClick={() => (onPick ? onPick(s) : go('tasks'))} data-stage={s}>
          <div className="row" style={{ gap: 6 }}>
            <span className={`dot ${s === 'running' ? 'green live' : s === 'checking' ? 'violet' : s === 'queued' ? 'amber' : ''}`} style={{ width: 6, height: 6, opacity: counts[s] ? 1 : 0.35 }} />
            <span className="tiny" style={{ fontWeight: 600 }}>{['Queued', 'Running', 'Checking', 'Done today'][i]}</span>
          </div>
          <div className="row" style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 2, gap: 8 }}>
            <Num value={counts[s] || 0} />
            {s === 'running' && counts[s] ? <ActivityBars level={0.6} tone="green" n={4} /> : null}
            {s === 'checking' && counts[s] ? <ProgressRing value={0.3} size={16} stroke={2.4} tone="violet" spin /> : null}
          </div>
        </Glass>
      ))}
    </div>
  );
}
