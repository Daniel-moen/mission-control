import { getMC, toast, agentName } from './store.js';
import { offerLink } from './announce.js';

// `mia panel …` — what the panel does with a {type:'panel'} frame from Mia
// (docs/mia.md §8.2). Navigation and view actions only, from this allow-list;
// nothing here edits, sends or deletes. Each returns { ok, detail } and the
// store reports it back to the relay → Mac → Mia (failures reach her as an
// [MC] event). `nav` is App's set of doors (App.jsx, panelApi).

const VIEWS = { home: 'Home', fleet: 'Fleet', library: 'Library', mia: 'Mia', insights: 'Insights', settings: 'Settings' };

const norm = (s) => String(s || '').toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);
const when = (d) => Date.parse(d?.updatedAt || d?.created || '') || 0;

// A Library id (the filename), with or without .md — or failing that, the
// best title match, so "the Oblivion report" can still land.
export function resolveDoc(arg, docs = getMC().docs || []) {
  const a = String(arg || '').trim();
  if (!a) return null;
  const exact = docs.find((d) => d.id === a || d.id === `${a}.md` || d.id.toLowerCase() === a.toLowerCase());
  if (exact) return exact;
  const n = norm(a);
  const byTitle = docs.filter((d) => norm(d.title) === n || norm(d.id) === n);
  if (byTitle.length) return byTitle.sort((x, y) => when(y) - when(x))[0];
  const w = words(a);
  if (!w.length) return null;
  const hits = docs.filter((d) => {
    const hay = ` ${norm(d.title)} ${norm(d.id)} ${norm(d.subject)} ${(d.tags || []).map(norm).join(' ')} `;
    return w.every((x) => hay.includes(x));
  });
  return hits.sort((x, y) => when(y) - when(x))[0] || null;
}

export function resolveAgent(arg, agents = getMC().agents || []) {
  const a = String(arg || '').trim();
  if (!a) return null;
  const byId = agents.find((x) => x.id === a || x.sessionId === a);
  if (byId) return byId;
  const n = norm(a);
  const named = agents.filter((x) => norm(agentName(x)) === n || norm(x.folder) === n);
  const pool = named.length ? named : agents.filter((x) => norm(agentName(x)).includes(n) || norm(x.folder).includes(n));
  // Prefer one that's alive over an exited run in the same folder.
  return pool.sort((x, y) => (y.status === 'exited' ? -1 : 0) - (x.status === 'exited' ? -1 : 0))[0] || null;
}

// Scroll the open doc to a heading; waits for the body to render (a doc Mia
// just opened is still loading).
export function scrollToHeading(text, timeoutMs = 8000) {
  const want = norm(text);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const look = () => {
      const art = document.querySelector('article.md');
      const hs = art ? [...art.querySelectorAll('h1,h2,h3,h4,h5,h6')] : [];
      const h = hs.find((x) => norm(x.textContent) === want) || hs.find((x) => norm(x.textContent).includes(want));
      if (h) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        h.classList.add('mia-flash');
        setTimeout(() => h.classList.remove('mia-flash'), 2400);
        return resolve({ ok: true, detail: h.textContent.trim() });
      }
      if (Date.now() - t0 > timeoutMs) {
        return resolve({ ok: false, detail: art ? `no heading matching "${text}" in the open doc` : 'no document is open' });
      }
      setTimeout(look, 250);
    };
    look();
  });
}

// Opening a link on the device. window.open hands https links to Safari and
// universal links (Zoom, Meet, Teams) to their apps. Without a tap it may be
// blocked: the Home Screen app then navigates to the link (iOS shows it over
// the app, or passes it to the meeting app); a browser tab must not lose the
// panel, so it offers the link in the top-bar pill for one tap instead.
const standalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
function openUrl(url, host) {
  let w = null;
  try {
    w = window.open(url, '_blank', 'noopener');
  } catch {}
  if (w) return 'opened';
  if (standalone()) {
    try {
      location.assign(url);
      return 'opened';
    } catch {}
  }
  offerLink(url, host);
  return 'offered';
}

export async function runPanelCommand(cmd, nav) {
  const arg = typeof cmd.arg === 'string' ? cmd.arg.trim() : '';
  switch (cmd.action) {
    case 'view': {
      if (!VIEWS[arg]) return { ok: false, detail: `unknown view "${arg}"` };
      nav.view(arg);
      toast(`Mia opened ${VIEWS[arg]}`);
      return { ok: true };
    }
    case 'open-doc': {
      const d = resolveDoc(arg);
      if (!d) return { ok: false, detail: `no Library doc matches "${arg}"` };
      nav.openDoc(d.id);
      toast(`Mia opened “${d.title || d.id}”`);
      if (cmd.heading) {
        const r = await scrollToHeading(cmd.heading);
        return r.ok ? { ok: true, detail: d.id } : { ok: false, detail: `opened ${d.id}, but ${r.detail}` };
      }
      return { ok: true, detail: d.id };
    }
    case 'open-task': {
      const id = /^\d+$/.test(arg) ? String(Number(arg)).padStart(4, '0') : arg;
      const t = (getMC().mia?.tasks || []).find((x) => x.id === id);
      if (!t) return { ok: false, detail: `task ${id} isn't on the board` };
      nav.openTask(id);
      toast(`Mia opened task ${id}`);
      return { ok: true };
    }
    case 'open-agent': {
      const a = resolveAgent(arg);
      if (!a) return { ok: false, detail: `no agent matches "${arg}"` };
      nav.openAgent(a.id);
      toast(`Mia opened ${agentName(a) || 'an agent'}`);
      return { ok: true, detail: a.id };
    }
    case 'open-url': {
      if (!/^https:\/\/\S+$/i.test(arg)) return { ok: false, detail: 'only https links can be opened' };
      let host = '';
      try {
        host = new URL(arg).host;
      } catch {
        return { ok: false, detail: 'not a valid link' };
      }
      const how = openUrl(arg, host);
      toast(how === 'opened' ? `Mia opened ${host}` : `Mia sent a link — tap to open ${host}`);
      return { ok: true, detail: how };
    }
    case 'search': {
      if (!arg) return { ok: false, detail: 'empty search' };
      nav.search(arg.slice(0, 200));
      toast(`Mia searched for “${arg.slice(0, 60)}”`);
      return { ok: true };
    }
    case 'scroll-to': {
      if (!arg) return { ok: false, detail: 'no heading given' };
      const r = await scrollToHeading(arg, 2500);
      if (r.ok) toast(`Mia jumped to “${r.detail.slice(0, 60)}”`);
      return r;
    }
    default:
      return { ok: false, detail: `"${cmd.action}" isn't something the panel does` };
  }
}
