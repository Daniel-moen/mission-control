import { motion, useDragControls } from 'motion/react';
import { spring } from '../lib/motion.js';
import { useMedia } from '../lib/hooks.js';
import IconButton from '../ui/IconButton.jsx';

// A pane of frosted glass floating over the scene. On desktop it takes its
// place in App's window row (`column` beside `main`, or a centred `center`);
// on a phone every window is a full-screen sheet you can throw downwards.
//
// Chromeless: with no `title` the window draws no header at all — the view
// inside owns its own header row (name, status, actions, close). The phone
// grab handle stays either way, since a sheet you can't throw away is a trap.
//
// Esc is NOT bound here on purpose — App owns a single keydown handler so the
// topmost overlay closes exactly once when several are stacked.
const DESK = {
  column: 'w-[360px] flex-none',
  main: 'min-w-0 flex-1',
  center: 'mx-auto w-full max-w-[1100px] min-w-0 flex-1',
  full: 'min-w-0 flex-1',
};

export default function Window({ title, subtitle, actions, onClose, size = 'center', className = '', children }) {
  const desktop = useMedia('(min-width: 1024px)');
  const drag = useDragControls();

  const header = title ? (
    <header className="flex flex-none items-center gap-3 border-b border-glass-line px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle && <div className="truncate text-[12px] text-ink3">{subtitle}</div>}
      </div>
      {actions}
      {onClose && <IconButton icon="close" label="Close" size="sm" variant="glass" onClick={onClose} />}
    </header>
  ) : null;

  if (desktop) {
    return (
      <motion.section
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 4 }}
        transition={spring.smooth}
        className={`glass flex min-h-0 flex-col overflow-hidden ${DESK[size] || DESK.center} ${className}`}
      >
        {header}
        <div className={`noscroll min-h-0 flex-1 ${title ? 'overflow-y-auto' : 'flex flex-col overflow-hidden'}`}>
          {children}
        </div>
      </motion.section>
    );
  }

  return (
    <motion.section
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={spring.smooth}
      drag="y"
      // Only the grab handle starts a drag — otherwise every scroll inside the
      // window would try to throw it off the screen.
      dragListener={false}
      dragControls={drag}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.5 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > 120 || info.velocity.y > 700) onClose?.();
      }}
      className={`glass-strong fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden rounded-b-none ${className}`}
      // Leave room for the floating dock, which stays above every window.
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 84px)' }}
    >
      <div
        onPointerDown={(e) => drag.start(e)}
        className="grid flex-none cursor-grab touch-none place-items-center pt-2 pb-1.5 active:cursor-grabbing"
      >
        <div className="h-1 w-9 rounded-full bg-white/25" />
      </div>
      {header}
      <div className={`noscroll min-h-0 flex-1 ${title ? 'overflow-y-auto' : 'flex flex-col overflow-hidden'}`}>
        {children}
      </div>
    </motion.section>
  );
}
