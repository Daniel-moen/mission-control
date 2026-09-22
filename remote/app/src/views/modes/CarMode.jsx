import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Volume2, VolumeX } from 'lucide-react';
import {
  useMC,
  attentionList,
  agentName,
  agentStatus,
  statusLabel,
  counts,
  reply,
  sendKey,
  kill,
  launch,
  toast,
  fmtInt,
  fmtTokens,
  allDirs,
} from '../../lib/store.js';
import { useAgents, useLink, useWakeLock } from '../../lib/hooks.js';
import { TONE } from '../../lib/tone.js';
import { dictate, speechSupported } from '../../lib/speech.js';
import { spring } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';
import ModeBackdrop from './ModeBackdrop.jsx';

// Car mode — run the fleet with your eyes on the road. Hash-routed (#car).
// Three screens, one at a time, giant type on the dimmed backdrop:
//   • ask    — an agent needs you: question + enormous numbered buttons
//   • list   — every agent as a big row; the mic LAUNCHES a new agent by
//              voice into the selected project chip
//   • agent  — one agent focused: what it's doing, Stop, mic to reply
// New "needs you" items are announced out loud (speech synthesis).
// Deliberately NOT here: a voice directory dispatcher — the project is a chip
// you tap once, not a word you have to pronounce correctly at 70mph.

const LS_DIR = 'mc_car_dir';
const ORDER = { waiting: 0, exited: 1, working: 2, done: 3 };

// Every tappable surface in here is a slab: ≥76px tall, 20px+ type, translucent
// so it reads over the photo without stealing light from the road. The blur
// lives ONCE on the root scrim — a phone clamped to a windscreen cannot afford
// a dozen stacked backdrop-filters.
const SLAB = 'flex items-center justify-center border transition-colors active:brightness-125';
const SLAB_TONE = {
  // A DARK translucent fill, not a light one: a white wash over a forest photo
  // keeps the texture and eats the contrast. Dark fill + white hairline reads
  // at a glance over any picture.
  plain: 'border-glass-line bg-black/40 text-ink',
  active: 'border-glass-line2 bg-white/[0.15] text-ink',
  warn: 'border-warn/45 bg-warn/[0.14] text-warn',
  crit: 'border-crit/45 bg-crit/[0.14] text-crit',
  accent: 'border-accent/45 bg-accent/[0.14] text-accent',
  quiet: 'border-glass-line bg-black/30 text-ink3',
};

function Slab({ tone = 'plain', radius = 'rounded-[26px]', className = '', children, ...rest }) {
  return (
    <motion.button
      whileTap={{ scale: 0.975 }}
      transition={spring.snappy}
      className={`${SLAB} ${SLAB_TONE[tone] || SLAB_TONE.plain} ${radius} ${className}`}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

// The answer controls for one attention item: a parsed menu, a bare "waiting"
// prompt, or a dead process. Identical on the ask screen and inside a focused
// agent, which is why it lives on its own.
function AskControls({ item }) {
  const a = item.agent;
  if (item.kind === 'exited') {
    return (
      <Slab
        tone="crit"
        onClick={() => kill(a.id)}
        className="min-h-[84px] text-[22px] font-semibold landscape:col-span-2 landscape:min-h-[64px] landscape:text-[19px]"
      >
        Clear session
      </Slab>
    );
  }
  if (item.prompt) {
    return (
      <>
        {item.prompt.options.slice(0, 6).map((o) => (
          <Slab
            key={o.n}
            onClick={() => sendKey(a.id, String(o.n))}
            className="min-h-[76px] justify-start gap-4 px-6 text-left landscape:min-h-[62px] landscape:gap-3 landscape:px-4"
          >
            <span className="grid h-11 w-11 flex-none place-items-center rounded-2xl border border-glass-line bg-white/[0.09] font-mono text-[20px] font-bold text-ink landscape:h-9 landscape:w-9 landscape:text-[16px]">
              {o.n}
            </span>
            <span className="min-w-0 flex-1 truncate text-[21px] font-medium landscape:text-[17px]">{o.label}</span>
          </Slab>
        ))}
      </>
    );
  }
  return (
    <>
      <Slab
        onClick={() => reply(a.id, 'Yes')}
        className="min-h-[84px] text-[24px] font-semibold landscape:min-h-[64px] landscape:text-[19px]"
      >
        Yes
      </Slab>
      <Slab
        onClick={() => reply(a.id, 'Continue')}
        className="min-h-[84px] text-[24px] font-semibold landscape:min-h-[64px] landscape:text-[19px]"
      >
        Continue
      </Slab>
      <Slab
        onClick={() => sendKey(a.id, 'enter')}
        className="min-h-[68px] gap-2.5 text-[20px] font-medium landscape:col-span-2 landscape:min-h-[56px] landscape:text-[17px]"
      >
        <Icon name="enter" size={22} /> Enter
      </Slab>
    </>
  );
}

export default function CarMode({ onClose }) {
  const agents = useAgents();
  const screens = useMC((s) => s.screens);
  const summary = useMC((s) => s.summary);
  const link = useLink();
  const knownDirs = useMC((s) => s.knownDirs);
  const localDirs = useMC((s) => s.localDirs);
  const lastDir = useMC((s) => s.lastDir);

  // attentionInfo() parses the streamed screen, so the list has to recompute
  // when a screen frame lands — not just when the agent array changes.
  const items = useMemo(() => attentionList(agents), [agents, screens]);
  const c = useMemo(() => counts(agents), [agents]);

  const [idx, setIdx] = useState(0);
  const cur = items.length ? items[Math.min(idx, items.length - 1)] : null;
  useEffect(() => {
    if (idx > 0 && idx >= items.length) setIdx(Math.max(0, items.length - 1));
  }, [idx, items.length]);

  // ---- which screen ---------------------------------------------------------
  const [focus, setFocus] = useState(null); // focused agent id
  const [showList, setShowList] = useState(false); // user chose the list over pending asks
  const focused = focus ? agents.find((a) => a.id === focus) || null : null;
  useEffect(() => {
    if (focus && !focused) setFocus(null); // it left the board
  }, [focus, focused]);
  const screen = focused ? 'agent' : items.length && !showList ? 'ask' : 'list';
  // When the last ask clears, fall back to the list naturally.
  useEffect(() => {
    if (!items.length) setShowList(false);
  }, [items.length]);

  const roster = useMemo(
    () => [...agents].sort((a, b) => (ORDER[agentStatus(a)] ?? 9) - (ORDER[agentStatus(b)] ?? 9)),
    [agents],
  );

  const linkDot = link === 'linked' ? 'bg-ok' : link === 'relay' ? 'bg-warn' : 'bg-crit';

  // ---- launch target --------------------------------------------------------
  // The project the mic launches into — big chips, remembered across drives.
  const [dir, setDir] = useState(() => {
    try {
      return localStorage.getItem(LS_DIR) || '';
    } catch {
      return '';
    }
  });
  const dirs = useMemo(() => allDirs(), [knownDirs, localDirs]);
  useEffect(() => {
    if (!dir && lastDir) setDir(lastDir);
    // A remembered dir nobody knows anymore falls back to the last used.
    else if (dir && dirs.length && !dirs.includes(dir)) setDir(lastDir || dirs[0]);
  }, [dir, dirs, lastDir]);
  const pickDir = (d) => {
    setDir(d);
    try {
      localStorage.setItem(LS_DIR, d);
    } catch {
      /* private mode — this drive only */
    }
  };
  const dirName = dir ? dir.split('/').filter(Boolean).pop() : '';

  // ---- spoken announcements -------------------------------------------------
  const [voiceOn, setVoiceOn] = useState(true);
  const announced = useRef(new Set());
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;
  const speak = useCallback((text) => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch {
      /* no synthesis on this device — the screen still says it */
    }
  }, []);
  useEffect(() => {
    for (const it of items) {
      if (announced.current.has(it.agent.id)) continue;
      announced.current.add(it.agent.id);
      if (voiceRef.current)
        speak(
          `${agentName(it.agent)} needs you. ` +
            (it.kind === 'exited'
              ? 'The process exited.'
              : it.prompt?.question || it.agent.activity || 'Waiting for your input.'),
        );
    }
    // Prune as items clear, so an agent that needs you twice is announced twice.
    const ids = new Set(items.map((i) => i.agent.id));
    for (const id of [...announced.current]) if (!ids.has(id)) announced.current.delete(id);
  }, [items, speak]);

  // ---- tap-to-talk ----------------------------------------------------------
  // Tap mic → listening. Tap again → stop AND send. What "send" means depends
  // on the screen: reply to the focused agent / the current ask, or LAUNCH a
  // new agent with the spoken mission on the list screen.
  const [listening, setListening] = useState(false);
  const [draft, setDraft] = useState('');
  const micRef = useRef(null);
  const draftRef = useRef('');
  const discardRef = useRef(false);

  const micTarget = focused
    ? { kind: 'reply', agent: focused }
    : screen === 'ask' && cur
      ? { kind: 'reply', agent: cur.agent }
      : { kind: 'launch' };

  // The dictation callbacks outlive the render that created them, so where the
  // words go is read from a ref at send time rather than captured.
  const sendRef = useRef(() => {});
  sendRef.current = (text) => {
    const t = (text || '').trim();
    if (!t) return;
    if (micTarget.kind === 'reply') {
      reply(micTarget.agent.id, t);
      return;
    }
    if (!launch({ mission: t, dir: dir.trim(), managerModel: null, workerModels: [''] })) return;
    toast(`Launching agent${dirName ? ' in ' + dirName : ''}`);
    if (voiceRef.current) speak(`Launching agent${dirName ? ' in ' + dirName : ''}.`);
  };

  function toggleMic() {
    if (micRef.current) {
      micRef.current.stop(); // onEnd fires and sends
      return;
    }
    discardRef.current = false;
    draftRef.current = '';
    setDraft('');
    const sess = dictate({
      base: '',
      onText: (t) => {
        draftRef.current = t;
        setDraft(t);
      },
      onEnd: () => {
        micRef.current = null;
        setListening(false);
        if (!discardRef.current) sendRef.current(draftRef.current);
        draftRef.current = '';
        setDraft('');
      },
      onError: () => {
        micRef.current = null;
        setListening(false);
      },
    });
    if (sess) {
      micRef.current = sess;
      setListening(true);
    }
  }
  function discardMic() {
    discardRef.current = true;
    micRef.current?.stop();
    draftRef.current = '';
    setDraft('');
  }

  // Keep the screen awake while driving — best effort.
  useWakeLock(true);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      try {
        speechSynthesis.cancel();
      } catch {}
      micRef.current?.stop();
      micRef.current = null;
    };
  }, [onClose]);

  const transcript = (
    <div className="rounded-[26px] border border-crit/45 bg-crit/[0.10] px-5 py-4 text-[20px] leading-snug text-ink landscape:col-span-2 landscape:text-[17px]">
      {draft || 'Listening…'}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[78] flex flex-col">
      {/* The photo, dimmed hard: at speed, contrast beats scenery. */}
      <ModeBackdrop extra={0.35} />

      <div
        className="relative flex min-h-0 flex-1 flex-col"
        style={{ paddingTop: 'var(--sat)', paddingBottom: 'var(--sab)' }}
      >
      {/* top bar: exit, status, voice toggle — all thumb-sized */}
      <header className="flex flex-none items-center gap-3 px-4 pt-3 pb-2">
        {/* Portrait has no room for the word AND the counts — the ✕ carries it. */}
        <Slab
          onClick={onClose}
          aria-label="Exit car mode"
          radius="rounded-[22px]"
          className="h-16 w-16 flex-none gap-2 text-[17px] font-semibold landscape:h-12 landscape:w-auto landscape:px-5 landscape:text-[15px]"
        >
          <Icon name="close" size={24} />
          <span className="hidden landscape:inline">Exit</span>
        </Slab>
        <div className="min-w-0 flex-1 overflow-hidden px-1 text-center">
          <div className="tnum flex items-center justify-center gap-2 overflow-hidden whitespace-nowrap text-[15px] font-semibold landscape:text-[16px]">
            <span className={`h-2.5 w-2.5 flex-none rounded-full ${linkDot}`} />
            {c.working > 0 && <span className="text-accent">{c.working} working</span>}
            {c.working > 0 && items.length > 0 && <span className="text-ink3">·</span>}
            {items.length > 0 && (
              <span className="text-warn">
                {items.length} need{items.length === 1 ? 's' : ''} you
              </span>
            )}
            {!c.working && !items.length && (
              <span className="text-ink2">{agents.length ? 'All quiet' : 'No agents'}</span>
            )}
          </div>
          <div className="tnum mt-1 font-mono text-[13px] text-ink3">
            {fmtInt(Math.round(summary.tokensPerSec ?? 0))} tok/s · ${(summary.totalCost ?? 0).toFixed(2)}
          </div>
        </div>
        <Slab
          tone={voiceOn ? 'accent' : 'quiet'}
          onClick={() => setVoiceOn((v) => !v)}
          aria-pressed={voiceOn}
          aria-label="Spoken announcements"
          radius="rounded-[22px]"
          className="h-16 w-16 flex-none landscape:h-12 landscape:w-12"
        >
          {voiceOn ? <Volume2 size={26} strokeWidth={1.9} /> : <VolumeX size={26} strokeWidth={1.9} />}
        </Slab>
      </header>

      <main className="noscroll flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-3">
        <AnimatePresence mode="wait" initial={false}>
          {screen === 'ask' && cur && (
            <motion.div
              key="ask"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="flex min-h-full flex-1 flex-col"
            >
              {/* who + navigation between asks */}
              <div className="flex flex-none items-center gap-3 py-2">
                {items.length > 1 && (
                  <Slab
                    onClick={() => setIdx((i) => (i - 1 + items.length) % items.length)}
                    aria-label="Previous"
                    radius="rounded-[22px]"
                    className="h-16 w-16 flex-none landscape:h-12 landscape:w-12"
                  >
                    <Icon name="chevronLeft" size={26} />
                  </Slab>
                )}
                <div className="min-w-0 flex-1 text-center">
                  <div className="truncate text-[30px] font-bold tracking-tight landscape:text-[22px]">
                    {agentName(cur.agent)}
                  </div>
                  {items.length > 1 && (
                    <div className="tnum mt-0.5 text-[14px] text-ink3 landscape:mt-0 landscape:text-[12px]">
                      {Math.min(idx, items.length - 1) + 1} of {items.length}
                    </div>
                  )}
                </div>
                {items.length > 1 && (
                  <Slab
                    onClick={() => setIdx((i) => (i + 1) % items.length)}
                    aria-label="Next"
                    radius="rounded-[22px]"
                    className="h-16 w-16 flex-none landscape:h-12 landscape:w-12"
                  >
                    <Icon name="chevronRight" size={26} />
                  </Slab>
                )}
              </div>

              <p className="flex-none px-1 py-2 text-center text-[22px] font-medium leading-snug text-warn landscape:py-1 landscape:text-[17px]">
                {cur.kind === 'exited'
                  ? 'Process exited unexpectedly'
                  : cur.prompt?.question || cur.agent.activity || 'Waiting for your input'}
              </p>

              <div className="mt-2 grid flex-1 content-end gap-3 landscape:grid-cols-2">
                {listening || draft ? (
                  transcript
                ) : (
                  <>
                    <AskControls item={cur} />
                    <button
                      onClick={() => setShowList(true)}
                      className="min-h-[56px] rounded-[26px] text-[16px] font-medium text-ink3 transition-colors hover:text-ink2 landscape:col-span-2 landscape:min-h-[48px]"
                    >
                      All agents ›
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          )}

          {screen === 'agent' && focused && (
            <motion.div
              key="agent"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="flex min-h-full flex-1 flex-col"
            >
              <FocusedAgent
                agent={focused}
                items={items}
                listening={listening}
                draft={draft}
                transcript={transcript}
                onBack={() => setFocus(null)}
              />
            </motion.div>
          )}

          {screen === 'list' && (
            <motion.div
              key="list"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="flex min-h-full flex-1 flex-col"
            >
              {items.length > 0 && (
                <Slab
                  tone="warn"
                  onClick={() => {
                    setShowList(false);
                    setFocus(null);
                  }}
                  className="mb-2 min-h-[60px] flex-none gap-2 text-[18px] font-semibold"
                >
                  {items.length} need{items.length === 1 ? 's' : ''} you ›
                </Slab>
              )}

              {roster.length ? (
                <div className="flex flex-col gap-2">
                  {roster.map((a) => {
                    const st = agentStatus(a);
                    return (
                      <Slab
                        key={a.id}
                        tone={st === 'waiting' ? 'warn' : 'plain'}
                        onClick={() => setFocus(a.id)}
                        className="min-h-[72px] justify-start gap-4 px-5 py-3 text-left landscape:min-h-[60px]"
                      >
                        <span className="relative flex h-3 w-3 flex-none">
                          {st === 'working' && (
                            <span className="anim-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" />
                          )}
                          <span className={`relative inline-flex h-3 w-3 rounded-full ${TONE[st].dot}`} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[20px] font-semibold tracking-tight text-ink landscape:text-[17px]">
                            {agentName(a)}
                          </span>
                          <span
                            className={`block truncate text-[14px] landscape:text-[13px] ${
                              st === 'waiting' ? 'text-warn' : 'text-ink3'
                            }`}
                          >
                            {st === 'exited' ? 'Process exited' : a.activity || statusLabel(st)}
                          </span>
                        </span>
                        <span className="flex-none text-right">
                          <span className={`block text-[13px] font-semibold ${TONE[st].text}`}>{statusLabel(st)}</span>
                          {st === 'working' && (a.tokensPerSec ?? 0) > 0 && (
                            <span className="tnum block font-mono text-[12px] text-ink3">
                              {fmtInt(Math.round(a.tokensPerSec))} t/s
                            </span>
                          )}
                        </span>
                      </Slab>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
                  <div className="text-[28px] font-bold tracking-tight landscape:text-[22px]">No agents running</div>
                  <div className="text-[16px] text-ink3">Pick a project below and speak a mission to launch one.</div>
                </div>
              )}

              {(listening || draft) && <div className="mt-3">{transcript}</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* launch target: the list of previous project dirs, all visible at once */}
      {screen === 'list' && dirs.length > 0 && !listening && (
        <div className="noscroll flex max-h-[30dvh] flex-none flex-wrap gap-2 overflow-y-auto border-t border-glass-line/60 px-4 pb-2 pt-2.5">
          {dirs.map((d) => (
            <Slab
              key={d}
              tone={d === dir ? 'active' : 'quiet'}
              radius="rounded-full"
              onClick={() => pickDir(d)}
              className="min-h-[52px] flex-none gap-2 px-5 text-[16px] font-medium landscape:min-h-[44px] landscape:text-[14px]"
            >
              <Icon name="folder" size={16} />
              {d.split('/').filter(Boolean).pop() || d}
            </Slab>
          ))}
        </div>
      )}

      {/* the mic: the whole bottom of the screen */}
      {speechSupported && (
        <footer className="flex flex-none items-center gap-3 px-4 pb-4 pt-1">
          {listening && (
            <Slab
              onClick={discardMic}
              aria-label="Discard"
              className="h-24 w-24 flex-none landscape:h-[68px] landscape:w-[68px]"
            >
              <Icon name="close" size={30} />
            </Slab>
          )}
          <motion.button
            onClick={toggleMic}
            whileTap={{ scale: 0.98 }}
            animate={listening ? { boxShadow: ['0 0 0 0 rgba(242,109,100,.55)', '0 0 0 22px rgba(242,109,100,0)'] } : {}}
            transition={listening ? { duration: 1.5, repeat: Infinity, ease: 'easeOut' } : spring.snappy}
            className={`flex h-24 min-w-0 flex-1 items-center justify-center gap-4 rounded-[26px] text-[22px] font-bold tracking-tight transition-colors landscape:h-[68px] landscape:text-[18px] ${
              listening ? 'bg-crit text-white' : 'bg-ink text-bg'
            }`}
          >
            <Icon name={micTarget.kind === 'launch' ? 'launch' : 'mic'} size={30} strokeWidth={2.2} />
            <span className="truncate">
              {listening
                ? 'Tap to send'
                : micTarget.kind === 'reply'
                  ? `Reply to ${agentName(micTarget.agent)}`
                  : `New agent${dirName ? ' · ' + dirName : ''}`}
            </span>
          </motion.button>
        </footer>
      )}
      </div>
    </div>
  );
}

// One agent, focused: status, what it's doing, todo progress, burn, and the one
// control that matters for its state (answer / Stop / clear).
function FocusedAgent({ agent, items, listening, draft, transcript, onBack }) {
  const st = agentStatus(agent);
  const todos = agent.todos || [];
  const done = todos.filter((td) => td.status === 'completed').length;
  // A waiting agent opened from the list may not be in `items` yet (its screen
  // hasn't streamed) — fall back to a promptless ask so the controls still work.
  const item = items.find((i) => i.agent.id === agent.id) || {
    agent,
    kind: st === 'exited' ? 'exited' : 'waiting',
    prompt: null,
  };

  return (
    <>
      <div className="flex flex-none items-center gap-3 py-2">
        <Slab
          onClick={onBack}
          aria-label="Back to agents"
          radius="rounded-[22px]"
          className="h-16 w-16 flex-none landscape:h-12 landscape:w-12"
        >
          <Icon name="back" size={26} />
        </Slab>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-[30px] font-bold tracking-tight landscape:text-[22px]">{agentName(agent)}</div>
          <div className={`mt-0.5 text-[15px] font-semibold landscape:mt-0 landscape:text-[13px] ${TONE[st].text}`}>
            {statusLabel(st)}
          </div>
        </div>
        <span className="w-16 flex-none landscape:w-12" />
      </div>

      <p
        className={`flex-none px-1 py-2 text-center text-[20px] font-medium leading-snug landscape:py-1 landscape:text-[16px] ${
          st === 'waiting' ? 'text-warn' : 'text-ink2'
        }`}
      >
        {st === 'exited' ? 'Process exited unexpectedly' : agent.activity || '—'}
      </p>

      {todos.length > 0 && (
        <div className="mx-1 flex flex-none items-center gap-3 py-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.12]">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={false}
              animate={{ width: `${Math.round((100 * done) / todos.length)}%` }}
              transition={spring.gentle}
            />
          </div>
          <span className="tnum font-mono text-[14px] text-ink3">
            {done}/{todos.length}
          </span>
        </div>
      )}
      <div className="tnum flex-none py-1 text-center font-mono text-[14px] text-ink3">
        {(st === 'working' ? `${fmtInt(Math.round(agent.tokensPerSec ?? 0))} tok/s · ` : '') +
          `${fmtTokens(agent.tokens ?? 0)} tok · $${(agent.cost ?? 0).toFixed(2)}`}
      </div>

      <div className="mt-2 grid flex-1 content-end gap-3 landscape:grid-cols-2">
        {listening || draft ? (
          transcript
        ) : st === 'waiting' || st === 'exited' ? (
          <AskControls item={item} />
        ) : st === 'working' ? (
          <Slab
            tone="warn"
            onClick={() => reply(agent.id, 'Stop')}
            className="min-h-[76px] gap-3 text-[21px] font-semibold landscape:col-span-2 landscape:min-h-[60px] landscape:text-[18px]"
          >
            <Icon name="stop" size={22} /> Stop this agent
          </Slab>
        ) : (
          <Slab
            onClick={() => kill(agent.id)}
            className="min-h-[68px] text-[18px] font-medium text-ink2 landscape:col-span-2 landscape:min-h-[56px]"
          >
            Clear session
          </Slab>
        )}
      </div>
    </>
  );
}
