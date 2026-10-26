import { useEffect, useState } from 'react';
import { MotionConfig, motion, AnimatePresence } from 'motion/react';
import { useMC, initToken, onPanelCommand, getMC } from '../src/lib/store.js';
import { resolveDoc, resolveAgent } from '../src/lib/panelCommands.js';
import { initPush } from '../src/lib/push.js';
import { initViewportGap } from '../src/lib/viewport.js';
import { useUsageSync } from '../src/lib/usage.js';
import { initPrefs } from '../v2/lib/prefs.js';
import { hydrateFromCache, startCaching } from '../v2/lib/offline.js';
import { Gate } from '../v2/shell/Chrome.jsx';
import { initQuality, useQuality } from '../v3/shared/quality.js';
import { initPerf } from '../v3/shared/perf.js';
import { VoiceEngine } from '../v3/shared/voice.jsx';
import { initTheme, toggleTheme, useTheme } from './shared/theme.js';
import { openRoute, closeRoute, useEscCloses, useRoute } from './shared/route.js';
import './v4.css';

// v4 (task 0446): the shared entry of the three STRUCTURAL directions —
// Stage (Mia-first canvas), Atlas (zoomable map of rooms), Now (a stack of
// moments by attention). Same store, wire and relay as v1/v2/v3; only the
// way you move around differs. Mia's `mia panel` commands land as routes.

let inited = false;
function init() {
  if (inited) return;
  inited = true;
  initPrefs();
  initTheme();
  document.documentElement.classList.add('v4');
  hydrateFromCache();
  initToken();
  startCaching();
  initPush();
  initViewportGap();
  initQuality();
  initPerf();
}

const VIEW = { mia: 'mia', fleet: 'agents', agents: 'agents', library: 'library', insights: 'pulse', tasks: 'tasks', home: '' };
function runPanel(cmd) {
  const arg = typeof cmd.arg === 'string' ? cmd.arg.trim() : '';
  switch (cmd.action) {
    case 'open-doc':
    case 'show-doc': {
      const d = resolveDoc(arg);
      if (!d) return { ok: false, detail: `no Library doc matches "${arg}"` };
      openRoute('doc', d.id);
      return { ok: true, detail: d.id };
    }
    case 'open-agent': {
      const a = resolveAgent(arg);
      if (!a) return { ok: false, detail: `no agent matches "${arg}"` };
      openRoute('agent', a.id);
      return { ok: true, detail: a.id };
    }
    case 'open-task': {
      const id = /^\d+$/.test(arg) ? String(Number(arg)).padStart(4, '0') : arg;
      if (!(getMC().mia?.tasks || []).some((t) => t.id === id)) return { ok: false, detail: `task ${id} isn't on the board` };
      openRoute('task', id);
      return { ok: true };
    }
    case 'view': {
      if (!(arg in VIEW)) return { ok: false, detail: `unknown view "${arg}"` };
      if (VIEW[arg]) openRoute(VIEW[arg]);
      else closeRoute();
      return { ok: true };
    }
    case 'close':
      closeRoute();
      return { ok: true };
    default:
      return { ok: false, detail: `"${cmd.action}" isn't in the v4 prototypes yet` };
  }
}

const ALL = [
  { ui: 'v4a', name: 'Stage', hint: 'Mia brings everything in' },
  { ui: 'v4b', name: 'Atlas', hint: 'a map you zoom into' },
  { ui: 'v4c', name: 'Now', hint: 'a stack of moments' },
  { ui: 'v2', name: 'v2', hint: 'Quiet' },
  { ui: 'v1', name: 'v1', hint: 'Studio Glass' },
];
function Switcher({ current }) {
  const [open, setOpen] = useState(false);
  const theme = useTheme((s) => s.theme);
  const me = ALL.find((d) => d.ui === current);
  // out of the way while something is open full-screen (its close button
  // lives in that corner)
  const r = useRoute();
  if (r.kind) return null;
  const pick = (ui) => {
    try {
      localStorage.setItem('mc.ui', ui);
    } catch {}
    document.cookie = `mc_ui=${ui}; path=/; max-age=31536000; samesite=lax`;
    location.replace(ui.startsWith('v4') ? `/${ui}${location.hash}` : `/?ui=${ui}${location.hash}`);
  };
  return (
    <div className="v4-switch" data-switcher>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            className="v4-switch-menu"
          >
            {ALL.map((d) => (
              <button key={d.ui} onClick={() => pick(d.ui)} data-pick={d.ui} className={d.ui === current ? 'on' : ''}>
                <b>{d.name}</b>
                <span>{d.hint}</span>
              </button>
            ))}
            <button onClick={toggleTheme} data-theme-toggle>
              <b>{theme === 'dark' ? 'Light' : 'Dark'}</b>
              <span>switch appearance</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <button className="v4-switch-chip" onClick={() => setOpen((v) => !v)} aria-label="Design direction">
        <i>{current.slice(-1).toUpperCase()}</i>
        {me?.name}
      </button>
    </div>
  );
}

export default function Boot({ ui, Direction }) {
  init();
  const needsToken = useMC((s) => s.needsToken);
  const reduce = useQuality((s) => s.reduce);
  const toastText = useMC((s) => s.toast);
  useUsageSync();
  useEscCloses();
  useEffect(() => {
    document.documentElement.dataset.direction = ui;
    return onPanelCommand(runPanel);
  }, [ui]);
  if (needsToken) return <Gate />;
  return (
    <MotionConfig reducedMotion={reduce ? 'always' : 'never'}>
      <Direction />
      <VoiceEngine />
      {toastText && <div className="v4-toast" role="status">{toastText}</div>}
      <Switcher current={ui} />
    </MotionConfig>
  );
}
