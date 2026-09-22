import { useMemo } from 'react';
import { useMC, clockOf } from '../../lib/store.js';
import { Section, Head } from './parts.jsx';

// Live event stream across the whole fleet. The store records every change to
// an agent's current activity (trackActivity); this surfaces it newest-first —
// the fastest way to see what all your agents are doing without opening each
// one. A row is clickable only while its agent is still in the snapshot.
export default function ActivityFeed({ onOpen }) {
  const activity = useMC((s) => s.activity);
  const agents = useMC((s) => s.agents);

  const events = useMemo(() => activity.slice(-60).reverse(), [activity]);
  const live = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);

  return (
    <Section className="overflow-hidden">
      <Head title="Activity" meta={`${events.length} events`} className="px-4 py-3 sm:px-5" />
      {events.length ? (
        <div className="noscroll max-h-[320px] overflow-y-auto border-t border-glass-line">
          {events.map((e, i) => {
            const on = e.id && live.has(e.id);
            return (
              <button
                key={`${e.t}-${e.folder}-${i}`}
                onClick={() => on && onOpen?.(e.id)}
                className={`flex min-h-10 w-full items-baseline gap-3 border-b border-white/[0.06] px-4 py-2 text-left transition-colors last:border-0 sm:px-5 ${
                  on ? 'hover:bg-white/[0.07]' : 'cursor-default'
                }`}
              >
                <span className="tnum flex-none text-[11px] text-ink3">{clockOf(e.t)}</span>
                <span
                  className={`max-w-[34%] flex-none truncate text-[12px] font-medium ${on ? 'text-ink' : 'text-ink3'}`}
                >
                  {e.who || e.folder}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink2">{e.text}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="border-t border-glass-line px-5 py-10 text-center text-[12.5px] text-ink3">
          Events appear here as agents work.
        </div>
      )}
    </Section>
  );
}
