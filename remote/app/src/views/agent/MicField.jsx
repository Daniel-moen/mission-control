import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { dictate, speechSupported } from '../../lib/speech.js';
import { press } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';

// Reply composer: type it or say it. The mic streams INTERIM results straight
// into the textarea, so you watch the words land and can edit before sending —
// that live-transcript loop is the whole reason voice is usable here.
//
// Enter sends, Shift+Enter makes a newline (it is a textarea so a long
// instruction can breathe). The mic button is simply absent where the Web
// Speech API isn't — no dead control, no apology.
export default function MicField({ onSend, placeholder = 'Message…', autoFocus = false }) {
  const [value, setValue] = useState('');
  const [recording, setRecording] = useState(false);
  const session = useRef(null);
  const field = useRef(null);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  // A dictation session outlives a re-render but must not outlive the component.
  useEffect(() => () => session.current?.stop(), []);

  function toggleMic() {
    if (session.current) {
      session.current.stop();
      return;
    }
    const s = dictate({
      base: value,
      onText: (t) => setValue(t),
      onEnd: () => {
        session.current = null;
        setRecording(false);
      },
      onError: () => {
        session.current = null;
        setRecording(false);
      },
    });
    if (s) {
      session.current = s;
      setRecording(true);
    }
  }

  function submit() {
    session.current?.stop();
    const text = value.trim();
    if (!text) return;
    // A handler may refuse (socket down) — keep the text so nothing is lost.
    if (onSend?.(text) === false) return;
    setValue('');
  }

  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={field}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        className={`noscroll max-h-32 min-h-[48px] flex-1 resize-none rounded-xl2 border bg-term px-4 py-3 text-[16px] leading-snug text-ink outline-none transition-colors placeholder:text-ink3 ${
          recording ? 'border-crit/45' : 'border-glass-line focus:border-glass-line2'
        }`}
      />

      {speechSupported && (
        <motion.button
          {...press}
          onClick={toggleMic}
          aria-label="Dictate"
          aria-pressed={recording}
          className={`grid h-12 w-12 flex-none place-items-center rounded-xl2 border transition-colors ${
            recording ? 'anim-pulse border-crit bg-crit/15 text-crit' : 'glass-soft glass-soft-hover text-ink2'
          }`}
        >
          <Icon name="mic" size={21} />
        </motion.button>
      )}

      <motion.button
        {...press}
        onClick={submit}
        disabled={!value.trim()}
        aria-label="Send"
        className="grid h-12 w-12 flex-none place-items-center rounded-xl2 bg-ink text-bg transition-opacity disabled:pointer-events-none disabled:opacity-40"
      >
        <Icon name="send" size={19} />
      </motion.button>
    </div>
  );
}
