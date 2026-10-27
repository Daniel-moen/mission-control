import { useEffect, useRef } from 'react';
import { useTalk } from '../src/lib/talkSession.js';
import { usePrefs } from '../v2/lib/prefs.js';

// Mia's orb (task 0491, one of v5.2's "cool things"): her presence, live.
//   idle      a slow breath of light
//   thinking  the colours swirl faster (she's writing, or her agents work)
//   talk      the orb listens: it swells and ripples with the mic level
//             (the talk engine's level listeners, lib/talkSession.js), and
//             a ring of bars around it is the waveform
//   off       grey and still (Mia off / the Mac offline)
// Pure CSS layers driven by custom properties — one rAF writes --lvl while
// talking; nothing re-renders per frame. Reduced motion: still, colour only.

const BARS = 18;

export default function Orb({ state = 'idle', size = 32, onClick, label = 'Mia', className = '', ...rest }) {
  const ref = useRef(null);
  const levels = useTalk((s) => s.levels);
  const talking = useTalk((s) => s.on);
  const reduce = usePrefs((s) => s.reduce);
  const mode = talking ? 'talk' : state;

  // the mic level → --lvl (smoothed), only while talking
  useEffect(() => {
    const el = ref.current;
    if (!el || !levels || reduce) return undefined;
    let target = 0;
    let cur = 0;
    let raf = 0;
    const on = (v) => (target = Math.max(0, Math.min(1, Number(v) || 0)));
    levels.add(on);
    const tick = () => {
      cur += (target - cur) * 0.25;
      el.style.setProperty('--lvl', cur.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      levels.delete(on);
      cancelAnimationFrame(raf);
      el.style.setProperty('--lvl', '0');
    };
  }, [levels, reduce]);

  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      ref={ref}
      onClick={onClick}
      aria-label={onClick ? label : undefined}
      aria-hidden={onClick ? undefined : 'true'}
      className={`v52-orb ${reduce ? 'still' : ''} ${className}`}
      data-orb={mode}
      style={{ '--orb': `${size}px` }}
      {...rest}
    >
      {mode === 'talk' && (
        <span className="v52-orb-wave" aria-hidden="true">
          {Array.from({ length: BARS }, (_, i) => (
            <i key={i} style={{ '--a': `${(360 / BARS) * i}deg`, '--d': `${(i % 5) * 0.11}s` }} />
          ))}
        </span>
      )}
      <span className="v52-orb-core" />
      <span className="v52-orb-swirl" />
      <span className="v52-orb-gloss" />
    </Tag>
  );
}
