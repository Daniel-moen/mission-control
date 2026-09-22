import { useState } from 'react';
import { motion } from 'motion/react';
import { saveToken } from '../lib/store.js';
import { spring } from '../lib/motion.js';
import Button from '../ui/Button.jsx';

// Sign-in: one quiet pane of glass in the dark.
export default function Gate() {
  const [value, setValue] = useState('');
  const go = () => value.trim() && saveToken(value);

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center px-6"
      style={{ paddingTop: 'var(--sat)', paddingBottom: 'var(--sab)' }}
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring.smooth}
        className="glass-strong w-full max-w-sm px-7 py-9 sm:px-9"
      >
        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-[24px] font-semibold tracking-tight">Mission Control</h1>
          <p className="text-[14px] leading-relaxed text-ink2">Enter your access token to connect to your Mac.</p>
        </div>

        <label className="label mb-2 block" htmlFor="gate-token">
          Access token
        </label>
        <input
          id="gate-token"
          className="glass-soft w-full rounded-xl2 px-4 py-3.5 font-mono text-[16px] text-ink outline-none transition-colors placeholder:text-ink3 focus:border-glass-line2"
          type="password"
          placeholder="••••••••••••"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <Button variant="primary" size="lg" block className="mt-4" disabled={!value.trim()} onClick={go}>
          Connect
        </Button>
      </motion.div>
    </div>
  );
}
