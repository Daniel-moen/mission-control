import { useNow, useLink } from '../lib/hooks.js';
import { reconnectNow, dataAge } from '../lib/store.js';
import { motion } from 'motion/react';
import { fadeIn, press } from '../lib/motion.js';
import IconButton from '../ui/IconButton.jsx';

const LINK = {
  linked: { dot: 'bg-accent', label: 'Live', ping: false },
  relay: { dot: 'bg-warn', label: 'Mac offline', ping: true },
  offline: { dot: 'bg-ink3', label: 'Reconnecting…', ping: true },
};

// The scene's chrome: what time it is on the left, what the link is doing and
// the three things you always need on the right. Nothing else lives up here.
export default function TopBar({ onPalette, onLaunch, onSettings }) {
  const now = useNow();
  const link = useLink();
  const l = LINK[link] || LINK.offline;
  const d = new Date(now || Date.now());
  const date = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const p = (n) => String(n).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const age = link !== 'linked' ? dataAge() : null;

  return (
    <motion.header
      {...fadeIn}
      className="relative z-30 flex items-start gap-4 px-5 pb-2 sm:px-8"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 18px)' }}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink2 sm:text-[15px]">{date}</div>
        <div className="mt-0.5 text-[30px] font-extralight leading-none tracking-tight text-ink tnum sm:text-[44px]">
          {clock}
        </div>
      </div>

      <div className="ml-auto flex flex-none items-center gap-2 pt-0.5">
        <motion.button
          {...press}
          onClick={() => link !== 'linked' && reconnectNow()}
          title={age != null ? `Last data ${age}s ago` : l.label}
          className="glass-soft glass-soft-hover pill hidden h-9 items-center gap-2 px-3.5 text-[12.5px] font-medium text-ink transition-colors sm:inline-flex"
        >
          <span className="relative flex h-2 w-2 flex-none">
            {l.ping && <span className={`anim-ping absolute inline-flex h-full w-full rounded-full ${l.dot} opacity-60`} />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${l.dot}`} />
          </span>
          {l.label}
        </motion.button>

        {/* phone: the pill collapses to just the dot */}
        <button
          onClick={() => link !== 'linked' && reconnectNow()}
          aria-label={l.label}
          className="glass-soft pill grid h-9 w-9 place-items-center sm:hidden"
        >
          <span className="relative flex h-2 w-2">
            {l.ping && <span className={`anim-ping absolute inline-flex h-full w-full rounded-full ${l.dot} opacity-60`} />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${l.dot}`} />
          </span>
        </button>

        <IconButton icon="search" label="Search — ⌘K" variant="glass" onClick={onPalette} />
        <IconButton icon="launch" label="Launch an agent" variant="glass" onClick={onLaunch} />
        <IconButton icon="settings" label="Settings" variant="glass" onClick={onSettings} />
      </div>
    </motion.header>
  );
}
