import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useTransform } from 'motion/react';
import { useMC, miaStart, miaStop, miaRestart, miaModelLabel, agentStatus, miaDismissOld, miaOldQuestions } from '../src/lib/store.js';
import { spring, tap } from '../v2/lib/motion.js';
import { Button, Empty, Icon, useArm } from '../v2/ui/kit.jsx';
import { startVoice } from '../v2/shell/TalkHost.jsx';
import { openSheet } from '../v2/lib/nav.js';
import Thread, { Chips, useThinking } from './Chat.jsx';
import Orb from './Orb.jsx';
import Rings, { useExecutors } from './Rings.jsx';
import { place } from './TabBar.jsx';

// The chat stage (tasks 0491, 0502): Mia's conversation IS the home screen.
// One big pane of Lens glass from the top of the screen down to the
// composer (which floats under it with the tab bar, over the photo —
// App.jsx). Over the top of the thread: Mia, what she's doing, the agents'
// progress rings and the ··· menu (HQ, Insights, Settings live there now
// that the tab bar holds five places). At its foot: quiet suggestions.

function useStatus(mia, thinking) {
  const link = useMC((s) => s.link);
  const ex = useExecutors();
  if (link !== 'linked') return { tone: 'off', text: link === 'relay' ? 'Mac offline' : 'Reconnecting…' };
  if (!mia || !mia.enabled) return { tone: 'off', text: 'Off' };
  if (!mia.online) return { tone: 'warn', text: 'Offline' };
  if (thinking) return { tone: 'live', text: 'Thinking…' };
  const w = ex.filter((a) => agentStatus(a) === 'waiting').length;
  if (w) return { tone: 'warn', text: `${w} agent${w === 1 ? '' : 's'} need${w === 1 ? 's' : ''} you` };
  if (ex.length) return { tone: 'live', text: `${ex.length} agent${ex.length === 1 ? '' : 's'} working` };
  return { tone: 'live', text: 'Online' };
}

function More({ mia }) {
  const [open, setOpen] = useState(false);
  const [armed, fire] = useArm();
  const box = useRef(null);
  const old = useMC((s) => miaOldQuestions(s.mia, s.miaLocal).length);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  const Item = ({ icon, children, onClick, danger, ...rest }) => (
    <motion.button {...tap} onClick={onClick} className={`flex h-10 items-center gap-3 rounded-[9px] px-3 text-left text-[0.86rem] font-medium hover:bg-fill ${danger ? 'text-crit' : 'text-ink'}`} {...rest}>
      <Icon name={icon} size={15} className={danger ? '' : 'text-ink2'} />
      {children}
    </motion.button>
  );
  return (
    <div ref={box} className="relative">
      <motion.button {...tap} onClick={() => setOpen((v) => !v)} aria-label="More" className="grid h-9 w-9 place-items-center rounded-full text-ink hover:bg-fill" data-mia-more>
        <Icon name="more" size={17} />
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={spring.snappy}
            style={{ transformOrigin: 'top right' }}
            className="v-menu v5-menu v53-menu absolute right-0 top-11 z-40 flex w-[228px] flex-col p-1"

            data-no-lens
            data-mia-menu
          >
            <Item icon="hq" onClick={() => (place('hq'), setOpen(false))} data-more-item="hq">
              HQ
            </Item>
            <Item icon="gauge" onClick={() => (place('insights'), setOpen(false))} data-more-item="insights">
              Insights
            </Item>
            <Item icon="settings" onClick={() => (place('settings'), setOpen(false))} data-more-item="settings">
              Settings
            </Item>
            <Item icon="launch" onClick={() => (openSheet('launch'), setOpen(false))} data-more-item="launch">
              Launch an agent
            </Item>
            <div className="mx-3 my-1 h-px bg-hair" />
            {old > 0 && (
              <Item icon="close" onClick={() => (miaDismissOld(), setOpen(false))}>
                Dismiss {old} old question{old === 1 ? '' : 's'}
              </Item>
            )}

            {!mia?.enabled ? (
              <Item icon="play" onClick={() => (miaStart(), setOpen(false))}>
                Start Mia
              </Item>
            ) : (
              <Item icon="stop" danger onClick={() => fire(() => (miaStop(), setOpen(false)))}>
                {armed ? 'Tap again to stop Mia' : 'Stop Mia'}
              </Item>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RestartOffer({ mia }) {
  const [busy, setBusy] = useState(false);
  const running = mia?.runningModel || '';
  const stale = !!mia?.enabled && !!mia.model && !!running && mia.online && running !== mia.model;
  useEffect(() => {
    if (!stale) setBusy(false);
  }, [stale]);
  if (!stale) return null;
  return (
    <div className="v53-chip pointer-events-auto mx-auto mt-2 flex w-fit max-w-[92%] items-center gap-3 rounded-full py-1 pl-4 pr-1 text-[0.8rem]" data-mia-restart={busy ? 'restarting' : 'offer'}>
      <span className="min-w-0 flex-1 truncate text-ink2">
        {busy ? `Restarting Mia on ${miaModelLabel(mia.model) || mia.model}…` : `Mia is still on ${miaModelLabel(running) || running}.`}
      </span>
      {!busy && (
        <Button size="sm" tone="primary" icon="refresh" onClick={() => miaRestart() && setBusy(true)}>
          Restart
        </Button>
      )}
    </div>
  );
}

export default function Stage({ geo, L, R, bottom, back, onThinking }) {
  const mia = useMC((s) => s.mia);
  const snapshot = useMC((s) => s.snapshot);
  const local = useMC((s) => s.miaLocal);
  const thinking = useThinking(mia, local);
  const status = useStatus(mia, thinking);
  const foot = useRef(null);
  const box = useRef(null);
  useEffect(() => onThinking?.(thinking), [thinking, onThinking]);

  // the suggestions' height pads the thread (they come and go)
  useEffect(() => {
    const el = foot.current;
    const host = box.current;
    if (!el || !host || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => host.style.setProperty('--stage-foot', `${el.offsetHeight + 14}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // under a pane (iPhone, iPad portrait), the chat recedes a little
  const scale = useTransform(back, (b) => 1 - 0.035 * b);
  const dim = useTransform(back, (b) => `rgba(0, 0, 0, ${(b * 0.3).toFixed(3)})`);
  const ty = useTransform(back, (b) => b * 3);

  const dot = { live: 'bg-accent', warn: 'bg-warn', off: 'bg-ink3' }[status.tone];
  const orbState = !mia?.enabled || status.tone === 'off' ? 'off' : thinking || status.text.endsWith('working') ? 'thinking' : 'idle';

  return (
    <motion.section
      ref={box}
      className="v53-stage"
      style={{ left: L, right: R, top: geo.top, bottom, scale, y: ty, borderRadius: geo.radius }}
      data-lens
      data-depth="0.7"
      data-v53-stage
      aria-label="Chat with Mia"
    >
      <div className="v53-stage-inner" style={{ width: geo.stageW }}>
        {!snapshot && !mia ? (
          <div className="flex flex-1 items-center justify-center">
            <Empty icon="mia" title="Connecting to your Mac…" hint="Mia lives on your Mac — this fills in as soon as it answers." />
          </div>
        ) : !mia ? (
          <div className="flex flex-1 items-center justify-center">
            <Empty icon="mia" title="Mia is off" hint="Your Mac hasn't reported Mia yet. Start her here." action={<Button tone="primary" icon="play" onClick={() => miaStart()}>Start Mia</Button>} />
          </div>
        ) : (
          <Thread mia={mia} thinking={thinking} />
        )}

        <header className="v53-head" data-stage-head>
          <div className="pointer-events-auto flex min-w-0 shrink items-center gap-2.5 pl-1">
            <Orb size={26} state={orbState} onClick={() => startVoice()} label="Talk to Mia" data-head-orb />
            <div className="min-w-0">
              <div className="text-[0.95rem] font-semibold leading-tight tracking-[-0.012em] text-ink">Mia</div>
              <div className="flex items-center gap-1.5 text-[0.7rem] font-medium leading-tight text-ink3" data-presence={status.text}>
                <span className={`h-[5px] w-[5px] rounded-full ${dot}`} />
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span key={status.text} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} className="truncate">
                    {status.text}
                  </motion.span>
                </AnimatePresence>
              </div>
            </div>
          </div>
          <div className="min-w-1 flex-1" />
          <div className="v53-cluster pointer-events-auto flex h-10 flex-none items-center gap-0.5 rounded-full px-0.5">
            <Rings max={geo.stageW < 430 ? 1 : geo.stageW < 560 ? 2 : geo.stageW < 720 ? 3 : 4} />
            <More mia={mia} />
          </div>
        </header>
        <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--stage-head,64px)-8px)] z-10">{mia && <RestartOffer mia={mia} />}</div>

        {mia && (
          <div ref={foot} className="v53-foot" data-stage-foot>
            <div className="mx-auto w-full max-w-[720px]">
              <Chips mia={mia} />
            </div>
          </div>
        )}
      </div>
      <motion.div className="pointer-events-none absolute inset-0 z-30 rounded-[inherit]" style={{ backgroundColor: dim }} aria-hidden="true" />
    </motion.section>
  );
}
