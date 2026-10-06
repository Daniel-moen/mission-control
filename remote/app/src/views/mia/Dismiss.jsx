import { useRef } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'motion/react';
import { useMC, miaDismiss, miaDismissOld, miaOldQuestions, fmtQuestionAge } from '../../lib/store.js';
import { spring } from '../../lib/motion.js';
import IconButton from '../../ui/IconButton.jsx';
import Button from '../../ui/Button.jsx';

// Closing Mia's questions without answering them. Dismissing marks the
// question closed on the Mac (every panel drops it) and Mia gets an [MC] line
// saying no answer is coming. Old questions — open past the max age, 48 h by
// default — are hidden and don't count anywhere; this bar says how many and
// clears them in one tap.

export function DismissButton({ questionId, size = 'sm', className = '' }) {
  return (
    <IconButton
      icon="close"
      size={size}
      label="Dismiss question"
      data-dismiss={questionId}
      onClick={(e) => {
        e.stopPropagation();
        miaDismiss(questionId);
      }}
      className={`text-ink3 ${className}`}
    />
  );
}

// Swipe a question card sideways to dismiss it. The card follows the finger,
// fades as it goes, and springs back if let go short of the threshold. The
// click a drag ends on is swallowed, so a swipe never also opens Mia.
export function Swipeable({ questionId, children, className = '' }) {
  const x = useMotionValue(0);
  const dragged = useRef(false);
  const opacity = useTransform(x, [-180, -70, 0, 70, 180], [0.25, 0.85, 1, 0.85, 0.25]);
  return (
    <motion.div
      drag="x"
      dragDirectionLock
      dragSnapToOrigin
      dragElastic={0.5}
      dragConstraints={{ left: 0, right: 0 }}
      dragTransition={{ bounceStiffness: 520, bounceDamping: 40 }}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={(_, info) => {
        setTimeout(() => (dragged.current = false), 0);
        if (Math.abs(info.offset.x) > 110 || (Math.abs(info.offset.x) > 50 && Math.abs(info.velocity.x) > 700)) miaDismiss(questionId);
      }}
      onClickCapture={(e) => {
        if (!dragged.current) return;
        e.stopPropagation();
        e.preventDefault();
      }}
      style={{ x, opacity, touchAction: 'pan-y' }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// "N old questions hidden · Show · Dismiss all". Renders nothing when there
// are none (or the Mac predates the age rule).
export function OldQuestionsBar({ shown, onToggle, className = '' }) {
  const mia = useMC((s) => s.mia);
  const local = useMC((s) => s.miaLocal);
  const n = miaOldQuestions(mia, local).length;
  const age = fmtQuestionAge(mia?.questionMaxAgeHours);
  return (
    <AnimatePresence initial={false}>
      {n > 0 && (
        <motion.div
          key="old-qs"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={spring.smooth}
          data-old-questions={n}
          className={`glass-soft flex items-center gap-2 rounded-xl2 py-1.5 pl-3.5 pr-1.5 ${className}`}
        >
          <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink2">
            {n} old question{n === 1 ? '' : 's'} hidden
            {age && <span className="text-ink3"> · over {age}</span>}
          </span>
          {onToggle && (
            <Button size="sm" variant="ghost" onClick={onToggle}>
              {shown ? 'Hide' : 'Show'}
            </Button>
          )}
          <Button size="sm" variant="secondary" icon="close" onClick={() => miaDismissOld()}>
            Dismiss all old
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
