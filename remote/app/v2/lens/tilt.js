import { useEffect } from 'react';
import { motionValue, animate } from 'motion/react';
import { usePrefs } from '../lib/prefs.js';

// Lens (task 0445): where the device is leaning and where the finger is.
//   tiltX/tiltY ∈ [-1, 1] — DeviceOrientation relative to how you were holding
//   it when the screen opened (iOS asks permission on the first tap), or the
//   pointer's position on a desktop. Sprung, so parallax never jitters.
//   lightX/lightY — CSS px of the light source: follows a touching finger,
//   otherwise drifts with the tilt.
export const tiltX = motionValue(0);
export const tiltY = motionValue(0);
export const lightX = motionValue(typeof innerWidth === 'number' ? innerWidth * 0.3 : 0);
export const lightY = motionValue(typeof innerHeight === 'number' ? innerHeight * 0.15 : 0);
export const touching = motionValue(0);

const springy = { type: 'spring', stiffness: 60, damping: 18, mass: 1 };
let base = null;
let started = false;

export function useTilt() {
  const reduce = usePrefs((s) => s.reduce);
  useEffect(() => {
    if (reduce || started) return undefined;
    started = true;
    let fromSensor = false;
    const setTilt = (x, y) => {
      animate(tiltX, Math.max(-1, Math.min(1, x)), springy);
      animate(tiltY, Math.max(-1, Math.min(1, y)), springy);
      if (!touching.get()) {
        animate(lightX, innerWidth * (0.5 + x * 0.42), springy);
        animate(lightY, innerHeight * (0.25 + y * 0.35), springy);
      }
    };
    const onOrient = (e) => {
      if (e.beta == null || e.gamma == null) return;
      fromSensor = true;
      if (!base) base = { b: e.beta, g: e.gamma };
      const land = Math.abs(window.orientation || screen.orientation?.angle || 0) === 90;
      const db = e.beta - base.b;
      const dg = e.gamma - base.g;
      setTilt((land ? db : dg) / 22, (land ? -dg : db) / 22);
    };
    const onMove = (e) => {
      if (e.pointerType === 'touch') {
        if (touching.get()) {
          lightX.set(e.clientX);
          lightY.set(e.clientY);
        }
        return;
      }
      if (!fromSensor) setTilt((e.clientX / innerWidth - 0.5) * 2, (e.clientY / innerHeight - 0.5) * 2);
      lightX.set(e.clientX);
      lightY.set(e.clientY);
    };
    const onDown = (e) => {
      touching.set(1);
      animate(lightX, e.clientX, { duration: 0.12 });
      animate(lightY, e.clientY, { duration: 0.12 });
      // iOS 13+: motion sensors only after a gesture asks for them.
      const D = window.DeviceOrientationEvent;
      if (D && typeof D.requestPermission === 'function' && !fromSensor) D.requestPermission().catch(() => {});
    };
    const onUp = () => touching.set(0);
    window.addEventListener('deviceorientation', onOrient);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    return () => {
      started = false;
      window.removeEventListener('deviceorientation', onOrient);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [reduce]);
}
