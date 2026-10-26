import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useMC, toast } from '../../src/lib/store.js';
import { useTalk, startTalk, endTalk } from '../../src/lib/talkSession.js';
import { talkSupported } from '../../src/lib/voice.js';

// v3 (task 0445): talk mode with v1's engine (whisper on the relay, Mia's
// Kokoro voice) mounted off-screen; each direction draws its own voice UI
// from the phase and the live mic level.

const Talk = lazy(() => import('../../src/views/mia/Talk.jsx'));

// The latest mic level 0..1 (smoothed) — read every frame by the shaders.
export const voice = { level: 0, raw: 0 };

export function talk() {
  if (useTalk.getState().on) return endTalk();
  if (!talkSupported) return toast('Talk mode needs a microphone this browser doesn’t offer');
  startTalk();
}
export { endTalk };

export function VoiceEngine() {
  const on = useTalk((s) => s.on);
  const levels = useTalk((s) => s.levels);
  const mia = useMC((s) => s.mia);
  const [park] = useState(() => {
    const d = document.createElement('div');
    Object.assign(d.style, { position: 'fixed', left: '-10000px', top: '0', width: '360px', height: '640px', overflow: 'hidden', pointerEvents: 'none' });
    d.setAttribute('aria-hidden', 'true');
    document.body.appendChild(d);
    return d;
  });
  useEffect(() => {
    if (!levels) return undefined;
    const f = (l) => (voice.raw = l);
    levels.add(f);
    return () => levels.delete(f);
  }, [levels]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      voice.level += (voice.raw - voice.level) * 0.25;
      voice.raw *= 0.9;
      raf = requestAnimationFrame(tick);
    };
    if (on) raf = requestAnimationFrame(tick);
    else voice.level = voice.raw = 0;
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return on
    ? createPortal(
        <Suspense fallback={null}>
          <Talk mia={mia} onExit={endTalk} />
        </Suspense>,
        park,
      )
    : null;
}

export const useVoice = () => useTalk(useShallow((s) => ({ on: s.on, phase: s.phase })));
