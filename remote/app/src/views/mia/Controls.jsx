import { useEffect, useRef, useState } from 'react';
import { useMC, miaStart, miaStop, miaRestart, miaSetModel, miaPushTest, MIA_MODELS, miaModelLabel } from '../../lib/store.js';
import { enablePush } from '../../lib/push.js';
import { modelLabel } from '../../lib/models.js';
import Icon from '../../ui/Icon.jsx';
import Button from '../../ui/Button.jsx';

// Mia's switches — notifications, start/stop, her model. They used to crowd
// the chat header; since task 0290 they live in Settings › Mia (and Stop in the
// chat's ⋯ menu), so the chat is just the chat.

export function Notifications() {
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

export function StartStop({ mia }) {
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

// The model picker in the header's top-right corner. It shows the model the
// Mac has saved for her (the snapshot's `model` — never a panel default) and a
// pick goes to the host as miaSetModel, which applies from her next start. A
// native <select> sits invisibly over the pill, so iPad gets the system picker.
export function ModelPick({ mia }) {
  const models = useMC((s) => s.models);
  const value = mia?.model || '';
  const label = miaModelLabel(value) || (value ? modelLabel(value, models) : 'Model');
  const options = !value || MIA_MODELS.some((m) => m.value === value)
    ? MIA_MODELS
    : [...MIA_MODELS, { value, label }];
  return (
    <label
      className="pill glass-soft glass-soft-hover relative inline-flex h-8 flex-none cursor-pointer items-center gap-1 pl-3 pr-2 text-[12.5px] text-ink transition-colors"
      title="Mia's model — a change applies from her next start"
      data-mia-model={value}
    >
      <span className="whitespace-nowrap">{label}</span>
      <Icon name="chevronDown" size={13} className="text-ink3" />
      <select
        aria-label="Mia's model"
        value={value}
        onChange={(e) => e.target.value && e.target.value !== value && miaSetModel(e.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {!value && (
          <option value="" disabled>
            Model
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// After a switch she keeps running on the old model until she restarts: say
// so, and offer the restart. Driven by the host's runningModel vs model; a Mac
// app that doesn't report runningModel falls back to "switched from this panel
// while she was online".
export function RestartOffer({ mia }) {
  const [switched, setSwitched] = useState(null); // model picked here while she ran (old hosts)
  const [restarting, setRestarting] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const prev = useRef(mia?.model);
  useEffect(() => {
    if (prev.current && mia?.model && prev.current !== mia.model && mia.online) setSwitched(mia.model);
    prev.current = mia?.model;
  }, [mia?.model, mia?.online]);
  const sid = useRef(mia?.sessionId);
  useEffect(() => {
    // A new session (or her going down) ends the offer for old hosts.
    if (mia?.sessionId !== sid.current || !mia?.online) setSwitched(null);
    sid.current = mia?.sessionId;
  }, [mia?.sessionId, mia?.online]);

  const running = mia?.runningModel || '';
  const stale =
    !!mia?.enabled && !!mia.model &&
    (running ? mia.online && running !== mia.model : !!switched && switched === mia.model);
  // "Restarting…" holds while she's down and ends once she's back on it.
  const back = !!mia?.online && (running ? running === mia.model : !switched);
  useEffect(() => {
    if (back) {
      clearTimeout(timer.current);
      setRestarting(false);
    }
  }, [back, mia?.sessionId]);
  if (!stale && !restarting) return null;
  const now = miaModelLabel(mia.model) || mia.model;
  const was = running ? miaModelLabel(running) || running : '';
  return (
    <div
      data-mia-restart={restarting ? 'restarting' : 'offer'}
      className="glass-soft flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl2 px-3.5 py-2.5 text-[12.5px] text-ink2"
    >
      <span className="min-w-0 flex-1">
        {restarting
          ? `Restarting Mia on ${now}…`
          : was
            ? `Mia is still running on ${was}. ${now} applies from her next start.`
            : `${now} applies from Mia's next start.`}
      </span>
      {!restarting && (
        <Button
          size="sm"
          variant="primary"
          icon="refresh"
          onClick={() => {
            if (!miaRestart()) return;
            setRestarting(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setRestarting(false), 120000);
          }}
        >
          Restart Mia now
        </Button>
      )}
    </div>
  );
}
