// iPad / iPhone Home Screen (standalone) viewport gap.
//
// In a standalone web app iPadOS can report a layout viewport that is shorter
// than the screen it actually paints on (seen with viewport-fit=cover +
// black-translucent), so everything sized by 100dvh or pinned with
// `position: fixed; bottom: 0` stops short and the bare body shows as a strip
// along the bottom edge. We can't fix the viewport, but in standalone the app
// fills the screen, so the shortfall is knowable: screen height (for the
// current orientation) minus innerHeight. It lands in --vgap, and the shell,
// backdrop, dock, windows and sheets extend their bottoms by it (app.css
// `.to-screen-bottom`, App.jsx's root height). Anywhere else --vgap stays 0.

const standalone = () =>
  typeof window !== 'undefined' &&
  (window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches);

export function measureGap() {
  if (!standalone()) return 0;
  const sw = window.screen?.width || 0;
  const sh = window.screen?.height || 0;
  if (!sw || !sh) return 0;
  // iOS keeps screen.width/height in portrait terms; pick by orientation.
  const landscape = window.innerWidth > window.innerHeight;
  const fullW = landscape ? Math.max(sw, sh) : Math.min(sw, sh);
  const fullH = landscape ? Math.min(sw, sh) : Math.max(sw, sh);
  // Only when we really own the whole screen: Split View / Stage Manager
  // windows are narrower than the screen and their height is honest.
  if (Math.abs(window.innerWidth - fullW) > 2) return 0;
  const gap = fullH - window.innerHeight;
  return gap > 0 && gap <= 80 ? gap : 0;
}

export function initViewportGap() {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  const apply = () => {
    const gap = measureGap();
    root.style.setProperty('--vgap', `${gap}px`);
    root.dataset.vgap = String(gap);
  };
  apply();
  // Rotation settles over a few frames on iOS; re-measure after it does.
  const later = () => {
    apply();
    setTimeout(apply, 250);
    setTimeout(apply, 800);
  };
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', later);
  window.addEventListener('pageshow', later);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && later());
}
