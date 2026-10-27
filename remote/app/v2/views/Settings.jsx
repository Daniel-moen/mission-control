import { useEffect, useState } from 'react';
import {
  useMC, changeToken, forgetToken, dataAge, stopAll, PANEL_BUILD, miaSetQuestionAge, miaStart, miaStop, miaRestart, miaSetModel, miaPushTest, MIA_MODELS, miaModelLabel,
} from '../../src/lib/store.js';
import { enablePush } from '../../src/lib/push.js';
import { modelLabel } from '../../src/lib/models.js';
import { useWake, enableWake, disableWake, resumeWake, wakeSupported } from '../../src/lib/wake.js';
import { useLocalStorage } from '../../src/lib/hooks.js';
import { ANNOUNCE_MODE_KEY, QUIET_KEY, QUIET_DEFAULT } from '../../src/lib/announce.js';
import { usePrefs, setTheme, setMotionPref, setGlass, switchUi } from '../lib/prefs.js';
import { useBackdrop, setBackdrop } from '../lens/backdrop.js';
import { Button, Group, Row, Segmented, Select, Spinner, Toggle, useArm } from '../ui/kit.jsx';
import Page from '../shell/Page.jsx';

// Settings, iOS-style: grouped, quiet, everything local to this device unless
// it says otherwise (Mia's model and question age live on the Mac).

const WAKE_HINT = 'Say “Hey Mia” to start talking, “Okay Mia, I’m done” to finish. Runs on this device; on iPad and iPhone only while the app is open (the screen stays awake).';
const QUESTION_AGES = [
  { value: 24, label: '24 h' },
  { value: 48, label: '48 h' },
  { value: 168, label: '7 d' },
  { value: 0, label: 'Never' },
];

// The photograph every page floats on. Shared with v1 (mc.backdrop).
function Backdrop() {
  const pick = useBackdrop((s) => s.pick);
  const list = useBackdrop((s) => s.list);
  const [url, setUrl] = useState(pick.url || '');
  const dim = typeof pick.dim === 'number' ? pick.dim : 0.2;
  const auto = !pick.file && !pick.url;
  const Thumb = ({ on, onClick, children, label, ...rest }) => (
    <button onClick={onClick} aria-label={label} aria-pressed={on} className={`relative aspect-[4/3] overflow-hidden rounded-[14px] ${on ? 'ring-2 ring-ink ring-offset-2 ring-offset-transparent' : 'opacity-80 hover:opacity-100'}`} {...rest}>
      {children}
    </button>
  );
  return (
    <Group title="Backdrop" footer="Auto follows the time of day — dawn, day, dusk, night. Your pick holds on every page, and in the classic interface too.">
      <div className="grid grid-cols-3 gap-2.5 p-3 sm:grid-cols-6" data-backdrops>
        <Thumb on={auto} onClick={() => setBackdrop({ file: null, url: null })} label="Auto (time of day)" data-backdrop="auto">
          <span className="absolute inset-0 grid place-items-center bg-gradient-to-br from-[#e9a35f] via-[#5b4a7a] to-[#0d1424] text-[0.78rem] font-bold text-white">Auto</span>
        </Thumb>
        {list.map((e) => (
          <Thumb key={e.file} on={pick.file === e.file && !pick.url} onClick={() => setBackdrop({ file: e.file, url: null })} label={`${e.tone} — ${e.credit}`} data-backdrop={e.file}>
            <img src={`/bg/${e.file}`} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
            <span className="absolute bottom-1 left-1.5 text-[0.62rem] font-semibold capitalize text-white/85 [text-shadow:0_1px_3px_rgba(0,0,0,.8)]">{e.tone}</span>
          </Thumb>
        ))}
      </div>
      <Row icon="link" label="Image URL" hint="Any picture on the web.">
        <form className="flex items-center gap-2" onSubmit={(e) => (e.preventDefault(), setBackdrop({ url: url.trim() || null }))}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="v-field h-9 w-[180px] px-3 text-[0.86rem] sm:w-[260px]" aria-label="Backdrop image URL" />
          <Button size="sm" tone="ghost" type="submit">Use</Button>
        </form>
      </Row>
      <Row icon="watch" label="Dim" hint="Darker photo, calmer glass." last>
        <input type="range" min="0" max="0.6" step="0.05" value={dim} onChange={(e) => setBackdrop({ dim: +e.target.value })} aria-label="Dim the photo" className="w-[150px] accent-[var(--color-ink)]" data-backdrop-dim />
      </Row>
    </Group>
  );
}

function Appearance() {
  const theme = usePrefs((s) => s.theme);
  const motion = usePrefs((s) => s.motion);
  const glass = usePrefs((s) => s.glass);
  // v5 (task 0483) runs this page too, and says so
  const ui = document.documentElement.dataset.ui === 'v5' ? 'v5' : 'v2';
  return (
    <Group title="Appearance" footer="The classic interface is the panel as it was; this device remembers the choice. Every device chooses for itself.">
      <Row icon="eye" label="Theme">
        <Segmented size="sm" value={theme} onChange={setTheme} options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </Row>
      <Row icon="sparkles" label="Motion" hint={motion === 'reduce' ? 'Fades only — nothing slides or zooms.' : 'Follows the system’s Reduce Motion.'}>
        <Segmented size="sm" value={motion} onChange={setMotionPref} options={[{ value: 'system', label: 'Full' }, { value: 'reduce', label: 'Reduced' }]} />
      </Row>
      <Row icon="sparkles" label="Glass" hint={glass === 'lite' ? 'Lite: frosted, no live refraction — easiest on the battery.' : glass === 'full' ? 'Full: live refracting glass, always.' : 'Auto: full glass; lite on Reduce Motion or low power.'}>
        <Segmented size="sm" value={glass} onChange={setGlass} options={[{ value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full' }, { value: 'lite', label: 'Lite' }]} data-glass-pref />
      </Row>
      <Row icon="undo" label="Interface" hint={ui === 'v5' ? 'v5: the classic layout in Lens glass — switch any time.' : 'New (Lens) — switch back any time.'} last>
        <Segmented
          size="sm"
          value={ui}
          onChange={(v) => v !== ui && switchUi(v)}
          options={ui === 'v5' ? [{ value: 'v5', label: 'v5' }, { value: 'v2', label: 'v2' }, { value: 'v1', label: 'Classic' }] : [{ value: 'v2', label: 'New' }, { value: 'v1', label: 'Classic' }]}
          data-ui-switch
        />
      </Row>
    </Group>
  );
}

function Notifications() {
  const push = useMC((s) => s.push);
  if (push === 'on')
    return (
      <>
        <span className="text-[0.82rem] font-semibold text-accent">On</span>
        <Button size="sm" onClick={() => miaPushTest()}>
          Test
        </Button>
      </>
    );
  if (push === 'working') return <Spinner size={16} className="text-ink3" />;
  if (push === 'denied') return <span className="text-[0.8rem] text-ink3">Blocked in Settings</span>;
  if (push === 'install') return <span className="max-w-[160px] text-right text-[0.76rem] leading-snug text-ink3">Add to Home Screen first</span>;
  if (push === 'unsupported') return <span className="text-[0.8rem] text-ink3">Not on this device</span>;
  return (
    <Button size="sm" tone="primary" icon="bell" onClick={() => enablePush()}>
      {push === 'error' ? 'Retry' : 'Turn on'}
    </Button>
  );
}

function MiaGroup() {
  const mia = useMC((s) => s.mia);
  const models = useMC((s) => s.models);
  const [armed, fire] = useArm();
  if (!mia) return null;
  const value = mia.model || '';
  const options = !value || MIA_MODELS.some((m) => m.value === value) ? MIA_MODELS : [...MIA_MODELS, { value, label: modelLabel(value, models) }];
  const running = mia.runningModel || '';
  const stale = mia.enabled && mia.online && running && value && running !== value;
  return (
    <Group title="Mia" footer={stale ? `She’s still running on ${miaModelLabel(running) || running}; the new model applies from her next start.` : 'Her model applies from her next start.'}>
      <div data-settings-mia>
        <Row icon="mia" label="Model">
          <Select label="Mia’s model" value={value} onChange={(v) => v && v !== value && miaSetModel(v)} options={value ? options : [{ value: '', label: 'Model', disabled: true }, ...options]} className="w-[150px]" data-mia-model={value} />
        </Row>
        {stale && (
          <Row icon="refresh" label="Restart on the new model">
            <Button size="sm" tone="primary" onClick={() => miaRestart()}>
              Restart
            </Button>
          </Row>
        )}
        <Row icon="bell" label="Notifications" hint="Mia’s updates and questions on this device.">
          <Notifications />
        </Row>
        <Row icon={mia.enabled ? 'stop' : 'play'} label={mia.enabled ? 'Running' : 'Mia is off'} hint={mia.enabled ? 'Stopping ends her session; tasks and messages wait.' : 'Start her to pick up waiting tasks.'} last>
          {mia.enabled ? (
            <Button size="sm" tone={armed ? 'dangerSolid' : 'danger'} onClick={() => fire(() => miaStop())}>
              {armed ? 'Tap to stop' : 'Stop'}
            </Button>
          ) : (
            <Button size="sm" tone="primary" icon="play" onClick={() => miaStart()}>
              Start
            </Button>
          )}
        </Row>
      </div>
    </Group>
  );
}

function VoiceGroup() {
  const token = useMC((s) => s.token);
  const w = useWake();
  const [tts, setTts] = useState(undefined);
  useEffect(() => {
    let dead = false;
    fetch('/tts', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => !dead && setTts(d.ok ? d : null))
      .catch(() => !dead && setTts(null));
    return () => {
      dead = true;
    };
  }, [token]);
  const voice = tts?.voice || 'Kokoro (Heart)';
  return (
    <Group title="Voice" footer="Talk mode is free and local: whisper on the relay hears you; Mia answers in her own voice, made on the Mac. OpenAI Realtime is off.">
      <Row icon="mic" label="Talk mode">
        <span className="text-[0.86rem] font-semibold text-ink2" data-talk-engine="basic">
          Basic
        </span>
      </Row>
      {wakeSupported && (
        <Row icon="ear" label="“Hey Mia”" hint={w.error || WAKE_HINT}>
          {w.status === 'loading' ? (
            <Spinner size={16} className="text-ink3" />
          ) : w.on && w.status === 'interrupted' ? (
            <Button size="sm" tone="warn" onClick={() => resumeWake()}>
              Resume
            </Button>
          ) : (
            <Toggle on={w.on} label="Hey Mia" onChange={(on) => (on ? enableWake() : disableWake())} />
          )}
        </Row>
      )}
      <Row
        icon="louder"
        label="Mia’s voice"
        hint={tts === undefined ? 'Checking the relay…' : tts?.available ? `${voice}, made on the Mac.` : 'The Mac can’t make speech right now — the device voice is used.'}
        last
      >
        <span className="v-num text-[0.8rem] text-ink3" data-tts-usage>
          {tts?.today ? `${tts.today.requests} said · ${tts.today.chars.toLocaleString()} chars` : ''}
        </span>
      </Row>
    </Group>
  );
}

function AnnounceGroup() {
  const [mode, setMode] = useLocalStorage(ANNOUNCE_MODE_KEY, 'important');
  const [quiet, setQuiet] = useLocalStorage(QUIET_KEY, QUIET_DEFAULT);
  const q = { ...QUIET_DEFAULT, ...(quiet || {}) };
  const time = 'v-field h-9 rounded-full px-3 font-mono text-[0.8rem]';
  return (
    <Group title="Spoken updates" footer="With the app open and talk mode off: a chime, then her voice. Never in the background.">
      <Row icon="louder" label="Speak Mia’s updates" hint={mode === 'off' ? 'Silent.' : mode === 'all' ? 'Everything she writes to you.' : 'Questions, alerts, and what she marks to be spoken.'}>
        <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'off', label: 'Off' }, { value: 'important', label: 'Important' }, { value: 'all', label: 'All' }]} />
      </Row>
      <Row icon="clock" label="Quiet hours" hint={q.on ? `Silent ${q.from}–${q.to}.` : 'Off — she may speak at any hour.'} last>
        <Toggle on={q.on} label="Quiet hours" onChange={(on) => setQuiet({ ...q, on })} />
      </Row>
      {q.on && (
        <div className="flex items-center gap-2 px-4 pb-3.5 pl-[60px]">
          <input type="time" aria-label="Quiet from" value={q.from} onChange={(e) => e.target.value && setQuiet({ ...q, from: e.target.value })} className={time} />
          <span className="text-[0.8rem] text-ink3">to</span>
          <input type="time" aria-label="Quiet until" value={q.to} onChange={(e) => e.target.value && setQuiet({ ...q, to: e.target.value })} className={time} />
        </div>
      )}
    </Group>
  );
}

function QuestionsGroup() {
  const saved = useMC((s) => s.mia?.questionMaxAgeHours ?? null);
  const [picked, setPicked] = useState(null);
  useEffect(() => setPicked(null), [saved]);
  if (saved == null) return null;
  const value = picked ?? saved;
  const options = QUESTION_AGES.some((o) => o.value === saved) ? QUESTION_AGES : [...QUESTION_AGES, { value: saved, label: `${saved} h` }];
  return (
    <Group title="Mia’s questions" footer="Old questions leave badges and Home and aren’t read aloud. Nothing is deleted.">
      <Row icon="chat" label="Hide unanswered after" last>
        <Segmented size="sm" value={value} onChange={(v) => v !== value && miaSetQuestionAge(v) && setPicked(v)} options={options} />
      </Row>
    </Group>
  );
}

export default function Settings() {
  const token = useMC((s) => s.token);
  const link = useMC((s) => s.link);
  useMC((s) => s.now);
  const age = dataAge();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const snippet = [
      `export MISSION_CONTROL_URL="${location.origin}"`,
      `export MISSION_CONTROL_TOKEN="${token}"`,
      'curl -sf -H "Authorization: Bearer $MISSION_CONTROL_TOKEN" "$MISSION_CONTROL_URL/api/v1/status"',
    ].join('\n');
    navigator.clipboard?.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const info = [
    ['Relay', location.host],
    ['Mac', link === 'linked' ? 'Linked' : link === 'relay' ? 'Relay only' : 'Offline'],
    ['Last snapshot', age === null ? 'never' : age <= 2 ? 'just now' : `${age}s ago`],
    ['Access token', token ? `${token.slice(0, 4)}••••••••` : '—'],
    ['Build', `v2 · ${PANEL_BUILD.split('·').pop().trim()}`],
  ];
  return (
    <Page title="Settings" maxW={720}>
      <div className="flex flex-col gap-7 pb-8" data-settings>
        <Appearance />
        <Backdrop />
        <MiaGroup />
        <VoiceGroup />
        <AnnounceGroup />
        <QuestionsGroup />
        <Group title="Modes">
          <Row icon="tv" label="TV mode" hint="Ambient fleet display for a big screen" onClick={() => (location.hash = '#tv')} />
          <Row icon="car" label="Car mode" hint="Voice-first, giant buttons" onClick={() => (location.hash = '#car')} last />
        </Group>
        <Group title="Connection">
          {info.map(([k, v], i) => (
            <Row key={k} label={k} last={i === info.length - 1}>
              <span className="v-num max-w-[200px] truncate font-mono text-[0.8rem] text-ink2">{v}</span>
            </Row>
          ))}
        </Group>
        <Group title="API access" footer={`Bots and scripts drive the fleet over HTTPS with the same token: Authorization: Bearer <token>. GET ${location.origin}/api/v1 lists every endpoint.`}>
          <Row icon="copy" label="Machine setup" hint="Env vars + a test call, token included" last>
            <Button size="sm" icon={copied ? 'check' : undefined} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </Row>
        </Group>
        <Group title="Access">
          <Row icon="shield" label="Change token" onClick={changeToken} />
          <Row icon="stop" iconTone="!text-crit" label="Stop all agents" hint="Send “Stop” to every agent still running">
            <Button size="sm" tone="danger" onClick={() => confirm('Send “Stop” to every agent still running?') && stopAll()}>
              Stop all
            </Button>
          </Row>
          <Row icon="off" iconTone="!text-crit" label="Disconnect" hint="Forget the token on this device" last>
            <Button size="sm" tone="danger" onClick={() => confirm('Forget the access token on this device?') && forgetToken()}>
              Forget
            </Button>
          </Row>
        </Group>
      </div>
    </Page>
  );
}
