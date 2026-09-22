import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

// The photograph is the only decoration in the app; everything else is calm
// glass floating on top of it. Images live in /bg (curated separately) with a
// manifest describing each one's time-of-day tone. Until that manifest exists
// the deep graphite gradient on <body> shows through — never a white flash.

const LS_KEY = 'mc.backdrop';

function toneNow(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}

function readOverride() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || 'null') || {};
  } catch {
    return {};
  }
}

export default function Backdrop() {
  const reduce = useReducedMotion();
  const [src, setSrc] = useState(null);
  const [override, setOverride] = useState(readOverride);
  const dim = typeof override.dim === 'number' ? override.dim : 0.2;

  // Settings writes the override and fires `mc:backdrop`; another tab's edit
  // arrives as `storage`. Either way the scene follows without a reload.
  useEffect(() => {
    const sync = () => setOverride(readOverride());
    window.addEventListener('mc:backdrop', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('mc:backdrop', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    let dead = false;
    // An explicit override wins outright — no fetch needed.
    if (override.url) {
      setSrc(override.url);
      return;
    }
    fetch('/bg/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (dead || !Array.isArray(list) || !list.length) return;
        if (override.file) {
          const hit = list.find((e) => e.file === override.file);
          if (hit) return setSrc(`/bg/${hit.file}`);
        }
        const tone = toneNow();
        const pool = list.filter((e) => e.tone === tone);
        const set = pool.length ? pool : list;
        // Rotate within the tone set each visit, so the scene isn't identical
        // every morning but also isn't a slideshow within one session.
        const pick = set[Math.floor(Math.random() * set.length)];
        setSrc(`/bg/${pick.file}`);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [override.url, override.file]);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <AnimatePresence>
        {src && (
          <motion.img
            key={src}
            src={src}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9 }}
            className={`absolute inset-0 h-full w-full object-cover ${reduce ? '' : 'anim-drift'}`}
          />
        )}
      </AnimatePresence>
      {/* Legibility scrims: the clock lives up top, the dock and cards down
          low, so both ends get darker than the middle. */}
      <div className="absolute inset-0" style={{ background: `rgba(6,6,8,${dim})` }} />
      <div className="absolute inset-x-0 top-0 h-[32%] bg-gradient-to-b from-black/55 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-[42%] bg-gradient-to-t from-black/70 to-transparent" />
    </div>
  );
}
