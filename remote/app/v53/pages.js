import { createElement } from 'react';
import { setPageLoaders } from '../v2/shell/pages.js';

// v5.3's pages (tasks 0491, 0502). The same pages as v5 — each one a WINDOW of Lens
// glass (.v5-win) — but the window lives in the pane beside or over the chat,
// not over a bare photo. The Mia place is the chat itself, drawn by the shell
// (Stage.jsx), so its page in the stack is empty: anything pushed over it
// (a task, a doc, HQ, Settings) opens the pane, and popping back to it
// closes the pane. Home is Today (Home + Insights' headline in one page);
// Mia's board is a page of its own (Tasks).

const frames = {};
function framed(name, Page) {
  if (!frames[name]) {
    frames[name] = function Window(props) {
      return createElement(
        'div',
        { className: 'v5-win-slot', 'data-win-slot': name },
        createElement('div', { className: 'v5-win', 'data-win': name }, createElement(Page, { ...props, v5: true })),
      );
    };
  }
  return frames[name];
}
const win = (name, load) => () => load().then((m) => ({ ...m, default: framed(name, m.default) }));
const Blank = () => null;

export function initPages() {
  setPageLoaders({
    home: win('home', () => import('./Today.jsx')),
    mia: () => Promise.resolve({ default: Blank }),
    tasks: win('tasks', () => import('./TasksPage.jsx')),
    agents: win('agents', () => import('../v2/views/Agents.jsx')),
    agent: win('agent', () => import('../v2/views/Agent.jsx')),
    library: win('library', () => import('../v5/Library.jsx')),
    doc: win('doc', () => import('../v2/views/Doc.jsx')),
    insights: win('insights', () => import('../v2/views/Insights.jsx')),
    settings: win('settings', () => import('../v2/views/Settings.jsx')),
    hq: win('hq', () => import('../v2/views/HQ.jsx')),
    task: win('task', () => import('../v5/Task.jsx')),
  });
}
