import { motion, LayoutGroup, AnimatePresence } from 'motion/react';
import { useMC, miaBadge, agentStatus, isMiaAgent, reconnectNow, dataAge } from '../src/lib/store.js';
import { useUsage, worstWindow, levelOf } from '../src/lib/usage.js';
import { useTalk } from '../src/lib/talkSession.js';
import { goView, openSheet, push } from '../v2/lib/nav.js';
import { spring, tap } from '../v2/lib/motion.js';
import { Icon } from '../v2/ui/kit.jsx';
import { startVoice } from '../v2/shell/TalkHost.jsx';

// v5's chrome (task 0483) — v1's two pieces, in Lens glass:
//   • the top bar: time and date on the left; on the right Claude usage
//     (past 80%), the link, Search, Launch, Settings. Nothing else.
//   • the dock: Mia · Home · HQ · Fleet · Insights · Library, one highlight
//     gliding between them, the mic as the raised circle, Launch on an iPad.
//     'compact' (icons only) under a report; 'none' in Mia's chat.
// Both float over content, so they're CSS glass with a real backdrop blur
// (what scrolls under them is frosted, never cut off by a shader pane).

const LINK = {
  linked: { dot: 'bg-accent', label: 'Live' },
  relay: { dot: 'bg-warn', label: 'Mac offline' },
  offline: { dot: 'bg-ink3', label: 'Reconnecting…' },
};

function Clock({ now }) {
  const d = new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return (
    <div className="flex min-w-0 items-baseline gap-2.5" title={d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}>
      <span className="v5-hero-title v-num text-[1.25rem] font-light leading-none tracking-tight">{`${p(d.getHours())}:${p(d.getMinutes())}`}</span>
      <span className="v5-hero-sub truncate text-[0.8rem] font-medium">
        <span className="hidden md:inline">{d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        <span className="md:hidden">{d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      </span>
    </div>
  );
}

function Btn({ icon, label, onClick, ...rest }) {
  return (
    <motion.button {...tap} onClick={onClick} aria-label={label} title={label} className="v5-chip grid h-9 w-9 flex-none place-items-center rounded-full text-ink" {...rest}>
      <Icon name={icon} size={17} />
    </motion.button>
  );
}

export function TopBar() {
  const now = useMC((s) => s.now);
  const link = useMC((s) => s.link);
  const http = useMC((s) => s.transport) === 'poll';
  const usage = useUsage((s) => s.usage);
  const l = LINK[link] || LINK.offline;
  const worst = worstWindow(usage, now || Date.now());
  const lvl = worst ? levelOf(worst.pct) : 'ok';
  const age = link !== 'linked' ? dataAge() : null;
  const via = http ? `${l.label} · over HTTP (WebSocket blocked on this network)` : l.label;
  return (
    <header className="v5-topbar fixed inset-x-0 top-0 z-30 flex items-center gap-3 px-4 sm:px-6" data-topbar style={{ paddingTop: 'calc(env(safe-area-inset-top) + 10px)' }}>
      <Clock now={now} />
      <div className="ml-auto flex flex-none items-center gap-1.5">
        {worst && lvl !== 'ok' && (
          <motion.button
            {...tap}
            onClick={() => place('insights')}
            className={`v5-chip flex h-9 items-center gap-1.5 rounded-full px-3 text-[0.78rem] font-semibold ${lvl === 'crit' ? 'text-crit' : 'text-warn'}`}
            title={`${worst.label}: ${Math.round(worst.pct)}% used`}
            data-usage-pill
          >
            <Icon name="gauge" size={15} />
            <span className="v-num">{Math.round(worst.pct)}%</span>
          </motion.button>
        )}
        <motion.button
          {...tap}
          onClick={() => link !== 'linked' && reconnectNow()}
          title={age != null ? `Last data ${age}s ago` : via}
          aria-label={via}
          className="v5-chip flex h-9 items-center gap-1.5 rounded-full px-3 text-[0.78rem] font-semibold text-ink"
          data-link={link}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${l.dot} ${link === 'linked' ? '' : 'v-breathe'}`} />
          <span className="hidden sm:inline">{l.label}</span>
          {http && <span className="text-[0.62rem] tracking-[0.08em] text-ink3">HTTP</span>}
        </motion.button>
        <Btn icon="search" label="Search — ⌘K" onClick={() => openSheet('search')} data-top-search />
        <Btn icon="launch" label="Launch an agent" onClick={() => openSheet('launch')} data-top-launch />
        <Btn icon="settings" label="Settings" onClick={() => goSettings()} data-open-settings />
      </div>
    </header>
  );
}

// A place from the dock (v1's windows). Mia, Fleet and Library each keep
// their own stack (a doc you opened is still there when you come back);
// Insights, HQ and Settings open over Home, so Back returns to Home.
export function place(key) {
  if (key === 'insights' || key === 'hq' || key === 'settings' || key === 'channels') {
    goView('home');
    return key === 'channels' ? push('hq', { section: 'channels' }) : push(key, {});
  }
  return goView(key);
}
export const goSettings = () => place('settings');

const ITEMS = [
  { key: 'mia', label: 'Mia', icon: 'mia' },
  { key: 'home', label: 'Home', icon: 'sparkles' },
  { key: 'hq', label: 'HQ', icon: 'hq' },
  { key: 'fleet', label: 'Fleet', icon: 'agents' },
  { key: 'insights', label: 'Insights', icon: 'overview' },
  { key: 'library', label: 'Library', icon: 'library' },
];

export function Dock({ mode = 'full', active = 'home', wide = false }) {
  const mia = useMC((s) => miaBadge(s.mia, s.miaLocal));
  const waiting = useMC((s) => s.agents.filter((a) => agentStatus(a) === 'waiting' && !isMiaAgent(a)).length);
  const talkOn = useTalk((s) => s.on);
  const badges = { mia, fleet: waiting };
  const slim = mode === 'compact';
  return (
    <AnimatePresence initial={false}>
      {mode !== 'none' && (
        <motion.div
          key="dock"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 40 }}
          transition={spring.sheet}
          className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-2"
          style={{ bottom: `calc(env(safe-area-inset-bottom) + ${slim ? 8 : 12}px - var(--vgap, 0px))` }}
          data-dock={mode}
        >
          <LayoutGroup id="v5-dock">
            <nav aria-label="Main" className={`v5-dock pointer-events-auto flex items-center rounded-full ${slim ? 'gap-0.5 p-1' : 'gap-0.5 p-1.5 sm:gap-1'}`}>
              {ITEMS.map((it) => {
                const on = active === it.key;
                const b = badges[it.key] || 0;
                return (
                  <motion.button
                    {...tap}
                    key={it.key}
                    onClick={() => place(it.key)}
                    aria-label={b ? `${it.label}, ${b} new` : it.label}
                    aria-current={on ? 'page' : undefined}
                    data-tab={it.key}
                    className={`relative flex items-center justify-center rounded-full font-semibold transition-colors ${
                      slim ? 'h-9 w-10' : wide ? 'h-11 gap-2 px-4 text-[0.84rem]' : 'h-11 w-[46px]'
                    } ${on ? 'text-ink' : 'text-ink2 hover:text-ink'}`}
                  >
                    {on && <motion.span layoutId="v5-dock-pill" transition={spring.snappy} className="v5-dock-pill absolute inset-0 rounded-full" />}
                    <span className="relative flex">
                      <Icon name={it.icon} size={slim ? 17 : 19} strokeWidth={on ? 2.2 : 1.9} />
                      {b > 0 && (
                        <span
                          className={`v-num absolute -right-2.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[0.6rem] font-bold leading-none ${it.key === 'fleet' ? 'bg-warn text-[#241a02]' : 'bg-accent text-accent-ink'}`}
                          data-badge={it.key}
                        >
                          {b > 9 ? '9+' : b}
                        </span>
                      )}
                    </span>
                    {wide && !slim && <span className="relative">{it.label}</span>}
                  </motion.button>
                );
              })}
              <span className="mx-1 h-6 w-px flex-none bg-hair2" />
              <motion.button
                {...tap}
                onClick={() => startVoice()}
                aria-label={talkOn ? 'Back to the conversation' : 'Talk to Mia'}
                data-tab-talk
                className={`grid flex-none place-items-center rounded-full ${slim ? 'h-9 w-9' : 'h-11 w-11'} ${talkOn ? 'bg-accent text-accent-ink' : 'bg-ink text-page'}`}
              >
                <Icon name="mic" size={slim ? 17 : 20} strokeWidth={2} />
              </motion.button>
              {wide && !slim && (
                <motion.button {...tap} onClick={() => openSheet('launch')} className="v5-chip ml-1 flex h-11 items-center gap-2 rounded-full px-4 text-[0.84rem] font-semibold text-ink" data-dock-launch>
                  <Icon name="launch" size={17} />
                  Launch
                </motion.button>
              )}
            </nav>
          </LayoutGroup>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
