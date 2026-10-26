import { useEffect, useLayoutEffect, useState } from 'react';
import { useMedia } from '../../src/lib/hooks.js';

export { useMedia };

// Width breakpoints are about the WINDOW, not the device: an iPad in Stage
// Manager or Split View can be phone-narrow, and gets the phone layout.
export const useWide = (px = 900) => useMedia(`(min-width: ${px}px)`);

// The size of an element (a page's content box) — layouts that depend on the
// space a view actually has, not the screen.
export function useSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// Page visibility (tab in the background / phone locked).
export function usePageVisible() {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setV(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}
