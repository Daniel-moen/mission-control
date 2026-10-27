import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { getMC, reconnectNow, docMeta, docDelete, kill, miaTaskCancel, miaTaskSet, agentName, toast } from '../src/lib/store.js';
import { attachToMia } from '../src/lib/attach.js';
import { useNav, push, pop, setTab, openOverlay, applyHash, hashFor, topOf } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring } from '../v2/lib/motion.js';
import { Archive, ArchiveRestore, Command } from 'lucide-react';
import { Icon as KitIcon } from '../v2/ui/kit.jsx';

// v1's icon map plus the three v5.1 needs (kept here so v1's bundle is untouched)
const EXTRA = { archive: Archive, unarchive: ArchiveRestore, command: Command };
export function Icon({ name, size = 18, strokeWidth = 1.75, ...rest }) {
  const G = EXTRA[name];
  return G ? <G size={size} strokeWidth={strokeWidth} aria-hidden="true" {...rest} /> : <KitIcon name={name} size={size} strokeWidth={strokeWidth} {...rest} />;
}

// v5.1 (task 0486): the small things an Apple app does without being asked.
//   • haptic()          — a physical acknowledgement (a vibration where the
//                         device has one, a spring "tick" on the element always)
//   • <PullToRefresh/>  — pull any list down from its top to refresh it
//   • <ContextMenus/>   — long-press (or right-click / two-finger click) a
//                         document, an agent or a task for what you can do to it
//   • <ShortcutsHUD/>   — hold ⌘ on an iPad keyboard to see every shortcut
//   • useRemembered()   — the place you were and how far you'd scrolled come
//                         back after a reload or a cold launch
// All of it is global: pages opt out with data-no-ptr / data-no-menu.

// ---- haptics ------------------------------------------------------------------
export function haptic(el, strength = 'light') {
  try {
    navigator.vibrate?.(strength === 'heavy' ? 16 : 8);
  } catch {
    /* not allowed before a gesture */
  }
  if (!el?.animate || usePrefs.getState().reduce) return;
  const k = strength === 'heavy' ? 0.92 : 0.96;
  el.animate([{ transform: 'scale(1)' }, { transform: `scale(${k})` }, { transform: 'scale(1.015)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(.3,1.3,.5,1)' });
}

// ---- pull to refresh ----------------------------------------------------------
// Lists you'd expect to refresh: Home, Fleet, Library, Insights, HQ, a task,
// Mia's board. Not the chat (it's bottom-anchored), a terminal or an editor.
const PTR_PAGES = new Set(['agents', 'library', 'insights', 'hq', 'task']);
const PULL = 72; // past this, letting go refreshes
const rubber = (x) => (x <= 0 ? 0 : 140 * (1 - 1 / (x / 140 + 1)));

function scrollerFor(target) {
  if (!(target instanceof Element)) return null;
  if (target.closest('[data-no-ptr], textarea, input, select, [role="dialog"], [data-sheet], .term, [data-thread]')) return null;
  const home = target.closest('.v5-home');
  if (home) return home;
  const s = target.closest('.v-scroll');
  const page = s?.closest('[data-page]');
  if (!s || !page || page.dataset.top !== 'true') return null;
  if (PTR_PAGES.has(page.dataset.page)) return s;
  // Mia's board (the Tasks segment) refreshes too; her chat doesn't
  if (page.dataset.page === 'mia' && s.querySelector('[data-tasks]')) return s;
  return null;
}

// Refresh = ask the relay for a fresh picture now, and resolve when it lands
// (or after a beat — the honest "nothing new" case).
export function refreshNow() {
  const before = getMC().lastSnapshotAt;
  reconnectNow();
  window.dispatchEvent(new CustomEvent('v5:refresh'));
  const t0 = Date.now();
  return new Promise((done) => {
    const tick = () => {
      const fresh = getMC().lastSnapshotAt !== before;
      const dt = Date.now() - t0;
      if ((fresh && dt > 650) || dt > 1800) return done(fresh);
      setTimeout(tick, 80);
    };
    tick();
  });
}

export function PullToRefresh() {
  const [ui, setUi] = useState(null); // { x, y, p, state }
  useEffect(() => {
    let g = null; // the gesture
    const content = (s) => s.firstElementChild || s;
    const place = (s, d, state) => {
      const r = s.getBoundingClientRect();
      setUi({
        x: r.left + r.width / 2,
        y: r.top + (s.classList.contains('v5-home') ? 10 : 58),
        p: Math.min(1, d / PULL),
        state,
      });
    };
    const move = (e) => {
      if (!g || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - g.y0;
      const dx = e.touches[0].clientX - g.x0;
      if (!g.pulling) {
        if (Math.abs(dx) > Math.abs(dy) || dy < 6 || g.s.scrollTop > 0) {
          if (dy < 0 || Math.abs(dx) > 10) end(true);
          return;
        }
        g.pulling = true;
        g.box = content(g.s);
      }
      e.preventDefault();
      const d = rubber(dy - 6);
      g.d = d;
      g.box.style.transform = `translate3d(0, ${d}px, 0)`;
      if (!g.armed && d >= PULL) {
        g.armed = true;
        haptic(null);
      } else if (g.armed && d < PULL) g.armed = false;
      place(g.s, d, g.armed ? 'armed' : 'pull');
    };
    const settle = (box, from) => {
      const a = box.animate([{ transform: `translate3d(0, ${from}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }], { duration: 380, easing: 'cubic-bezier(.25,1,.5,1)' });
      box.style.transform = '';
      return a.finished.catch(() => {});
    };
    const end = (cancel = false) => {
      const cur = g;
      g = null;
      if (!cur) return;
      cur.s.removeEventListener('touchmove', move);
      if (!cur.pulling) return;
      if (cancel || !cur.armed) {
        settle(cur.box, cur.d);
        setUi(null);
        return;
      }
      // hold the content open on the spinner while the refresh runs
      cur.box.style.transform = 'translate3d(0, 56px, 0)';
      cur.box.animate([{ transform: `translate3d(0, ${cur.d}px, 0)` }, { transform: 'translate3d(0, 56px, 0)' }], { duration: 220, easing: 'ease-out' });
      place(cur.s, PULL, 'busy');
      document.documentElement.dataset.refreshing = '1';
      refreshNow().then((fresh) => {
        place(cur.s, PULL, fresh ? 'done' : 'same');
        setTimeout(() => {
          settle(cur.box, 56);
          setUi(null);
          delete document.documentElement.dataset.refreshing;
        }, 380);
      });
    };
    const start = (e) => {
      if (g || e.touches.length !== 1 || document.documentElement.dataset.refreshing) return;
      const s = scrollerFor(e.target);
      if (!s || s.scrollTop > 0) return;
      g = {
        s,
        x0: e.touches[0].clientX,
        y0: e.touches[0].clientY,
        d: 0,
        pulling: false,
        armed: false,
      };
      // non-passive only for this gesture, only on this scroller
      s.addEventListener('touchmove', move, { passive: false });
    };
    const up = () => end(false);
    document.addEventListener('touchstart', start, {
      passive: true,
      capture: true,
    });
    document.addEventListener('touchend', up, true);
    document.addEventListener('touchcancel', () => end(true), true);
    return () => {
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchend', up, true);
    };
  }, []);
  return createPortal(
    <AnimatePresence>
      {ui && (
        <motion.div
          key="ptr"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{
            opacity: Math.min(1, ui.p * 1.4),
            scale: ui.state === 'armed' ? 1.08 : 0.7 + ui.p * 0.3,
          }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={spring.snappy}
          className="v5-chip v5-ptr pointer-events-none fixed z-[70] grid h-10 w-10 place-items-center rounded-full"
          style={{ left: ui.x - 20, top: ui.y }}
          data-ptr={ui.state}
          aria-live="polite"
        >
          {ui.state === 'done' || ui.state === 'same' ? (
            <Icon name="check" size={18} strokeWidth={2.4} className="text-accent" />
          ) : (
            <span className={ui.state === 'busy' ? 'v5-spin flex' : 'flex'} style={ui.state === 'busy' ? undefined : { transform: `rotate(${ui.p * 270}deg)` }}>
              <Icon name="refresh" size={18} strokeWidth={2.2} className={ui.state === 'pull' ? 'text-ink2' : 'text-ink'} />
            </span>
          )}
          <span className="sr-only">{ui.state === 'busy' ? 'Refreshing' : ui.state === 'done' ? 'Updated' : ''}</span>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---- context menus --------------------------------------------------------------
const TARGET = '[data-doc], [data-agent], [data-task]';

const docLink = (id) => `${location.origin}${location.pathname}#doc/${encodeURIComponent(id)}`;
async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast('Couldn’t copy on this device');
  }
}

// What you can do to a thing, most useful first, destructive last.
function itemsFor(el) {
  const mc = getMC();
  const here = el.hasAttribute('data-menu-here'); // a ⋯ button on the thing's own page
  if (el.dataset.doc) {
    const id = el.dataset.doc;
    const d = mc.docs.find((x) => x.id === id);
    if (!d) return null;
    const archived = d.status === 'archived';
    return {
      title: d.title || id,
      items: [
        {
          icon: 'doc',
          label: 'Open',
          run: () => push('doc', { id }, { tab: 'library' }),
        },
        {
          icon: 'mia',
          label: 'Ask Mia about it',
          run: () => (attachToMia({ kind: 'doc', id, title: d.title }), setTab('mia')),
        },
        {
          icon: 'link',
          label: 'Copy link',
          run: () => copy(docLink(id), 'Link'),
        },
        d.status !== 'done' &&
          !archived && {
            icon: 'check',
            label: 'Mark as done',
            run: () => (docMeta(id, { status: 'done' }), toast('Marked as done')),
          },
        {
          icon: archived ? 'unarchive' : 'archive',
          label: archived ? 'Unarchive' : 'Archive',
          run: () => (docMeta(id, { status: archived ? 'done' : 'archived' }), toast(archived ? 'Moved back to the Library' : 'Archived')),
        },
        {
          icon: 'trash',
          label: 'Delete',
          danger: true,
          confirm: 'Delete — tap again',
          run: () => docDelete(id) && toast('Deleted'),
        },
      ].filter(Boolean),
    };
  }
  if (el.dataset.agent) {
    const id = el.dataset.agent;
    const a = mc.agents.find((x) => x.id === id);
    if (!a) return null;
    return {
      title: agentName(a),
      items: [
        !here && {
          icon: 'agents',
          label: 'Open',
          run: () => push('agent', { id }, { tab: 'agents' }),
        },
        a.controllable !== false && {
          icon: 'terminal',
          label: 'Open terminal',
          run: () => openOverlay('console', { id }),
        },
        a.dir && {
          icon: 'folder',
          label: 'Copy folder path',
          run: () => copy(a.dir, 'Path'),
        },
        {
          icon: 'kill',
          label: 'Stop agent',
          danger: true,
          confirm: 'Stop — tap again',
          run: () => kill(id) && (toast(`Stopping ${agentName(a)}`), here && pop()),
        },
      ].filter(Boolean),
    };
  }
  if (el.dataset.task) {
    const id = el.dataset.task;
    const t = (mc.mia?.tasks || []).find((x) => x.id === id);
    if (!t) return null;
    const live = ['queued', 'asking', 'running', 'checking'].includes(t.status);
    return {
      title: t.title || `Task ${id}`,
      items: [
        {
          icon: 'tasks',
          label: 'Open',
          run: () => push('task', { id }, { tab: 'mia' }),
        },
        {
          icon: 'mia',
          label: 'Ask Mia about it',
          run: () => (attachToMia({ kind: 'task', id, title: t.title }), setTab('mia')),
        },
        live &&
          Number(t.priority) !== 1 && {
            icon: 'arrowUp',
            label: 'Make top priority',
            run: () => (miaTaskSet(id, 'priority', 1), toast('Now P1')),
          },
        !live &&
          t.status !== 'done' && {
            icon: 'retry',
            label: 'Queue again',
            run: () => miaTaskSet(id, 'status', 'queued'),
          },
        live && {
          icon: 'close',
          label: 'Cancel task',
          danger: true,
          confirm: 'Cancel — tap again',
          run: () => miaTaskCancel(id) && toast('Task cancelled'),
        },
      ].filter(Boolean),
    };
  }
  return null;
}

export function ContextMenus() {
  const [menu, setMenu] = useState(null); // { rect, title, items, at }
  const [armed, setArmed] = useState(-1);
  const previewRef = useRef(null);
  const reduce = usePrefs((s) => s.reduce);

  useEffect(() => {
    let timer = 0;
    let p0 = null;
    let swallow = 0;
    const open = (el, at) => {
      if (el.closest('[data-no-menu], [role="dialog"]')) return false;
      const spec = itemsFor(el);
      if (!spec) return false;
      haptic(null, 'heavy');
      setArmed(-1);
      setMenu({ ...spec, rect: el.getBoundingClientRect(), at, el });
      return true;
    };
    const down = (e) => {
      if (e.pointerType !== 'touch' || e.button > 0) return;
      const el = e.target.closest?.(TARGET);
      if (!el) return;
      p0 = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (open(el, null)) swallow = Date.now();
      }, 480);
    };
    const moveP = (e) => {
      if (p0 && Math.hypot(e.clientX - p0.x, e.clientY - p0.y) > 9) (clearTimeout(timer), (p0 = null));
    };
    const upP = () => (clearTimeout(timer), (p0 = null));
    const click = (e) => {
      if (Date.now() - swallow < 900) {
        e.preventDefault();
        e.stopPropagation();
        swallow = 0;
      }
    };
    const ctx = (e) => {
      const el = e.target.closest?.(TARGET);
      if (!el) return;
      e.preventDefault();
      if (Date.now() - swallow < 900) return; // the long-press already opened it
      open(el, { x: e.clientX, y: e.clientY });
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', moveP, true);
    document.addEventListener('pointerup', upP, true);
    document.addEventListener('pointercancel', upP, true);
    document.addEventListener('click', click, true);
    document.addEventListener('contextmenu', ctx, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', moveP, true);
      document.removeEventListener('pointerup', upP, true);
      document.removeEventListener('pointercancel', upP, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('contextmenu', ctx, true);
    };
  }, []);

  // the thing you pressed, lifted out of the page (iOS's preview)
  useLayoutEffect(() => {
    const box = previewRef.current;
    if (!menu || !box || menu.at) return;
    const c = menu.el.cloneNode(true);
    c.removeAttribute('data-doc');
    c.removeAttribute('data-agent');
    c.removeAttribute('data-task');
    c.removeAttribute('data-zoom');
    c.style.cssText = 'width:100%;height:100%;margin:0;transform:none;pointer-events:none;';
    box.replaceChildren(c);
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const k = (e) => e.key === 'Escape' && (e.stopPropagation(), setMenu(null));
    const close = () => setMenu(null);
    window.addEventListener('keydown', k, true);
    window.addEventListener('resize', close);
    const off = useNav.subscribe(close);
    return () => {
      window.removeEventListener('keydown', k, true);
      window.removeEventListener('resize', close);
      off();
    };
  }, [menu]);

  let layout = null;
  if (menu) {
    const W = innerWidth;
    const H = innerHeight;
    const mw = 250;
    const mh = menu.items.length * 46 + 12;
    if (menu.at) {
      layout = {
        menu: {
          left: Math.min(Math.max(8, menu.at.x), W - mw - 8),
          top: Math.min(Math.max(8, menu.at.y), H - mh - 8),
        },
      };
    } else {
      const r = menu.rect;
      const pw = Math.min(r.width, W - 16);
      const ph = Math.min(r.height, H * 0.4);
      const top = Math.max(12, Math.min(r.top, H - ph - mh - 28));
      const left = Math.max(8, Math.min(r.left, W - pw - 8));
      const below = top + ph + 10;
      layout = {
        preview: { left, top, width: pw, height: ph },
        menu: { left: Math.max(8, Math.min(left, W - mw - 8)), top: below },
      };
      if (below + mh > H - 8) layout.menu.top = Math.max(8, top - mh - 10);
    }
  }
  const run = (it, i) => {
    if (it.confirm && armed !== i) {
      setArmed(i);
      haptic(null);
      return;
    }
    setMenu(null);
    it.run();
  };

  return createPortal(
    <AnimatePresence>
      {menu && (
        <motion.div key="ctx" className="fixed inset-0 z-[90]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} data-context-menu>
          <div className="v5-ctx-scrim absolute inset-0" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
          {layout.preview && (
            <motion.div
              ref={previewRef}
              initial={reduce ? { opacity: 0 } : { scale: 1, opacity: 0.6 }}
              animate={{ scale: reduce ? 1 : 1.03, opacity: 1 }}
              exit={{ scale: 1, opacity: 0 }}
              transition={spring.snappy}
              className="v5-ctx-preview pointer-events-none absolute overflow-hidden"
              style={layout.preview}
              aria-hidden="true"
            />
          )}
          <motion.div
            role="menu"
            aria-label={menu.title}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={spring.sheet}
            style={{ ...layout.menu, width: 250, transformOrigin: 'top left' }}
            className="v-menu v5-menu absolute flex flex-col p-1.5"
          >
            {menu.items.map((it, i) => (
              <motion.button
                key={it.label}
                role="menuitem"
                whileTap={{ scale: 0.97 }}
                onClick={() => run(it, i)}
                data-menu-item={it.label}
                className={`flex h-11 items-center gap-3 rounded-[12px] px-3 text-left text-[0.94rem] ${it.danger ? 'text-crit' : 'text-ink'} hover:bg-fill ${it.danger && i > 0 ? 'v5-menu-sep' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{armed === i ? it.confirm : it.label}</span>
                <Icon name={it.icon} size={17} />
              </motion.button>
            ))}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---- keyboard shortcuts (iPad with a keyboard) ------------------------------------
export const SHORTCUTS = [
  ['⌘1 – ⌘5', 'Home, Mia, Fleet, Library, HQ'],
  ['⌘K', 'Search everything'],
  ['⌘F', 'Find on this page'],
  ['⌘N', 'New document'],
  ['⌘L', 'Launch an agent'],
  ['⌘R', 'Refresh'],
  ['⌘[  or  Esc', 'Back'],
  ['⌘,', 'Settings'],
  ['⌘I', 'Insights'],
  ['⌘/', 'Show these shortcuts'],
];

export function ShortcutsHUD() {
  const [on, setOn] = useState(false); // false | 'hold' (⌘ held) | 'pinned' (⌘/)
  useEffect(() => {
    let t = 0;
    const down = (e) => {
      if (e.key === 'Meta' && !e.repeat) {
        clearTimeout(t);
        t = setTimeout(() => setOn((v) => v || 'hold'), 900);
      } else if (e.metaKey && e.key === '/') {
        e.preventDefault();
        clearTimeout(t);
        setOn((v) => (v === 'pinned' ? false : 'pinned'));
      } else if (e.key === 'Escape') setOn(false);
      else clearTimeout(t); // ⌘ + a key: a shortcut, not a look
    };
    const up = (e) => {
      if (e.key !== 'Meta') return;
      clearTimeout(t);
      setOn((v) => (v === 'hold' ? false : v)); // a held look ends with the key
    };
    const blur = () => (clearTimeout(t), setOn(false));
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return (
    <AnimatePresence>
      {on && (
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={spring.sheet}
          className="fixed inset-0 z-[95] grid place-items-center p-6"
          onClick={() => setOn(false)}
          data-shortcuts
        >
          <div className="v-menu v5-menu w-full max-w-[460px] p-5" role="dialog" aria-label="Keyboard shortcuts">
            <div className="mb-3 flex items-center gap-2 text-[1.05rem] font-bold text-ink">
              <Icon name="command" size={18} /> Mission Control
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-[0.9rem]">
              {SHORTCUTS.map(([k, what]) => (
                <div key={k} className="contents">
                  <span className="v-num font-semibold text-ink">{k}</span>
                  <span className="text-ink2">{what}</span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---- remembered place and scroll -------------------------------------------------
const LAST = 'mc.v5.last';
const SCROLL = 'mc.v5.scroll';
const FRESH_MS = 30 * 60 * 1000; // a cold launch within half an hour resumes where you were
const read = (store, k, d) => {
  try {
    return JSON.parse(store.getItem(k)) ?? d;
  } catch {
    return d;
  }
};
const write = (store, k, v) => {
  try {
    store.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};
const scrollerOfTop = () => {
  const s = useNav.getState();
  if (s.tab === 'home' && topOf(s).name === 'home') return document.querySelector('.v5-home');
  const tops = [...document.querySelectorAll('[data-page][data-top="true"]')].filter((e) => e.getClientRects().length);
  return tops.pop()?.querySelector('.v-scroll') || null;
};
const keyOf = () => hashFor(useNav.getState()) || 'home';

export function useRemembered() {
  // the place: resume a recent session (no hash = a cold launch from the icon)
  useLayoutEffect(() => {
    const last = read(localStorage, LAST, null);
    if (!location.hash && last?.hash && Date.now() - last.at < FRESH_MS) applyHash(`#${last.hash}`, { cold: true });
    let t = 0;
    const off = useNav.subscribe((s) => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (s.overlay || s.sheet) return;
        write(localStorage, LAST, { hash: hashFor(s), at: Date.now() });
      }, 250);
    });
    const beat = setInterval(() => {
      const l = read(localStorage, LAST, null);
      if (l) write(localStorage, LAST, { ...l, at: Date.now() });
    }, 60000);
    return () => (off(), clearInterval(beat));
  }, []);

  // the scroll: per place, kept for this browser session (survives a reload)
  useEffect(() => {
    const pos = read(sessionStorage, SCROLL, {});
    let raf = 0;
    const onScroll = (e) => {
      const el = e.target;
      if (!(el instanceof Element) || !(el.classList.contains('v-scroll') || el.classList.contains('v5-home'))) return;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (el !== scrollerOfTop()) return;
        pos[keyOf()] = Math.round(el.scrollTop);
        write(sessionStorage, SCROLL, pos);
      });
    };
    document.addEventListener('scroll', onScroll, true);
    // restore once, for the place we launched into, when its content is long enough
    const want = pos[keyOf()];
    let tries = 0;
    const restore = () => {
      const el = scrollerOfTop();
      if (el && want > 0 && el.scrollHeight - el.clientHeight >= want - 2) {
        el.scrollTop = want;
        return;
      }
      if (++tries < 40) setTimeout(restore, 100);
    };
    if (want > 0) setTimeout(restore, 150);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);
}
