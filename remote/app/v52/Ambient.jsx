import { useEffect, useRef } from 'react';
import { useMC } from '../src/lib/store.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { useExecutors } from './Rings.jsx';

// The room reacts (task 0491, a "cool thing"): soft light over the photo
// that drifts with what's going on. Nothing running: it hangs almost still.
// Executors working: the light moves, a little more for each (up to four),
// and warms to amber while one is waiting on Daniel. A message from Mia
// sends a gentle swell of light up from the composer.
// Compositor-only (transforms + opacity on three blurred blobs; the speed is
// the animations' playbackRate, so nothing restarts). Reduced motion: still.
// Lite glass: still and fainter.

export default function Ambient({ thinking = false }) {
  const ref = useRef(null);
  const ex = useExecutors();
  const reduce = usePrefs((s) => s.reduce);
  const lite = usePrefs((s) => s.lite);
  const lastMia = useMC((s) => {
    const m = s.mia?.messages;
    for (let i = (m?.length || 0) - 1; i >= 0; i--) if (m[i].from === 'mia') return m[i].id || m[i].at || i;
    return null;
  });
  const working = ex.filter((a) => a.status === 'active').length + (thinking ? 1 : 0);
  const waiting = ex.length - ex.filter((a) => a.status === 'active').length;
  const level = Math.min(4, working);
  const still = reduce || lite;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.dataset.level = String(level);
    el.dataset.warm = waiting > 0 ? '1' : '0';
    const rate = still ? 0 : level === 0 ? 0.18 : 0.7 + level * 0.45;
    for (const a of el.getAnimations({ subtree: true })) {
      if (a.animationName?.startsWith('v52-drift')) a.updatePlaybackRate ? a.updatePlaybackRate(rate) : (a.playbackRate = rate);
    }
  }, [level, waiting, still]);

  // a swell when Mia speaks (not on first load)
  const seen = useRef(lastMia);
  useEffect(() => {
    if (lastMia === seen.current) return;
    seen.current = lastMia;
    const el = ref.current?.querySelector('.v52-swell');
    if (!el || still) return;
    el.animate(
      [
        { opacity: 0, transform: 'translate(-50%, 30%) scale(0.6)' },
        { opacity: 0.85, transform: 'translate(-50%, 0%) scale(1)', offset: 0.35 },
        { opacity: 0, transform: 'translate(-50%, -25%) scale(1.25)' },
      ],
      { duration: 1800, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' },
    );
  }, [lastMia, still]);

  return (
    <div ref={ref} className={`v52-ambient ${still ? 'still' : ''} ${lite ? 'lite' : ''}`} aria-hidden="true" data-ambient>
      <i className="v52-blob a" />
      <i className="v52-blob b" />
      <i className="v52-blob c" />
      <i className="v52-swell" />
    </div>
  );
}
