import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  useMC, agentName, agentStatus, statusLabel, fmtTokens, fmtInt, fmtMem,
  parsePrompt, rawScreenFor, sparkOf, reply, kill, sendKey,
} from '../../lib/store.js';
import { fmtDuration, fmtMoney } from '../../lib/format.js';
import { useAgent, useMedia, useNow, useWatch } from '../../lib/hooks.js';
import { fadeUp, press, reduced, spring } from '../../lib/motion.js';
import StatusDot from '../../ui/StatusDot.jsx';
import IconButton from '../../ui/IconButton.jsx';
import Icon from '../../ui/Icon.jsx';
import Ticker from '../../ui/Ticker.jsx';
import Sparkline from '../../ui/Sparkline.jsx';
import Progress from '../../ui/Progress.jsx';
import Meter from '../../ui/Meter.jsx';
import Button from '../../ui/Button.jsx';
import Terminal from './Terminal.jsx';
import PromptControls from './PromptControls.jsx';
import MicField from './MicField.jsx';
import Subagents from './Subagents.jsx';

// The agent workspace. Rendered by App inside a CHROMELESS glass window, so
// this view draws its own header. It owns the watch-lease lifecycle for its
// session: acquired on open, heartbeated by the store every 3s, re-asserted on
// reconnect, released on unmount.
//
// The terminal mirror is the centrepiece and gets the room; stats, plan,
// subagents and log ride in a right rail (desktop) or stack under it (phone).
// The footer is always reachable: quick keys + the reply composer.

const LOG_TONE = {
  command: 'text-accent',
  tool: 'text-s3',
  text: 'text-ink2',
  result: 'text-ink3',
  status: 'text-ink3 italic',
};

// A rail section that rises into place with the rest of the stack.
function Section({ i = 0, reduce, className = '', children }) {
  const v = reduce ? reduced(fadeUp) : fadeUp;
  return (
    <motion.section
      initial={v.initial}
      animate={v.animate}
      transition={{ ...fadeUp.transition, delay: Math.min(i, 6) * 0.04 }}
      className={className}
    >
      {children}
    </motion.section>
  );
}

function Tile({ label, children, sub }) {
  return (
    <div className="rounded-xl2 border border-glass-line bg-white/[0.04] px-3.5 py-3">
      <div className="label">{label}</div>
      <div className="mt-1.5 text-[19px] font-semibold tracking-tight tabular-nums text-ink">{children}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink3">{sub}</div>}
    </div>
  );
}

export default function AgentView({ agentId, inline = false, onClose, onConsole }) {
  const a = useAgent(agentId);
  const now = useNow();
  const desktop = useMedia('(min-width: 1024px)');
  const reduce = useReducedMotion();

  useWatch(agentId);

  const st = a ? agentStatus(a) : 'done';
  const todos = a?.todos || [];
  const doneCount = todos.filter((td) => td.status === 'completed').length;
  const pct = todos.length ? doneCount / todos.length : 0;

  // The menu is parsed off the RAW screen — cleanScreen() hides the very box
  // we want to turn into buttons.
  const prompt = useMemo(
    () => (a && a.controllable ? parsePrompt(rawScreenFor(a)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a, a?.screen, now],
  );

  const [objOpen, setObjOpen] = useState(false);

  // Two-tap kill: the first tap arms for 3s, the second fires. No modal — a
  // confirmation dialog on a phone is a tap you make without reading.
  const [killArmed, setKillArmed] = useState(false);
  const killTimer = useRef(null);
  useEffect(() => () => clearTimeout(killTimer.current), []);
  function tapKill() {
    if (killArmed) {
      clearTimeout(killTimer.current);
      setKillArmed(false);
      kill(agentId);
      onClose?.();
      return;
    }
    setKillArmed(true);
    clearTimeout(killTimer.current);
    killTimer.current = setTimeout(() => setKillArmed(false), 3000);
  }

  // A deep link (#agent/<id>) mounts this view before the first snapshot —
  // an empty roster then means "no data yet", not "that agent is gone".
  const seenSnapshot = useMC((s) => s.lastSnapshotAt);

  // The agent left the board (finished and reaped, or the Mac restarted).
  // Say so calmly instead of yanking the window away mid-read.
  if (!a && !seenSnapshot) {
    return <div className="flex h-full min-h-0 items-center justify-center p-10 text-[13px] text-ink3">Waiting for the Mac…</div>;
  }
  if (!a) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-10 text-center">
        <div className="glass-soft grid h-12 w-12 place-items-center rounded-xl3 text-ink3">
          <Icon name="agents" size={22} />
        </div>
        <div>
          <div className="text-[17px] font-semibold tracking-tight text-ink">This agent has left the board</div>
          <p className="mt-1 max-w-[42ch] text-[13px] leading-relaxed text-ink3">
            Its session is no longer in the snapshot — it finished, was killed, or the Mac restarted.
          </p>
        </div>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    );
  }

  const uptime = a.startedAt ? fmtDuration(now - a.startedAt) : a.uptime || '—';
  const hasSys = typeof a.cpu === 'number';
  // sparkOf() hands back the SAME array it keeps pushing into, so a copy is
  // what tells Sparkline's memo that the trace moved.
  const spark = sparkOf(a.id).slice(-24);
  const meta = [a.model, a.branch, a.dir || a.folder].filter(Boolean);

  const killBtn = (
    <motion.button
      {...press}
      onClick={tapKill}
      className={`pill flex h-9 flex-none items-center gap-1.5 px-3.5 text-[12.5px] font-semibold transition-colors ${
        killArmed ? 'bg-crit text-white' : 'border border-crit/35 text-crit hover:bg-crit/12'
      }`}
    >
      {killArmed ? 'Tap again to kill' : 'Kill'}
    </motion.button>
  );

  const rail = (
    <>
      {/* stat tiles */}
      <Section i={0} reduce={reduce} className="grid grid-cols-2 gap-2.5">
        <Tile label="Tokens">
          <Ticker value={a.tokens ?? 0} format={(n) => fmtTokens(Math.round(n))} />
        </Tile>
        <Tile label="Cost">
          <Ticker value={a.cost ?? 0} format={fmtMoney} />
        </Tile>
        <div className="col-span-2 flex items-center justify-between gap-3 rounded-xl2 border border-glass-line bg-white/[0.04] px-3.5 py-3">
          <div className="min-w-0">
            <div className="label">Burn</div>
            <div className="mt-1 text-[19px] font-semibold tracking-tight tabular-nums text-ink">
              <Ticker
                value={a.tokensPerSec ?? 0}
                format={(n) => (n > 0 && n < 10 ? n.toFixed(1) : String(Math.round(n)))}
                className={st === 'working' ? 'text-accent' : ''}
              />
              <span className="ml-1 text-[11.5px] font-normal text-ink3">tok/s</span>
            </div>
          </div>
          <Sparkline data={spark} width={116} height={34} tone={st === 'working' ? 'accent' : 'neutral'} />
        </div>
        <Tile label="Turns">{fmtInt(a.turns ?? 0)}</Tile>
        <Tile label="Uptime">
          <span className="text-[17px]">{uptime}</span>
        </Tile>
        {hasSys && (
          <div className="col-span-2 grid grid-cols-2 gap-4 rounded-xl2 border border-glass-line bg-white/[0.04] px-3.5 py-3">
            <Meter value={(a.cpu ?? 0) / 100} label="CPU" />
            <Meter
              value={typeof a.mem === 'number' ? Math.min(1, a.mem / 4096) : 0}
              label="Memory"
              sub={typeof a.mem === 'number' ? fmtMem(a.mem) : ''}
            />
          </div>
        )}
      </Section>

      {st === 'exited' && (
        <Section i={1} reduce={reduce} className="rounded-xl3 border border-crit/30 bg-crit/[0.07] p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-crit">
            <Icon name="alert" size={15} />
            Process exited
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink2">
            The claude process behind this session is gone. Its last terminal output is preserved.
          </p>
        </Section>
      )}

      {/* objective */}
      {a.prompt && (
        <Section i={2} reduce={reduce} className="rounded-xl3 border border-glass-line bg-white/[0.035] p-4">
          <div className="label mb-2">Objective</div>
          <p
            className={`break-words text-[13.5px] leading-relaxed text-ink2 [overflow-wrap:anywhere] ${
              objOpen ? '' : 'line-clamp-3'
            }`}
          >
            {a.prompt}
          </p>
          {a.prompt.length > 150 && (
            <button
              onClick={() => setObjOpen((v) => !v)}
              className="mt-1.5 text-[12px] font-medium text-ink3 transition-colors hover:text-ink2"
            >
              {objOpen ? 'Show less' : 'Show more'}
            </button>
          )}
        </Section>
      )}

      {/* plan */}
      {!!todos.length && (
        <Section i={3} reduce={reduce} className="rounded-xl3 border border-glass-line bg-white/[0.035] p-4">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="label">Plan</span>
            <span className="tnum text-[11.5px] text-ink3">
              {doneCount}/{todos.length} · {Math.round(pct * 100)}%
            </span>
          </div>
          <Progress value={pct} className="mb-3" />
          <div className="flex flex-col gap-2">
            {todos.map((td, i) => (
              <div
                key={`${i}-${td.content}`}
                className={`flex items-baseline gap-2.5 text-[13.5px] ${
                  td.status === 'completed'
                    ? 'text-ink3 line-through'
                    : td.status === 'in_progress'
                      ? 'font-semibold text-ink'
                      : 'text-ink2'
                }`}
              >
                <span
                  className={`w-4 flex-none font-mono text-[12px] ${
                    td.status === 'completed' ? 'text-ok' : td.status === 'in_progress' ? 'text-accent' : 'text-ink3'
                  }`}
                >
                  {td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '▶' : '○'}
                </span>
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* subagents */}
      {!!(a.subagents || []).length && (
        <Section i={4} reduce={reduce}>
          <Subagents agent={a} />
        </Section>
      )}

      {/* recent activity */}
      <Section i={5} reduce={reduce}>
        <div className="label mb-2">Recent activity</div>
        <div className="noscroll max-h-56 overflow-y-auto rounded-xl2 border border-glass-line bg-term p-3 font-mono text-[11.5px] leading-relaxed">
          {(a.log || []).length ? (
            (a.log || []).map((l, i) => (
              <div key={i} className={`truncate ${LOG_TONE[l.kind] || 'text-ink2'}`}>
                {l.text}
              </div>
            ))
          ) : (
            <div className="text-ink3">No activity yet.</div>
          )}
        </div>
      </Section>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header — the window is chromeless, so this view owns its own */}
      <header
        className="flex flex-none items-center gap-2.5 border-b border-glass-line px-3 py-2.5 sm:px-4"
        style={inline ? undefined : { paddingTop: 'calc(6px + var(--sat))' }}
      >
        {!inline && (
          <IconButton icon="back" label="Back" size="md" variant="ghost" onClick={onClose} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[17px] font-semibold tracking-tight text-ink">{agentName(a)}</h2>
            {a.isManager && (
              <span className="flex-none rounded-md border border-mgr/40 px-1.5 py-0.5 text-[10px] font-semibold text-mgr">
                MGR
              </span>
            )}
          </div>
          {/* One truncated line — three separately-truncating spans turn into
              "m… · /Users/…" the moment a phone runs out of room. */}
          <div className="flex min-w-0 items-center gap-1 text-[11.5px] text-ink3">
            {a.branch && <Icon name="branch" size={11} className="flex-none" />}
            <span className="truncate">{meta.join(' · ')}</span>
          </div>
        </div>

        <span
          className={`pill flex flex-none items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-semibold ${
            st === 'working'
              ? 'bg-accent/12 text-accent'
              : st === 'waiting'
                ? 'bg-warn/14 text-warn'
                : st === 'exited'
                  ? 'bg-crit/14 text-crit'
                  : 'glass-soft text-ink2'
          }`}
        >
          <StatusDot status={st} size={7} />
          <span className="hidden sm:inline">{statusLabel(st)}</span>
        </span>

        {onConsole && a.controllable && (
          <IconButton
            icon="terminal"
            label="Console"
            size="md"
            variant="glass"
            onClick={() => onConsole(agentId)}
          />
        )}
        {killBtn}
        {inline && <IconButton icon="close" label="Close workspace" size="md" variant="ghost" onClick={onClose} />}
      </header>

      {/* body */}
      {/* Phone: one flex column that scrolls. Desktop: terminal + rail side by
          side, each scrolling on its own. (A 1-col grid collapses the left
          column's auto row to 0 once the terminal takes a viewport height.) */}
      <main className="noscroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3 sm:p-4 lg:grid lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] lg:overflow-hidden">
        {/* left: menu banner + terminal. With a menu open the column scrolls as
            one and the mirror keeps a fixed slot below the question — two
            cramped panes side by side read worse than one honest scroll. */}
        <div
          className={`flex min-h-0 min-w-0 flex-none flex-col gap-3 ${
            prompt
              ? 'noscroll lg:overflow-y-auto lg:[mask-image:linear-gradient(to_bottom,#000_calc(100%-36px),transparent)]'
              : ''
          }`}
        >
          <AnimatePresence initial={false}>
            {prompt && (
              <motion.div
                key="prompt"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8, height: 0 }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, height: 'auto' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, height: 0 }}
                transition={spring.smooth}
                className="flex-none overflow-hidden"
              >
                <PromptControls agent={a} prompt={prompt} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* A definite height below lg: the phone body is one long scroll, and
              a flex-sized terminal there would grow to its whole transcript. */}
          <div
            className={`h-[46vh] flex-none ${
              prompt ? 'lg:h-[300px]' : 'lg:h-auto lg:min-h-0 lg:flex-1'
            }`}
          >
            <Terminal
              agent={a}
              onExpand={onConsole && a.controllable ? () => onConsole(agentId) : null}
              className="h-full"
            />
          </div>
        </div>

        {/* right rail (desktop) / stacked sections (phone) */}
        <div className="noscroll flex min-w-0 flex-none flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pb-2 lg:[mask-image:linear-gradient(to_bottom,#000_calc(100%-28px),transparent)]">
          {rail}
        </div>
      </main>

      {/* sticky footer: quick keys + reply composer */}
      <footer
        className="flex-none border-t border-glass-line px-3 pt-2.5 sm:px-4"
        style={{ paddingBottom: inline ? 10 : 'calc(10px + var(--sab))' }}
      >
        {a.controllable ? (
          <>
            <div className="noscroll mb-2.5 flex items-center gap-2 overflow-x-auto pb-0.5">
              {[
                ['esc', 'Esc'],
                ['up', '↑'],
                ['down', '↓'],
                ['enter', '⏎'],
              ].map(([k, lbl]) => (
                <motion.button
                  key={k}
                  {...press}
                  onClick={() => sendKey(agentId, k)}
                  aria-label={k}
                  className="glass-soft glass-soft-hover pill grid h-10 w-11 flex-none place-items-center text-[14px] font-medium text-ink2"
                >
                  {lbl}
                </motion.button>
              ))}
              <span className="h-5 w-px flex-none bg-glass-line" />
              {['Continue', 'Yes', 'Approve plan'].map((q) => (
                <motion.button
                  key={q}
                  {...press}
                  onClick={() => reply(agentId, q)}
                  className="glass-soft glass-soft-hover pill h-10 flex-none px-3.5 text-[13px] font-medium text-ink2"
                >
                  {q}
                </motion.button>
              ))}
              <motion.button
                {...press}
                onClick={() => reply(agentId, 'Stop')}
                className="pill h-10 flex-none border border-crit/35 px-3.5 text-[13px] font-medium text-crit transition-colors hover:bg-crit/12"
              >
                ■ Stop
              </motion.button>
              <span className="min-w-2 flex-1" />
            </div>
            <MicField
              onSend={(text) => reply(agentId, text)}
              placeholder="Message this agent…"
              autoFocus={desktop && st === 'waiting'}
            />
          </>
        ) : (
          <div className="flex items-center justify-between gap-3 pb-1">
            <p className="text-[13px] text-ink3">Read-only — this agent’s terminal can’t be driven remotely.</p>
          </div>
        )}
      </footer>
    </div>
  );
}
