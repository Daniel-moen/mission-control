import { useEffect, useState } from 'react';
import { useMC, socketState, reconnectNow } from '../lib/store.js';

// #diag — a plain read-out of the panel's link for a device that won't
// connect. No glass, no motion, no dependencies on the snapshot: this must
// render even when nothing else does. Works with no token (it says so).

function Row({ k, v }) {
  return (
    <div className="flex gap-3 border-b border-white/10 py-2 text-[13px]">
      <div className="w-32 flex-none text-white/50">{k}</div>
      <div className="min-w-0 flex-1 break-all font-mono text-white">{String(v)}</div>
    </div>
  );
}

async function probe(path, token) {
  const t0 = Date.now();
  try {
    const r = await fetch(path, {
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const text = await r.text();
    return `${r.status} in ${Date.now() - t0}ms — ${text.slice(0, 120)}`;
  } catch (err) {
    return `FAILED in ${Date.now() - t0}ms — ${err && err.message ? err.message : err}`;
  }
}

export default function Diag() {
  const s = useMC();
  const [health, setHealth] = useState('…');
  const [status, setStatus] = useState('…');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    probe('/health', '').then(setHealth);
    probe('/api/v1/status', s.token).then(setStatus);
  }, [s.token]);

  const d = s.diag || {};
  const ago = (t) => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : 'never');
  const ua = navigator.userAgent;
  const standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  return (
    <div className="fixed inset-0 z-[200] overflow-auto bg-[#111113] px-5 py-8 text-white" style={{ paddingTop: 'max(2rem, env(safe-area-inset-top))' }}>
      <div className="mx-auto max-w-lg">
        <h1 className="mb-1 text-[20px] font-semibold">Link diagnostics</h1>
        <p className="mb-6 text-[13px] text-white/50">Screenshot this whole screen. Nothing here is secret. Tick {tick}.</p>

        <Row k="Page" v={`${location.origin}${location.pathname}`} />
        <Row k="Secure context" v={window.isSecureContext} />
        <Row k="Standalone app" v={standalone} />
        <Row k="Online (OS)" v={navigator.onLine} />
        <Row k="Token stored" v={s.token ? `yes (${s.token.length} chars)` : 'NO — enter it at the gate first'} />
        <Row k="Needs token" v={s.needsToken} />
        <Row k="Link state" v={s.link} />
        <Row k="Transport" v={s.transport === 'poll' ? 'HTTP polling (fallback)' : 'WebSocket'} />
        <Row k="Transport switch" v={d.switchedAt ? `${ago(d.switchedAt)} — ${d.switchReason}` : 'never'} />
        <Row k="WS fails in a row" v={d.wsFails || 0} />
        <Row k="Socket" v={socketState()} />
        <Row k="Last dial" v={`${ago(d.lastAttemptAt)} → ${d.lastUrl || '—'}`} />
        <Row k="Opens / closes" v={`${d.opens || 0} / ${d.closes || 0}`} />
        <Row k="Errors" v={d.errors || 0} />
        <Row k="Frames received" v={`${d.frames || 0} (last: ${d.lastFrameType || '—'})`} />
        <Row k="Last close" v={d.lastClose ? `code ${d.lastClose.code} ${d.lastClose.reason ? `“${d.lastClose.reason}”` : ''} ${ago(d.lastClose.at)}` : 'none'} />
        <Row k="Last snapshot" v={ago(s.lastSnapshotAt)} />
        <Row k="Polls" v={d.polls || 0} />
        <Row k="Last poll" v={d.lastPollAt ? `${d.lastPollStatus} ${ago(d.lastPollAt)}` : 'never'} />
        <Row k="Last cmd" v={d.lastCmdAt ? `${d.lastCmdStatus} ${ago(d.lastCmdAt)}` : 'never'} />
        <Row k="GET /health" v={health} />
        <Row k="GET /api/v1/status" v={status} />
        <Row k="Browser" v={ua} />

        <div className="mt-6 flex gap-3">
          <button className="rounded-lg bg-white px-4 py-2 text-[13px] font-semibold text-black" onClick={reconnectNow}>
            Redial now
          </button>
          <button className="rounded-lg border border-white/20 px-4 py-2 text-[13px]" onClick={() => (location.hash = '')}>
            Back to panel
          </button>
        </div>
      </div>
    </div>
  );
}
