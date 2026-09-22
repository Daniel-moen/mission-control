import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useMC, rawScreenFor, sendKey, sendText, agentName, agentStatus, statusLabel } from '../../lib/store.js';
import { ansiToHtml } from '../../lib/ansi.js';
import { TONE } from '../../lib/tone.js';
import { useAgents, useNow, useScreen, useWatch } from '../../lib/hooks.js';
import { press, spring } from '../../lib/motion.js';
import StatusDot from '../../ui/StatusDot.jsx';
import IconButton from '../../ui/IconButton.jsx';
import Icon from '../../ui/Icon.jsx';

// Full-screen terminal console. Pick one of the fleet's terminals and drive it
// as if you were sitting at the Mac: every character you type is forwarded to
// that tty verbatim, and the mirror comes back at ~3 Hz (a "hot" watch lease,
// vs the 1 Hz a passive workspace gets).
//
// Two input paths, because one isn't enough:
//   • keydown  — desktop keyboards. Named keys (arrows, esc, tab, ⌃C …) are
//     preventDefault'd and sent by NAME; printable characters are queued.
//   • beforeinput — soft keyboards, which mostly report keydown as
//     "Unidentified". insertText carries the characters, deleteContent* means
//     backspace, insertLineBreak means return.
// Printable characters are batched for a beat so fast typing costs one frame,
// not one per letter. Named keys flush the queue first so order is preserved.
//
// The screen is shown RAW — no cleanScreen() — because in a console the TUI
// chrome, the input box and the cursor line are exactly what you're steering.

const SIZES = [10.5, 12.5, 15];

const NAMED = {
  Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'esc',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
};

const KEYS = [
  ['esc', 'esc'], ['tab', 'tab'], ['up', '↑'], ['down', '↓'],
  ['left', '←'], ['right', '→'], ['backspace', '⌫'], ['enter', '⏎'],
];

export default function TerminalConsole({ agentId = null, onSelect, onClose }) {
  const agents = useAgents();
  const now = useNow();

  const [sel, setSel] = useState(agentId);
  const [picking, setPicking] = useState(!agentId);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [sizeIdx, setSizeIdx] = useState(1);

  // The caller can retarget the console while it is open (deep link, palette).
  useEffect(() => {
    setSel(agentId);
    setPicking(!agentId);
  }, [agentId]);

  const agent = agents.find((a) => a.id === sel) || null;
  const st = agent ? agentStatus(agent) : 'done';
  const t = TONE[st] || TONE.done;

  // Hot lease — held for as long as a terminal is open in here.
  useWatch(sel, { hot: true });

  const frame = useScreen(sel); // subscribe: every streamed frame re-renders
  const screen = agent ? rawScreenFor(agent) : '';
  const html = useMemo(() => (screen ? ansiToHtml(screen) : ''), [screen]);
  const age = frame?.at ? Math.max(0, Math.round((now - frame.at) / 1000)) : null;
  const live = age !== null && age <= 3;

  // The chosen terminal left the fleet — fall back to the picker. Gated on a
  // snapshot having actually landed: a deep link (#console/<id>) mounts this
  // view before the first snapshot, and an empty roster then is "no data yet",
  // not "that session is gone".
  const seenSnapshot = useMC((s) => s.lastSnapshotAt);
  useEffect(() => {
    if (sel && !agent && seenSnapshot) {
      setSel(null);
      setPicking(true);
    }
  }, [sel, agent, seenSnapshot]);

  // ---- input ---------------------------------------------------------------
  // `typing` is the user's INTENT, not the focus state: tapping a key-bar button
  // blurs the hidden field (and would drop an iPad's soft keyboard), so a blur
  // while the intent stands simply takes focus back.
  const field = useRef(null);
  const [typing, setTyping] = useState(false);
  const typingRef = useRef(false);
  const pending = useRef('');
  const flushTimer = useRef(null);
  const selRef = useRef(sel);
  const ctrlRef = useRef(false);

  selRef.current = sel;
  typingRef.current = typing;
  ctrlRef.current = ctrlArmed;

  const flush = useCallback(() => {
    clearTimeout(flushTimer.current);
    flushTimer.current = null;
    const text = pending.current;
    pending.current = '';
    if (text && selRef.current) sendText(selRef.current, text);
  }, []);

  const key = useCallback(
    (k) => {
      flush(); // keep ordering: queued characters land before the named key
      setCtrlArmed(false);
      ctrlRef.current = false;
      if (selRef.current) sendKey(selRef.current, k);
    },
    [flush],
  );

  const queue = useCallback(
    (chars) => {
      if (!chars) return;
      // An armed Ctrl turns the next letter into a control key instead.
      if (ctrlRef.current) {
        ctrlRef.current = false;
        setCtrlArmed(false);
        const c = chars[0];
        if (/[a-zA-Z]/.test(c)) {
          key('c-' + c.toLowerCase());
          queue(chars.slice(1));
          return;
        }
      }
      pending.current += chars;
      if (!flushTimer.current) flushTimer.current = setTimeout(flush, 45);
    },
    [flush, key],
  );

  useEffect(() => () => clearTimeout(flushTimer.current), []);

  function onKeyDown(e) {
    if (e.metaKey) return; // leave ⌘C/⌘V and browser shortcuts to the browser
    if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) {
      e.preventDefault();
      key('c-' + e.key.toLowerCase());
      return;
    }
    const named = NAMED[e.key];
    if (named) {
      e.preventDefault();
      key(named === 'tab' && e.shiftKey ? 'shift-tab' : named);
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      queue(e.key);
    }
  }

  // Soft keyboards: the characters arrive here, not on keydown. This has to be
  // a NATIVE listener — React's synthetic `onBeforeInput` is a composite of
  // `textInput`/composition events and carries no `inputType`, which is the
  // only thing that tells backspace and return apart on iOS.
  useEffect(() => {
    const el = field.current;
    if (!el) return undefined;
    const onBeforeInput = (e) => {
      e.preventDefault();
      const type = e.inputType || '';
      if (type === 'insertLineBreak' || type === 'insertParagraph') return key('enter');
      if (type.startsWith('delete')) return key('backspace');
      if (e.data) queue(e.data);
      return undefined;
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, [key, queue]);

  function onPaste(e) {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    flush();
    if (selRef.current) sendText(selRef.current, text);
  }

  function startTyping() {
    if (!selRef.current) return;
    typingRef.current = true;
    setTyping(true);
    queueMicrotask(() => field.current?.focus());
  }
  function stopTyping() {
    typingRef.current = false;
    setTyping(false);
    field.current?.blur();
  }
  // A blur with the intent still set means focus was stolen by a key-bar tap —
  // take it straight back so the keyboard never drops mid-session.
  function onBlur() {
    if (typingRef.current) setTimeout(() => typingRef.current && field.current?.focus(), 0);
  }
  // Every key-bar press routes through here so the field keeps focus.
  function tap(k) {
    key(k);
    if (typingRef.current) field.current?.focus();
  }

  function choose(a) {
    if (!a.controllable) return;
    selRef.current = a.id;
    setSel(a.id);
    setPicking(false);
    onSelect?.(a.id);
    startTyping();
  }

  // ---- follow-the-tail scrolling -------------------------------------------
  const pre = useRef(null);
  const [follow, setFollow] = useState(true);
  function onScroll() {
    const el = pre.current;
    if (!el) return;
    setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 40);
  }
  useLayoutEffect(() => {
    const el = pre.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [screen, follow]);

  const pillOn = 'bg-white/[0.16] text-ink border-glass-line2';
  const pillOff = 'glass-soft glass-soft-hover text-ink2';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={spring.smooth}
      className="fixed inset-0 z-[80] flex flex-col bg-[#08080a]/[0.97] backdrop-blur-xl"
    >
      {/* header: which terminal, and how fresh the mirror is */}
      <header
        className="relative flex flex-none items-center gap-2 border-b border-glass-line px-3 sm:px-5"
        style={{ paddingTop: 'calc(8px + var(--sat))', paddingBottom: 8 }}
      >
        <span className={`absolute inset-x-0 top-0 h-[2px] ${agent ? t.edge : 'bg-glass-line'}`} />
        <IconButton icon="back" label="Close console" size="md" variant="ghost" onClick={onClose} />

        <motion.button
          {...press}
          onClick={() => setPicking((p) => !p)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl2 px-2 py-1.5 text-left transition-colors hover:bg-white/[0.07]"
        >
          <Icon name="terminal" size={17} className="flex-none text-ink3" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15.5px] font-semibold leading-tight tracking-tight text-ink">
              {agent ? agentName(agent) : 'Choose a terminal'}
            </span>
            {agent && (
              <span className="block truncate font-mono text-[11px] text-ink3">{agent.dir || agent.folder || ''}</span>
            )}
          </span>
          <Icon name="chevronDown" size={16} className="flex-none text-ink3" />
        </motion.button>

        {agent && (
          <>
            <span
              className={`pill hidden flex-none items-center gap-1.5 px-2.5 py-1 text-[12px] font-semibold sm:flex ${t.chip}`}
            >
              {statusLabel(st)}
            </span>
            {live ? (
              <span className="flex flex-none items-center gap-1.5 text-[11px] font-semibold text-accent">
                <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />
                Live
              </span>
            ) : age !== null ? (
              <span className="tnum flex-none font-mono text-[11px] text-ink3">
                {age < 120 ? `${age}s ago` : `${Math.round(age / 60)}m ago`}
              </span>
            ) : null}
          </>
        )}

        <motion.button
          {...press}
          onClick={() => setSizeIdx((i) => (i + 1) % SIZES.length)}
          aria-label="Text size"
          className="grid h-10 w-10 flex-none place-items-center rounded-xl2 font-mono text-[13px] font-bold text-ink3 transition-colors hover:bg-white/[0.07]"
        >
          A{sizeIdx === 0 ? '⁻' : sizeIdx === 2 ? '⁺' : ''}
        </motion.button>
      </header>

      {/* terminal picker */}
      {picking && (
        <div className="flex-none border-b border-glass-line bg-white/[0.02] px-3 py-3 sm:px-5">
          <div className="label mb-2">Terminals · {agents.length}</div>
          <div className="noscroll flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto">
            {agents.length ? (
              agents.map((a) => {
                const ast = agentStatus(a);
                return (
                  <motion.button
                    key={a.id}
                    {...press}
                    onClick={() => choose(a)}
                    disabled={!a.controllable}
                    className={`flex w-full items-center gap-2.5 rounded-xl2 border px-3 py-2.5 text-left transition-colors ${
                      a.id === sel ? 'border-glass-line2 bg-white/[0.10]' : 'border-glass-line bg-white/[0.04]'
                    } ${a.controllable ? 'hover:bg-white/[0.08]' : 'opacity-45'}`}
                  >
                    <StatusDot status={ast} size={8} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold text-ink">{agentName(a)}</span>
                      <span className="block truncate font-mono text-[11px] text-ink3">{a.dir || a.folder || ''}</span>
                    </span>
                    <span className="flex-none text-[11px] text-ink3">
                      {a.controllable ? statusLabel(ast) : 'no mirror'}
                    </span>
                  </motion.button>
                );
              })
            ) : (
              <p className="py-3 text-[14px] italic text-ink3">
                No agents are running, so there are no terminals to drive.
              </p>
            )}
          </div>
        </div>
      )}

      {/* the screen, raw */}
      <main className="relative min-h-0 flex-1 bg-[#08080a]">
        {agent ? (
          <>
            <pre
              ref={pre}
              onScroll={onScroll}
              onClick={startTyping}
              className="term noscroll m-0 h-full overflow-auto whitespace-pre bg-transparent p-3 leading-[1.35]"
              style={{ fontSize: `${SIZES[sizeIdx]}px` }}
              dangerouslySetInnerHTML={{ __html: html || 'Mirror warming up…' }}
            />

            {!follow && (
              <button
                onClick={() => {
                  setFollow(true);
                  if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
                }}
                className="pill absolute bottom-3 left-1/2 flex h-9 -translate-x-1/2 items-center gap-1.5 bg-ink px-3.5 text-[13px] font-semibold text-bg shadow-[0_6px_20px_-6px_rgba(0,0,0,0.6)]"
              >
                <Icon name="arrowDown" size={14} strokeWidth={2.4} /> Live
              </button>
            )}
          </>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center">
            <div>
              <Icon name="terminal" size={34} className="mx-auto text-ink3" />
              <p className="mt-3 text-[15px] text-ink2">Pick a terminal above to take it over.</p>
              <p className="mt-1 text-[13px] text-ink3">Everything you type goes straight to that tty.</p>
            </div>
          </div>
        )}
      </main>

      {/* key bar: the keys a browser keyboard can't send, plus the typing toggle */}
      <footer
        className="relative flex-none border-t border-glass-line px-2 sm:px-4"
        style={{ paddingTop: 8, paddingBottom: 'calc(8px + var(--sab))' }}
      >
        <div className="noscroll mx-auto flex max-w-[1100px] items-center gap-1.5 overflow-x-auto">
          <motion.button
            {...press}
            onClick={() => (typing ? stopTyping() : startTyping())}
            disabled={!agent}
            aria-pressed={typing}
            className={`pill flex h-11 flex-none items-center gap-1.5 border px-3.5 text-[13px] font-semibold transition-colors ${
              typing ? pillOn : pillOff
            } ${agent ? '' : 'opacity-40'}`}
          >
            <Icon name="keyboard" size={17} />
            {typing ? 'Typing' : 'Type'}
          </motion.button>
          <span className="h-6 w-px flex-none bg-glass-line" />
          <motion.button
            {...press}
            onClick={() => {
              setCtrlArmed((v) => !v);
              if (typingRef.current) field.current?.focus();
            }}
            disabled={!agent}
            aria-pressed={ctrlArmed}
            className={`pill h-11 flex-none border px-3.5 text-[13px] font-semibold transition-colors ${
              ctrlArmed ? pillOn : pillOff
            }`}
          >
            ctrl
          </motion.button>
          <motion.button
            {...press}
            onClick={() => tap('c-c')}
            disabled={!agent}
            className="pill h-11 flex-none border border-crit/40 bg-crit/[0.08] px-3.5 text-[13px] font-semibold text-crit transition-colors hover:bg-crit/15"
          >
            ^C
          </motion.button>
          {/* shift+tab — what Claude Code cycles its permission mode with */}
          <motion.button
            {...press}
            onClick={() => tap('shift-tab')}
            disabled={!agent}
            title="Cycle permission mode (shift+tab)"
            className={`pill flex h-11 flex-none items-center gap-1 border px-3.5 text-[13px] font-semibold ${pillOff}`}
          >
            mode <span className="text-[11px] text-ink3">⇧⇥</span>
          </motion.button>
          {KEYS.map(([k, lbl]) => (
            <motion.button
              key={k}
              {...press}
              onClick={() => tap(k)}
              disabled={!agent}
              aria-label={k}
              className={`pill grid h-11 w-11 flex-none place-items-center border text-[15px] font-semibold ${pillOff}`}
            >
              {lbl}
            </motion.button>
          ))}
          <span className="min-w-1 flex-1" />
          {agent && !agent.controllable && (
            <span className="flex-none whitespace-nowrap text-[12px] italic text-ink3">
              Read-only — this terminal can’t be driven.
            </span>
          )}
        </div>

        {/* the real input target: invisible, but focused whenever typing is on */}
        <textarea
          ref={field}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={onBlur}
          rows={1}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck="false"
          aria-label="Terminal input"
          className="pointer-events-none absolute bottom-2 left-2 h-px w-px resize-none border-0 bg-transparent p-0 text-transparent opacity-0"
        />
      </footer>
    </motion.div>
  );
}
