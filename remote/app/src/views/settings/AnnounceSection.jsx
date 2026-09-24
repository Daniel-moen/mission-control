import { useLocalStorage } from '../../lib/hooks.js';
import { ANNOUNCE_MODE_KEY, QUIET_KEY, QUIET_DEFAULT } from '../../lib/announce.js';
import Segmented from '../../ui/Segmented.jsx';

// Settings › Announcements — when Mia may speak up on this panel with talk
// mode off (lib/announce.js). Settings owns Section/Row; they're passed in.
const TIME = 'h-9 rounded-xl border border-glass-line bg-white/[0.05] px-2 font-mono text-[12.5px] text-ink tnum';

export default function AnnounceSection({ Section, Row }) {
  const [mode, setMode] = useLocalStorage(ANNOUNCE_MODE_KEY, 'important');
  const [quiet, setQuiet] = useLocalStorage(QUIET_KEY, QUIET_DEFAULT);
  const q = { ...QUIET_DEFAULT, ...(quiet || {}) };
  return (
    <Section title="Announcements">
      <Row
        label="Mia speaks up"
        hint="With the panel open and talk mode off, Mia reads out what needs you — a chime, then one sentence. Tap the mic in the top bar to answer. Never while the app is in the background."
      >
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'all', label: 'All' },
            { value: 'important', label: 'Questions & alerts' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </Row>
      <Row label="Quiet hours" hint={q.on ? `Silent from ${q.from} to ${q.to}.` : 'Off — Mia may speak at any hour.'} last>
        <div className="flex items-center gap-2">
          {q.on && (
            <>
              <input
                type="time"
                aria-label="Quiet from"
                value={q.from}
                onChange={(e) => e.target.value && setQuiet({ ...q, from: e.target.value })}
                className={TIME}
              />
              <span className="text-[12px] text-ink3">to</span>
              <input
                type="time"
                aria-label="Quiet until"
                value={q.to}
                onChange={(e) => e.target.value && setQuiet({ ...q, to: e.target.value })}
                className={TIME}
              />
            </>
          )}
          <Segmented
            value={q.on ? 'on' : 'off'}
            onChange={(v) => setQuiet({ ...q, on: v === 'on' })}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </div>
      </Row>
    </Section>
  );
}
