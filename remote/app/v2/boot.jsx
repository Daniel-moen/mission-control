import { useEffect, useState } from 'react';
import { initToken } from '../src/lib/store.js';
import { initPush } from '../src/lib/push.js';
import { initViewportGap } from '../src/lib/viewport.js';
import { initUpdates } from '../src/lib/update.js';
import { initPrefs } from './lib/prefs.js';
import { initBackdrop } from './lens/backdrop.js';
import { hydrateFromCache, startCaching } from './lib/offline.js';
import App from './App.jsx';
import { preload } from './shell/pages.js';

// Mission Control v2 (task 0444): the client entry. Next.js (next-v2/) only
// ships it — a static export whose one page loads this module in the browser
// (never on the server: the store opens a socket and reads localStorage the
// moment it's imported). Same store, same wire, same relay as v1.

initPrefs();
initBackdrop();
// The last picture of the fleet, before the socket even dials, so a cold
// start offline shows something true-a-moment-ago instead of nothing.
hydrateFromCache();
initToken();
startCaching();
initPush();
initViewportGap();
initUpdates();

// Home's code (and a deep link's page) start downloading now, in parallel with
// the socket; the first paint waits for them — no skeleton, no layout shift.
const first = { doc: 'doc', agent: 'agent', mia: 'mia', fleet: 'agents', library: 'library', insights: 'insights', settings: 'settings' }[location.hash.replace(/^#/, '').split('/')[0]];
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
