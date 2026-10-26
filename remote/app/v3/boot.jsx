import { useEffect } from 'react';
import { MotionConfig } from 'motion/react';
import { useMC, initToken } from '../src/lib/store.js';
import { initPush } from '../src/lib/push.js';
import { initViewportGap } from '../src/lib/viewport.js';
import { useUsageSync } from '../src/lib/usage.js';
import { initPrefs } from '../v2/lib/prefs.js';
import { hydrateFromCache, startCaching } from '../v2/lib/offline.js';
import { Gate } from '../v2/shell/Chrome.jsx';
import { initQuality, useQuality } from './shared/quality.js';
import { initPerf } from './shared/perf.js';
import { VoiceEngine } from './shared/voice.jsx';
import { useHashMarks } from './shared/nav.js';
import Switcher from './shared/Switcher.jsx';
import './v3.css';

// v3 (task 0445): the shared client entry of the three design directions.
// Same store, wire and relay as v1/v2 (so they show live data); each
// direction is just its own Home + Mia screens. Dark first.

let inited = false;
function init() {
  if (inited) return;
  inited = true;
  initPrefs();
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.classList.add('v3');
  hydrateFromCache();
  initToken();
  startCaching();
  initPush();
  initViewportGap();
  initQuality();
  initPerf();
}

export default function Boot({ ui, Direction }) {
  init();
  const needsToken = useMC((s) => s.needsToken);
  const reduce = useQuality((s) => s.reduce);
  const toastText = useMC((s) => s.toast);
  useUsageSync();
  useHashMarks();
  useEffect(() => {
    document.documentElement.dataset.direction = ui;
  }, [ui]);
  if (needsToken) return <Gate />;
  return (
    <MotionConfig reducedMotion={reduce ? 'always' : 'never'}>
      <Direction />
      <VoiceEngine />
      {toastText && <div className="v3-toast" role="status">{toastText}</div>}
      <Switcher current={ui} />
    </MotionConfig>
  );
}
