import { motion, LayoutGroup } from 'motion/react';
import { spring, press } from '../lib/motion.js';
import { useMedia } from '../lib/hooks.js';
import Icon from '../ui/Icon.jsx';
import Button from '../ui/Button.jsx';

const ITEMS = [
  { key: 'home', label: 'Home', icon: 'sparkles' },
  { key: 'fleet', label: 'Fleet', icon: 'agents' },
  { key: 'insights', label: 'Insights', icon: 'overview' },
  { key: 'library', label: 'Library', icon: 'library' },
];

// The floating dock. One highlight glides between segments (shared layoutId);
// the mic is the raised primary, because talking to the fleet is the fastest
// thing you can do from a phone in a mount.
export default function Dock({ active = 'home', onSelect, onMic, onLaunch }) {
  const desktop = useMedia('(min-width: 1024px)');
  return (
    <LayoutGroup id="dock">
      <div
        // Above the phone's full-screen windows (z-50) so navigation never
        // disappears, and so a window's blur doesn't sample the dock.
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 14px)' }}
      >
        <motion.nav
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring.smooth}
          className="glass pointer-events-auto flex items-center gap-1 p-1.5"
          style={{ borderRadius: 9999 }}
        >
          {ITEMS.map((it) => {
            const on = active === it.key;
            return (
              <motion.button
                {...press}
                key={it.key}
                onClick={() => onSelect?.(it.key)}
                aria-label={it.label}
                aria-pressed={on}
                className={`pill relative flex h-11 items-center gap-2 px-3.5 text-[13px] font-medium transition-colors sm:px-4 ${
                  on ? 'text-ink' : 'text-ink2 hover:text-ink'
                }`}
              >
                {on && (
                  <motion.span
                    layoutId="dock-pill"
                    transition={spring.snappy}
                    className="pill absolute inset-0 bg-white/[0.14]"
                  />
                )}
                <span className="relative flex items-center gap-2">
                  <Icon name={it.icon} size={18} />
                  <span className="hidden sm:inline">{it.label}</span>
                </span>
              </motion.button>
            );
          })}

          <span className="mx-1 h-6 w-px flex-none bg-white/15" />

          <motion.button
            {...press}
            onClick={onMic}
            aria-label="Voice command"
            className="grid h-11 w-11 flex-none place-items-center rounded-full bg-ink text-bg shadow-2"
          >
            <Icon name="mic" size={20} strokeWidth={2} />
          </motion.button>

          {desktop && (
            <Button variant="secondary" icon="launch" onClick={onLaunch} className="ml-1 h-11">
              Launch
            </Button>
          )}
        </motion.nav>
      </div>
    </LayoutGroup>
  );
}
