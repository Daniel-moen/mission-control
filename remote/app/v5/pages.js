import { createElement } from 'react';
import { setPageLoaders } from '../v2/shell/pages.js';

// v5's pages (task 0483). The same page code as v2 — v1's information and
// flows, already rebuilt without v1's components — but every page except
// Home opens as a WINDOW: one large pane of Lens glass over the photo, as in
// v1 (Mission Control's original shape). Home is v1's scene (Home.jsx); a
// task gets its own page (Task.jsx).

const frames = {};
function framed(name, Page) {
  if (!frames[name]) {
    frames[name] = function Window(props) {
      return createElement(
        'div',
        { className: 'v5-win-slot', 'data-win-slot': name },
        createElement('div', { className: 'v5-win', 'data-win': name }, createElement(Page, props)),
      );
    };
  }
  return frames[name];
}
const win = (name, load) => () => load().then((m) => ({ ...m, default: framed(name, m.default) }));

export function initPages() {
  setPageLoaders({
    home: () => import('./Home.jsx'),
    mia: win('mia', () => import('../v2/views/Mia.jsx')),
    agents: win('agents', () => import('../v2/views/Agents.jsx')),
    agent: win('agent', () => import('../v2/views/Agent.jsx')),
    library: win('library', () => import('../v2/views/Library.jsx')),
    doc: win('doc', () => import('../v2/views/Doc.jsx')),
    insights: win('insights', () => import('../v2/views/Insights.jsx')),
    settings: win('settings', () => import('../v2/views/Settings.jsx')),
    hq: win('hq', () => import('../v2/views/HQ.jsx')),
    task: win('task', () => import('./Task.jsx')),
  });
}
