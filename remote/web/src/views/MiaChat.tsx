'use client';
// Mia: just the conversation (Daniel's rule: no bottom bar clutter here —
// model and notifications live in Settings). Questions render as answerable
// cards inline; task events are quiet centred lines that open the task.

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { miaRead, useMC, VOICE_TAG } from '@/lib/store';
import { open } from '@/lib/nav';
import { Composer, QuestionCard } from './parts';
import { MiaMark } from './MiaMark';
import { Glass, Icon, spring } from '@/ui/kit';
import { modelName } from '@/lib/model';
import type { MiaMessage } from '@/lib/types';

function time(at?: string) {
  const t = at ? new Date(at) : null;
  return t && !isNaN(+t) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
}

export function MiaChat({ active }: { active: boolean }) {
  const mia = useMC((s) => s.mia);
  const local = useMC((s) => s.miaLocal);
  const scroller = useRef<HTMLDivElement>(null);
  const msgs = mia?.messages || [];
  const open_ = useMemo(() => new Set([...(mia?.pendingQuestions || []), ...(mia?.oldQuestions || [])].map((q) => q.questionId)), [mia]);
  const pendingEcho = local.sent.map((p, i) => ({ id: `local-${i}`, from: 'daniel', kind: 'chat', text: p.text, at: new Date(p.at).toISOString(), pending: true }));
  const all: (MiaMessage & { pending?: boolean })[] = [...msgs.slice(-120), ...pendingEcho];

  useLayoutEffect(() => {
    const el = scroller.current?.closest('.pane') as HTMLElement | null;
    if (el && active) el.scrollTop = el.scrollHeight;
  }, [all.length, active]);
  useEffect(() => {
    if (active && msgs.length) miaRead(msgs[msgs.length - 1].id);
  }, [active, msgs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="wrap" style={{ maxWidth: 820 }} ref={scroller}>
      <Glass lens radius={26} className="row chat-head" style={{ padding: '12px 14px', marginBottom: 16 }}>
        <MiaMark size={40} state={mia?.online ? 'idle' : 'off'} />
        <div className="grow">
          <div className="title-m">Mia</div>
          <div className="tiny">{mia?.online ? `Online · ${modelName(mia.runningModel || mia.model)}` : mia ? 'Offline' : 'Not connected'}</div>
        </div>
        <button className="pill small" onClick={() => import('@/lib/nav').then((n) => n.setTalk(true))}>
          <Icon name="wave" size={16} /> Talk
        </button>
      </Glass>
      <div className="col chat-list" style={{ gap: 8, paddingBottom: 12 }}>
        <AnimatePresence initial={false}>
          {all.map((m) => {
            if (m.kind === 'question' && m.questionId && open_.has(m.questionId) && !(m.questionId in local.answered)) {
              const q = [...(mia?.pendingQuestions || []), ...(mia?.oldQuestions || [])].find((x) => x.questionId === m.questionId);
              if (q) return (
                <motion.div key={m.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} style={{ alignSelf: 'stretch' }}>
                  <QuestionCard q={q} scope="mia" />
                </motion.div>
              );
            }
            const mine = m.from === 'daniel';
            const event = m.from === 'system' || m.kind === 'event';
            let text = String(m.text || '');
            const voice = text.startsWith(VOICE_TAG);
            if (voice) text = text.slice(VOICE_TAG.length);
            if (m.kind === 'answer') text = `↳ ${text}`;
            return (
              <motion.div
                key={m.id}
                layout="position"
                initial={{ opacity: 0, y: 14, scale: 0.98 }}
                animate={{ opacity: m.pending ? 0.6 : 1, y: 0, scale: 1 }}
                transition={spring}
                className={`msg ${event ? 'event' : mine ? 'me' : 'mia'}`}
                onClick={event && m.taskId ? () => open({ kind: 'task', id: String(m.taskId) }) : undefined}
                style={event && m.taskId ? { cursor: 'pointer' } : undefined}
                data-msg={m.id}
              >
                {voice ? <Icon name="mic" size={13} style={{ marginRight: 4, verticalAlign: -2 }} /> : null}
                {text}
                {!event ? <div style={{ fontSize: 10.5, opacity: 0.5, marginTop: 3, textAlign: mine ? 'right' : 'left' }}>{time(m.at)}</div> : <span> · {time(m.at)}</span>}
              </motion.div>
            );
          })}
        </AnimatePresence>
        {!all.length ? <div className="small" style={{ textAlign: 'center', padding: 40 }}>No messages yet. Say hello to Mia.</div> : null}
      </div>
      <div style={{ position: 'sticky', bottom: 0, paddingTop: 6, zIndex: 20 }}>
        <Composer placeholder="Message Mia" />
      </div>
    </div>
  );
}
