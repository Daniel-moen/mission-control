// The photo lightbox for Library docs (task 0124): tap an image in a rendered
// doc (lib/thumbs.js) and it opens full-size over everything, with the doc's
// other images a swipe away. Its own tiny store so md/thumbs don't need the
// big one; App's Escape handler closes it first (topmost overlay).
import { create } from 'zustand';

export const useLightbox = create(() => ({ items: null, at: 0 }));

// items: [{ full, preview, alt, tag, tone, caption }]
export function openLightbox(items, at = 0) {
  if (!items?.length) return;
  useLightbox.setState({ items, at: Math.max(0, Math.min(at, items.length - 1)) });
}
export const closeLightbox = () => useLightbox.setState({ items: null, at: 0 });
export const lightboxOpen = () => !!useLightbox.getState().items;
export function stepLightbox(d) {
  const { items, at } = useLightbox.getState();
  if (!items) return;
  useLightbox.setState({ at: (at + d + items.length) % items.length });
}
