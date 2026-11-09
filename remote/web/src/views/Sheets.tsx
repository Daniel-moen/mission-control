'use client';
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { close, open, type Sheet } from '@/lib/nav';
import {
  docGet, forgetToken, getMC, kill, launch, miaPushTest, miaRestart, miaSend, miaSetModel, miaStart, miaTaskAdd, miaTaskCancel, miaTaskSet, reply, sendKey, useMC, watchAgent, BUILD,
} from '@/lib/store';
import { cleanTitle, describeTool, elapsed, isLive, jobsByTask, money, tailLine, taskCards, modelName, ago } from '@/lib/model';
import { cleanScreen, parsePrompt } from '@/lib/screen';
import { Glass, Icon, ModelChip, Num, spring } from '@/ui/kit';
import { setCalm, setTilt, useGlassPrefs } from '@/lib/glass';
import { QuestionCard, StageRail } from './parts';
import { enablePush, pushState } from '@/lib/push';

function Head({ title, sub, right }: { title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="sheet-head" style={{ cursor: 'grab' }}>
      <div className="grow" style={{ paddingTop: 10 }}>
        {sub ? <div className="tiny" style={{ marginBottom: 2 }}>{sub}</div> : null}
        <div className="title-m clamp2">{title}</div>
      </div>
      {right}
      <button className="icon-btn" style={{ background: 'rgba(255,255,255,.1)', width: 34, height: 34, marginTop: 8 }} onClick={close} aria-label="Close">
        <Icon name="close" size={17} />
      </button>
    </div>
  );
}

function Feed({ lines }: { lines: string[] }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      {lines.slice(-8).map((l, i, all) => {
        const t = tailLine(l);
        const last = i === all.length - 1;
        return (
          <motion.div key={`${l}-${i}`} layout="position" initial={{ opacity: 0, x: -8 }} animate={{ opacity: last ? 1 : 0.55, x: 0 }} transition={spring} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
            <span className={`dot ${last ? 'green live' : ''}`} style={{ marginTop: 7, width: 6, height: 6 }} />
            <div className="grow">
              <div className="small" style={{ color: 'var(--ink)' }}>{describeTool(t)}</div>
              <div className="tiny mono trunc">{t?.text}</div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

function TaskSheet({ id }: { id: string }) {
  const mia = useMC((s) => s.mia);
  const now = useMC((s) => s.now);
  const card = useMemo(() => taskCards(mia).find((c) => c.id === id), [mia, id]);
  const jobs = useMemo(() => jobsByTask(mia).get(id) || [], [mia, id]);
  const [say, setSay] = useState('');
  if (!card) return (<><Head title={`Task ${id}`} /><div className="sheet-body small">This task isn’t on the board (it may be older than a week).</div></>);
  const t = card.task;
  const qs = (mia?.pendingQuestions || []).filter((q) => q.taskId === id);
  const live = jobs.find(isLive);
  const open_ = !['done', 'failed', 'cancelled'].includes(card.status);
  return (
    <>
      <Head sub={<span className="row gap6"><span className="num">#{id}</span><ModelChip model={card.model} /></span>} title={card.title} />
      <div className="sheet-body">
        <div style={{ margin: '6px 0 16px' }}>
          <StageRail card={card} />
          <div className="row tiny" style={{ marginTop: 6, justifyContent: 'space-between' }}>
            <span>Queued</span><span>Running</span><span>Checking</span><span>Done</span>
          </div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
          <div className="well" style={{ padding: '10px 12px' }}><div className="tiny">Status</div><div className="title-s" style={{ textTransform: 'capitalize' }}>{card.asking ? 'Needs you' : card.status}</div></div>
          <div className="well" style={{ padding: '10px 12px' }}><div className="tiny">{card.stage === 'done' ? 'Took' : 'Elapsed'}</div><div className="title-s num">{card.startedAt ? elapsed(card.startedAt, card.finishedAt || now) : '–'}</div></div>
          <div className="well" style={{ padding: '10px 12px' }}><div className="tiny">Cost</div><div className="title-s"><Num value={card.cost} format={money} /></div></div>
        </div>
        {qs.map((q) => (<div key={q.questionId} style={{ marginBottom: 12 }}><QuestionCard q={q} scope="task" /></div>))}
        {live?.tail?.length ? (
          <section style={{ marginBottom: 18 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Live · executor {live.id}</div>
            <div className="well dark" style={{ padding: 14 }}><Feed lines={live.tail} /></div>
          </section>
        ) : null}
        {t.detail ? (<section style={{ marginBottom: 18 }}><div className="eyebrow" style={{ marginBottom: 6 }}>Brief</div><div className="small" style={{ whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{t.detail}</div></section>) : null}
        <section style={{ marginBottom: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Timeline</div>
          <div className="col" style={{ gap: 8, borderLeft: '1px solid var(--line)', paddingLeft: 14, marginLeft: 4 }}>
            {[...(t.log || [])].reverse().slice(0, 30).map((l, i) => (
              <div key={i}>
                <div className="small" style={{ color: i === 0 ? 'var(--ink)' : undefined }}>{l.text}</div>
                <div className="tiny">{l.at ? ago(Date.parse(l.at), now) : ''}</div>
              </div>
            ))}
          </div>
        </section>
        {jobs.length ? (
          <section style={{ marginBottom: 18 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Runs</div>
            {jobs.map((j) => (
              <div key={j.id} className="row small" style={{ padding: '6px 0' }}>
                <span className="grow">Run {j.attempts || 1} · {j.status}{j.error ? ` · ${j.error}` : ''}</span>
                <span className="tiny">{modelName(j.model)}</span>
                <span className="num">{money(j.costUsd || 0)}</span>
              </div>
            ))}
          </section>
        ) : null}
        <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); if (miaSend(`About task ${id}: ${say}`)) { setSay(''); close(); } }}>
          <input className="input grow" value={say} onChange={(e) => setSay(e.target.value)} placeholder="Tell Mia about this task…" />
          <button className="pill primary" disabled={!say.trim()}>Send</button>
        </form>
        {open_ ? (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="pill" onClick={() => miaTaskSet(id, 'priority', card.priority <= 1 ? 3 : 1)}>{card.priority <= 1 ? 'Normal priority' : 'Make urgent'}</button>
            <button className="pill danger" onClick={() => { if (confirm(`Cancel task ${id}?`)) { miaTaskCancel(id); close(); } }}>Cancel task</button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function AgentSheet({ id }: { id: string }) {
  const agent = useMC((s) => s.agents.find((a) => a.id === id));
  const screen = useMC((s) => s.screens[id]?.text || agent?.screen || '');
  const [text, setText] = useState('');
  useEffect(() => watchAgent(id), [id]);
  const prompt = useMemo(() => parsePrompt(screen), [screen]);
  const clean = useMemo(() => cleanScreen(screen).split('\n').slice(-60).join('\n'), [screen]);
  if (!agent) return (<><Head title="Session ended" /><div className="sheet-body small">This session has left the board.</div></>);
  return (
    <>
      <Head sub={<span>{agent.folder}{agent.branch ? ` · ${agent.branch}` : ''}</span>} title={agent.name || agent.folder} right={<span className="chip num" style={{ marginTop: 10 }}>{money(agent.cost || 0)}</span>} />
      <div className="sheet-body">
        {agent.todos?.length ? (
          <div className="well" style={{ padding: 12, marginBottom: 12 }}>
            {agent.todos.map((t, i) => (
              <div key={i} className="row small" style={{ padding: '3px 0', color: t.status === 'completed' ? 'var(--ink-3)' : 'var(--ink)' }}>
                <Icon name={t.status === 'completed' ? 'check' : t.status === 'in_progress' ? 'bolt' : 'more'} size={15} />
                <span className="grow" style={{ textDecoration: t.status === 'completed' ? 'line-through' : undefined }}>{t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="well dark terminal" style={{ marginBottom: 12 }}>{clean || 'No screen yet…'}</div>
        {prompt ? (
          <div className="col gap6" style={{ marginBottom: 12 }}>
            <div className="title-s">{prompt.question}</div>
            {prompt.options.map((o) => (
              <button key={o.n} className="pill" style={{ justifyContent: 'flex-start' }} onClick={() => sendKey(id, String(o.n))}>{o.n}. {o.label}</button>
            ))}
          </div>
        ) : null}
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (reply(id, text)) setText(''); }}>
          <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type to this session…" />
          <button className="pill primary" disabled={!text.trim()}>Send</button>
        </form>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="pill small" onClick={() => sendKey(id, 'esc')}>Esc</button>
          <button className="pill small danger" onClick={() => { if (confirm('Stop this session?')) { kill(id); close(); } }}>Stop session</button>
        </div>
      </div>
    </>
  );
}

function JobSheet({ id }: { id: string }) {
  const job = useMC((s) => s.mia?.jobs?.jobs.find((j) => String(j.id) === id));
  if (!job) return (<><Head title={`Job ${id}`} /><div className="sheet-body small">Gone.</div></>);
  return (
    <>
      <Head sub={`Job ${id}`} title={job.beat || job.kind || 'Executor'} right={<ModelChip model={job.model} />} />
      <div className="sheet-body"><div className="well dark" style={{ padding: 14 }}><Feed lines={job.tail || []} /></div></div>
    </>
  );
}

function DocSheet({ id }: { id: string }) {
  const meta = useMC((s) => s.docs.find((d) => d.id === id));
  const body = useMC((s) => s.docBodies[id]);
  const token = useMC((s) => s.token);
  const [page, setPage] = useState('');
  useEffect(() => {
    if (meta?.kind === 'page') {
      fetch(`/api/v1/doc-pages/${encodeURIComponent(id.replace(/\.md$/i, ''))}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        .then((r) => r.json()).then((j) => j?.url && setPage(j.url)).catch(() => {});
    } else if (!body) docGet(id);
  }, [id, body, meta?.kind, token]);
  const html = useMemo(() => {
    if (!body) return '';
    const stem = id.replace(/\.md$/i, '');
    const raw = marked.parse(body.content.replace(/^---\n[\s\S]*?\n---\n/, ''), { async: false }) as string;
    const fixed = raw.replace(/src="(?:\.\/)?(?:[^"/]+\.assets\/|assets\/)([^"]+)"/g, (_m, n) => `src="/api/v1/doc-assets/${encodeURIComponent(stem)}/${encodeURIComponent(n)}?token=${encodeURIComponent(token)}"`);
    return DOMPurify.sanitize(fixed);
  }, [body, id, token]);
  return (
    <>
      <Head sub={meta?.kind ? meta.kind[0].toUpperCase() + meta.kind.slice(1) : 'Document'} title={meta?.title || body?.title || id} />
      <div className="sheet-body">
        {meta?.kind === 'page' ? (
          page ? <iframe src={page} sandbox="allow-scripts" style={{ width: '100%', height: '75vh', border: 0, borderRadius: 18, background: '#fff' }} title={meta.title} /> : <div className="small">Loading page…</div>
        ) : body ? (
          <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="col gap8">{[80, 95, 70, 88].map((w, i) => <div key={i} className="well" style={{ height: 14, width: `${w}%` }} />)}</div>
        )}
      </div>
    </>
  );
}

function NewSheet() {
  const dirs = useMC((s) => s.knownDirs);
  const [mode, setMode] = useState<'mia' | 'agent'>('mia');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [dir, setDir] = useState('');
  const go = () => {
    const ok = mode === 'mia' ? miaTaskAdd(title.trim(), detail.trim(), dir) : launch({ dir, mission: [title, detail].filter(Boolean).join('\n\n') });
    if (ok) close();
  };
  return (
    <>
      <Head title="New work" />
      <div className="sheet-body col gap12">
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          {(['mia', 'agent'] as const).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {mode === m ? <motion.span layoutId="new-thumb" className="thumb" transition={spring} /> : null}
              {m === 'mia' ? 'Task for Mia' : 'Launch a session'}
            </button>
          ))}
        </div>
        <div className="small">{mode === 'mia' ? 'Mia briefs an executor, picks the model and checks the result.' : 'Starts a Claude Code session on the Mac directly.'}</div>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === 'mia' ? 'What should get done?' : 'Mission'} autoFocus />
        <textarea className="input" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Details (optional)" />
        <input className="input" list="mc6-dirs" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Folder (optional)" />
        <datalist id="mc6-dirs">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
        <button className="pill primary" disabled={!title.trim()} onClick={go}>{mode === 'mia' ? 'Give it to Mia' : 'Launch'}</button>
      </div>
    </>
  );
}

function SettingsSheet() {
  const mia = useMC((s) => s.mia);
  const models = ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  const [push, setPush] = useState('');
  const [scene, setScene] = useState('photo');
  const calm = useGlassPrefs((s) => s.calm);
  const tilt = useGlassPrefs((s) => s.tilt);
  useEffect(() => { setPush(pushState()); setScene(localStorage.getItem('mc6_scene') || 'photo'); }, []);
  return (
    <>
      <Head title="Settings" />
      <div className="sheet-body col gap16">
        <section className="col gap8">
          <div className="eyebrow">Mia</div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {models.map((m) => (
              <button key={m} className={`pill small ${mia?.model === m ? 'primary' : ''}`} onClick={() => miaSetModel(m)}>{modelName(m)}</button>
            ))}
          </div>
          <div className="row">
            {mia?.online ? <button className="pill small" onClick={() => miaRestart()}><Icon name="restart" size={15} /> Restart Mia</button> : <button className="pill small" onClick={() => miaStart()}>Start Mia</button>}
          </div>
        </section>
        <section className="col gap8">
          <div className="eyebrow">Notifications</div>
          <div className="small">{push === 'working' ? 'On for this device.' : push === 'install' ? 'Add this panel to your Home Screen to get notifications.' : push === 'denied' ? 'Blocked in system settings.' : push === 'unsupported' ? 'Not available here (needs HTTPS).' : 'Off on this device.'}</div>
          <div className="row">
            {push !== 'working' && push !== 'unsupported' && push !== 'install' ? <button className="pill small" onClick={async () => setPush(await enablePush())}><Icon name="bell" size={15} /> Turn on</button> : null}
            <button className="pill small" onClick={() => miaPushTest()}>Send a test</button>
          </div>
        </section>
        <section className="col gap8">
          <div className="eyebrow">Backdrop</div>
          <div className="row">
            {['photo', 'gradient'].map((m) => (
              <button key={m} className={`pill small ${scene === m ? 'primary' : ''}`} onClick={() => { localStorage.setItem('mc6_scene', m); setScene(m); location.reload(); }}>{m === 'photo' ? 'Photo' : 'Moving gradient'}</button>
            ))}
          </div>
        </section>
        <section className="col gap8" data-glass-settings>
          <div className="eyebrow">Glass</div>
          <div className="row">
            {[false, true].map((c) => (
              <button key={String(c)} className={`pill small ${calm === c ? 'primary' : ''}`} onClick={() => setCalm(c)} data-calm={c ? 'on' : 'off'}>{c ? 'Calm' : 'Liquid'}</button>
            ))}
          </div>
          <div className="small">{calm ? 'Calm: plain frosted glass, no moving light, still backdrop. Lightest on battery.' : 'Liquid: refracting glass edges, light that follows your finger, flowing backdrop.'}</div>
          {!calm ? (
            <div className="row">
              <button className={`pill small ${tilt ? 'primary' : ''}`} onClick={() => setTilt(!tilt)} data-tilt>{tilt ? 'Light follows tilt: on' : 'Light follows tilt: off'}</button>
            </div>
          ) : null}
        </section>
        <section className="col gap8">
          <div className="eyebrow">Panel</div>
          <a className="pill small" href="/classic" style={{ alignSelf: 'flex-start', textDecoration: 'none' }}><Icon name="external" size={15} /> Open the classic panel</a>
          <button className="pill small danger" style={{ alignSelf: 'flex-start' }} onClick={() => confirm('Forget the token on this device?') && forgetToken()}>Forget token</button>
          <div className="tiny">Build {BUILD} · link {getMC().transport}</div>
        </section>
      </div>
    </>
  );
}

export function SheetBody({ sheet }: { sheet: NonNullable<Sheet> }) {
  switch (sheet.kind) {
    case 'task': return <TaskSheet id={sheet.id} />;
    case 'agent': return <AgentSheet id={sheet.id} />;
    case 'job': return <JobSheet id={sheet.id} />;
    case 'doc': return <DocSheet id={sheet.id} />;
    case 'new': return <NewSheet />;
    case 'settings': return <SettingsSheet />;
  }
}
// keep imports used
void open; void cleanTitle; void Glass;
