'use client';
// Tasks: Mia's work as a flow. Wide screens get four lanes side by side
// (queued → running → checking → done) and a card glides between lanes when
// its status moves; phones get the same lanes stacked, with a stage filter.

import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { STAGES, STAGE_LABEL, flow, taskCards, type Stage } from '@/lib/model';
import { useMC } from '@/lib/store';
import { open } from '@/lib/nav';
import { TaskCardView } from './parts';
import { TopBar } from './Now';
import { Icon, listItem, spring } from '@/ui/kit';
import { useWide } from './hooks';

export function Tasks() {
  const mia = useMC((s) => s.mia);
  const cards = useMemo(() => taskCards(mia), [mia]);
  const lanes = useMemo(() => flow(cards), [cards]);
  const wide = useWide(900);
  const [pick, setPick] = useState<Stage | 'active'>('active');
  const shown: Stage[] = wide ? STAGES : pick === 'active' ? ['queued', 'running', 'checking'] : [pick];

  return (
    <div className="wrap" style={{ maxWidth: wide ? 1400 : undefined }}>
      <TopBar title="Tasks" />
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {!wide ? (
          <div className="seg" role="tablist">
            {(['active', ...STAGES] as const).map((s) => (
              <button key={s} className={pick === s ? 'on' : ''} onClick={() => setPick(s)} role="tab" aria-selected={pick === s}>
                {pick === s ? <motion.span layoutId="seg-thumb" className="thumb" transition={spring} /> : null}
                {s === 'active' ? 'Active' : STAGE_LABEL[s]}
                <span className="num" style={{ opacity: 0.6, marginLeft: 4 }}>{s === 'active' ? lanes.queued.length + lanes.running.length + lanes.checking.length : lanes[s].length}</span>
              </button>
            ))}
          </div>
        ) : null}
        <span className="grow" />
        <button className="pill primary" onClick={() => open({ kind: 'new' })}>
          <Icon name="plus" size={17} stroke={2.2} /> New task
        </button>
      </div>
      <LayoutGroup id="lanes">
        <div className="grid" style={{ gridTemplateColumns: wide ? 'repeat(4, minmax(0,1fr))' : '1fr', gap: wide ? 14 : 4, alignItems: 'start' }}>
          {shown.map((s) => (
            <section key={s} data-lane={s}>
              <div className="row" style={{ margin: wide ? '0 4px 10px' : '14px 4px 10px' }}>
                <span className={`dot ${s === 'running' ? 'green live' : s === 'checking' ? 'violet' : s === 'queued' ? 'amber' : ''}`} style={{ width: 7, height: 7 }} />
                <span className="title-s">{STAGE_LABEL[s]}</span>
                <span className="small num">{lanes[s].length}</span>
              </div>
              <div className="col gap8" style={{ gap: 10 }}>
                <AnimatePresence mode="popLayout" initial={false}>
                  {(s === 'done' ? lanes.done.slice(0, 40) : lanes[s]).map((c) => (
                    <motion.div key={c.id} layout {...listItem} transition={spring}>
                      <TaskCardView card={c} scope="tasks" compact={wide} />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {!lanes[s].length ? <div className="tiny" style={{ padding: '10px 6px' }}>Nothing {s === 'done' ? 'finished yet' : 'here'}.</div> : null}
              </div>
            </section>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
