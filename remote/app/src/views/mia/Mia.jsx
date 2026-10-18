import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useMC, miaStart, miaOpenQuestions } from '../../lib/store.js';
import { RestartOffer, StartStop } from './Controls.jsx';
import { useMedia, usePane } from '../../lib/hooks.js';
import { spring } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';
import Button from '../../ui/Button.jsx';
import IconButton from '../../ui/IconButton.jsx';
import Segmented from '../../ui/Segmented.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import Thread from './Thread.jsx';
import Tasks from './Tasks.jsx';
import { talkSupported } from '../../lib/voice.js';
import { useTalk, startTalk } from '../../lib/talkSession.js';
import { TalkSlot } from '../../shell/TalkHost.jsx';
import { WakeToggle } from './Wake.jsx';

// MIA — the assistant's window (docs/mia.md §9). Chromeless like Library: the
// header row is ours (presence, model, start/stop, notifications, close). Two
// regions: the conversation and the task board — side by side once the window
// is wide enough (iPad / desktop), and on a phone one at a time behind a
// segmented switch, because a pinned composer and a scrolling board can't
// share 400px of height and both stay usable.

const WIDE = 720; // px of window width before the regions sit side by side
const TASKS_W = 400;
const TASKS_RAIL = 52;

function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function Presence({ mia, link }) {
  const s =
    link !== 'linked'
      ? { dot: 'bg-ink3', text: 'text-ink3', label: link === 'relay' ? 'Mac offline' : 'Reconnecting…' }
      : !mia || !mia.enabled
        ? { dot: 'bg-ink3', text: 'text-ink3', label: 'Off' }
        : mia.online
          ? { dot: 'bg-accent', text: 'text-ink2', label: 'Online' }
          : { dot: 'bg-warn', text: 'text-warn', label: 'Offline' };
  // Online is the normal state: just the dot. Anything else says what's wrong.
  const fine = s.label === 'Online';
  return (
    <span className={`inline-flex flex-none items-center gap-1.5 text-[11.5px] ${s.text}`} title={s.label} aria-label={`Mia ${s.label}`} data-presence={s.label}>
      <span className={`h-2 w-2 flex-none rounded-full ${s.dot}`} />
      {!fine && s.label}
    </span>
  );
}

// The ⋯ menu: the rarely-used switches, out of the chat's way (task 0290).
// Notifications and the model live in Settings › Mia.
function MoreMenu({ mia }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  return (
    <div ref={box} className="relative flex-none">
      <IconButton icon="more" label="More" size="sm" variant="glass" onClick={() => setOpen((v) => !v)} data-mia-more />
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={spring.snappy}
          className="glass-strong absolute right-0 top-10 z-30 flex w-[220px] flex-col items-stretch gap-2 rounded-xl2 p-2.5"
          data-mia-menu
        >
          {talkSupported && <WakeToggle />}
          <StartStop mia={mia} />
          <Button
            size="sm"
            variant="ghost"
            icon="settings"
            onClick={() => {
              setOpen(false);
              location.hash = 'settings';
            }}
          >
            Model &amp; notifications
          </Button>
        </motion.div>
      )}
    </div>
  );
}

export default function Mia({ onOpenAgent, onClose, focusTask }) {
  const mia = useMC((s) => s.mia);
  const snapshot = useMC((s) => s.snapshot);
  const link = useMC((s) => s.link);
  const local = useMC((s) => s.miaLocal);

  const root = useRef(null);
  const width = useWidth(root);
  const wide = width >= WIDE;

  const [tab, setTab] = useState('thread');
  // The session itself lives at the app root (shell/TalkHost.jsx) so it keeps
  // running when Daniel leaves this view; here it only borrows a slot.
  const talkOn = useTalk((s) => s.on);
  // Set aside: the session runs on in the top-bar pill while the thread and
  // board show here (e.g. Mia opened a task mid-conversation).
  const [talkAside, setTalkAside] = useState(false);
  const expandN = useTalk((s) => s.expandN);
  useEffect(() => {
    setTalkAside(false);
  }, [talkOn, expandN]);
  const talking = talkOn && !talkAside;
  const [highlight, setHighlight] = useState(null); // { id, n } — n re-fires the same id

  const openQ = miaOpenQuestions(mia, local).length;
  const liveTasks = (mia?.tasks || []).filter((t) => ['queued', 'asking', 'running', 'checking'].includes(t.status)).length;

  // Side by side, the task board folds to a rail at the window's edge. An
  // iPad in portrait gives the thread the room by default.
  const portrait = useMedia('(max-width: 1023px)');
  const [tasksFolded, toggleTasks] = usePane('mia.tasks', portrait);

  const showTask = (id) => {
    setHighlight((h) => ({ id, n: (h?.n || 0) + 1 }));
    if (!wide) setTab('tasks');
    else if (tasksFolded) toggleTasks();
  };

  // `mia panel open-task <id>`: App bumps focusTask.n; show that task.
  useEffect(() => {
    if (!focusTask?.id) return;
    setTalkAside(true);
    showTask(focusTask.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTask?.n]);

  // Talk: the tap itself unlocks speech and asks for the mic (iOS only allows
  // both inside a gesture); the Talk view picks the session up when it mounts.
  const talkButton =
    talkSupported && mia && !talking ? (
      wide ? (
        <Button size="sm" variant="primary" icon="mic" onClick={() => (talkOn ? setTalkAside(false) : startTalk())}>
          {talkOn ? 'Back to talk' : 'Talk'}
        </Button>
      ) : (
        <IconButton icon="mic" label={talkOn ? 'Back to talk' : 'Talk'} size="sm" variant="glass" onClick={() => (talkOn ? setTalkAside(false) : startTalk())} />
      )
    ) : null;

  // One slim row (task 0290): name + presence, the phone's Chat | Tasks
  // switch, Talk, the tasks fold, ⋯, close. Everything else is in Settings.
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" data-mia-view>
      <header className="flex flex-none flex-col gap-2 px-3 pb-2 pt-2.5 sm:px-4">
        <div className="flex items-center gap-2">
          <h2 className="flex flex-none items-center gap-1.5 pl-1 text-[16px] font-semibold tracking-tight text-ink">
            <Icon name="mia" size={16} className="text-ink2" />
            Mia
          </h2>
          <Presence mia={mia} link={link} />
          {!wide && mia && snapshot && !talking && (
            <Segmented
              className="ml-1 min-w-0"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'thread', label: 'Chat', count: openQ || null },
                { value: 'tasks', label: 'Tasks', count: liveTasks || null },
              ]}
            />
          )}
          <span className="flex-1" />
          {talkButton}
          {wide && mia && !talking && (
            <IconButton
              icon={tasksFolded ? 'paneRightOpen' : 'paneRightClose'}
              label={tasksFolded ? 'Show tasks' : 'Hide tasks'}
              size="sm"
              variant="glass"
              onClick={toggleTasks}
            />
          )}
          {mia && !talking && <MoreMenu mia={mia} />}
          {onClose && <IconButton icon="close" label="Close" size="sm" variant="glass" onClick={onClose} />}
        </div>
        {mia && <RestartOffer mia={mia} />}
      </header>

      {!snapshot ? (
        <EmptyState icon="mia" title="Connecting to your Mac…" hint="Mia lives on your Mac — this fills in as soon as it answers." />
      ) : !mia ? (
        <EmptyState
          icon="mia"
          title="Mia is off"
          hint="Your Mac hasn't reported Mia yet. Start her here — if nothing happens, update Mission Control on the Mac to a build that includes Mia."
          action={
            <Button variant="primary" icon="play" onClick={() => miaStart()}>
              Start Mia
            </Button>
          }
        />
      ) : talking ? (
        <TalkSlot />
      ) : wide ? (
        <div className="flex min-h-0 flex-1 border-t border-glass-line">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-2">
            <Thread mia={mia} active onTask={showTask} />
          </div>
          {/* Folds like the desktop columns: the board keeps its width and is
              clipped (so drafts and scroll survive), a rail fades in over it. */}
          <motion.div
            initial={false}
            animate={{ width: tasksFolded ? TASKS_RAIL : Math.min(TASKS_W, Math.round(width * 0.42)) }}
            transition={spring.smooth}
            data-pane="mia.tasks"
            data-collapsed={tasksFolded ? 'true' : 'false'}
            className="relative flex min-h-0 flex-none flex-col overflow-hidden border-l border-glass-line"
          >
            <motion.div
              animate={{ opacity: tasksFolded ? 0 : 1 }}
              transition={{ duration: 0.18 }}
              inert={tasksFolded ? true : undefined}
              className={`flex min-h-0 flex-1 flex-col pt-3 ${tasksFolded ? 'pointer-events-none' : ''}`}
              style={{ width: Math.min(TASKS_W, Math.round(width * 0.42)) }}
            >
              <Tasks mia={mia} onOpenAgent={onOpenAgent} highlight={highlight} />
            </motion.div>
            {tasksFolded && (
              <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18, delay: 0.08 }}
                onClick={toggleTasks}
                aria-label="Show tasks"
                className="absolute inset-0 flex flex-col items-center gap-3 pt-3 text-ink2 transition-colors hover:bg-white/[0.04]"
              >
                <span className="glass-soft pill grid h-8 w-8 place-items-center text-ink">
                  <Icon name="paneRightOpen" size={15} />
                </span>
                <span className="relative">
                  <Icon name="tasks" size={17} />
                  {liveTasks > 0 && (
                    <span className="tnum absolute -right-2.5 -top-2 min-w-4 rounded-full bg-white/[0.14] px-1 text-center text-[10px] font-semibold leading-4 text-ink">
                      {liveTasks}
                    </span>
                  )}
                </span>
                <span className="text-[12px] font-medium tracking-wide [writing-mode:vertical-rl]">Tasks</span>
              </motion.button>
            )}
          </motion.div>
        </div>
      ) : (
        <>
          {/* Both stay mounted so scroll position and drafts survive the switch. */}
          <div className={`min-h-0 flex-1 flex-col ${tab === 'thread' ? 'flex' : 'hidden'}`}>
            <Thread mia={mia} active={tab === 'thread'} onTask={showTask} />
          </div>
          <div className={`min-h-0 flex-1 flex-col ${tab === 'tasks' ? 'flex' : 'hidden'}`}>
            <Tasks mia={mia} onOpenAgent={onOpenAgent} highlight={highlight} />
          </div>
        </>
      )}
    </div>
  );
}
