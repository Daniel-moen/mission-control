'use client';
// Fleet: the machine room. Plan limits, spend, Mia's engine (slots, budget),
// the Mac, and every session with a stop button.
import { useMemo } from 'react';
import { motion } from 'motion/react';
import { useMC } from '@/lib/store';
import { open } from '@/lib/nav';
import { agentState, elapsed, isLive, modelName, money, spendToday, tokens } from '@/lib/model';
import { TopBar, Ring } from './Now';
import { Glass, Icon, ModelChip, Num, spring } from '@/ui/kit';
import { ProgressRing, Sparkline } from '@/ui/charts';

function Stat({ label, value, sub, art }: { label: string; value: React.ReactNode; sub?: string; art?: React.ReactNode }) {
  return (
    <Glass variant="thin" radius={22} style={{ padding: '14px 16px' }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div className="tiny" style={{ fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', marginTop: 2 }}>{value}</div>
          {sub ? <div className="tiny">{sub}</div> : null}
        </div>
        {art}
      </div>
    </Glass>
  );
}

export function Fleet() {
  const mia = useMC((s) => s.mia);
  const agents = useMC((s) => s.agents);
  const usage = useMC((s) => s.usage);
  const system = useMC((s) => s.system);
  const now = useMC((s) => s.now);
  const spend = useMemo(() => spendToday(mia, now), [mia, Math.floor(now / 60000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const jobs = mia?.jobs;
  const live = (jobs?.jobs || []).filter(isLive);
  const recent = (jobs?.jobs || []).filter((j) => !isLive(j)).slice(0, 12);
  const costHist = useMC((s) => s.hist['fleet:cost']);
  const tps = useMC((s) => s.spark);
  return (
    <div className="wrap">
      <TopBar title="Fleet" />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
        <Stat label="Spent today" value={<Num value={spend.total} format={money} />} sub={`${spend.runs} runs`} art={costHist && costHist.length > 2 ? <Sparkline data={costHist} width={64} height={34} tone="ember" /> : null} />
        <Stat label="Executors" value={<span className="num">{live.length}<span className="dim" style={{ fontSize: 18 }}>/{jobs?.cap ?? '–'}</span></span>} sub={jobs?.online ? 'mia-core running' : 'mia-core off'} art={<ProgressRing value={live.length / Math.max(1, jobs?.cap || 4)} size={38} stroke={4} tone="green" spin={live.length > 0} />} />
        <Stat label="Opus today" value={<span className="num">{tokens(jobs?.opusTokensToday || 0)}</span>} sub="tokens" art={tps.length > 2 ? <Sparkline data={tps.slice(-30)} width={64} height={34} tone="violet" min={0} /> : null} />
        {system ? <Stat label="Mac" value={<span className="num">{Math.round(system.cpu)}%</span>} sub={system.memTotalMB ? `${(system.memUsedMB! / 1024).toFixed(1)} / ${(system.memTotalMB / 1024).toFixed(0)} GB` : 'CPU'} art={<ProgressRing value={system.cpu / 100} size={38} stroke={4} tone={system.cpu > 80 ? 'red' : 'white'} />} /> : null}
      </div>

      <div className="section-h"><h2>Plan limits</h2><span className="small">{usage?.plan || ''}</span></div>
      <Glass radius={24} style={{ padding: 16 }}>
        {(usage?.windows || []).length ? (
          <div className="col gap12">
            {usage!.windows!.map((w) => (
              <div key={w.key} className="row gap12">
                <ProgressRing value={(w.pct || 0) / 100} size={40} stroke={4.5} tone={(w.pct || 0) >= 80 ? 'red' : (w.pct || 0) >= 60 ? 'amber' : w.key.includes('fable') ? 'ember' : 'violet'}>
                  <span className="num" style={{ fontSize: 10.5, fontWeight: 700 }}>{Math.round(w.pct || 0)}</span>
                </ProgressRing>
                <div className="grow">
                  <div className="row"><span className="title-s grow">{w.label || w.key}</span><span className="num small">{Math.round(w.pct || 0)}%</span></div>
                  <div className="tiny">{w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
                </div>
              </div>
            ))}
            {jobs?.budget ? <div className="tiny">Opus pauses at {Math.round((jobs.budget.pauseAt || 0.8) * 100)}% · {jobs.budget.paused ? 'paused now' : 'running'}</div> : null}
          </div>
        ) : (
          <div className="small">No usage reading yet. The Mac pushes one every few minutes.</div>
        )}
      </Glass>

      <div className="section-h"><h2>Sessions</h2><span className="small num">{agents.length}</span></div>
      <Glass radius={24} style={{ padding: 6 }}>
        {agents.map((a) => {
          const st = agentState(a);
          return (
            <motion.button key={a.id} layout="position" transition={spring} className="row" style={{ width: '100%', padding: '11px 12px', borderRadius: 16, textAlign: 'left' }} onClick={() => open({ kind: 'agent', id: a.id })} data-agent={a.id}>
              <span className={`dot ${st === 'working' ? 'green live' : st === 'waiting' ? 'amber' : st === 'exited' ? 'red' : ''}`} />
              <div className="grow">
                <div className="title-s trunc">{a.name || a.folder}</div>
                <div className="tiny trunc">{a.activity || a.statusLabel}</div>
              </div>
              <span className="tiny num">{money(a.cost || 0)}</span>
              <Icon name="chevron" size={16} className="dim" />
            </motion.button>
          );
        })}
        {!agents.length ? <div className="small" style={{ padding: 20, textAlign: 'center' }}>No sessions on the Mac.</div> : null}
      </Glass>

      <div className="section-h"><h2>Recent runs</h2></div>
      <Glass radius={24} style={{ padding: 6 }}>
        {recent.map((j) => (
          <button key={j.id} className="row" style={{ width: '100%', padding: '10px 12px', borderRadius: 16, textAlign: 'left' }} onClick={() => (j.taskId ? open({ kind: 'task', id: j.taskId }) : open({ kind: 'job', id: String(j.id) }))}>
            <span className={`dot ${j.status === 'finished' ? '' : j.status === 'failed' ? 'red' : ''}`} />
            <div className="grow">
              <div className="small trunc" style={{ color: 'var(--ink)' }}>{j.taskId ? `#${j.taskId}` : j.beat || j.kind || `Job ${j.id}`} · {j.status}</div>
              <div className="tiny">{j.startedAt && j.finishedAt ? elapsed(Date.parse(j.startedAt), Date.parse(j.finishedAt)) : ''} {modelName(j.model)}</div>
            </div>
            <ModelChip model={j.model} />
            <span className="tiny num" style={{ width: 52, textAlign: 'right' }}>{money(j.costUsd || 0)}</span>
          </button>
        ))}
        {!recent.length ? <div className="small" style={{ padding: 20, textAlign: 'center' }}>No runs yet.</div> : null}
      </Glass>
    </div>
  );
}
