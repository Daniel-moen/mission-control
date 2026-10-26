import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, miaStart, miaStop, miaRestart, miaOpenQuestions, miaModelLabel } from '../../src/lib/store.js';
import { useNav, setMiaSeg, push } from '../lib/nav.js';
import { spring, tap } from '../lib/motion.js';
import { useSize } from '../ui/hooks.js';
import { Button, Empty, Icon, IconBtn, Segmented, useArm } from '../ui/kit.jsx';
import Page from '../shell/Page.jsx';
import { usePage } from '../shell/Stack.jsx';
import { startVoice } from '../shell/TalkHost.jsx';
import Thread from './mia/Thread.jsx';
import Tasks from './mia/Tasks.jsx';

// Mia: the conversation and her task board. Side by side when the page is
// wide enough to give both real room (iPad landscape, Stage Manager large);
// otherwise one at a time behind a Chat | Tasks switch, each keeping its
// scroll and drafts.

const SPLIT = 980;

function Presence({ mia, link }) {
  const s =
    link !== 'linked'
      ? { tone: 'done', label: link === 'relay' ? 'Mac offline' : 'Reconnecting…' }
      : !mia || !mia.enabled
        ? { tone: 'done', label: 'Off' }
        : mia.online
          ? { tone: 'working', label: 'Online' }
          : { tone: 'waiting', label: 'Offline' };
  const dot = { working: 'bg-accent', waiting: 'bg-warn', done: 'bg-ink3' }[s.tone];
  return (
    <span className="flex items-center gap-1.5 text-[0.78rem] font-semibold text-ink3" data-presence={s.label}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {s.label}
    </span>
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
    <div className="mx-4 mb-2 flex flex-wrap items-center gap-3 rounded-[18px] bg-fill px-4 py-3 sm:mx-6" data-mia-restart={busy ? 'restarting' : 'offer'}>
      <span className="min-w-0 flex-1 text-[0.84rem] text-ink2">
        {busy ? `Restarting Mia on ${miaModelLabel(mia.model) || mia.model}…` : `Mia is still on ${miaModelLabel(running) || running}. ${miaModelLabel(mia.model) || mia.model} applies from her next start.`}
      </span>
      {!busy && (
        <Button size="sm" tone="primary" icon="refresh" onClick={() => miaRestart() && setBusy(true)}>
          Restart now
        </Button>
      )}
    </div>
  );
}

function More({ mia }) {
  const [open, setOpen] = useState(false);
  const [armed, fire] = useArm();
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  return (
    <div ref={box} className="relative">
      <IconBtn icon="more" label="More" tone="ghost" onClick={() => setOpen((v) => !v)} data-mia-more />
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={spring.snappy}
            style={{ transformOrigin: 'top right' }}
            className="v-card absolute right-0 top-12 z-40 flex w-[230px] flex-col p-1.5"
            data-mia-menu
          >
            {!mia?.enabled ? (
              <MenuItem icon="play" onClick={() => (miaStart(), setOpen(false))}>
                Start Mia
              </MenuItem>
            ) : (
              <MenuItem icon="stop" danger onClick={() => fire(() => (miaStop(), setOpen(false)))}>
                {armed ? 'Tap again to stop Mia' : 'Stop Mia'}
              </MenuItem>
            )}
            <MenuItem icon="settings" onClick={() => (push('settings'), setOpen(false))}>
              Model &amp; notifications
            </MenuItem>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
const MenuItem = ({ icon, children, onClick, danger }) => (
  <motion.button {...tap} onClick={onClick} className={`flex h-11 items-center gap-3 rounded-[12px] px-3 text-left text-[0.9rem] font-medium hover:bg-fill ${danger ? 'text-crit' : 'text-ink'}`}>
    <Icon name={icon} size={16} />
    {children}
  </motion.button>
);

export default function Mia() {
  const mia = useMC((s) => s.mia);
  const snapshot = useMC((s) => s.snapshot);
  const link = useMC((s) => s.link);
  const local = useMC((s) => s.miaLocal);
  const seg = useNav((s) => s.miaSeg);
  const focus = useNav((s) => s.focusTask);
  const { active } = usePage();
  const box = useRef(null);
  const { w } = useSize(box);
  const split = w >= SPLIT;
  const openQ = miaOpenQuestions(mia, local).length;
  const liveTasks = (mia?.tasks || []).filter((t) => ['queued', 'asking', 'running', 'checking'].includes(t.status)).length;
  const onTask = (id) => useNav.setState((s) => ({ focusTask: { id, n: (s.focusTask?.n || 0) + 1 }, miaSeg: 'tasks' }));

  const actions = (
    <>
      <motion.button {...tap} onClick={() => startVoice()} className="flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[0.86rem] font-semibold text-page" data-mia-talk>
        <Icon name="mic" size={16} strokeWidth={2.2} />
        <span className="hidden sm:inline">Talk</span>
      </motion.button>
      <More mia={mia} />
    </>
  );

  const body = !snapshot && !mia ? (
    <Empty icon="mia" title="Connecting to your Mac…" hint="Mia lives on your Mac — this fills in as soon as it answers." />
  ) : !mia ? (
    <Empty icon="mia" title="Mia is off" hint="Your Mac hasn't reported Mia yet. Start her here." action={<Button tone="primary" icon="play" onClick={() => miaStart()}>Start Mia</Button>} />
  ) : split ? (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Thread mia={mia} active={active} onTask={onTask} />
      </div>
      <div className="v-scroll min-h-0 w-[400px] flex-none border-l border-hair px-5 pt-1" style={{ paddingBottom: 'var(--tabbar-space)' }} data-pane="tasks">
        <div className="mb-3 flex items-baseline gap-2 pt-1">
          <h2 className="text-[1.15rem] font-bold tracking-[-0.02em] text-ink">Tasks</h2>
          {liveTasks > 0 && <span className="v-num text-[0.92rem] font-semibold text-accent">{liveTasks} live</span>}
        </div>
        <Tasks mia={mia} focus={focus} />
      </div>
    </div>
  ) : (
    <>
      <div className={`min-h-0 flex-1 flex-col ${seg === 'chat' ? 'flex' : 'hidden'}`}>
        <Thread mia={mia} active={active && seg === 'chat'} onTask={onTask} />
      </div>
      <div className={`v-scroll min-h-0 flex-1 px-4 sm:px-6 ${seg === 'tasks' ? 'block' : 'hidden'}`} style={{ paddingBottom: 'var(--tabbar-space)' }} data-pane="tasks">
        <div className="mx-auto max-w-[760px] pt-1">
          <Tasks mia={mia} focus={focus} />
        </div>
      </div>
    </>
  );

  return (
    <Page
      scroll={false}
      leading={
        <div className="flex min-w-0 items-center gap-2.5 pl-1">
          <span className="text-[1.3rem] font-bold tracking-[-0.03em] text-ink">Mia</span>
          <Presence mia={mia} link={link} />
        </div>
      }
      actions={actions}
    >
      <div ref={box} className="flex min-h-0 flex-1 flex-col" data-mia-view>
        {mia && !split && (
          <div className="flex flex-none justify-center px-4 pb-2">
            <Segmented
              value={seg}
              onChange={setMiaSeg}
              options={[
                { value: 'chat', label: 'Chat', count: openQ || null },
                { value: 'tasks', label: 'Tasks', count: liveTasks || null },
              ]}
            />
          </div>
        )}
        {mia && <RestartOffer mia={mia} />}
        {body}
      </div>
    </Page>
  );
}
