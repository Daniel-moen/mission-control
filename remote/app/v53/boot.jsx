import { useEffect, useState } from 'react';
import { initToken } from '../src/lib/store.js';
import { initPush } from '../src/lib/push.js';
import { initViewportGap } from '../src/lib/viewport.js';
import { initUpdates } from '../src/lib/update.js';
import { initPrefs } from '../v2/lib/prefs.js';
import { navOpts, useNav } from '../v2/lib/nav.js';
import { initBackdrop, useBackdrop } from '../v2/lens/backdrop.js';
import { hydrateFromCache, startCaching } from '../v2/lib/offline.js';
import { preload } from '../v2/shell/pages.js';
import { initQuality } from '../v3/shared/quality.js';
import { initPerf } from '../v3/shared/perf.js';
import { SHORTCUTS } from '../v5/ux.jsx';
import { initPages } from './pages.js';
import App from './App.jsx';

// Mission Control v5.3 (tasks 0491, 0502): the client entry, shipped by Next.js like
// v5 (next-v2/app/(v53)/v53). Same store, wire and relay as v1/v2/v5; v5's
// glass, pages and UX helpers; its own shell — chat first (App.jsx).

initPrefs();
const root = document.documentElement;
root.classList.remove('v2');
root.classList.add('v5', 'v53');
root.dataset.ui = 'v53';
navOpts.taskPage = true;
navOpts.chatFirst = true;
// the chat is where you start (the Mia place); Home is a place in the pane
useNav.setState({ tab: 'mia', visited: { mia: true } });
// v5's hold-⌘ list, in v5.3's words
SHORTCUTS.splice(
  0,
  SHORTCUTS.length,
  ['⌘K', 'Go anywhere, find anything'],
  ['⌘\\', 'Minimise or restore the tab bar'],
  ['⌘1 – ⌘5', 'Chat, Home, Tasks, Fleet, Library (⌘6–8: HQ, Insights, Settings)'],
  ['⌘J  or  /', 'Write to Mia'],
  ['⌘F', 'Find on this page'],
  ['⌘N', 'New document'],
  ['⌘L', 'Launch an agent'],
  ['⌘R', 'Refresh'],
  ['⌘[  or  Esc', 'Back · close the page'],
  ['⌘/', 'Show these shortcuts'],
);
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

const first = { doc: 'doc', agent: 'agent', home: 'home', fleet: 'agents', library: 'library', insights: 'insights', settings: 'settings', task: 'task', tasks: 'tasks', hq: 'hq', channels: 'hq' }[
  location.hash.replace(/^#/, '').split('/')[0]
];
const ready = Promise.all([import('./Chat.jsx'), first && preload(first)]);

// Task 0503 (no pop-in): the glass's photo and the shader's code start loading
// now, beside the chat's, not when the scene mounts on idle — so the photo is
// decoded and the module parsed by the time the shader asks for them.
import('./Scene.jsx').catch(() => {});
const warmed = new Set();
const warmPhoto = (src) => {
  if (!src || warmed.has(src)) return;
  warmed.add(src);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  img.decode?.().catch(() => {});
};
warmPhoto(useBackdrop.getState().src);
useBackdrop.subscribe((s) => warmPhoto(s.src));

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
