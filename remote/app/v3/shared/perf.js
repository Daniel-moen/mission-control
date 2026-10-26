// v3 (task 0445): a frame-time probe for the perf numbers. The rigs call
// window.__v3perf.start() before a scripted interaction and .stop() after;
// it reports what requestAnimationFrame actually delivered.
export function initPerf() {
  let times = [];
  let loaf = [];
  let obs = null;
  let raf = 0;
  let last = 0;
  const tick = (t) => {
    if (last) times.push(t - last);
    last = t;
    raf = requestAnimationFrame(tick);
  };
  window.__v3perf = {
    start() {
      times = [];
      loaf = [];
      // Chromium's Long Animation Frames: any frame whose work ran past 50 ms
      try {
        obs?.disconnect();
        obs = new PerformanceObserver((l) => loaf.push(...l.getEntries().map((e) => e.duration)));
        obs.observe({ type: 'long-animation-frame', buffered: false });
      } catch {
        obs = null;
      }
      last = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(raf);
      obs?.disconnect();
      const s = [...times].sort((a, b) => a - b);
      const n = s.length || 1;
      const avg = times.reduce((a, b) => a + b, 0) / n;
      const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))] || 0;
      // The display's own interval is the median frame; "dropped" = frames that
      // took over 1.5 intervals.
      const base = p(0.5) || 16.7;
      return {
        frames: times.length,
        fps: Math.round(1000 / avg),
        avgMs: +avg.toFixed(2),
        p95Ms: +p(0.95).toFixed(2),
        worstMs: +(s[s.length - 1] || 0).toFixed(2),
        dropped: times.filter((d) => d > base * 1.5).length,
        longFrames: obs ? loaf.length : null,
        worstLongMs: loaf.length ? Math.round(Math.max(...loaf)) : 0,
        glScale: window.__v3gl?.scale ?? null,
      };
    },
  };
}
