import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useMC, miaStart, miaStop, miaSetModel, miaPushTest, miaOpenQuestions,
  MIA_MODELS, MIA_DEFAULT_MODEL,
} from '../../lib/store.js';
import { enablePush } from '../../lib/push.js';
import { modelLabel } from '../../lib/models.js';
import Icon from '../../ui/Icon.jsx';
import Button from '../../ui/Button.jsx';
import IconButton from '../../ui/IconButton.jsx';
import Select from '../../ui/Select.jsx';
import Segmented from '../../ui/Segmented.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import Thread from './Thread.jsx';
import Tasks from './Tasks.jsx';

// MIA — the assistant's window (docs/mia.md §9). Chromeless like Library: the
// header row is ours (presence, model, start/stop, notifications, close). Two
// regions: the conversation and the task board — side by side once the window
// is wide enough (iPad / desktop), and on a phone one at a time behind a
// segmented switch, because a pinned composer and a scrolling board can't
// share 400px of height and both stay usable.

const WIDE = 720; // px of window width before the regions sit side by side

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
  return (
    <span className={`pill glass-soft inline-flex flex-none items-center gap-1.5 px-2.5 py-1 text-[11.5px] ${s.text}`}>
      <span className={`h-1.5 w-1.5 flex-none rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function Notifications() {
  const push = useMC((s) => s.push);
  if (push === 'on')
    return (
      <>
        <span className="pill glass-soft inline-flex h-8 flex-none items-center gap-1.5 px-3 text-[12px] text-ink2">
          <Icon name="bellOn" size={13} />
          Notifications on
        </span>
        <Button size="sm" variant="ghost" onClick={() => miaPushTest()}>
          Test
        </Button>
      </>
    );
  if (push === 'working')
    return (
      <Button size="sm" loading>
        Notifications
      </Button>
    );
  if (push === 'denied' || push === 'install')
    return (
      <span
        className="pill glass-soft inline-flex h-8 flex-none items-center gap-1.5 px-3 text-[12px] text-ink3"
        title={push === 'install' ? 'iOS delivers notifications only to the Home Screen app — Share › Add to Home Screen' : 'Allow notifications for this app in Settings'}
      >
        <Icon name="bellOff" size={13} />
        {push === 'install' ? 'Add to Home Screen to get notifications' : 'Notifications blocked'}
      </span>
    );
  if (push === 'unsupported') return null;
  // idle | error — the tap handler must call enablePush directly (iOS only
  // shows the permission prompt inside a user gesture).
  return (
    <Button size="sm" icon="bell" onClick={() => enablePush()}>
      {push === 'error' ? 'Retry notifications' : 'Notify me'}
    </Button>
  );
}

function StartStop({ mia }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => setArmed(false), [mia?.enabled]);
  if (!mia || !mia.enabled)
    return (
      <Button size="sm" variant="primary" icon="play" onClick={() => miaStart()}>
        Start
      </Button>
    );
  // Stopping kills her session — one confirming tap, like clearing an agent.
  return (
    <Button
      size="sm"
      variant={armed ? 'danger' : 'secondary'}
      icon="stop"
      onClick={() => {
        if (armed) {
          clearTimeout(timer.current);
          setArmed(false);
          miaStop();
        } else {
          setArmed(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setArmed(false), 3000);
        }
      }}
    >
      {armed ? 'Tap to stop' : 'Stop'}
    </Button>
  );
}

function ModelPick({ mia }) {
  const models = useMC((s) => s.models);
  const value = mia?.model || MIA_DEFAULT_MODEL;
  const options = MIA_MODELS.some((m) => m.value === value)
    ? MIA_MODELS
    : [...MIA_MODELS, { value, label: modelLabel(value, models) }];
  return (
    <Select
      className="w-[118px] flex-none"
      aria-label="Mia's model"
      value={value}
      onChange={(v) => v !== value && miaSetModel(v)}
      options={options}
    />
  );
}

export default function Mia({ onOpenAgent, onClose }) {
  const mia = useMC((s) => s.mia);
  const snapshot = useMC((s) => s.snapshot);
  const link = useMC((s) => s.link);
  const local = useMC((s) => s.miaLocal);

  const root = useRef(null);
  const width = useWidth(root);
  const wide = width >= WIDE;

  const [tab, setTab] = useState('thread');
  const [highlight, setHighlight] = useState(null); // { id, n } — n re-fires the same id

  const openQ = miaOpenQuestions(mia, local).length;
  const liveTasks = (mia?.tasks || []).filter((t) => ['queued', 'asking', 'running', 'checking'].includes(t.status)).length;

  const showTask = (id) => {
    setHighlight((h) => ({ id, n: (h?.n || 0) + 1 }));
    if (!wide) setTab('tasks');
  };

  const controls = (
    <>
      {mia && <ModelPick mia={mia} />}
      <StartStop mia={mia} />
      <Notifications />
    </>
  );

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-none flex-col gap-2.5 px-4 pb-3 pt-4 sm:px-5">
        <div className="flex items-center gap-2">
          <h2 className="display flex items-center gap-2 text-[20px] font-semibold tracking-tight text-ink">
            <Icon name="mia" size={18} className="text-ink2" />
            Mia
          </h2>
          <Presence mia={mia} link={link} />
          <span className="flex-1" />
          {wide && <div className="flex flex-wrap items-center justify-end gap-2">{controls}</div>}
          {onClose && <IconButton icon="close" label="Close" size="sm" variant="glass" onClick={onClose} />}
        </div>
        {!wide && <div className="noscroll -mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:-mx-5 sm:px-5">{controls}</div>}
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
      ) : wide ? (
        <div className="flex min-h-0 flex-1 border-t border-glass-line">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-3">
            <Thread mia={mia} active onTask={showTask} />
          </div>
          <div className="flex min-h-0 w-[min(400px,42%)] flex-none flex-col border-l border-glass-line pt-3">
            <Tasks mia={mia} onOpenAgent={onOpenAgent} highlight={highlight} />
          </div>
        </div>
      ) : (
        <>
          <div className="flex-none px-4 pb-3 sm:px-5">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'thread', label: 'Thread', icon: 'chat', count: openQ || null },
                { value: 'tasks', label: 'Tasks', icon: 'tasks', count: liveTasks || null },
              ]}
            />
          </div>
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
