// Home Screen (standalone) viewport gap — ported from the classic panel
// (remote/app/src/lib/viewport.js). With viewport-fit=cover + black-translucent,
// iOS can report a layout viewport that is shorter than the screen it paints on
// (by the status-bar height), so everything sized by 100dvh or pinned with
// `bottom: 0` stops short and a black band shows under the dock (Daniel's
// iPhone, task 0623). In standalone the app owns the whole screen, so the
// shortfall is knowable: screen height (current orientation) − innerHeight.
// It lands in --vgap; the app shell, backdrop, glass layer and bottom-pinned
// bars extend by it (globals.css). Anywhere else --vgap stays 0.

export function isStandalone(): boolean {
  return typeof window !== 'undefined' && ((navigator as any).standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches);
}

export function measureGap(): number {
  if (!isStandalone()) return 0;
  const sw = screen?.width || 0, sh = screen?.height || 0;
  if (!sw || !sh) return 0;
  // iOS keeps screen.width/height in portrait terms; pick by orientation
  const landscape = innerWidth > innerHeight;
  const fullW = landscape ? Math.max(sw, sh) : Math.min(sw, sh);
  const fullH = landscape ? Math.min(sw, sh) : Math.max(sw, sh);
  // only when we really own the whole screen (Split View / Stage Manager are honest)
  if (Math.abs(innerWidth - fullW) > 2) return 0;
  const gap = fullH - innerHeight;
  return gap > 0 && gap <= 80 ? gap : 0;
}

export function initViewportGap(): () => void {
  const root = document.documentElement;
  const apply = () => {
    const gap = measureGap();
    root.style.setProperty('--vgap', `${gap}px`);
    root.dataset.vgap = String(gap);
  };
  apply();
  const timers: ReturnType<typeof setTimeout>[] = [];
  // rotation settles over a few frames on iOS; re-measure after it does
  const later = () => { apply(); timers.push(setTimeout(apply, 250), setTimeout(apply, 800)); };
  const vis = () => document.visibilityState === 'visible' && later();
  addEventListener('resize', apply);
  addEventListener('orientationchange', later);
  addEventListener('pageshow', later);
  document.addEventListener('visibilitychange', vis);
  return () => {
    removeEventListener('resize', apply);
    removeEventListener('orientationchange', later);
    removeEventListener('pageshow', later);
    document.removeEventListener('visibilitychange', vis);
    timers.forEach(clearTimeout);
  };
}
