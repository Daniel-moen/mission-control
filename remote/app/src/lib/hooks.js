// React hooks over the store and the handful of browser APIs the panel leans
// on. Components subscribe through these so a snapshot only re-renders the
// views that read the slice that moved.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMC, watchAgent } from './store.js';

export const useAgents = () => useMC((s) => s.agents);
export const useAgent = (id) => useMC((s) => s.agents.find((a) => a.id === id) || null);
export const useScreen = (id) => useMC((s) => s.screens[id]); // re-render on stream frames
export const useNow = () => useMC((s) => s.now); // 1 Hz clock
export const useLink = () => useMC((s) => s.link);
export const useSummary = () => useMC((s) => s.summary);

// Hold a watch lease on a session for as long as this component is mounted.
// `hot` says someone is TYPING into that terminal (the host then mirrors at
// ~3 Hz instead of 1 Hz) — flipping it re-acquires the lease, which is cheap
// and refcounted, so two views of the same session never cancel each other.
export function useWatch(id, { hot = false } = {}) {
  useEffect(() => {
    if (!id) return undefined;
    const release = watchAgent(id, { hot });
    return release;
  }, [id, hot]);
}

// matchMedia as a boolean. Safari < 14 only has the deprecated listener API, so
// prefer addEventListener and fall back.
export function useMedia(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mql.matches);
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

// Keep the screen awake (car mode / TV mode). Best effort: unsupported
// browsers and a denied request are silent no-ops. A wake lock is dropped
// whenever the tab is hidden, so re-acquire it when the tab comes back.
export function useWakeLock(on) {
  const ref = useRef(null);
  useEffect(() => {
    if (!on || typeof navigator === 'undefined' || !navigator.wakeLock) return undefined;
    let cancelled = false;
    const acquire = async () => {
      if (cancelled || ref.current) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          try { lock.release(); } catch {}
          return;
        }
        ref.current = lock;
        lock.addEventListener?.('release', () => {
          if (ref.current === lock) ref.current = null;
        });
      } catch {
        /* denied, or not allowed from this context — carry on without it */
      }
    };
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      const lock = ref.current;
      ref.current = null;
      if (lock) {
        try { lock.release(); } catch {}
      }
    };
  }, [on]);
}

// location.hash without the '#'. Full-screen takeovers (#tv, #car) and deep
// links ride on this; closing one is `location.hash = ''`.
export function useHashRoute() {
  const read = () => (typeof location === 'undefined' ? '' : (location.hash || '').replace(/^#/, ''));
  const [hash, setHash] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onHash = () => setHash(read());
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hash;
}

// JSON-backed localStorage state. Private mode throws on write and can throw on
// read, so every access is wrapped — the value simply stays in memory then.
export function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next) => {
      setValue((prev) => {
        const v = typeof next === 'function' ? next(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(v));
        } catch {
          /* private mode — memory-only for this visit */
        }
        return v;
      });
    },
    [key],
  );
  return [value, set];
}
