// Glass that never lags the text (task 0486). Daniel, on v4: "whenever I
// scroll, the liquid glass lags behind the text a little bit".
//
// Why it lagged: a page scrolls on the compositor thread, but the shader
// draws each pane where the main thread last measured it (rAF →
// getBoundingClientRect → WebGL → the next composite). A pane inside a
// scroller therefore trails its own text by a frame or two — worst on a
// phone, where the compositor scrolls at 120 Hz while the main thread
// catches up.
//
// The web gives a page no way to draw WebGL inside the compositor's scroll,
// so the fix is a hand-over: the moment a finger or a wheel starts moving a
// scroller, every pane INSIDE a scroller stops being drawn by the shader and
// shows its CSS glass instead (a backdrop blur, which the compositor moves in
// the very same frame as the text). Once everything has been still for a
// moment, the shader takes the pane back and fades its refraction in.
// Panes that don't scroll (windows, the dock, the top bar) are never touched.

const STILL_MS = 140; // quiet this long = the scroll is over
const FADE_MS = 240; // the refraction's return

let lastMove = -1e9;
let installed = false;
const bump = () => {
  lastMove = performance.now();
};

export function installScrollSync() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // touchmove/wheel arrive before the first scrolled frame; scroll covers
  // momentum, the keyboard and programmatic scrolls
  for (const ev of ['touchmove', 'wheel', 'scroll']) document.addEventListener(ev, bump, { capture: true, passive: true });
}

export const scrolling = (now = performance.now()) => now - lastMove < STILL_MS;

function inScroller(el) {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return true;
  }
  return false;
}

// How much of the shader's glass this pane gets this frame: 1 at rest, 0
// while its page is moving, easing back in after.
export function scrollGate(el, now, dt) {
  if (el.__lensInScroll === undefined) el.__lensInScroll = inScroller(el);
  if (!el.__lensInScroll) return 1;
  let f = el.__lensFade ?? 1;
  f = scrolling(now) ? 0 : Math.min(1, f + Math.max(dt, 1) / FADE_MS);
  el.__lensFade = f;
  return f;
}
