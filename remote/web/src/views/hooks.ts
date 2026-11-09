'use client';
import { useEffect, useState } from 'react';

export function useWide(min = 900) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${min}px)`);
    const f = () => setWide(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [min]);
  return wide;
}
