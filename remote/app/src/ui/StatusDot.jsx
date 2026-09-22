import { TONE } from '../lib/tone.js';

// The smallest carrier of state in the app. Only a *working* agent gets the
// ping — motion means "something is happening right now", so a done agent that
// kept pulsing would be a lie.
export default function StatusDot({ status = 'done', size = 8, pulse = true, className = '' }) {
  const t = TONE[status] || TONE.done;
  const working = status === 'working';
  return (
    <span className={`relative flex flex-none ${className}`} style={{ width: size, height: size }}>
      {working && pulse && (
        <span className={`anim-ping absolute inline-flex h-full w-full rounded-full ${t.dot} opacity-50`} />
      )}
      <span className={`relative inline-flex h-full w-full rounded-full ${t.dot}`} />
    </span>
  );
}
