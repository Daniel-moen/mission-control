import { createElement, lazy } from 'react';

// Every page is its own chunk: the first paint downloads Home and the shell,
// nothing else. The likely-next pages are warmed up on idle (warmPages), so a
// tap never waits on the network for code.

let loaders = {
  home: () => import('../views/Home.jsx'),
  mia: () => import('../views/Mia.jsx'),
  agents: () => import('../views/Agents.jsx'),
  agent: () => import('../views/Agent.jsx'),
  library: () => import('../views/Library.jsx'),
  doc: () => import('../views/Doc.jsx'),
  insights: () => import('../views/Insights.jsx'),
  settings: () => import('../views/Settings.jsx'),
  hq: () => import('../views/HQ.jsx'),
};

// v5 (task 0483) runs the same pages in its own frame: it swaps in its own
// loaders (Home, the task page, each page wrapped in a glass window) before
// anything renders.
export function setPageLoaders(map) {
  loaders = { ...loaders, ...map };
}

// Loaded page modules. A page whose code is already here renders directly —
// React.lazy would still suspend for one frame even on a warm import, and
// that frame is a skeleton flash in the middle of a push.
const mods = {};
const load = (name) =>
  (loaders[name] || loaders.home)().then((m) => {
    mods[name] = m.default;
    return m;
  });
export const preload = (name) => (mods[name] ? Promise.resolve() : load(name).catch(() => {}));

const cache = {};
export function pageFor(name) {
  if (!cache[name]) {
    const Lazy = lazy(() => load(name));
    cache[name] = function PageCode(props) {
      const Mod = mods[name];
      return Mod ? createElement(Mod, props) : createElement(Lazy, props);
    };
  }
  return cache[name];
}

// Shortly after the first paint, fetch the pages a tap is most likely to
// open next (small chunks; the network is idle by then).
export function warmPages(names = ['mia', 'agents', 'library', 'agent', 'doc', 'insights', 'settings']) {
  setTimeout(() => names.reduce((p, n) => p.then(() => preload(n)), Promise.resolve()), 400);
}

// What a page looks like while its code arrives (rare after warm-up): the
// large title's slot and a few quiet rows — no spinner, no layout shift.
export function PageSkeleton() {
  const bar = (w, h, mt) => createElement('div', { className: 'v-skeleton', style: { width: w, height: h, marginTop: mt } });
  return createElement(
    'div',
    { className: 'flex flex-col px-5 v-pt-safe', 'aria-busy': 'true' },
    bar('42%', 34, 64),
    bar('100%', 72, 28),
    bar('100%', 72, 12),
    bar('70%', 72, 12),
  );
}
