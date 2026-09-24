import { createContext, useContext } from 'react';
import { motion, useDragControls } from 'motion/react';
import { spring } from '../lib/motion.js';
import { useMedia, usePane } from '../lib/hooks.js';
import IconButton from '../ui/IconButton.jsx';
import Icon from '../ui/Icon.jsx';

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
//
// Collapsible column: a `column` window given a `pane` ({ key, label, icon,
// count, collapsedByDefault, rail }) folds down to a thin glass rail and back.
// The state is remembered per pane (usePane). The content stays mounted at
// full width while it folds — clipped, not reflowed — so search boxes and
// scroll positions survive. A chromeless view puts <PaneToggle /> in its own
// header; a titled window gets the toggle in its header automatically.
const COLUMN_W = 360;
const RAIL_W = 56;

const PaneCtx = createContext(null);

export function PaneToggle() {
  const pane = useContext(PaneCtx);
  if (!pane) return null;
  return (
    <IconButton icon="paneLeftClose" label={`Collapse ${pane.label}`} size="sm" variant="glass" onClick={pane.toggle} />
  );
}

function Rail({ pane, onExpand }) {
  return (
    // The whole strip reopens the pane; the rail's own buttons (agent dots)
    // stop the click so they do their own thing.
    <div
      onClick={onExpand}
      className="flex h-full cursor-pointer flex-col items-center gap-3 pb-3 pt-3"
    >
      <IconButton
        icon="paneLeftOpen"
        label={`Show ${pane.label}`}
        size="sm"
        variant="glass"
        onClick={(e) => {
          e.stopPropagation();
          onExpand();
        }}
      />
      <span className="relative text-ink2">
        <Icon name={pane.icon} size={17} />
        {pane.count ? (
          <span className="tnum absolute -right-2.5 -top-2 min-w-4 rounded-full bg-white/[0.14] px-1 text-center text-[10px] font-semibold leading-4 text-ink">
            {pane.count}
          </span>
        ) : null}
      </span>
      <span className="text-[12px] font-medium tracking-wide text-ink2 [writing-mode:vertical-rl]">{pane.label}</span>
      {pane.rail && (
        <div className="noscroll flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto pt-1" onClick={(e) => e.stopPropagation()}>
          {pane.rail}
        </div>
      )}
    </div>
  );
}

const DESK = {
  column: 'w-[360px] flex-none',
  main: 'min-w-0 flex-1',
  center: 'mx-auto w-full max-w-[1100px] min-w-0 flex-1',
  full: 'min-w-0 flex-1',
};

export default function Window({ title, subtitle, actions, onClose, size = 'center', pane, className = '', children }) {
  const desktop = useMedia('(min-width: 1024px)');
  const drag = useDragControls();
  const foldable = desktop && size === 'column' && !!pane;
  const [collapsed, toggle] = usePane(pane?.key || 'none', !!pane?.collapsedByDefault);
  const folded = foldable && collapsed;
  const paneCtx = foldable ? { ...pane, toggle } : null;

  const header = title ? (
    <header className="flex flex-none items-center gap-3 border-b border-glass-line px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle && <div className="truncate text-[12px] text-ink3">{subtitle}</div>}
      </div>
      {actions}
      {foldable && <PaneToggle />}
      {onClose && <IconButton icon="close" label="Close" size="sm" variant="glass" onClick={onClose} />}
    </header>
  ) : null;

  if (foldable) {
    const w = folded ? RAIL_W : COLUMN_W;
    return (
      <PaneCtx.Provider value={paneCtx}>
        <motion.section
          initial={{ opacity: 0, scale: 0.97, y: 8, width: w }}
          animate={{ opacity: 1, scale: 1, y: 0, width: w }}
          exit={{ opacity: 0, scale: 0.98, y: 4 }}
          transition={spring.smooth}
          data-pane={pane.key}
          data-collapsed={folded ? 'true' : 'false'}
          className={`glass relative flex min-h-0 flex-none flex-col overflow-hidden ${className}`}
        >
          <motion.div
            animate={{ opacity: folded ? 0 : 1 }}
            transition={{ duration: 0.18 }}
            inert={folded ? true : undefined}
            aria-hidden={folded || undefined}
            className={`flex min-h-0 flex-1 flex-col ${folded ? 'pointer-events-none' : ''}`}
            style={{ width: COLUMN_W }}
          >
            {header}
            <div className={`noscroll min-h-0 flex-1 ${title ? 'overflow-y-auto' : 'flex flex-col overflow-hidden'}`}>
              {children}
            </div>
          </motion.div>
          <motion.div
            initial={false}
            animate={{ opacity: folded ? 1 : 0 }}
            transition={{ duration: 0.18, delay: folded ? 0.08 : 0 }}
            className={`absolute inset-y-0 left-0 ${folded ? '' : 'pointer-events-none'}`}
            style={{ width: RAIL_W }}
            inert={folded ? undefined : true}
          >
            <Rail pane={pane} onExpand={toggle} />
          </motion.div>
        </motion.section>
      </PaneCtx.Provider>
    );
  }

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
      className={`to-screen-bottom glass-strong fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden rounded-b-none ${className}`}
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
