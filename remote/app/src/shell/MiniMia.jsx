import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, miaSend, miaRead, miaUnread, miaOpenQuestions } from '../lib/store.js';
import { spring } from '../lib/motion.js';
import { talkSupported } from '../lib/voice.js';
import { useTalk, startTalk } from '../lib/talkSession.js';
import { useLocalStorage } from '../lib/hooks.js';
import Icon from '../ui/Icon.jsx';
import IconButton from '../ui/IconButton.jsx';
import Button from '../ui/Button.jsx';
import MicField from '../views/agent/MicField.jsx';
import { MessageRow, toMs } from '../views/mia/Thread.jsx';

// Mini Mia: a small bubble that floats over every view except Mia's own, and
// opens into a compact sheet — her last few messages, any open `mia ask` as
// tappable options, and a field to reply — so Daniel can talk to her from a
// doc, an agent or the page she is showing without leaving it.
//
// It is a second window onto the SAME thread: the rows come from the store's
// mia block, sending is miaSend, answering is the thread's own <Answer>
// (inside MessageRow), and opening it marks the thread read like the Mia view
// does. Nothing here keeps its own copy of the conversation.
//
// Placement: the bubble sits on the left or right edge (drag it; it snaps to
// the nearer side and remembers where, per device) and is kept out of the top
// band, where windows and the viewer have their Back / Close buttons, and off
// the dock at the bottom. Safe-area insets are measured, not guessed.

const SIZE = 52; // bubble diameter
const GUTTER = 12; // from the screen edge
const TOP_CLEAR = 136; // below the top bar + a window's / the viewer's header
const BOTTOM_CLEAR = 100; // above the dock
const SHEET_BOTTOM = 92; // the sheet's bottom edge sits on the dock's top
const ROWS = 6; // messages shown
const PEEK_MS = 7000;
const DEFAULT_POS = { side: 'right', f: 0.78 };

function readInsets() {
  const d = document.createElement('div');
  d.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(d);
  const cs = getComputedStyle(d);
  const r = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  d.remove();
  return r;
}

// Screen box + safe areas + how much of the bottom the keyboard covers.
function useBox() {
  const read = () => {
    const vv = window.visualViewport;
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    return { w: window.innerWidth, h: window.innerHeight, ins: readInsets(), kb };
  };
  const [box, setBox] = useState(read);
  useEffect(() => {
    let t = 0;
    const on = () => {
      setBox(read());
      clearTimeout(t);
      t = setTimeout(() => setBox(read()), 300); // rotation settles late on iOS
    };
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    window.visualViewport?.addEventListener('resize', on);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
      window.visualViewport?.removeEventListener('resize', on);
    };
  }, []);
  return box;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function bubbleSpot(box, pos) {
  const { w, h, ins } = box;
  const minTop = ins.t + TOP_CLEAR;
  const maxTop = Math.max(minTop, h - ins.b - BOTTOM_CLEAR - SIZE);
  const f = clamp(Number.isFinite(pos?.f) ? pos.f : DEFAULT_POS.f, 0, 1);
  return {
    minTop,
    maxTop,
    top: minTop + f * (maxTop - minTop),
    left: pos?.side === 'left' ? ins.l + GUTTER : w - ins.r - GUTTER - SIZE,
  };
}

// The last few messages, plus any question still open that has scrolled
// further back — an ask is never out of reach here.
function useRows(mia, local) {
  return useMemo(() => {
    if (!mia) return [];
    const msgs = mia.messages || [];
    const asked = new Set(msgs.filter((m) => m.kind === 'question' && m.questionId).map((m) => m.questionId));
    const open = new Set(miaOpenQuestions(mia, local).map((q) => q.questionId));
    const talk = msgs.filter(
      (m) => m.from !== 'system' && m.kind !== 'event' && !(m.kind === 'answer' && m.questionId && asked.has(m.questionId)),
    );
    const tail = talk.slice(-ROWS);
    const older = talk.slice(0, -ROWS).filter((m) => m.kind === 'question' && open.has(m.questionId));
    const list = [...older.map((m) => ({ m })), ...tail.map((m) => ({ m }))];
    for (const p of local.sent) list.push({ m: { from: 'daniel', kind: 'chat', text: p.text, at: p.at }, key: p.id, pending: true });
    let prev = null;
    return list.map((r, i) => {
      const head = !prev || prev.from !== r.m.from || toMs(r.m.at) - toMs(prev.at) > 10 * 60 * 1000 || (i > 0 && i === older.length);
      prev = r.m;
      return { ...r, key: r.key || r.m.id || `i${i}`, head };
    });
  }, [mia, local]);
}

function Presence({ mia, link }) {
  const s =
    link !== 'linked'
      ? ['bg-ink3', link === 'relay' ? 'Mac offline' : 'Reconnecting…']
      : !mia?.enabled
        ? ['bg-ink3', 'Off']
        : mia.online
          ? ['bg-accent', 'Online']
          : ['bg-warn', 'Offline'];
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-ink3">
      <span className={`h-1.5 w-1.5 rounded-full ${s[0]}`} />
      {s[1]}
    </span>
  );
}

export default function MiniMia({ hidden = false, onOpenMia }) {
  const mia = useMC((s) => s.mia);
  const local = useMC((s) => s.miaLocal);
  const link = useMC((s) => s.link);
  const badge = useMC((s) => miaUnread(s.mia, s.miaLocal));
  const talkOn = useTalk((s) => s.on);
  const box = useBox();
  const [pos, setPos] = useLocalStorage('mc.miniMia.pos', DEFAULT_POS);
  const [open, setOpen] = useState(false); // false | 'open' | 'peek'
  const [drag, setDrag] = useState(null); // { dx, dy } while dragging
  const gesture = useRef(null);
  const moved = useRef(false);
  const rows = useRows(mia, local);

  const spot = bubbleSpot(box, pos);

  // Leaving for the Mia view (or a sheet covering everything) folds it away.
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  // ---- auto-peek on a new `mia ask` ----------------------------------------
  const openQs = miaOpenQuestions(mia, local);
  const openKey = openQs.map((q) => q.questionId).join(' ');
  const seenQs = useRef(null); // every question id this page has already seen
  const peekTimer = useRef(0);
  useEffect(() => {
    if (!mia) return; // the first snapshot's questions are old news, not a new ask
    const ids = openKey ? openKey.split(' ') : [];
    if (!seenQs.current) {
      seenQs.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !seenQs.current.has(id));
    for (const id of fresh) seenQs.current.add(id);
    if (!fresh.length) return;
    if (hidden || open || talkOn || document.visibilityState === 'hidden') return;
    setOpen('peek');
  }, [openKey, !!mia]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    clearTimeout(peekTimer.current);
    if (open === 'peek') peekTimer.current = setTimeout(() => setOpen((o) => (o === 'peek' ? false : o)), PEEK_MS);
    return () => clearTimeout(peekTimer.current);
  }, [open]);

  // ---- read marker: an open sheet on a visible page has been seen ----------
  const lastId = useMemo(() => {
    const msgs = mia?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id) return msgs[i].id;
    return '';
  }, [mia]);
  useEffect(() => {
    if (open === 'open' && !hidden && link === 'linked' && lastId && document.visibilityState === 'visible') miaRead(lastId);
  }, [open, hidden, link, lastId]);

  // ---- follow the newest row -----------------------------------------------
  const scroller = useRef(null);
  const lastKey = rows.length ? rows[rows.length - 1].key : '';
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastKey, open, rows.length]);

  // ---- drag ------------------------------------------------------------------
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    moved.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!moved.current && Math.hypot(dx, dy) < 6) return;
    moved.current = true;
    const left = clamp(spot.left + dx, box.ins.l + 4, box.w - box.ins.r - SIZE - 4);
    const top = clamp(spot.top + dy, spot.minTop, spot.maxTop);
    setDrag({ dx: left - spot.left, dy: top - spot.top });
  };
  const onPointerUp = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!moved.current || !drag) {
      setDrag(null);
      return;
    }
    const cx = spot.left + drag.dx + SIZE / 2;
    const top = spot.top + drag.dy;
    const range = spot.maxTop - spot.minTop;
    setPos({ side: cx < box.w / 2 ? 'left' : 'right', f: range > 0 ? clamp((top - spot.minTop) / range, 0, 1) : 0 });
    setDrag(null);
  };

  if (!mia) return null;

  // ---- the sheet ---------------------------------------------------------------
  const narrow = box.w < 640;
  const bottom = Math.max(box.ins.b + SHEET_BOTTOM, box.kb + 8);
  const avail = box.h - bottom - (box.ins.t + (narrow ? 72 : TOP_CLEAR));
  const sheetStyle = {
    bottom,
    maxHeight: clamp(avail, 240, 520),
    ...(narrow
      ? { left: box.ins.l + GUTTER, right: box.ins.r + GUTTER }
      : pos.side === 'left'
        ? { left: box.ins.l + 16, width: 384 }
        : { right: box.ins.r + 16, width: 384 }),
  };
  const openQCount = openQs.length;
  const ctx = { block: mia, local, openIds: new Set(openQs.map((q) => q.questionId)) };

  return createPortal(
    <AnimatePresence>
      {!hidden && !open && (
        <motion.button
          key="bubble"
          data-mini-mia="bubble"
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.7 }}
          transition={spring.snappy}
          whileTap={drag ? undefined : { scale: 0.94 }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={() => {
            if (moved.current) {
              moved.current = false;
              return;
            }
            setOpen('open');
          }}
          aria-label={badge ? `Chat with Mia, ${badge} new` : 'Chat with Mia'}
          title="Chat with Mia — drag to move"
          className="glass fixed z-[89] grid !rounded-full touch-none select-none place-items-center rounded-full text-ink shadow-2"
          style={{ width: SIZE, height: SIZE, left: spot.left + (drag?.dx || 0), top: spot.top + (drag?.dy || 0) }}
        >
          <Icon name="mia" size={22} />
          {badge > 0 && (
            <span
              data-mini-dot
              className="absolute right-[3px] top-[3px] h-3 w-3 rounded-full border-2 border-[#1b1b1f] bg-warn"
            />
          )}
        </motion.button>
      )}
      {!hidden && open && (
        <motion.div
          key="sheet"
          data-mini-mia={open}
          role="dialog"
          aria-label="Mia"
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.97 }}
          transition={spring.smooth}
          onPointerDown={() => open === 'peek' && setOpen('open')}
          onFocusCapture={() => open === 'peek' && setOpen('open')}
          className="glass-strong fixed z-[89] flex flex-col overflow-hidden rounded-xl3 shadow-2"
          style={sheetStyle}
        >
          <header className="flex flex-none items-center gap-2 border-b border-glass-line py-2 pl-3.5 pr-2">
            <Icon name="mia" size={16} className="text-ink2" />
            <span className="text-[14px] font-semibold tracking-tight text-ink">Mia</span>
            <Presence mia={mia} link={link} />
            {openQCount > 0 && (
              <span
                className="pill tnum whitespace-nowrap bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn"
                title={`${openQCount} question${openQCount === 1 ? '' : 's'} waiting on you`}
              >
                {openQCount} {narrow ? 'open' : 'waiting'}
              </span>
            )}
            <span className="flex-1" />
            {talkSupported && !talkOn && (
              <Button
                size="sm"
                icon="mic"
                onClick={() => {
                  startTalk(); // inside the tap: unlocks audio and asks for the mic
                  setOpen(false);
                }}
              >
                Talk
              </Button>
            )}
            <IconButton icon="expand" label="Open Mia" size="sm" onClick={() => onOpenMia?.()} />
            <IconButton icon="chevronDown" label="Minimise Mia" size="sm" onClick={() => setOpen(false)} />
          </header>
          <div ref={scroller} className="noscroll min-h-0 flex-1 overflow-y-auto px-3.5 pb-3">
            {rows.length ? (
              <div className="flex flex-col" data-mini-rows>
                {rows.map((r) => (
                  <MessageRow
                    key={r.key}
                    m={r.m}
                    head={r.head}
                    pending={r.pending}
                    mia={ctx}
                    onTask={() => onOpenMia?.()}
                  />
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-[13px] text-ink3">Nothing yet — tell Mia what you need.</p>
            )}
          </div>
          <div className="flex-none border-t border-glass-line p-2.5">
            <MicField onSend={(t) => miaSend(t)} placeholder={mia.enabled ? 'Message Mia…' : 'Message Mia — she’ll read it when she starts'} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
