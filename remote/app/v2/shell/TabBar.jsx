import { motion, AnimatePresence } from 'motion/react';
import { useMC, miaBadge, agentStatus, isMiaAgent } from '../../src/lib/store.js';
import { useNav, setTab, openSheet } from '../lib/nav.js';
import { spring, tap } from '../lib/motion.js';
import { useWide } from '../ui/hooks.js';
import { Icon } from '../ui/kit.jsx';
import { startVoice } from './TalkHost.jsx';
import { useTalk } from '../../src/lib/talkSession.js';

// The one piece of permanent chrome: a floating capsule at the bottom edge,
// where a thumb already is. Four places; the voice button sits apart as its
// own circle. On an iPad the labels sit beside the icons and search joins in.
// No sidebar, ever.

const ITEMS = [
  { key: 'home', label: 'Home', icon: 'sparkles' },
  { key: 'mia', label: 'Mia', icon: 'mia' },
  { key: 'agents', label: 'Agents', icon: 'agents' },
  { key: 'library', label: 'Library', icon: 'library' },
];

export default function TabBar({ hidden }) {
  const tab = useNav((s) => s.tab);
  const wide = useWide(700);
  const mia = useMC((s) => miaBadge(s.mia, s.miaLocal));
  const waiting = useMC((s) => s.agents.filter((a) => agentStatus(a) === 'waiting' && !isMiaAgent(a)).length);
  const talkOn = useTalk((s) => s.on);
  const badges = { mia, agents: waiting };

  return (
    <AnimatePresence initial={false}>
      {!hidden && (
        <motion.nav
          key="tabbar"
          initial={{ y: 120, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 120, opacity: 0 }}
          transition={spring.sheet}
          aria-label="Main"
          className="pointer-events-none fixed inset-x-0 z-50 flex items-end justify-center gap-2.5 px-3"
          style={{ bottom: 'calc(max(10px, env(safe-area-inset-bottom) - 4px) - var(--vgap, 0px))' }}
          data-tabbar
        >
          <div className={`v-bar pointer-events-auto flex items-center rounded-full p-1.5 ${wide ? 'gap-1' : 'gap-0.5'}`}>
            {ITEMS.map((it) => {
              const on = tab === it.key;
              const b = badges[it.key] || 0;
              return (
                <motion.button
                  key={it.key}
                  {...tap}
                  onClick={() => setTab(it.key)}
                  aria-label={it.label}
                  aria-current={on ? 'page' : undefined}
                  data-tab={it.key}
                  className={`relative flex items-center justify-center rounded-full transition-colors ${
                    wide ? 'h-11 gap-2 px-4' : 'h-[52px] w-[66px] flex-col gap-0.5'
                  } ${on ? 'text-ink' : 'text-ink3 hover:text-ink2'}`}
                >
                  {on && <motion.span layoutId="tab-pill" transition={spring.snappy} className="absolute inset-0 rounded-full bg-fill2" />}
                  <span className="relative">
                    <Icon name={it.icon} size={wide ? 18 : 21} strokeWidth={on ? 2.2 : 1.9} />
                    <AnimatePresence>
                      {b > 0 && (
                        <motion.span
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          exit={{ scale: 0 }}
                          transition={spring.snappy}
                          className={`v-num absolute -right-2.5 -top-1.5 grid h-[17px] min-w-[17px] place-items-center rounded-full px-1 text-[10px] font-bold ${
                            it.key === 'agents' ? 'bg-warn text-[#241a02]' : 'bg-accent text-accent-ink'
                          }`}
                          data-badge={it.key}
                        >
                          {b > 99 ? '99+' : b}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                  <span className={`relative font-semibold tracking-[-0.01em] ${wide ? 'text-[0.86rem]' : 'text-[0.66rem]'}`}>{it.label}</span>
                </motion.button>
              );
            })}
            {wide && (
              <>
                <span className="mx-1 h-6 w-px bg-hair2" />
                <motion.button
                  {...tap}
                  onClick={() => openSheet('search')}
                  aria-label="Search"
                  data-tab-search
                  className="flex h-11 items-center gap-2 rounded-full px-4 text-ink3 transition-colors hover:text-ink2"
                >
                  <Icon name="search" size={18} strokeWidth={1.9} />
                  <span className="text-[0.86rem] font-semibold">Search</span>
                  <kbd className="rounded-md bg-fill px-1.5 py-0.5 font-sans text-[0.7rem] font-semibold text-ink3">⌘K</kbd>
                </motion.button>
              </>
            )}
          </div>
          <motion.button
            {...tap}
            onClick={() => startVoice()}
            aria-label={talkOn ? 'Back to the conversation' : 'Talk to Mia'}
            data-tab-talk
            className={`pointer-events-auto grid flex-none place-items-center rounded-full ${wide ? 'h-14 w-14' : 'h-16 w-16'} ${
              talkOn ? 'bg-accent text-accent-ink' : 'v-bar text-ink'
            }`}
          >
            <Icon name="mic" size={wide ? 21 : 23} strokeWidth={2} />
          </motion.button>
        </motion.nav>
      )}
    </AnimatePresence>
  );
}
