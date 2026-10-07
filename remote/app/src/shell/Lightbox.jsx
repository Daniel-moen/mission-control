import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useLightbox, closeLightbox, stepLightbox } from '../lib/lightbox.js';
import { loadImage } from '../lib/thumbs.js';
import { fadeIn } from '../lib/motion.js';
import IconButton from '../ui/IconButton.jsx';

// Full-size photos from a Library doc (task 0124). The small copy the doc
// already showed appears at once; the full one (lib/thumbs.js → relay
// doc-asset store) replaces it when it lands. Arrows / swipe step through the
// doc's images; Escape (App), the close button or a tap on the backdrop close.

const SWIPE_PX = 50;

function Slide({ item }) {
  const [src, setSrc] = useState(item.preview || '');
  useEffect(() => {
    let live = true;
    setSrc(item.preview || '');
    if (item.full) loadImage(item.full).then((u) => live && u && setSrc(u));
    return () => {
      live = false;
    };
  }, [item.full, item.preview]);
  return src ? (
    <img
      src={src}
      alt={item.alt}
      draggable="false"
      className="max-h-full max-w-full select-none rounded-xl2 object-contain shadow-3"
      data-lightbox-img
    />
  ) : (
    <span className="anim-spin h-10 w-10 rounded-full border-2 border-white/15 border-t-accent" />
  );
}

export default function Lightbox() {
  const items = useLightbox((s) => s.items);
  const at = useLightbox((s) => s.at);
  const start = useRef(null);
  const item = items?.[at];
  const many = (items?.length || 0) > 1;

  // Arrow keys while open (Escape is App's).
  useEffect(() => {
    if (!items) return;
    const onKey = (e) => {
      if (e.key === 'ArrowRight') stepLightbox(1);
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items]);

  const down = (e) => (start.current = { x: e.clientX, y: e.clientY });
  const up = (e) => {
    const s = start.current;
    start.current = null;
    if (!s || !many) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - s.y)) stepLightbox(dx < 0 ? 1 : -1);
  };

  return createPortal(
    <AnimatePresence>
      {item && (
        <motion.div
          key="lightbox"
          {...fadeIn}
          className="fixed inset-0 z-[96] flex flex-col"
          style={{
            paddingTop: 'env(safe-area-inset-top)',
            paddingBottom: 'env(safe-area-inset-bottom)',
            background: 'rgba(6, 6, 8, 0.94)',
            backdropFilter: 'blur(28px) saturate(1.1)',
            WebkitBackdropFilter: 'blur(28px) saturate(1.1)',
          }}
          role="dialog"
          aria-modal="true"
          aria-label={item.caption || item.alt || 'Photo'}
          data-lightbox
          onPointerDown={down}
          onPointerUp={up}
        >
          <div className="flex flex-none items-center gap-3 px-3 py-2.5 sm:px-4">
            <span className="tnum font-mono text-[12px] text-ink3">{many ? `${at + 1} / ${items.length}` : ''}</span>
            <div className="flex-1" />
            <IconButton icon="close" label="Close photo" size="md" variant="glass" onClick={closeLightbox} />
          </div>
          <div
            className="relative flex min-h-0 flex-1 items-center justify-center px-3 sm:px-16"
            onClick={(e) => e.target === e.currentTarget && closeLightbox()}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={at}
                initial={{ opacity: 0, scale: 0.985 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="flex h-full w-full items-center justify-center"
                onClick={(e) => e.target === e.currentTarget && closeLightbox()}
              >
                <Slide item={item} />
              </motion.div>
            </AnimatePresence>
            {many && (
              <>
                <IconButton
                  icon="chevronLeft"
                  label="Previous photo"
                  size="md"
                  variant="glass"
                  onClick={() => stepLightbox(-1)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 max-sm:!hidden"
                />
                <IconButton
                  icon="chevronRight"
                  label="Next photo"
                  size="md"
                  variant="glass"
                  onClick={() => stepLightbox(1)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 max-sm:!hidden"
                />
              </>
            )}
          </div>
          {(item.tag || item.caption) && (
            <div className="flex flex-none items-baseline justify-center gap-2 px-5 pb-4 pt-3 text-center text-[13.5px] text-ink2">
              {item.tag && (
                <span className="md-tag" data-tone={item.tone}>
                  {item.tag}
                </span>
              )}
              <span>{item.caption}</span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
