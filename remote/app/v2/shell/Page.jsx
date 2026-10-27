import { forwardRef, useCallback, useLayoutEffect, useRef } from 'react';
import { motion, useMotionValue, useTransform } from 'motion/react';
import { usePage } from './Stack.jsx';
import { Icon } from '../ui/kit.jsx';
import { tap } from '../lib/motion.js';

// A page: a nav bar that stays out of the way, a large title that scrolls
// with the content and hands over to the bar's small title as it leaves
// (iOS), and room at the bottom for the floating tab bar.
//
// `scroll={false}` for pages that lay out their own scrolling regions (the
// chat, the agent workspace); they still get the bar.

const saved = new Map(); // route key → scrollTop, so Back lands where you were

export default forwardRef(function Page(
  { title, subtitle, actions, leading, toolbar, children, scroll = true, scrollProps = {}, maxW = 1100, bar = 'auto', className = '', pad = true, large = true },
  ref,
) {
  const { route, depth, back, close } = usePage();
  const local = useRef(null);
  const y = useMotionValue(0);
  // The small title arrives as the large one passes under the bar.
  const small = useTransform(y, [24, 52], [0, 1]);
  const barBg = useTransform(y, [0, 20], [0, 1]);

  const setRef = useCallback(
    (el) => {
      local.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  useLayoutEffect(() => {
    const el = local.current;
    if (!el || !route) return;
    const top = saved.get(route.key);
    if (top) el.scrollTop = top;
    y.set(el.scrollTop);
  }, [route, y]);

  const onScroll = (e) => {
    const t = e.currentTarget.scrollTop;
    y.set(t);
    if (route) saved.set(route.key, t);
    scrollProps.onScroll?.(e);
  };

  const showBack = depth > 0;
  const solid = bar === 'solid' || !scroll;

  const navBar = (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30" style={{ paddingTop: 'var(--page-safe-top, env(safe-area-inset-top))' }}>
      <motion.div
        aria-hidden="true"
        className="lens-navbar absolute inset-0"
        style={{ opacity: solid ? 1 : barBg }}
      />
      <div className="pointer-events-auto relative flex h-[52px] items-center gap-2 px-3 sm:px-4">
        {showBack ? (
          <motion.button
            {...tap}
            onClick={back}
            aria-label="Back"
            data-back
            className="-ml-1 flex h-10 flex-none items-center gap-0.5 rounded-full pl-1.5 pr-3 text-[0.95rem] font-medium text-ink hover:bg-fill"
          >
            <Icon name="back" size={22} strokeWidth={2.2} />
            <span className="hidden sm:inline">Back</span>
          </motion.button>
        ) : close ? (
          <>
            <motion.button
              {...tap}
              onClick={close}
              aria-label="Close"
              data-close-window
              className="-ml-1 grid h-10 w-10 flex-none place-items-center rounded-full text-ink hover:bg-fill"
            >
              <Icon name="close" size={19} strokeWidth={2.2} />
            </motion.button>
            {leading}
          </>
        ) : (
          leading || <span className="w-1" />
        )}
        <motion.div
          style={{ opacity: solid || !title ? 1 : small }}
          className="min-w-0 flex-1 truncate text-center text-[0.98rem] font-semibold tracking-[-0.01em] text-ink"
        >
          {solid ? title : title}
        </motion.div>
        <div className="flex flex-none items-center gap-1.5" data-bar-actions>{actions}</div>
      </div>
    </div>
  );

  if (!scroll) {
    return (
      <div className={`relative flex h-full min-h-0 flex-col ${className}`}>
        {navBar}
        <div className="flex min-h-0 flex-1 flex-col" style={{ paddingTop: 'calc(var(--page-safe-top, env(safe-area-inset-top)) + 52px)' }}>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className={`relative h-full min-h-0 ${className}`}>
      {navBar}
      <div
        ref={setRef}
        {...scrollProps}
        onScroll={onScroll}
        className={`v-scroll h-full ${scrollProps.className || ''}`}
        style={{ paddingTop: 'calc(var(--page-safe-top, env(safe-area-inset-top)) + 52px)', paddingBottom: 'var(--tabbar-space)' }}
      >
        <div className={`mx-auto w-full ${pad ? 'px-4 sm:px-6' : ''}`} style={{ maxWidth: maxW }}>
          {title && large && (
            <header className="pb-4 pt-1">
              <h1 className="v-title text-ink">{title}</h1>
              {subtitle && <div className="mt-1.5 text-[0.92rem] text-ink3">{subtitle}</div>}
              {toolbar && <div className="mt-4">{toolbar}</div>}
            </header>
          )}
          {children}
        </div>
      </div>
    </div>
  );
});
