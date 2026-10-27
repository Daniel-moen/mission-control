import { motion, LayoutGroup, AnimatePresence } from 'motion/react';
import { useMC, miaBadge, agentStatus, isMiaAgent, reconnectNow, dataAge } from '../src/lib/store.js';
import { useUsage, worstWindow, levelOf } from '../src/lib/usage.js';
import { useTalk } from '../src/lib/talkSession.js';
import { goView, openSheet, push } from '../v2/lib/nav.js';
import { spring, tap } from '../v2/lib/motion.js';
import { Icon } from '../v2/ui/kit.jsx';
import { startVoice } from '../v2/shell/TalkHost.jsx';

// v5's chrome (task 0483; v5.1 0486: five tabs + the mic beside them, one
// status pill, the tools in one capsule) — v1's two pieces, in Lens glass:
//   • the top bar: time and date on the left; on the right Claude usage
//     (past 80%), the link, Search, Launch, Settings. Nothing else.
//   • the dock — an iOS tab bar: Home · Mia · Fleet · Library · Insights · HQ,
//     labelled, one highlight gliding between them, the mic as the raised
//     circle. Launch lives once, in the top bar (task 0484: Apple's restraint).
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
    <motion.button {...tap} onClick={onClick} aria-label={label} title={label} className="grid h-9 w-10 flex-none place-items-center rounded-full text-ink hover:bg-fill" {...rest}>
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
  const hot = worst && lvl !== 'ok';
  const age = link !== 'linked' ? dataAge() : null;
  const via = http ? `${l.label} · over HTTP (WebSocket blocked on this network)` : l.label;
  // v5.1 (task 0486): one status pill — the link, and Claude usage only when
  // it's high (tap: reconnect when you're not live, else Insights) — and the
  // three tools in one capsule.
  return (
    <header className="v5-topbar fixed inset-x-0 top-0 z-30 flex items-center gap-3 px-4 sm:px-6" data-topbar style={{ paddingTop: 'calc(env(safe-area-inset-top) + 10px)' }}>
      <div className="max-sm:hidden">
        <Clock now={now} />
      </div>
      <div className="flex flex-none items-center gap-1.5 sm:ml-auto">
        <motion.button
          {...tap}
          onClick={() => (link !== 'linked' ? reconnectNow() : place('insights'))}
          title={[age != null ? `Last data ${age}s ago` : via, hot ? `${worst.label}: ${Math.round(worst.pct)}% used` : ''].filter(Boolean).join(' · ')}
          aria-label={[via, hot ? `Claude usage ${Math.round(worst.pct)}%` : ''].filter(Boolean).join(', ')}
          className="v5-chip flex h-9 items-center gap-2 rounded-full px-3 text-[0.78rem] font-semibold text-ink"
          data-link={link}
          data-status-pill
        >
          <span className={`h-2 w-2 rounded-full ${l.dot} ${link === 'linked' ? '' : 'v-breathe'}`} />
          <span className={hot ? 'hidden md:inline' : 'max-[380px]:hidden'}>{l.label}</span>
          {http && <span className="text-[0.62rem] tracking-[0.08em] text-ink3">HTTP</span>}
          {hot && (
            <span className={`flex items-center gap-1 ${lvl === 'crit' ? 'text-crit' : 'text-warn'}`} data-usage-pill>
              <Icon name="gauge" size={14} />
              <span className="v-num">{Math.round(worst.pct)}%</span>
            </span>
          )}
        </motion.button>
      </div>
      <div className="ml-auto flex flex-none items-center gap-1.5 sm:ml-0">
        <div className="v5-chip flex items-center rounded-full" data-top-group>
          <Btn icon="search" label="Search — ⌘K" onClick={() => openSheet('search')} data-top-search />
          <Btn icon="launch" label="Launch an agent — ⌘L" onClick={() => openSheet('launch')} data-top-launch />
          <Btn icon="settings" label="Settings — ⌘," onClick={() => goSettings()} data-open-settings />
        </div>
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

// Five tabs, as Apple caps an iPhone tab bar (task 0486): Home first, then
// what you use most. Insights is a page of Home now — its figures open it,
// as do Fleet's usage row, the status pill and ⌘I. Every tab is labelled.
const ITEMS = [
  { key: 'home', label: 'Home', icon: 'sparkles' },
  { key: 'mia', label: 'Mia', icon: 'mia' },
  { key: 'fleet', label: 'Fleet', icon: 'agents' },
  { key: 'library', label: 'Library', icon: 'library' },
  { key: 'hq', label: 'HQ', icon: 'hq' },
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
                      slim ? 'h-9 w-11' : wide ? 'h-11 gap-2 px-5 text-[0.84rem]' : 'h-[50px] w-[58px] flex-col gap-[3px] max-[379px]:w-[52px]'
                    } ${on ? 'v5-tab-on' : 'text-ink2 hover:text-ink'}`}
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
                    {!slim && <span className={`relative leading-none ${wide ? '' : 'text-[0.625rem] font-medium tracking-[0.01em]'}`}>{it.label}</span>}
                  </motion.button>
                );
              })}
            </nav>
            {/* the mic: its own glass circle beside the bar (iOS 26's tab-bar accessory) */}
            <motion.button
              {...tap}
              onClick={() => startVoice()}
              aria-label={talkOn ? 'Back to the conversation' : 'Talk to Mia'}
              title="Talk to Mia"
              data-tab-talk
              className={`v5-dock pointer-events-auto ml-2 grid flex-none place-items-center rounded-full ${slim ? 'h-11 w-11' : wide ? 'h-[58px] w-[58px]' : 'h-[62px] w-[62px]'} ${talkOn ? 'v5-mic-on' : 'text-ink'}`}
            >
              <Icon name="mic" size={slim ? 18 : 22} strokeWidth={2} />
            </motion.button>
          </LayoutGroup>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
