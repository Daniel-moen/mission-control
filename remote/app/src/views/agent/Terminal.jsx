import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cleanScreen, screenInfoFor } from '../../lib/store.js';
import { ansiToHtml } from '../../lib/ansi.js';
import { useNow, useScreen } from '../../lib/hooks.js';
import IconButton from '../../ui/IconButton.jsx';
import Icon from '../../ui/Icon.jsx';

// The terminal mirror — the star of the workspace. Renders the best-available
// screen (the streamed watch-lease buffer with scrollback, else the snapshot's
// ~50-line tail), scrubbed by cleanScreen so the TUI's input box, spinner and
// footer hints don't fight the transcript. Auto-follows the tail; scrolling up
// detaches and offers a jump pill.
//
// It NEVER blanks on a missed frame: the last-known text stays on screen and
// the chrome carries an honest staleness age instead. Terminal text never
// animates — a transcript that moves is a transcript you can't read.

const MAX_LINES = 500; // render cap — keeps 50-agent boards smooth

export default function Terminal({ agent, onExpand, className = '' }) {
  useScreen(agent?.id); // subscribe: stream frames must re-render this mirror
  const now = useNow();
  const info = agent ? screenInfoFor(agent) : { text: '', at: 0, streamed: false };

  const shown = useMemo(() => {
    const cleaned = cleanScreen(info.text) || '';
    if (!cleaned) return '';
    const lines = cleaned.split('\n');
    return lines.length > MAX_LINES ? lines.slice(-MAX_LINES).join('\n') : cleaned;
  }, [info.text]);

  const html = useMemo(() => (shown ? ansiToHtml(shown) : ''), [shown]);

  const age = info.at ? Math.max(0, Math.round((now - info.at) / 1000)) : null;
  const live = age !== null && age <= 5;

  const pre = useRef(null);
  const [follow, setFollow] = useState(true);

  function onScroll() {
    const el = pre.current;
    if (!el) return;
    setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - 48);
  }
  function jumpLive() {
    setFollow(true);
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Stick to the bottom while output streams in, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = pre.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [shown, follow]);

  return (
    <div
      className={`relative flex min-h-0 flex-col overflow-hidden rounded-xl3 border border-glass-line bg-term ${className}`}
    >
      {/* chrome: what this is, and how fresh it is — always honest */}
      <div className="flex flex-none items-center gap-2 border-b border-white/[0.07] px-3.5 py-2">
        <Icon name="terminal" size={13} className="text-ink3" />
        <span className="label">Terminal</span>
        {info.streamed && (
          <span className="glass-soft rounded-md px-1.5 py-px text-[10px] leading-4 text-ink3">scrollback</span>
        )}
        <span className="flex-1" />
        {age !== null && shown ? (
          live ? (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-accent">
              <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />
              Live
            </span>
          ) : (
            <span className="tnum font-mono text-[11px] text-ink3">
              {age < 120 ? `${age}s ago` : `${Math.round(age / 60)}m ago`}
            </span>
          )
        ) : null}
        {onExpand && (
          <IconButton
            icon="expand"
            label="Open full-screen console"
            size="sm"
            variant="ghost"
            onClick={onExpand}
            className="-my-1 ml-1"
          />
        )}
      </div>

      {shown ? (
        <pre
          ref={pre}
          onScroll={onScroll}
          className="term term-wrap noscroll m-0 min-h-0 flex-1 overflow-auto p-4"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="flex-1 p-4 font-mono text-[12.5px] text-ink3">
          {agent?.controllable === false
            ? 'This terminal can’t be mirrored (only iTerm2, Terminal.app and WezTerm can).'
            : 'Mirror warming up…'}
        </div>
      )}

      {shown && !follow && (
        <button
          onClick={jumpLive}
          className="pill absolute bottom-3 left-1/2 flex h-9 -translate-x-1/2 items-center gap-1.5 bg-ink px-4 text-[13px] font-semibold text-bg shadow-[0_6px_20px_-6px_rgba(0,0,0,0.6)] transition active:scale-95"
        >
          <Icon name="arrowDown" size={14} strokeWidth={2.4} /> Jump to latest
        </button>
      )}
    </div>
  );
}
