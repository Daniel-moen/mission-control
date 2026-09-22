import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';

// The photograph, for the two full-screen takeovers.
//
// `shell/Backdrop.jsx` paints the same image for the app, but #tv and #car are
// TAKEOVERS: they cover the whole shell, so they need their own opaque base
// (otherwise the Home headline, the dock and the attention cards smear through
// the scrim as coloured ghosts). Same contract as the shell backdrop — the
// `mc.backdrop` override from Settings, the /bg manifest, time of day — so
// whichever scene you are in, you are looking at the same picture.

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

// `dim` is the user's slider (Settings → Backdrop); `extra` is how much darker
// this particular scene needs to be on top of it — a car at night and a wall
// display both want more than the app does.
export default function ModeBackdrop({ extra = 0.35 }) {
  const reduce = useReducedMotion();
  const [src, setSrc] = useState(null);
  const [override, setOverride] = useState(readOverride);
  const dim = Math.min(0.95, (typeof override.dim === 'number' ? override.dim : 0.2) + extra);

  // Settings dispatches `mc:backdrop` in this tab; `storage` covers the others.
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
    if (override.url) {
      setSrc(override.url); // an explicit URL wins outright — no fetch needed
      return undefined;
    }
    fetch('/bg/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (dead || !Array.isArray(list) || !list.length) return;
        if (override.file) {
          const hit = list.find((e) => e.file === override.file);
          if (hit) {
            setSrc(`/bg/${hit.file}`);
            return;
          }
        }
        const pool = list.filter((e) => e.tone === toneNow());
        const set = pool.length ? pool : list;
        setSrc(`/bg/${set[Math.floor(Math.random() * set.length)].file}`);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [override.url, override.file]);

  return (
    // Opaque graphite base: nothing from the app underneath may show through.
    <div className="absolute inset-0 overflow-hidden bg-bg" aria-hidden="true">
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
      <div className="absolute inset-0" style={{ background: `rgba(6,6,8,${dim})` }} />
    </div>
  );
}
