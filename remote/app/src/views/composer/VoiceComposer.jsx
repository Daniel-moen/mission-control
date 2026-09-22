import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useMC, broadcast, reply, agentStatus, agentName } from '../../lib/store.js';
import { useAgents } from '../../lib/hooks.js';
import { TONE } from '../../lib/tone.js';
import { dictate, speechSupported } from '../../lib/speech.js';
import { spring } from '../../lib/motion.js';
import Sheet from '../../ui/Sheet.jsx';
import Button from '../../ui/Button.jsx';
import Select from '../../ui/Select.jsx';
import Icon from '../../ui/Icon.jsx';

// Voice message — tap, then talk. It opens ALREADY listening (that is the whole
// point of the button that got you here), transcribes live into an editable
// field, and sends to one agent or the whole fleet.

export default function VoiceComposer({ initialTarget = 'all', onClose }) {
  const agents = useAgents();
  // The prop only SEEDS the target; retargeting afterwards is the user's call
  // and must survive every re-render (including new snapshots).
  const [target, setTarget] = useState(initialTarget || 'all');
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const sessionRef = useRef(null);
  const textRef = useRef('');
  textRef.current = text;

  function start() {
    if (sessionRef.current || !speechSupported) return;
    // `base` keeps what is already typed — restarting the mic appends rather
    // than wiping a message you half-dictated and then edited.
    const sess = dictate({
      base: textRef.current,
      onText: (t) => setText(t),
      onEnd: () => {
        sessionRef.current = null;
        setRecording(false);
      },
      onError: () => {
        sessionRef.current = null;
        setRecording(false);
      },
    });
    if (sess) {
      sessionRef.current = sess;
      setRecording(true);
    }
  }
  function stop() {
    sessionRef.current?.stop();
  }

  function send() {
    stop();
    const t = text.trim();
    if (!t) return;
    const ok = target === 'all' ? broadcast(t) : reply(target, t);
    if (ok) onClose?.();
  }

  useEffect(() => {
    start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const controllable = agents.filter((a) => a.controllable);
  const targetAgent = agents.find((a) => a.id === target) || null;
  const options = [
    { value: 'all', label: 'All agents' },
    ...controllable.map((a) => ({ value: a.id, label: agentName(a), hint: agentStatus(a) === 'waiting' ? 'needs you' : undefined })),
  ];

  return (
    <Sheet open onClose={onClose} title="Voice message" size="md">
      <div className="flex flex-col gap-3.5 pb-1">
        {/* who hears it */}
        <label className="block">
          <span className="label mb-1.5 block">Send to</span>
          <div className="flex items-center gap-2">
            {target !== 'all' && targetAgent && (
              <span className={`h-2 w-2 flex-none rounded-full ${TONE[agentStatus(targetAgent)].dot}`} />
            )}
            <Select className="min-w-0 flex-1" options={options} value={target} onChange={setTarget} />
          </div>
        </label>

        {/* live transcript — editable, because dictation is never perfect */}
        <div>
          {/* The listening flag sits ABOVE the field, never over it: on a phone
              a long first sentence runs straight under an overlaid badge. */}
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="label">Message</span>
            {recording && (
              <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-crit">
                <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-crit" />
                Listening
              </span>
            )}
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={recording ? 'Listening… speak now' : 'Type or tap the mic to speak'}
            className={`noscroll max-h-[38vh] min-h-[120px] w-full resize-none rounded-[18px] border bg-black/30 px-4 py-3.5 text-[15.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink3 ${
              recording ? 'border-crit/45' : 'border-glass-line focus:border-glass-line2'
            }`}
          />
        </div>

        <div className="flex items-center gap-3.5">
          {speechSupported && (
            <motion.button
              onClick={() => (recording ? stop() : start())}
              aria-label={recording ? 'Stop dictation' : 'Start dictation'}
              whileTap={{ scale: 0.95 }}
              animate={
                recording
                  ? { boxShadow: ['0 0 0 0 rgba(242,109,100,.45)', '0 0 0 14px rgba(242,109,100,0)'] }
                  : { boxShadow: '0 0 0 0 rgba(242,109,100,0)' }
              }
              transition={recording ? { duration: 1.5, repeat: Infinity, ease: 'easeOut' } : spring.snappy}
              className={`grid h-14 w-14 flex-none place-items-center rounded-full border transition-colors ${
                recording ? 'border-crit bg-crit/15 text-crit' : 'border-glass-line bg-white/[0.07] text-ink2 hover:text-ink'
              }`}
            >
              <Icon name="mic" size={24} strokeWidth={2.1} />
            </motion.button>
          )}
          <div className="min-w-0 flex-1">
            <div className={`text-[13px] font-medium ${recording ? 'text-crit' : 'text-ink2'}`}>
              {recording ? 'Recording' : 'Ready'}
            </div>
            <div className="mt-0.5 truncate text-[12px] text-ink3">
              {target === 'all' ? 'Broadcasting to every agent' : `Sending to ${agentName(targetAgent) || 'agent'}`}
            </div>
          </div>
          <Button variant="primary" size="lg" icon="send" onClick={send} disabled={!text.trim()}>
            Send
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
