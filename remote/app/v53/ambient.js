// The moving light (tasks 0491, 0502). Daniel: "I love the moving gradients".
// In v5.3 the gradients live INSIDE the Lens shader's scene (lens.js), under
// the glass — so every pane's rim bends them as they drift past, and the
// frosted bodies carry their colour. Ambient.jsx says how lively the room is;
// Scene.jsx advances the clock and hands the shader three soft lights.
//   level  0 nothing running (it hangs almost still) … 4 (several agents)
//   warm   an agent waits on Daniel: one light warms to amber
//   still  reduced motion / lite glass: frozen (lite draws them in CSS)

export const ambient = { level: 0, warm: 0, still: false, phase: 17, warmK: 0 };

// Three lights on slow Lissajous paths, in CSS px. Calm by design: big,
// soft, never more than a hint of colour.
export function lights(W, H, dark) {
  const p = ambient.phase;
  const m = Math.max(W, H);
  const k = dark ? 1 : 0.7;
  const w = ambient.warmK;
  return [
    // sage, high left
    [W * (0.18 + 0.16 * Math.sin(p * 0.071)), H * (0.16 + 0.12 * Math.cos(p * 0.053)), m * 0.62, 0.5 * k, ...(dark ? [0.22, 0.52, 0.42] : [0.36, 0.62, 0.5])],
    // smoked plum, right
    [W * (0.86 + 0.12 * Math.cos(p * 0.047)), H * (0.42 + 0.2 * Math.sin(p * 0.061)), m * 0.58, 0.42 * k, ...(dark ? [0.42, 0.3, 0.54] : [0.58, 0.46, 0.7])],
    // stone → ember when someone waits, low centre
    [W * (0.42 + 0.22 * Math.sin(p * 0.039 + 1.7)), H * (0.92 + 0.08 * Math.cos(p * 0.043)), m * 0.6, (0.4 + 0.25 * w) * k, ...mix(dark ? [0.5, 0.4, 0.3] : [0.7, 0.58, 0.44], dark ? [0.82, 0.5, 0.16] : [0.95, 0.66, 0.3], w)],
  ];
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// per frame (dt in ms): the clock runs at the room's pace
export function tick(dt) {
  ambient.warmK += ((ambient.warm ? 1 : 0) - ambient.warmK) * Math.min(1, dt / 900);
  if (ambient.still) return;
  const rate = ambient.level === 0 ? 0.35 : 0.9 + ambient.level * 0.5;
  ambient.phase += (dt / 1000) * rate;
}
