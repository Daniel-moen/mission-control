import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { miaAnswer } from '../../lib/store.js';
import { spring, press } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';

// One way to answer Mia, used by the thread and by the Home attention card:
// her options as pills (one tap = answered), plus a free-text answer for when
// none of them fit. Answering sends `miaAnswer`; the store echoes it locally so
// the pills leave at once instead of waiting a snapshot.

export function OptionPill({ onClick, children, title, tone = 'neutral' }) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      transition={spring.snappy}
      onClick={onClick}
      title={title}
      className={`pill inline-flex h-8 max-w-full flex-none items-center gap-1.5 px-3.5 text-[12.5px] transition-colors ${
        tone === 'accent' ? 'bg-ink font-semibold text-bg' : 'glass-soft glass-soft-hover text-ink'
      }`}
    >
      <span className="truncate">{children}</span>
    </motion.button>
  );
}

export default function Answer({ question, autoOpen = false }) {
  const options = Array.isArray(question?.options) ? question.options.filter(Boolean) : [];
  // With no options the text field IS the answer — show it straight away.
  const [open, setOpen] = useState(autoOpen || options.length === 0);
  const [text, setText] = useState('');

  const qid = question?.questionId || question?.id;
  const answer = (t) => {
    if (miaAnswer(qid, t)) setText('');
  };

  return (
    <div className="flex flex-col gap-2">
      {options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o, i) => (
            <OptionPill key={`${i}:${o}`} onClick={() => answer(String(o))} title={String(o)}>
              {String(o)}
            </OptionPill>
          ))}
          {!open && (
            <OptionPill onClick={() => setOpen(true)} title="Answer in your own words">
              Other…
            </OptionPill>
          )}
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.form
            key="free"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.smooth}
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) answer(text);
            }}
            className="flex items-center gap-1.5 overflow-hidden"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Your answer…"
              autoFocus={options.length > 0}
              className="glass-soft h-9 min-w-0 flex-1 rounded-full px-3.5 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink3 focus:border-glass-line2"
            />
            <motion.button
              {...press}
              type="submit"
              disabled={!text.trim()}
              aria-label="Send answer"
              className="grid h-9 w-9 flex-none place-items-center rounded-full bg-ink text-bg transition-opacity disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon name="send" size={15} />
            </motion.button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
