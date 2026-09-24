import { useNow, useLink } from '../lib/hooks.js';
import { useMC, reconnectNow, dataAge } from '../lib/store.js';
import { motion } from 'motion/react';
import { fadeIn, press } from '../lib/motion.js';
import IconButton from '../ui/IconButton.jsx';

const LINK = {
  linked: { dot: 'bg-accent', label: 'Live', ping: false },
  relay: { dot: 'bg-warn', label: 'Mac offline', ping: true },
  offline: { dot: 'bg-ink3', label: 'Reconnecting…', ping: true },
};

// The scene's chrome, kept to one slim row: the time and date on the left,
// what the link is doing and the three things you always need on the right.
// Nothing else lives up here — every pixel it takes is a pixel a window loses.
export default function TopBar({ onPalette, onLaunch, onSettings }) {
  const now = useNow();
  const link = useLink();
  const l = LINK[link] || LINK.offline;
  // On the HTTP fallback the link works the same, it just says how it's riding.
  const http = useMC((s) => s.transport) === 'poll';
  const via = http ? `${l.label} · over HTTP (WebSocket blocked on this network)` : l.label;
  const d = new Date(now || Date.now());
  const longDate = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const shortDate = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const p = (n) => String(n).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const age = link !== 'linked' ? dataAge() : null;

  return (
    <motion.header
      {...fadeIn}
      className="relative z-30 flex items-center gap-3 px-4 pb-1.5 sm:px-6"
      // --talkbar: room for the voice pill on narrow screens (shell/TalkHost.jsx).
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 8px + var(--talkbar, 0px))' }}
    >
      <div className="flex min-w-0 items-baseline gap-2.5" title={longDate}>
        <span className="text-[19px] font-light leading-none tracking-tight text-ink tnum">{clock}</span>
        <span className="truncate text-[12.5px] font-medium text-ink2">
          <span className="hidden md:inline">{longDate}</span>
          <span className="md:hidden">{shortDate}</span>
        </span>
      </div>

      <div className="ml-auto flex flex-none items-center gap-1.5">
        <motion.button
          {...press}
          onClick={() => link !== 'linked' && reconnectNow()}
          title={age != null ? `Last data ${age}s ago` : via}
          aria-label={via}
          className="glass-soft glass-soft-hover pill hidden h-8 items-center gap-1.5 px-3 text-[12px] font-medium text-ink transition-colors sm:inline-flex"
        >
          <span className="relative flex h-1.5 w-1.5 flex-none">
            {l.ping && <span className={`anim-ping absolute inline-flex h-full w-full rounded-full ${l.dot} opacity-60`} />}
            <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${l.dot}`} />
          </span>
          {l.label}
          {http && <span className="-ml-0.5 text-[10px] font-medium tracking-[0.08em] text-ink3">HTTP</span>}
        </motion.button>

        {/* phone: the pill collapses to just the dot */}
        <button
          onClick={() => link !== 'linked' && reconnectNow()}
          aria-label={via}
          className={`glass-soft pill h-8 sm:hidden ${http ? 'inline-flex items-center gap-1.5 px-2.5' : 'grid w-8 place-items-center'}`}
        >
          <span className="relative flex h-1.5 w-1.5">
            {l.ping && <span className={`anim-ping absolute inline-flex h-full w-full rounded-full ${l.dot} opacity-60`} />}
            <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${l.dot}`} />
          </span>
          {http && <span className="text-[10px] font-medium tracking-[0.08em] text-ink3">HTTP</span>}
        </button>

        <IconButton icon="search" label="Search — ⌘K" size="sm" variant="glass" onClick={onPalette} />
        <IconButton icon="launch" label="Launch an agent" size="sm" variant="glass" onClick={onLaunch} />
        <IconButton icon="settings" label="Settings" size="sm" variant="glass" onClick={onSettings} />
      </div>
    </motion.header>
  );
}
