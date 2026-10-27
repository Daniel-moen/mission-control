import { useEffect } from 'react';
import { usePrefs } from '../v2/lib/prefs.js';
import { useLensMode } from '../v2/lens/mode.js';
import { ambient } from './ambient.js';
import { useExecutors } from './Rings.jsx';

// The moving light (tasks 0491, 0502). Nothing running: it hangs almost
// still. Agents working: it drifts a little faster for each (up to four),
// and one light warms to amber while an agent waits on Daniel.
// v5.3: with the Lens shader on, the lights are drawn inside its scene
// (ambient.js, lens.js) so the glass bends them; this only sets the pace.
// Lite glass (reduced motion, low power, no WebGL): the same three lights in
// CSS over the photo, held still. v5.2's swell of light when Mia speaks is
// gone — calmer.

export default function Ambient({ thinking = false }) {
  const ex = useExecutors();
  const reduce = usePrefs((s) => s.reduce);
  const lite = usePrefs((s) => s.lite);
  const gl = useLensMode((s) => s.gl !== false);
  const working = ex.filter((a) => a.status === 'active').length + (thinking ? 1 : 0);
  const waiting = ex.length - ex.filter((a) => a.status === 'active').length;
  const level = Math.min(4, working);
  const still = reduce || lite;

  useEffect(() => {
    ambient.level = level;
    ambient.warm = waiting > 0 ? 1 : 0;
    ambient.still = still;
    window.__ambient = ambient;
  }, [level, waiting, still]);

  return (
    <div className={`v53-ambient ${still ? 'still' : ''} ${gl ? 'in-scene' : ''}`} aria-hidden="true" data-ambient data-level={level} data-warm={waiting > 0 ? '1' : '0'} data-in-scene={gl ? '1' : '0'}>
      {!gl && (
        <>
          <i className="v53-blob a" />
          <i className="v53-blob b" />
          <i className="v53-blob c" />
        </>
      )}
    </div>
  );
}
