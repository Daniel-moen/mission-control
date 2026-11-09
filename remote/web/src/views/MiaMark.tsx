'use client';
// Mia's mark: a glass sphere full of slow liquid light. Layers: base
// gradient · two counter-rotating caustic swirls · a drifting inner pool of
// light · a lens rim · a moving specular highlight. While her team works,
// small satellites orbit her (one per busy agent, up to four). Grey when she
// is offline. No glow, by design — depth comes from shading, not bloom.
import { motion } from 'motion/react';

type St = 'idle' | 'busy' | 'off' | 'listening' | 'thinking' | 'speaking';

export function MiaMark({ size = 48, state = 'idle', level = 0 }: { size?: number; state?: St; level?: number }) {
  const off = state === 'off';
  const moving = state !== 'idle' && !off;
  const voice = state === 'listening' || state === 'speaking';
  const scale = voice ? 1 + Math.min(0.18, level * 0.6) : 1;
  const speed = state === 'thinking' ? 2.6 : state === 'busy' ? 7 : 14;
  const sats = state === 'busy' ? Math.max(1, Math.round(level * 4)) : 0;
  return (
    <motion.div aria-label={`Mia ${state}`} animate={{ scale }} transition={{ type: 'spring', stiffness: 300, damping: 18 }} style={{ width: size, height: size, flex: 'none', position: 'relative' }}>
      {sats ? (
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 9, ease: 'linear', repeat: Infinity }} style={{ position: 'absolute', inset: -size * 0.16 }}>
          {Array.from({ length: sats }, (_, i) => (
            <span key={i} style={{ position: 'absolute', left: '50%', top: '50%', width: Math.max(4, size * 0.09), height: Math.max(4, size * 0.09), borderRadius: '50%', background: 'radial-gradient(circle at 35% 30%, #fff, #f2c7ff 60%, #a37bd6)', transform: `rotate(${(360 / sats) * i}deg) translateY(-${size * 0.66}px)`, boxShadow: '0 1px 3px rgba(0,0,0,.5)' }} />
          ))}
        </motion.div>
      ) : null}
      <div
        style={{
          position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden',
          background: off ? 'radial-gradient(circle at 35% 30%, #8a8590, #3a373e 70%)' : 'radial-gradient(circle at 32% 28%, #ffe8d2 0%, #f7a8b8 24%, #b48cff 56%, #3c2468 100%)',
          boxShadow: `inset 0 -${size * 0.12}px ${size * 0.28}px rgba(30,8,50,.6), inset 0 ${size * 0.03}px ${size * 0.05}px rgba(255,255,255,.55), 0 ${size * 0.16}px ${size * 0.4}px -${size * 0.14}px rgba(0,0,0,.7)`,
          filter: off ? 'none' : undefined,
        }}
      >
        {!off ? (
          <>
            <motion.div animate={{ rotate: 360 }} transition={{ duration: speed, ease: 'linear', repeat: Infinity }} style={{ position: 'absolute', inset: '-25%', background: 'conic-gradient(from 0deg, transparent 0 18%, rgba(255,214,170,.55) 30%, transparent 42%, rgba(255,150,190,.45) 62%, transparent 76%)', mixBlendMode: 'overlay' }} />
            <motion.div animate={{ rotate: -360 }} transition={{ duration: speed * 1.6, ease: 'linear', repeat: Infinity }} style={{ position: 'absolute', inset: '-25%', background: 'conic-gradient(from 90deg, transparent 0 25%, rgba(200,160,255,.5) 40%, transparent 55%)', mixBlendMode: 'soft-light' }} />
            <motion.div
              animate={moving ? { x: ['-8%', '10%', '-4%', '-8%'], y: ['6%', '-6%', '10%', '6%'], scale: [1, 1.15, 0.95, 1] } : { x: '0%', y: '0%', scale: 1 }}
              transition={{ duration: moving ? speed * 1.3 : 0.8, repeat: moving ? Infinity : 0, ease: 'easeInOut' }}
              style={{ position: 'absolute', left: '25%', top: '42%', width: '55%', height: '45%', borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(255,230,200,.55), transparent)', mixBlendMode: 'screen' }}
            />
          </>
        ) : null}
        {/* lens rim */}
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', boxShadow: `inset 0 0 0 ${Math.max(1, size * 0.02)}px rgba(255,255,255,.22), inset 0 0 ${size * 0.12}px rgba(255,255,255,.18)` }} />
        {/* specular highlight, sliding a little like light moving across glass */}
        <motion.div
          animate={moving ? { x: [0, size * 0.05, 0], y: [0, size * 0.02, 0] } : { x: 0, y: 0 }}
          transition={{ duration: 6, repeat: moving ? Infinity : 0, ease: 'easeInOut' }}
          style={{ position: 'absolute', left: '20%', top: '11%', width: '36%', height: '22%', borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(255,255,255,.95), rgba(255,255,255,0))', transform: 'rotate(-18deg)' }}
        />
        <div style={{ position: 'absolute', right: '18%', bottom: '14%', width: '14%', height: '9%', borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(255,255,255,.55), transparent)' }} />
      </div>
    </motion.div>
  );
}
