import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { press } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';

// Pieces both talk engines share (Talk.jsx = basic whisper voice,
// RealtimeTalk.jsx = OpenAI realtime): the orb, transcript lines, labels.

export const LABEL = {
  starting: 'Starting…',
  connecting: 'Connecting…',
  standby: 'Tap to talk',
  listening: 'Listening',
  hearing: 'Listening',
  transcribing: 'Got it…',
  thinking: 'Mia is thinking',
  speaking: 'Mia is speaking',
  paused: 'Paused',
  interrupted: 'Tap to resume',
  error: 'Mic unavailable',
};
export const HINT = {
  starting: 'Allow the microphone if asked.',
  connecting: 'Opening the realtime voice.',
  standby: 'The voice is off. Mia’s replies are still read out.',
  listening: 'Just talk. A short pause sends it.',
  hearing: 'Pause when you’re done.',
  transcribing: 'Turning that into text.',
  thinking: 'You can keep talking.',
  thinkingRt: 'One moment.',
  speaking: 'Talk or tap to cut in.',
  paused: 'Tap to listen again.',
  interrupted: 'The audio was paused by iOS.',
};

export const isMiaMsg = (m) => m.from === 'mia' && m.kind !== 'event' && m.text;

export function micError(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError')
    return 'Microphone access is blocked. On iPad or iPhone: Settings › Apps › Safari › Microphone › Ask or Allow, then tap the mic to try again.';
  if (n === 'NotFoundError') return 'No microphone found.';
  if (n === 'NotReadableError') return 'The microphone is busy in another app.';
  return e?.message || 'Could not open the microphone.';
}

// What Mia says aloud for a question: the question and its options.
export function spokenFor(m) {
  let t = m.text;
  const opts = Array.isArray(m.options) ? m.options.filter(Boolean) : [];
  if (m.kind === 'question' && opts.length)
    t += `. ${opts.length === 2 ? `${opts[0]}, or ${opts[1]}` : `${opts.slice(0, -1).join(', ')}, or ${opts[opts.length - 1]}`}?`;
  return t;
}

export function Orb({ phase, levels, onTap }) {
  // The level arrives ~20×/s; only the orb re-renders for it, not the transcript.
  const [level, setLevel] = useState(0);
  useEffect(() => {
    levels.add(setLevel);
    return () => levels.delete(setLevel);
  }, [levels]);
  const live = phase === 'listening' || phase === 'hearing';
  const ring = live ? 1 + Math.min(1, level * 1.4) * 0.28 : 1;
  const icon = phase === 'speaking' ? 'stop' : 'mic';
  const tone =
    phase === 'hearing'
      ? 'bg-accent text-accent-ink'
      : live
        ? 'bg-ink text-bg'
        : phase === 'speaking'
          ? 'bg-ink text-bg'
          : phase === 'interrupted'
            ? 'bg-warn text-[#241a02]'
            : 'glass-strong text-ink2';
  return (
    <div className="relative grid h-[136px] w-[136px] place-items-center">
      {/* Level ring — scales with Daniel's voice while the mic is live. */}
      <motion.span
        aria-hidden="true"
        animate={{ scale: ring, opacity: live ? 1 : 0.35 }}
        transition={{ type: 'spring', stiffness: 420, damping: 28 }}
        className={`absolute inset-0 rounded-full border ${phase === 'hearing' ? 'border-accent/70' : 'border-glass-line2'}`}
      />
      {(phase === 'thinking' || phase === 'transcribing' || phase === 'starting' || phase === 'connecting') && (
        <motion.span
          aria-hidden="true"
          className="absolute inset-[6px] rounded-full border-2 border-transparent border-t-ink2/70"
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1.1, ease: 'linear' }}
        />
      )}
      {phase === 'speaking' && (
        <motion.span
          aria-hidden="true"
          className="absolute inset-[10px] rounded-full border border-ink/40"
          animate={{ scale: [1, 1.08, 1], opacity: [0.6, 0.2, 0.6] }}
          transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
        />
      )}
      <motion.button
        {...press}
        onClick={onTap}
        aria-label={phase === 'speaking' ? 'Stop Mia speaking' : phase === 'paused' ? 'Resume listening' : phase === 'interrupted' ? 'Resume' : phase === 'standby' ? 'Start talking' : 'Pause listening'}
        data-phase={phase}
        className={`relative grid h-[104px] w-[104px] place-items-center rounded-full transition-colors duration-300 ${tone}`}
      >
        <Icon name={icon} size={38} strokeWidth={1.6} />
        {phase === 'paused' && <span className="absolute h-[3px] w-12 rotate-45 rounded-full bg-current" />}
      </motion.button>
    </div>
  );
}

export function Line({ who, text, voice, live, pending }) {
  if (who === 'note')
    return (
      <motion.div
        layout="position"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.22 }}
        className="flex items-center gap-1.5 pt-2.5 text-[12px] text-ink3"
      >
        <Icon name="arrowRight" size={12} className="flex-none" />
        <span className="min-w-0 break-words">{text}</span>
      </motion.div>
    );
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="pt-3"
    >
      <div className="mb-0.5 flex items-center gap-1.5 text-[12px] font-semibold tracking-tight">
        <span className={who === 'mia' ? 'text-ink' : 'text-ink2'}>{who === 'mia' ? 'Mia' : 'You'}</span>
        {voice && <Icon name="mic" size={11} className="text-ink3" />}
        {live && <span className="text-[11px] font-medium text-accent">speaking</span>}
      </div>
      <div
        className={`whitespace-pre-wrap break-words text-[16px] leading-relaxed ${pending ? 'text-ink3' : who === 'mia' ? 'text-ink' : 'text-ink2'}`}
      >
        {text}
      </div>
    </motion.div>
  );
}

