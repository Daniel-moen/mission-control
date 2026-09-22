import { useEffect, useState } from 'react';
import { useSpring, useTransform, useMotionValueEvent, useReducedMotion } from 'motion/react';
import { spring } from '../lib/motion.js';

// A number that travels to its new value instead of snapping. Tabular figures
// so the digits never shift the layout while it counts.
export default function Ticker({ value = 0, format = (n) => String(Math.round(n)), className = '', ...rest }) {
  const reduce = useReducedMotion();
  const mv = useSpring(value, spring.gentle);
  const text = useTransform(mv, (n) => format(n));
  const [shown, setShown] = useState(() => format(value));

  useEffect(() => {
    if (reduce) setShown(format(value));
    else mv.set(value);
  }, [value, reduce]); // eslint-disable-line react-hooks/exhaustive-deps

  useMotionValueEvent(text, 'change', (v) => setShown(v));

  return (
    <span className={`tnum ${className}`} {...rest}>
      {shown}
    </span>
  );
}
