import { create } from 'zustand';

// Lens (task 0445): the small shared facts about the scene, kept out of the
// scene's own chunk (Scene.jsx loads after first paint).

// Is the shader drawing? null until the scene has loaded and decided; false =
// CSS glass (Home then sets the clock in DOM itself).
export const useLensMode = create(() => ({ gl: null }));

// Where Home puts the giant clock (Home leaves this space open).
export function clockLayout(W = innerWidth, H = innerHeight) {
  const top = 0;
  if (W >= 900 && W > H) {
    const size = Math.min(H * 0.4, W * 0.24);
    return { left: W * 0.045, baseline: H * 0.58, size, side: true };
  }
  const size = W < 600 ? W * 0.335 : W * 0.28;
  return { left: W * 0.06, baseline: top + 64 + size * 0.78, size, side: false };
}

