import { useEffect, useState } from 'react';
import { initToken } from '../src/lib/store.js';
import { initPush } from '../src/lib/push.js';
import { initViewportGap } from '../src/lib/viewport.js';
import { initUpdates } from '../src/lib/update.js';
import { initPrefs } from '../v2/lib/prefs.js';
import { navOpts } from '../v2/lib/nav.js';
import { initBackdrop } from '../v2/lens/backdrop.js';
import { hydrateFromCache, startCaching } from '../v2/lib/offline.js';
import { preload } from '../v2/shell/pages.js';
import { initQuality } from '../v3/shared/quality.js';
import { initPerf } from '../v3/shared/perf.js';
import { initPages } from './pages.js';
import App from './App.jsx';

// Mission Control v5 (task 0483): the client entry, shipped by Next.js like
// v2 (next-v2/app/(v5)/v5) — never run on the server. Same store, wire and
// relay as v1/v2/v4; its own stylesheet (v5.css, in the (v5) root layout —
// not v1's app.css, not v2's v2.css).

initPrefs();
const root = document.documentElement;
root.classList.remove('v2');
root.classList.add('v5');
root.dataset.ui = 'v5';
navOpts.taskPage = true;
navOpts.placeRoots = new Set(['hq']); // v5.1: HQ is a tab (task 0486)
initPages();
initBackdrop();
hydrateFromCache();
initToken();
startCaching();
initPush();
initViewportGap();
initUpdates();
initQuality();
initPerf();

// Home's code (and a deep link's page) download with the socket; first paint waits.
const first = { doc: 'doc', agent: 'agent', mia: 'mia', fleet: 'agents', library: 'library', insights: 'insights', settings: 'settings', task: 'task', hq: 'hq', channels: 'hq' }[
  location.hash.replace(/^#/, '').split('/')[0]
];
const ready = Promise.all([preload('home'), first && preload(first)]);

export default function Boot() {
  const [go, setGo] = useState(false);
  useEffect(() => {
    let live = true;
    ready.finally(() => live && setGo(true));
    return () => {
      live = false;
    };
  }, []);
  return go ? <App /> : null;
}
