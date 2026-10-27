import { useEffect, useState } from 'react';
import { useMC, tarsRun, tarsStatus } from '../lib/store.js';
import { useLocalStorage } from '../lib/hooks.js';
import Button from '../ui/Button.jsx';

// "tars" card: runs a computer-use task on the Mac through the relay (the
// Mac's bridge calls its local trigger; the trigger token never leaves it).
// A small glass pill above the dock that opens into a card — textbox, Run, and
// the last run's status/result, polled every 5 s while the card is open.
const loom = (key, unit) =>
  `Open https://pi.loom.co.za/property?propertyKey=${key}&unitNumber=${unit} in Chrome. Wait for the page to load, click "Deeds Info", then click "Show Details" next to Current Owner, then "Accept" in the "Deeds Info Consent" popup. Never click Get number. Report the owner names and ID numbers exactly as shown with finished().`;
const PRESETS = [
  { label: 'Ivanette 301', text: 'On the open LOOM Deeds Info page for Ivanette Court 301, click "Show Details" next to Current Owner, then click "Accept" in the "Deeds Info Consent" popup. Never click Get number. Report the owner names and ID numbers exactly as shown with finished().' },
  { label: 'Tafelsicht 6', text: loom('C01600590000146000000', '00006') },
  { label: 'Strand Beach 506', text: loom('C01600510000138700000', '00506') },
];
const LABEL = { running: 'Running…', finished: 'Finished', failed: 'Failed', idle: 'Idle' };

export default function TarsCard({ hidden }) {
  const [open, setOpen] = useLocalStorage('mc.tarsOpen', false);
  const [task, setTask] = useState('');
  const linked = useMC((s) => s.link === 'linked');
  const t = useMC((s) => s.tars);

  useEffect(() => {
    if (!open || !linked) return undefined;
    tarsStatus();
    const id = setInterval(tarsStatus, 5000);
    return () => clearInterval(id);
  }, [open, linked]);

  if (hidden) return null;
  const running = t?.status === 'running';
  const tone = t?.status === 'finished' ? 'text-accent' : t?.status === 'failed' ? 'text-crit' : 'text-ink2';
  const run = () => {
    if (tarsRun(task)) setTask('');
    setTimeout(tarsStatus, 800);
  };

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[55] flex justify-start px-3"
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 82px)' }}
      data-tars={open ? 'open' : 'closed'}
    >
      {!open ? (
        <button onClick={() => setOpen(true)} aria-label="Run tars" className="glass pill pointer-events-auto h-9 px-4 text-[13px] font-medium text-ink2 hover:text-ink">
          tars{running ? ' · running' : ''}
        </button>
      ) : (
        <div className="glass pointer-events-auto w-full max-w-[420px] rounded-xl2 p-3" role="group" aria-label="tars">
          <div className="mb-2 flex items-center justify-between text-[13px] font-medium">
            <span>Run tars</span>
            <button onClick={() => setOpen(false)} aria-label="Close tars" className="px-2 text-ink2 hover:text-ink">✕</button>
          </div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PRESETS.map((x) => (
              <button key={x.label} onClick={() => setTask(x.text)} className="glass-soft glass-soft-hover pill h-8 px-3 text-[12.5px] text-ink">
                {x.label}
              </button>
            ))}
          </div>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder="What should tars do on the Mac?"
            aria-label="tars task"
            className="mb-2 w-full resize-none rounded-lg bg-white/[0.06] p-2 text-[14px] text-ink outline-none placeholder:text-ink2"
          />
          <div className="mb-2 flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={run} disabled={!task.trim() || running || !linked}>Run</Button>
            <span className={`text-[12.5px] ${tone}`} data-tars-status={t?.status || ''}>
              {!linked ? 'Mac offline' : t?.error ? t.error : t?.status ? LABEL[t.status] || t.status : '…'}
            </span>
          </div>
          {t?.task && <div className="mb-1 line-clamp-2 text-[12px] text-ink2">{t.task}</div>}
          {t?.result && <div className="max-h-40 overflow-auto whitespace-pre-wrap text-[13px] text-ink" data-tars-result>{t.result}</div>}
        </div>
      )}
    </div>
  );
}
