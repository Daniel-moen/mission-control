import { useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, agentName, agentStatus, statusLabel, fmtTokens, fmtInt, fmtMem, parsePrompt, rawScreenFor, sparkOf, reply, kill, sendKey } from '../../src/lib/store.js';
import { fmtDuration, fmtMoney } from '../../src/lib/format.js';
import { useWatch } from '../../src/lib/hooks.js';
import Ticker from '../../src/ui/Ticker.jsx';
import Sparkline from '../../src/ui/Sparkline.jsx';
import Terminal from '../../src/views/agent/Terminal.jsx';
import { openOverlay } from '../lib/nav.js';
import { usePrefs } from '../lib/prefs.js';
import { spring, tap } from '../lib/motion.js';
import { useSize } from '../ui/hooks.js';
import { Button, Composer, Dot, Empty, Icon, IconBtn, useArm } from '../ui/kit.jsx';
import Page from '../shell/Page.jsx';
import { usePage } from '../shell/Stack.jsx';

// One agent's workspace: the live terminal mirror, its menu as big tappable
// rows when it's asking, the numbers, the plan, and a composer that's always
// in reach. Wide: terminal and details side by side. Narrow: one scroll, with
// the composer pinned.
//
// The watch lease (the Mac streams this terminal while someone looks) is held
// only while this page is the one on screen.

const TONE = { working: 'bg-accent/12 text-accent', waiting: 'bg-warn/14 text-warn', exited: 'bg-crit/14 text-crit', done: 'bg-fill text-ink2' };
const LOG = { command: 'text-accent', tool: 'text-s3', text: 'text-ink2', result: 'text-ink3', status: 'text-ink3 italic' };

function Menu({ agent, prompt }) {
  const descOf = (o) => (o.desc || '').replace(/[│|╭╮╰╯┌┐└┘─━┃]/g, '').trim();
  return (
    <section className="rounded-[20px] border border-warn/30 bg-warn/[0.06] p-4" data-menu>
      <div className="mb-2 flex items-center gap-2 text-[0.78rem] font-bold text-warn">
        <span className="h-2 w-2 rounded-full bg-warn" />
        Waiting on you
      </div>
      {prompt.question && <p className="mb-3 break-words text-[1.02rem] font-semibold leading-snug tracking-[-0.01em] text-ink">{prompt.question}</p>}
      <div className="flex flex-col gap-2">
        {prompt.options.map((o) => {
          const chosen = prompt.multi ? o.checked : o.selected;
          return (
            <motion.button
              key={o.n}
              {...tap}
              onClick={() => sendKey(agent.id, String(o.n))}
              data-option={o.n}
              className={`flex min-h-[48px] items-start gap-3 rounded-[14px] px-3.5 py-3 text-left ${chosen ? 'bg-ink text-page' : 'bg-card text-ink'}`}
            >
              <span className={`v-num grid h-6 w-6 flex-none place-items-center rounded-[8px] font-mono text-[0.8rem] font-bold ${chosen ? 'bg-page/20' : 'bg-fill text-ink2'}`}>{prompt.multi ? (o.checked ? '✓' : '') : o.n}</span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-[0.95rem] font-semibold">{o.label}</span>
                {descOf(o) && <span className={`mt-0.5 block text-[0.8rem] leading-snug ${chosen ? 'opacity-70' : 'text-ink3'}`}>{descOf(o)}</span>}
              </span>
            </motion.button>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2">
        {[
          ['up', '↑'],
          ['down', '↓'],
          ['enter', 'Confirm ⏎'],
          ['esc', 'Esc'],
        ].map(([k, l]) => (
          <motion.button key={k} {...tap} onClick={() => sendKey(agent.id, k)} className="h-9 rounded-full bg-card px-3.5 text-[0.82rem] font-semibold text-ink2">
            {l}
          </motion.button>
        ))}
      </div>
    </section>
  );
}

function Stat({ label, children, sub, className = '' }) {
  return (
    <div className={`rounded-[16px] bg-fill px-3.5 py-3 ${className}`}>
      <div className="text-[0.72rem] font-semibold text-ink3">{label}</div>
      <div className="v-num mt-1 text-[1.2rem] font-bold tracking-[-0.02em] text-ink">{children}</div>
      {sub && <div className="mt-0.5 text-[0.72rem] text-ink3">{sub}</div>}
    </div>
  );
}

export default function Agent({ params }) {
  const id = params.id;
  const a = useMC((s) => s.agents.find((x) => x.id === id) || null);
  const now = useMC((s) => s.now);
  const seen = useMC((s) => s.lastSnapshotAt);
  const { active, back } = usePage();
  const reduce = usePrefs((s) => s.reduce);
  const box = useRef(null);
  const { w } = useSize(box);
  const wide = w >= 980;
  const [objOpen, setObjOpen] = useState(false);
  const [armed, fire] = useArm();
  useWatch(active ? id : null);

  const prompt = useMemo(() => (a && a.controllable ? parsePrompt(rawScreenFor(a)) : null), [a, now]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!a) {
    return (
      <Page title="" scroll={false}>
        <div ref={box} className="flex flex-1 items-center justify-center">
          {!seen ? (
            <span className="text-[0.9rem] text-ink3">Waiting for the Mac…</span>
          ) : (
            <Empty icon="agents" title="This agent has left the board" hint="Its session is no longer in the snapshot — it finished, was killed, or the Mac restarted." action={<Button onClick={back}>Back</Button>} />
          )}
        </div>
      </Page>
    );
  }

  const st = agentStatus(a);
  const todos = a.todos || [];
  const doneN = todos.filter((t) => t.status === 'completed').length;
  const uptime = a.startedAt ? fmtDuration(now - a.startedAt) : a.uptime || '—';
  const meta = [a.model, a.branch, a.dir || a.folder].filter(Boolean).join(' · ');

  const details = (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5">
        <Stat label="Tokens">
          <Ticker value={a.tokens ?? 0} format={(n) => fmtTokens(Math.round(n))} />
        </Stat>
        <Stat label="Cost">
          <Ticker value={a.cost ?? 0} format={fmtMoney} />
        </Stat>
        <div className="col-span-2 flex items-center justify-between gap-3 rounded-[16px] bg-fill px-3.5 py-3">
          <div>
            <div className="text-[0.72rem] font-semibold text-ink3">Burn</div>
            <div className="v-num mt-1 text-[1.2rem] font-bold tracking-[-0.02em] text-ink">
              <Ticker value={a.tokensPerSec ?? 0} format={(n) => (n > 0 && n < 10 ? n.toFixed(1) : String(Math.round(n)))} className={st === 'working' ? 'text-accent' : ''} />
              <span className="ml-1 text-[0.76rem] font-medium text-ink3">tok/s</span>
            </div>
          </div>
          <Sparkline data={sparkOf(a.id).slice(-24)} width={120} height={34} tone={st === 'working' ? 'accent' : 'neutral'} />
        </div>
        <Stat label="Turns">{fmtInt(a.turns ?? 0)}</Stat>
        <Stat label="Uptime">{uptime}</Stat>
        {typeof a.cpu === 'number' && <Stat label="CPU">{Math.round(a.cpu)}%</Stat>}
        {typeof a.mem === 'number' && <Stat label="Memory">{fmtMem(a.mem)}</Stat>}
      </div>
      {st === 'exited' && (
        <div className="rounded-[18px] bg-crit/10 p-4">
          <div className="flex items-center gap-2 text-[0.9rem] font-bold text-crit">
            <Icon name="alert" size={16} /> Process exited
          </div>
          <p className="mt-1 text-[0.86rem] leading-relaxed text-ink2">The claude process behind this session is gone. Its last terminal output is kept.</p>
        </div>
      )}
      {a.prompt && (
        <div className="v-card p-4">
          <div className="v-eyebrow mb-2">Objective</div>
          <p className={`break-words text-[0.9rem] leading-relaxed text-ink2 [overflow-wrap:anywhere] ${objOpen ? '' : 'line-clamp-3'}`}>{a.prompt}</p>
          {a.prompt.length > 150 && (
            <button onClick={() => setObjOpen((v) => !v)} className="mt-1.5 text-[0.8rem] font-semibold text-ink3 hover:text-ink2">
              {objOpen ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {!!todos.length && (
        <div className="v-card p-4" data-plan>
          <div className="mb-2.5 flex items-center justify-between">
            <span className="v-eyebrow">Plan</span>
            <span className="v-num text-[0.76rem] text-ink3">
              {doneN}/{todos.length}
            </span>
          </div>
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-fill2">
            <motion.div className="h-full rounded-full bg-accent" initial={false} animate={{ width: `${(doneN / todos.length) * 100}%` }} transition={spring.gentle} />
          </div>
          <div className="flex flex-col gap-2">
            {todos.map((td, i) => (
              <div key={`${i}-${td.content}`} className={`flex items-baseline gap-2.5 text-[0.9rem] ${td.status === 'completed' ? 'text-ink3 line-through' : td.status === 'in_progress' ? 'font-semibold text-ink' : 'text-ink2'}`}>
                <span className={`w-4 flex-none text-[0.8rem] ${td.status === 'completed' ? 'text-accent' : td.status === 'in_progress' ? 'text-accent' : 'text-ink3'}`}>
                  {td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '▶' : '○'}
                </span>
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!(a.subagents || []).length && (
        <div className="v-card p-4">
          <div className="v-eyebrow mb-2.5">Subagents</div>
          <div className="flex flex-col gap-2.5">
            <AnimatePresence initial={false}>
              {a.subagents.map((s, i) => (
                <motion.div key={s.id || i} layout={!reduce} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-start gap-2.5">
                  <Dot status={s.status === 'active' ? 'working' : 'done'} size={8} className="mt-[6px]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`truncate text-[0.9rem] font-medium ${s.status === 'active' ? 'text-ink' : 'text-ink2'}`}>{s.desc || s.agentType || 'Subagent'}</span>
                      {!!s.tokens && <span className="v-num flex-none text-[0.7rem] text-ink3">{fmtTokens(s.tokens)}</span>}
                    </span>
                    <span className="block truncate font-mono text-[0.72rem] text-ink3">{s.status === 'active' ? s.activity || '—' : 'Done'}</span>
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}
      <div>
        <div className="v-eyebrow mb-2 px-1">Recent activity</div>
        <div className="v-scroll max-h-60 rounded-[16px] bg-[#0f0f12] p-3 font-mono text-[0.74rem] leading-relaxed" data-theme="dark">
          {(a.log || []).length ? (a.log || []).map((l, i) => <div key={i} className={`truncate ${LOG[l.kind] || 'text-ink2'}`}>{l.text}</div>) : <div className="text-ink3">No activity yet.</div>}
        </div>
      </div>
    </div>
  );

  const term = (
    <div data-theme="dark" className={wide ? 'min-h-0 flex-1' : 'h-[46vh] min-h-[280px]'}>
      <Terminal agent={a} onExpand={a.controllable ? () => openOverlay('console', { id }) : null} className="h-full !rounded-[20px]" />
    </div>
  );

  const footer = a.controllable ? (
    <div className="lens-navbar flex-none !border-b-0 !border-t px-3 pt-2.5 sm:px-5" style={{ paddingBottom: 'var(--tabbar-space)' }}>
      <div className="v-scroll-x -mx-1 mb-2.5 flex items-center gap-2 px-1">
        {[
          ['esc', 'Esc'],
          ['up', '↑'],
          ['down', '↓'],
          ['enter', '⏎'],
        ].map(([k, l]) => (
          <motion.button key={k} {...tap} onClick={() => sendKey(id, k)} aria-label={k} className="grid h-10 w-11 flex-none place-items-center rounded-full bg-fill text-[0.9rem] font-semibold text-ink2">
            {l}
          </motion.button>
        ))}
        <span className="h-5 w-px flex-none bg-hair2" />
        {['Continue', 'Yes', 'Approve plan'].map((t) => (
          <motion.button key={t} {...tap} onClick={() => reply(id, t)} className="h-10 flex-none rounded-full bg-fill px-4 text-[0.86rem] font-semibold text-ink2">
            {t}
          </motion.button>
        ))}
        <motion.button {...tap} onClick={() => reply(id, 'Stop')} className="h-10 flex-none rounded-full bg-crit/12 px-4 text-[0.86rem] font-semibold text-crit">
          ■ Stop
        </motion.button>
      </div>
      <Composer onSend={(t) => reply(id, t)} placeholder="Message this agent" />
    </div>
  ) : (
    <div className="v-hair-t flex-none px-5 pt-3 text-[0.86rem] text-ink3" style={{ paddingBottom: 'var(--tabbar-space)' }}>
      Read-only — this agent’s terminal can’t be driven remotely.
    </div>
  );

  return (
    <Page
      scroll={false}
      title={agentName(a)}
      actions={
        <>
          <span className={`hidden h-8 items-center gap-1.5 rounded-full px-3 text-[0.76rem] font-bold sm:flex ${TONE[st]}`}>
            <Dot status={st} size={7} />
            {statusLabel(st)}
          </span>
          {a.controllable && <IconBtn icon="terminal" label="Console" tone="ghost" onClick={() => openOverlay('console', { id })} />}
          <motion.button
            {...tap}
            onClick={() =>
              fire(() => {
                kill(id);
                back();
              })
            }
            className={`h-9 rounded-full px-3.5 text-[0.82rem] font-bold ${armed ? 'bg-crit text-white' : 'bg-crit/12 text-crit'}`}
          >
            {armed ? 'Tap to kill' : 'Kill'}
          </motion.button>
        </>
      }
    >
      <div ref={box} className="flex min-h-0 flex-1 flex-col" data-agent-view={id}>
        <div className="flex-none px-4 pb-3 sm:px-6">
          <div className="flex items-center gap-2 text-[0.8rem] text-ink3">
            <Dot status={st} size={8} className="sm:hidden" />
            {a.isManager && <span className="rounded-md bg-mgr/15 px-1.5 py-0.5 text-[0.66rem] font-bold text-mgr">MGR</span>}
            <span className="truncate">{meta}</span>
          </div>
        </div>
        {wide ? (
          <div className="flex min-h-0 flex-1 gap-4 px-4 pb-3 sm:px-6">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              <AnimatePresence initial={false}>
                {prompt && (
                  <motion.div key="menu" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring.layout} className="v-scroll max-h-[55%] flex-none overflow-hidden">
                    <Menu agent={a} prompt={prompt} />
                  </motion.div>
                )}
              </AnimatePresence>
              {term}
            </div>
            <div className="v-scroll min-h-0 w-[min(380px,36%)] flex-none pb-2">{details}</div>
          </div>
        ) : (
          <div className="v-scroll min-h-0 flex-1 px-4 pb-4">
            <div className="flex flex-col gap-3">
              {prompt && <Menu agent={a} prompt={prompt} />}
              {term}
              {details}
            </div>
          </div>
        )}
        {footer}
      </div>
    </Page>
  );
}
