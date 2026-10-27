import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { useShallow } from 'zustand/react/shallow';
import {
  useMC, miaSend, miaRead, miaAnswer, miaAnswerFor, miaQuestionState, miaDismiss, miaDismissOld, miaOldQuestions, miaCanDismiss, miaStart,
  miaOpenQuestions, miaTaskAdd, miaSchedule, voiceText, fmtQuestionAge, agentName, agentStatus, toast,
} from '../src/lib/store.js';
import { stageFiles, unstage, sendStaged, retryUpload, dismissUpload, fmtSize, fileIcon } from '../src/lib/upload.js';
import { useAttach, detachRef, clearRefs, withRefs, splitRefs } from '../src/lib/attach.js';
import { dictate, speechSupported } from '../src/lib/speech.js';
import { openSheet, push } from '../v2/lib/nav.js';
import { usePrefs } from '../v2/lib/prefs.js';
import { spring, tap } from '../v2/lib/motion.js';
import { usePageVisible } from '../v2/ui/hooks.js';
import { Button, Icon } from '../v2/ui/kit.jsx';
import { Answer } from '../v2/views/parts/Needs.jsx';
import { startVoice } from '../v2/shell/TalkHost.jsx';
import { haptic } from '../v5/ux.jsx';
import { useV53, growFrom, setDraft } from './state.js';
import { useExecutors, Ring, progressOf } from './Rings.jsx';
import Orb from './Orb.jsx';

// v5.3's chat (tasks 0491, 0502): the home screen. Built from v2's thread (same
// rows, read marker, uploads, refs, old-question handling) and made the
// centre of everything:
//   • Mia's prose sits on the glass, calm and large; Daniel's words are a
//     soft glass bubble on the right.
//   • what she talks about comes as RICH GLASS CARDS in the stream: a task
//     (status, its agent's progress ring, the latest log line), a Library doc
//     she names, a question with its answers as buttons. A tap opens the card
//     IN PLACE (more detail, the actions); "Open" grows it into the pane.
//   • the live card at the foot: what's running right now, with rings.
//   • messages ARRIVE: a spring rise and a de-blur for hers, a lift from the
//     composer for his. Only new rows animate, never the history.
//   • long-press (or right-click) a message: make it a task, a reminder,
//     reply to it, copy it.

export const toMs = (at) => {
  if (!at) return 0;
  if (typeof at === 'number') return at > 1e12 ? at : at * 1000;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
};
const hhmm = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
function dayLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const t = new Date();
  const y = new Date();
  y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
const LIVE = new Set(['queued', 'asking', 'running', 'checking']);
const T_LABEL = { queued: 'Queued', asking: 'Waiting on you', running: 'Running', checking: 'Checking', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const T_TONE = { asking: 'text-warn', running: 'text-accent', checking: 'text-mgr', failed: 'text-crit', done: 'text-ink3', cancelled: 'text-ink3', queued: 'text-ink2' };

// open something in the pane, growing out of the element tapped
const openFrom = (el, name, params) => {
  growFrom(el);
  push(name, params);
};

// ---- Library docs Mia names ---------------------------------------------------
// A doc is "named" when its id (the filename, with or without .md) appears in
// her words, or a #doc/<id> link does. At most two cards per message.
function useDocIndex() {
  const docs = useMC((s) => s.docs);
  return useMemo(() => {
    const m = new Map();
    for (const d of docs || []) {
      if (!d?.id) continue;
      const base = d.id.replace(/\.md$/, '').toLowerCase();
      if (base.length >= 6) m.set(base, d);
    }
    return m;
  }, [docs]);
}
function docsIn(text, index) {
  if (!text || !index.size) return [];
  const out = [];
  const seen = new Set();
  for (const hit of String(text).toLowerCase().matchAll(/(?:#doc\/)?([a-z0-9][a-z0-9._-]{5,}?)(?:\.md)?(?=$|[\s,.;:!?)"'’”\]])/g)) {
    const d = index.get(hit[1]);
    if (d && !seen.has(d.id)) {
      seen.add(d.id);
      out.push(d);
      if (out.length === 2) break;
    }
  }
  return out;
}

// ---- cards ----------------------------------------------------------------------

function CardShell({ children, open, onToggle, tone, ...rest }) {
  const reduce = usePrefs((s) => s.reduce);
  return (
    <motion.div
      layout={!reduce}
      transition={spring.layout}
      className={`v53-card mt-2.5 w-full max-w-[560px] overflow-hidden ${tone === 'warn' ? 'warn' : ''} ${open ? 'open' : ''}`}
      data-lens
      data-depth="0.35"
      {...rest}
    >
      <motion.button layout={!reduce ? 'position' : false} onClick={onToggle} className="flex w-full items-center gap-3 px-3.5 py-3 text-left" aria-expanded={open}>
        {children[0]}
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="more"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring.layout}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3.5">{children[1]}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function TaskCard({ id }) {
  const { t, agents } = useMC(useShallow((s) => ({ t: (s.mia?.tasks || []).find((x) => x.id === id) || null, agents: s.agents })));
  const [open, setOpen] = useState(false);
  if (!t) return null;
  const ex = t.executor && typeof t.executor === 'object' ? t.executor : null;
  const a = ex?.sessionId ? agents.find((x) => x.id === ex.sessionId) : null;
  const log = Array.isArray(t.log) ? t.log : [];
  const lastLog = log[log.length - 1];
  const live = LIVE.has(t.status);
  const result = t.result == null ? '' : typeof t.result === 'string' ? t.result : '';
  return (
    <CardShell open={open} onToggle={() => setOpen((v) => !v)} tone={t.status === 'asking' ? 'warn' : ''} data-task={t.id} data-task-card={t.id} data-grow={`task:${t.id}`}>
      <>
        <span className="grid h-9 w-9 flex-none place-items-center rounded-[12px] bg-fill text-ink2">
          {a && live ? <Ring a={a} size={24} /> : <Icon name="tasks" size={17} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.94rem] font-semibold text-ink">{t.title || `Task ${t.id}`}</span>
          <span className="flex items-center gap-1.5 truncate text-[0.78rem]">
            <span className={`font-semibold ${T_TONE[t.status] || 'text-ink3'}`} data-task-status={t.status}>{T_LABEL[t.status] || t.status}</span>
            <span className="font-mono text-ink3">#{t.id}</span>
            {a && <span className="truncate text-ink3">· {a.activity || agentName(a)}</span>}
          </span>
        </span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="flex-none text-ink3">
          <Icon name="chevronRight" size={16} />
        </motion.span>
      </>
      <>
        {t.detail && t.detail !== t.title && <p className="mb-2.5 line-clamp-4 whitespace-pre-wrap break-words text-[0.86rem] leading-relaxed text-ink2">{t.detail}</p>}
        {result && <p className="mb-2.5 line-clamp-4 whitespace-pre-wrap break-words text-[0.86rem] leading-relaxed text-ink">{result}</p>}
        {lastLog && (
          <p className="mb-3 flex gap-2 text-[0.8rem] text-ink3">
            <Icon name="clock" size={13} className="mt-[2px] flex-none" />
            <span className="min-w-0 break-words">{lastLog.text}</span>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" tone="primary" icon="expand" onClick={(e) => openFrom(e.currentTarget.closest('[data-grow]'), 'task', { id: t.id })} data-card-open>
            Open
          </Button>
          {a && (
            <Button size="sm" tone="secondary" icon="agents" onClick={(e) => openFrom(e.currentTarget.closest('[data-grow]'), 'agent', { id: a.id })}>
              Agent
            </Button>
          )}
          <Button size="sm" tone="secondary" icon="chat" onClick={() => setDraft(`About task ${t.id} (${t.title}): `)}>
            Ask Mia
          </Button>
        </div>
      </>
    </CardShell>
  );
}

function DocCard({ d }) {
  const [open, setOpen] = useState(false);
  const body = useMC((s) => s.docDocs?.[d.id]);
  const first = (d.summary || d.subject || (typeof body?.body === 'string' ? body.body.replace(/^---[\s\S]*?---/, '').replace(/[#*>`_|-]+/g, ' ') : '') || '').replace(/\s+/g, ' ').trim().slice(0, 260);
  return (
    <CardShell open={open} onToggle={() => setOpen((v) => !v)} data-doc={d.id} data-doc-card={d.id} data-grow={`doc:${d.id}`}>
      <>
        <span className="grid h-9 w-9 flex-none place-items-center rounded-[12px] bg-fill text-ink2">
          <Icon name={d.kind === 'research' ? 'research' : d.kind === 'plan' ? 'plan' : d.kind === 'page' ? 'page' : 'doc'} size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.94rem] font-semibold text-ink">{d.title || d.id}</span>
          <span className="block truncate text-[0.78rem] text-ink3">{[d.kind ? d.kind[0].toUpperCase() + d.kind.slice(1) : 'Doc', d.company || d.subject].filter(Boolean).join(' · ')}</span>
        </span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="flex-none text-ink3">
          <Icon name="chevronRight" size={16} />
        </motion.span>
      </>
      <>
        {first && <p className="mb-3 line-clamp-4 text-[0.86rem] leading-relaxed text-ink2">{first}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" tone="primary" icon="expand" onClick={(e) => openFrom(e.currentTarget.closest('[data-grow]'), 'doc', { id: d.id })} data-card-open>
            Open
          </Button>
          <Button size="sm" tone="secondary" icon="chat" onClick={() => setDraft(`About “${d.title || d.id}”: `)}>
            Ask Mia
          </Button>
        </div>
      </>
    </CardShell>
  );
}

// A task that really is running (task 0503): its status says so AND it has an
// executor that hasn't finished. A status alone lies — 0154 sat at "checking"
// for weeks after its executor ended, and the card named it as working.
export function taskRunning(t) {
  return (t?.status === 'running' || t?.status === 'checking') && !!t.executor && !t.executor.finishedAt;
}

// What's running right now — the foot of the stream, live.
function LiveCard() {
  const ex = useExecutors();
  const tasks = useMC(useShallow((s) => (s.mia?.tasks || []).filter(taskRunning)));
  const [open, setOpen] = useState(false);
  if (!ex.length && !tasks.length) return null;
  const waiting = ex.filter((a) => agentStatus(a) === 'waiting').length;
  const title = ex.length ? `${ex.length} agent${ex.length === 1 ? '' : 's'} ${waiting ? `· ${waiting} need${waiting === 1 ? 's' : ''} you` : 'working'}` : `${tasks.length} task${tasks.length === 1 ? '' : 's'} running`;
  return (
    <div className="pt-5" data-live-card>
      <CardShell open={open} onToggle={() => setOpen((v) => !v)} tone={waiting ? 'warn' : ''} data-grow="live">
        <>
          <span className="flex flex-none -space-x-2">
            {ex.slice(0, 3).map((a) => (
              <span key={a.id} className="grid h-8 w-8 place-items-center rounded-full bg-fill text-ink">
                <Ring a={a} size={22} />
              </span>
            ))}
            {!ex.length && (
              <span className="grid h-8 w-8 place-items-center rounded-full bg-fill text-accent">
                <Icon name="bolt" size={15} />
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.92rem] font-semibold text-ink">Now · {title}</span>
            <span className="block truncate text-[0.78rem] text-ink3">{[...tasks.map((t) => t.title), ...ex.map((a) => agentName(a))].slice(0, 3).join(' · ')}</span>
          </span>
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="flex-none text-ink3">
            <Icon name="chevronRight" size={16} />
          </motion.span>
        </>
        <>
          <div className="flex flex-col gap-1">
            {ex.map((a) => {
              const p = progressOf(a);
              return (
                <motion.button {...tap} key={a.id} onClick={(e) => openFrom(e.currentTarget, 'agent', { id: a.id })} className="flex items-center gap-3 rounded-[12px] px-1.5 py-1.5 text-left hover:bg-fill" data-live-agent={a.id}>
                  <Ring a={a} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.88rem] font-semibold text-ink">{agentName(a)}</span>
                    <span className="block truncate text-[0.76rem] text-ink3">{agentStatus(a) === 'waiting' ? 'Needs you' : a.activity || 'Working'}{p != null ? ` · ${Math.round(p * 100)}%` : ''}</span>
                  </span>
                </motion.button>
              );
            })}
            {tasks.map((t) => (
              <motion.button {...tap} key={t.id} onClick={(e) => openFrom(e.currentTarget, 'task', { id: t.id })} className="flex items-center gap-3 rounded-[12px] px-1.5 py-1.5 text-left hover:bg-fill">
                <Icon name="tasks" size={18} className="mx-[3px] text-accent" />
                <span className="min-w-0 flex-1 truncate text-[0.88rem] text-ink">{t.title}</span>
                <span className="font-mono text-[0.72rem] text-ink3">#{t.id}</span>
              </motion.button>
            ))}
          </div>
        </>
      </CardShell>
    </div>
  );
}

// ---- rows -------------------------------------------------------------------------

const STATUS_LINE = { waiting: 'Waiting…', uploading: 'Uploading', delivering: 'Handing to the Mac…', done: 'Saved on the Mac', queued: 'Waiting for the Mac to collect it' };
const kindOf = (name = '', mime = '') => ((/\.([a-z0-9]+)$/i.exec(name) || [])[1] || mime.split('/')[1] || 'file').toUpperCase();

function FileCard({ file, upload }) {
  const name = file?.name || upload?.name || 'file';
  const mime = file?.mime || upload?.mime || '';
  const size = file?.size ?? upload?.size;
  const busy = upload && ['uploading', 'delivering', 'waiting'].includes(upload.status);
  const failed = upload?.status === 'error';
  const pct = upload && upload.size ? upload.loaded / upload.size : 0;
  return (
    <div className={`v53-bubble flex w-[min(100%,380px)] items-center gap-3 p-2.5 pr-3 ${failed ? 'fail' : ''}`} title={file?.path || name} data-file={name}>
      <span className="grid h-10 w-10 flex-none place-items-center rounded-[12px] bg-fill text-ink2">
        <Icon name={fileIcon(name, mime)} size={19} />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[0.88rem] font-semibold text-ink">{name}</span>
        <span className={`block truncate text-[0.74rem] ${failed ? 'text-crit' : 'text-ink3'}`}>
          {failed
            ? upload.error
            : [kindOf(name, mime), fmtSize(size), upload ? `${STATUS_LINE[upload.status] || ''}${upload.status === 'uploading' ? ` ${Math.round(pct * 100)}%` : ''}` : 'Saved on the Mac'].filter(Boolean).join(' · ')}
        </span>
        {busy && (
          <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-fill2">
            <motion.span className="block h-full rounded-full bg-accent" initial={false} animate={{ width: `${(upload.status === 'delivering' ? 1 : pct) * 100}%` }} transition={spring.gentle} />
          </span>
        )}
      </span>
      {failed && (
        <span className="flex flex-none gap-1">
          <button onClick={() => retryUpload(upload.id)} aria-label="Retry upload" className="grid h-8 w-8 place-items-center rounded-full text-ink2 hover:bg-fill">
            <Icon name="retry" size={15} />
          </button>
          <button onClick={() => dismissUpload(upload.id)} aria-label="Dismiss" className="grid h-8 w-8 place-items-center rounded-full text-ink3 hover:bg-fill">
            <Icon name="close" size={15} />
          </button>
        </span>
      )}
      {upload?.status === 'done' && <Icon name="check" size={17} className="flex-none text-accent" />}
    </div>
  );
}

function RefChip({ r, onRemove }) {
  const open = (e) => openFrom(e.currentTarget, r.kind === 'doc' ? 'doc' : 'task', { id: r.id });
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-hair bg-fill py-1 pl-2.5 pr-1 text-[0.8rem] text-ink2" data-ref={`${r.kind}:${r.id}`}>
      <button onClick={open} className="flex min-w-0 items-center gap-1.5 hover:text-ink">
        <Icon name={r.kind === 'doc' ? 'doc' : 'tasks'} size={13} className="flex-none text-ink3" />
        <span className="min-w-0 truncate font-medium">{r.title || r.id}</span>
        {r.kind === 'task' && <span className="flex-none font-mono text-[0.72rem] text-ink3">#{r.id}</span>}
      </button>
      {onRemove ? (
        <button onClick={onRemove} aria-label={`Remove ${r.title || r.id}`} className="grid h-6 w-6 flex-none place-items-center rounded-full text-ink3 hover:bg-fill hover:text-ink">
          <Icon name="close" size={12} />
        </button>
      ) : (
        <span className="w-1.5" />
      )}
    </span>
  );
}

const Message = memo(function Message({ m, head, ctx, pending, upload, showCaption = true, docIndex }) {
  const fromMia = m.from === 'mia';
  const isFile = m.kind === 'upload';
  const isQ = m.kind === 'question';
  const isNotify = m.kind === 'notify';
  const open = isQ && m.questionId && ctx.openIds.has(m.questionId);
  const qState = isQ && !open ? miaQuestionState(ctx.block, m.questionId, ctx.local) : null;
  const answer = qState === 'answered' ? miaAnswerFor(ctx.block, m.questionId, ctx.local) : null;
  const clipped = !fromMia && !isFile ? splitRefs(m.text) : { text: m.text, refs: [] };
  const said = voiceText(clipped.text);
  const named = fromMia ? docsIn(m.text, docIndex) : [];

  if (!fromMia) {
    return (
      <div className={`flex flex-col items-end ${head ? 'pt-4' : 'pt-1.5'}`} data-msg="daniel" data-msg-text={said.text || ''}>
        {isFile ? (
          <>
            <FileCard file={m.file} upload={upload} />
            {showCaption && m.caption && <div className="v53-bubble mt-1.5 max-w-[85%] whitespace-pre-wrap break-words px-4 py-2.5 text-[1rem] leading-relaxed text-ink">{m.caption}</div>}
          </>
        ) : (
          <div className={`v53-bubble max-w-[85%] whitespace-pre-wrap break-words px-4 py-2.5 text-[1rem] leading-relaxed ${pending ? 'pending text-ink3' : 'text-ink'}`} data-bubble>
            {said.voice && <Icon name="mic" size={13} className="mr-1.5 inline-block align-[-1px] text-ink3" aria-label="Spoken" />}
            {said.text}
            {clipped.refs.length > 0 && (
              <span className={`flex flex-wrap justify-end gap-1.5 ${said.text ? 'mt-2' : ''}`}>
                {clipped.refs.map((r) => (
                  <RefChip key={`${r.kind}:${r.id}`} r={r} />
                ))}
              </span>
            )}
          </div>
        )}
        {(head || pending) && (
          <div className="mt-1 px-1 text-[0.7rem] text-ink3">
            {pending && !isFile ? 'Sending…' : hhmm(toMs(m.at))}
          </div>
        )}
        {m.taskId && <TaskCard id={m.taskId} />}
      </div>
    );
  }

  return (
    <div className={`${head ? 'pt-6' : 'pt-2.5'}`} data-msg="mia" data-kind={m.kind || 'chat'} data-msg-text={said.text || ''}>
      {head && (
        <div className="v53-msg-head mb-1 flex items-baseline gap-2">
          <span className="text-[0.75rem] font-semibold tracking-[0.01em] text-ink2">Mia</span>
          <span className="v-num text-[0.7rem] text-ink3">{hhmm(toMs(m.at))}</span>
        </div>
      )}
      {isQ || isNotify ? (
        <div className={`v53-card w-full max-w-[620px] p-4 ${open || (isNotify && m.urgent) ? 'warn' : isNotify ? 'note' : ''}`} data-lens data-depth="0.35" data-question-card={isQ ? m.questionId || '' : undefined}>
          <div className={`v53-eyebrow mb-1.5 flex items-center gap-1.5 ${isNotify ? (m.urgent ? 'tone-warn' : 'tone-note') : open ? 'tone-warn' : ''}`}>
            <i className="v53-tone-dot" />
            {isNotify ? (m.urgent ? 'Urgent' : 'Update') : open ? 'Question' : qState === 'old' ? 'Old question' : 'Asked'}
            {m.taskId && <span className="font-mono font-medium text-ink3">#{m.taskId}</span>}
            {isQ && (open || qState === 'old') && m.questionId && ctx.canDismiss && (
              <button onClick={() => miaDismiss(m.questionId)} aria-label="Dismiss question" data-dismiss={m.questionId} className="-my-1.5 ml-auto grid h-7 w-7 place-items-center rounded-full text-ink3 hover:bg-fill hover:text-ink">
                <Icon name="close" size={13} />
              </button>
            )}
          </div>
          <div className="v53-card-text whitespace-pre-wrap break-words text-ink">{said.text}</div>
          {isQ &&
            (open ? (
              <div className="mt-3">
                <Answer question={m} />
              </div>
            ) : (
              <div className="mt-2 flex items-start gap-1.5 text-[0.86rem] leading-snug text-ink2">
                <Icon name={qState === 'answered' || qState == null ? 'check' : 'close'} size={14} className="mt-[3px] flex-none text-ink3" />
                {answer != null ? (
                  <span className="min-w-0 break-words">
                    <span className="text-ink3">You answered · </span>
                    {voiceText(answer).text}
                  </span>
                ) : qState === 'old' ? (
                  <span className="text-ink3">
                    Hidden — unanswered for over {fmtQuestionAge(ctx.block?.questionMaxAgeHours) || 'a while'}.{' '}
                    <button onClick={() => miaDismiss(m.questionId)} className="font-semibold text-ink2 hover:text-ink">
                      Dismiss
                    </button>
                  </span>
                ) : (
                  <span className="text-ink3">{qState === 'dismissed' ? 'Dismissed' : qState === 'expired' ? 'Expired' : 'Closed'}</span>
                )}
              </div>
            ))}
        </div>
      ) : (
        <div className="v53-prose whitespace-pre-wrap break-words" data-prose>
          {said.text}
        </div>
      )}
      {m.taskId && <TaskCard id={m.taskId} />}
      {named.map((d) => (
        <DocCard key={d.id} d={d} />
      ))}
    </div>
  );
});

function OldBar() {
  const mia = useMC((s) => s.mia);
  const local = useMC((s) => s.miaLocal);
  const n = miaOldQuestions(mia, local).length;
  if (!n || !miaCanDismiss(mia)) return null;
  return (
    <div className="mx-auto mb-1 mt-2 flex w-full items-center gap-2 rounded-full bg-fill py-1 pl-4 pr-1" data-old-questions={n}>
      <span className="min-w-0 flex-1 truncate text-[0.78rem] text-ink3">
        {n} old question{n === 1 ? '' : 's'} hidden · over {fmtQuestionAge(mia?.questionMaxAgeHours)}
      </span>
      <Button size="sm" tone="ghost" icon="close" onClick={() => miaDismissOld()}>
        Dismiss all
      </Button>
    </div>
  );
}

function Typing() {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={spring.snappy} className="flex items-center gap-2 pt-5" data-typing>
      <span className="v53-thinking" aria-label="Mia is thinking">
        Thinking
      </span>
    </motion.div>
  );
}

// A row that wasn't there when the chat mounted arrives; history doesn't.
function Arrive({ fresh, mine, children, reduce }) {
  if (!fresh) return children;
  // v5.3: a short, settled rise — no overshoot, no blur, no pop
  const from = reduce ? { opacity: 0 } : { opacity: 0, y: mine ? 12 : 8 };
  return (
    <motion.div initial={from} animate={{ opacity: 1, y: 0 }} transition={reduce ? { duration: 0.18 } : { type: 'spring', stiffness: 300, damping: 34 }} data-arrived>
      {children}
    </motion.div>
  );
}

// ---- long-press a message ------------------------------------------------------------
const remindAt = (kind) => {
  const d = new Date();
  if (kind === 'hour') d.setHours(d.getHours() + 1);
  else if (kind === 'evening') {
    if (d.getHours() >= 18) d.setDate(d.getDate() + 1);
    d.setHours(18, 0, 0, 0);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  return d;
};
function MsgMenu({ menu, onClose }) {
  if (!menu) return null;
  const text = menu.text.trim();
  const short = text.replace(/\s+/g, ' ').slice(0, 80);
  const remind = (k, label) => {
    const at = remindAt(k);
    if (miaSchedule('addReminder', { id: `r_${Date.now()}`, at: at.toISOString(), text: short })) toast(`Reminder set · ${label}`);
    else toast('Offline — the reminder wasn’t set');
  };
  const items = [
    { icon: 'tasks', label: 'Make it a task', run: () => (miaTaskAdd({ title: short, detail: text.length > short.length ? text : '' }) ? toast('Added to Mia’s tasks') : toast('Offline — the task wasn’t added')), key: 'task' },
    { icon: 'bell', label: 'Remind me in an hour', run: () => remind('hour', 'in an hour'), key: 'hour' },
    { icon: 'clock', label: new Date().getHours() >= 18 ? 'Remind me tomorrow evening' : 'Remind me this evening', run: () => remind('evening', '18:00'), key: 'evening' },
    { icon: 'clock', label: 'Remind me tomorrow morning', run: () => remind('morning', 'tomorrow 9:00'), key: 'morning' },
    { icon: 'chat', label: 'Reply', run: () => setDraft(`“${short}${text.length > short.length ? '…' : ''}” — `), key: 'reply' },
    { icon: 'copy', label: 'Copy', run: () => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy on this device')), key: 'copy' },
  ];
  const W = 272;
  const left = Math.max(10, Math.min(innerWidth - W - 10, menu.x - W / 2));
  const top = Math.max(10, Math.min(innerHeight - items.length * 46 - 80, menu.y + 12));
  return createPortal(
    <div className="fixed inset-0 z-[90]" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onContextMenu={(e) => (e.preventDefault(), onClose())} data-msg-menu>
      <motion.div
        initial={{ opacity: 0, scale: 0.86, y: -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94 }}
        transition={spring.snappy}
        style={{ left, top, width: W, transformOrigin: `${menu.x - left}px -12px` }}
        className="v-menu v5-menu absolute flex flex-col p-1.5"
        role="menu"
      >
        <div className="truncate px-3 pb-1.5 pt-1 text-[0.74rem] font-semibold text-ink3">{short}</div>
        {items.map((it) => (
          <motion.button
            {...tap}
            key={it.key}
            role="menuitem"
            onClick={() => (onClose(), it.run())}
            className="flex h-11 items-center gap-3 whitespace-nowrap rounded-[12px] px-3 text-left text-[0.9rem] font-medium text-ink hover:bg-fill"
            data-msg-action={it.key}
          >
            <Icon name={it.icon} size={16} className="text-ink2" />
            {it.label}
          </motion.button>
        ))}
      </motion.div>
    </div>,
    document.body,
  );
}

function useLongPress(onFire) {
  const st = useRef(null);
  const clear = () => {
    if (!st.current) return;
    clearTimeout(st.current.t);
    st.current.el?.classList.remove('v53-pressing');
    st.current = null;
  };
  return {
    onPointerDown: (e) => {
      if (e.button > 0) return;
      const row = e.target.closest?.('[data-msg-text]');
      if (!row || e.target.closest('button, a, input, textarea, [data-task], [data-doc], [data-agent]')) return;
      const el = row.querySelector('[data-bubble], [data-prose], .v53-card') || row;
      el.classList.add('v53-pressing');
      const x = e.clientX;
      const y = e.clientY;
      st.current = {
        el,
        x,
        y,
        t: setTimeout(() => {
          const text = row.dataset.msgText || '';
          clear();
          if (!text) return;
          haptic(el, 'medium');
          onFire({ text, x, y });
        }, 480),
      };
    },
    onPointerMove: (e) => st.current && Math.hypot(e.clientX - st.current.x, e.clientY - st.current.y) > 8 && clear(),
    onPointerUp: clear,
    onPointerCancel: clear,
    onContextMenu: (e) => {
      const row = e.target.closest?.('[data-msg-text]');
      if (!row || e.target.closest('[data-task], [data-doc], [data-agent], textarea, input')) return;
      e.preventDefault();
      clear();
      if (row.dataset.msgText) onFire({ text: row.dataset.msgText, x: e.clientX, y: e.clientY });
    },
  };
}

// ---- the thread ------------------------------------------------------------------------

export function useThinking(mia, local) {
  const now = useMC((s) => s.now) || Date.now();
  if (!mia?.enabled || !mia.online) return false;
  if (local?.sent?.length) return true;
  const msgs = mia.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.from === 'system' || m.kind === 'event') continue;
    return m.from !== 'mia' && m.kind !== 'answer' && now - toMs(m.at) < 3 * 60 * 1000;
  }
  return false;
}

export default function Thread({ mia, active = true, thinking = false }) {
  const local = useMC((s) => s.miaLocal);
  const link = useMC((s) => s.link);
  const uploads = useMC((s) => s.uploads);
  const reduce = usePrefs((s) => s.reduce);
  const pageVisible = usePageVisible();
  const docIndex = useDocIndex();
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(null);
  const press = useLongPress(setMenu);

  const openIds = useMemo(
    () => new Set(mia.pendingQuestions.map((q) => q.questionId).filter((id) => id && !(id in local.answered) && !(id in (local.dismissed || {})))),
    [mia.pendingQuestions, local.answered, local.dismissed],
  );

  // A line you sent keeps its row when the relay echoes it back (the
  // "Sending…" row becomes the real one in place, its arrival unbroken).
  const pendKey = useRef(new Map()); // text → the local row's key
  const idKey = useRef(new Map()); // relay message id → the local key it took over
  const rows = useMemo(() => {
    const asked = new Set(mia.messages.filter((m) => m.kind === 'question' && m.questionId).map((m) => m.questionId));
    const out = [];
    let prev = null;
    let prevDay = '';
    const add = (m, key, pending = false, extra = {}) => {
      const ms = toMs(m.at);
      const day = dayLabel(ms);
      if (day && day !== prevDay) {
        out.push({ type: 'day', key: `day:${day}:${key}`, label: day });
        prevDay = day;
        prev = null;
      }
      if (m.from === 'system' || m.kind === 'event') {
        out.push({ type: 'event', key, m });
        prev = null;
        return;
      }
      const head = !prev || prev.from !== m.from || ms - toMs(prev.at) > 10 * 60 * 1000;
      out.push({ type: 'msg', key, m, head, pending, ...extra });
      prev = m;
    };
    const lastCaption = (m) => !m.batch || m.batch.split('/')[0] === m.batch.split('/')[1];
    const landed = new Set();
    const pending = new Set(local.sent.map((p) => p.text));
    mia.messages.forEach((m, i) => {
      if (m.kind === 'answer' && m.questionId && asked.has(m.questionId)) return;
      if (m.kind === 'upload' && m.uploadId) landed.add(m.uploadId);
      let key = m.id || `i${i}`;
      if (idKey.current.has(key)) key = idKey.current.get(key);
      else if (m.id && m.from === 'daniel' && m.kind === 'chat' && pendKey.current.has(m.text) && !pending.has(m.text)) {
        key = pendKey.current.get(m.text);
        pendKey.current.delete(m.text);
        idKey.current.set(m.id, key);
      }
      add(m, key, false, m.kind === 'upload' ? { showCaption: lastCaption(m) } : {});
    });
    for (const p of local.sent) {
      pendKey.current.set(p.text, p.id);
      add({ from: 'daniel', kind: 'chat', text: p.text, at: p.at }, p.id, true);
    }
    for (const u of uploads) {
      if (u.relayId && landed.has(u.relayId)) continue;
      const m = { from: 'daniel', kind: 'upload', at: u.at, caption: u.caption, batch: u.batch };
      add(m, u.id, true, { upload: u, showCaption: lastCaption(m) });
    }
    return out;
  }, [mia.messages, local.sent, uploads]);

  // the rows on screen at mount are history; anything after arrives
  // (an arrival keeps its wrapper for good: swapping it out on the next
  // render would cut the spring short)
  const seen = useRef(null);
  if (!seen.current) seen.current = new Set(rows.map((r) => r.key));
  const arrived = useRef(new Map()); // key → animate (false: an echo of a line already shown)
  const sentTexts = useRef(new Set());
  for (const p of local.sent) sentTexts.current.add(p.text);
  for (const r of rows) {
    if (seen.current.has(r.key)) continue;
    seen.current.add(r.key);
    const mine = r.type === 'msg' && r.m.from !== 'mia';
    arrived.current.set(r.key, !(mine && !r.pending && sentTexts.current.has(r.m.text)));
  }

  // ---- follow the bottom while you're at it ---------------------------------
  const scroller = useRef(null);
  const stuck = useRef(true);
  const [behind, setBehind] = useState(false);
  const lastKey = rows.length ? rows[rows.length - 1].key : '';
  const toBottom = (smooth) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
    stuck.current = true;
    setBehind(false);
  };
  useLayoutEffect(() => {
    if (stuck.current) toBottom(false);
    else setBehind(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey, openIds.size, thinking]);
  useLayoutEffect(() => {
    if (active) toBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  const inner = useRef(null);
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const sc = scroller.current;
      if (sc && stuck.current) sc.scrollTop = sc.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- read marker ------------------------------------------------------------
  const lastId = useMemo(() => {
    for (let i = mia.messages.length - 1; i >= 0; i--) if (mia.messages[i].id) return mia.messages[i].id;
    return '';
  }, [mia.messages]);
  useEffect(() => {
    if (active && pageVisible && link === 'linked' && lastId) miaRead(lastId);
  }, [active, pageVisible, link, lastId]);

  const ctx = useMemo(() => ({ block: mia, local, openIds, canDismiss: miaCanDismiss(mia) }), [mia, local, openIds]);

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const drop = {
    onDragEnter: (e) => {
      if (hasFiles(e)) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragOver: (e) => {
      if (hasFiles(e)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    },
    onDragLeave: (e) => !e.currentTarget.contains(e.relatedTarget) && setDragging(false),
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      stageFiles(e.dataTransfer.files);
    },
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop} data-thread>
      <AnimatePresence>
        {dragging && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-[24px] border-2 border-dashed border-hair2 bg-page/60">
            <span className="flex items-center gap-2 text-[1rem] font-semibold text-ink">
              <Icon name="attach" size={18} /> Drop to send to Mia
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          stuck.current = atEnd;
          if (atEnd && behind) setBehind(false);
        }}
        className="v-scroll v53-thread min-h-0 flex-1 px-4 sm:px-8"
        data-reader="thread"
        {...press}
      >
        <div ref={inner} className="mx-auto flex w-full max-w-[720px] flex-col" style={{ paddingTop: 'var(--stage-head, 72px)', paddingBottom: 'calc(var(--stage-foot, 150px) + var(--stage-chrome, 0px))' }}>
          {!mia.enabled && (
            <div className="mb-2 mt-2 flex items-center gap-3 rounded-[18px] bg-fill px-4 py-3">
              <span className="min-w-0 flex-1 text-[0.86rem] leading-snug text-ink2">Mia is off. Messages and tasks wait here until she starts.</span>
              <Button size="sm" tone="primary" icon="play" onClick={() => miaStart()}>
                Start
              </Button>
            </div>
          )}
          <OldBar />
          {!rows.length ? (
            <div className="flex flex-col items-center px-6 pt-[12vh] text-center" data-chat-empty>
              <Orb size={44} state="idle" />
              <h2 className="mt-5 text-[1.25rem] font-semibold tracking-[-0.015em] text-ink">What can Mia do for you?</h2>
              <p className="mt-2 max-w-[38ch] text-[0.9rem] leading-relaxed text-ink3">A task, a question, a reminder. She hands the work to an agent, asks only when she must, and tells you when it’s done.</p>
            </div>
          ) : (
            <LayoutGroup>
              {rows.map((r) => {
                const fresh = !!arrived.current.get(r.key);
                const mine = r.type === 'msg' && r.m.from !== 'mia';
                const node =
                  r.type === 'day' ? (
                    <div className="flex items-center justify-center pb-1 pt-7" data-day>
                      <span className="v53-day">{r.label}</span>
                    </div>
                  ) : r.type === 'event' ? (
                    <div className="flex items-baseline justify-center gap-2 px-6 pt-3 text-center text-[0.76rem] leading-snug text-ink3" data-msg="event">
                      <span className="min-w-0 break-words">{r.m.text}</span>
                      <span className="v-num flex-none text-[0.68rem] opacity-70">{hhmm(toMs(r.m.at))}</span>
                    </div>
                  ) : (
                    <Message m={r.m} head={r.head} ctx={ctx} pending={r.pending} upload={r.upload} showCaption={r.showCaption} docIndex={docIndex} />
                  );
                return (
                  <div key={r.key} className="v-cv" data-row={r.type}>
                    <Arrive fresh={fresh} mine={mine} reduce={reduce}>
                      {node}
                    </Arrive>
                  </div>
                );
              })}
            </LayoutGroup>
          )}
          <AnimatePresence>{thinking && <Typing key="typing" />}</AnimatePresence>
          <LiveCard />
        </div>
      </div>

      <AnimatePresence>
        {behind && (
          <motion.button
            {...tap}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={spring.snappy}
            onClick={() => toBottom(true)}
            className="v-bar absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-4 py-2 text-[0.8rem] font-semibold text-ink"
            style={{ bottom: 'calc(var(--stage-foot, 150px) + var(--stage-chrome, 0px) + 6px)' }}
            data-new-messages
          >
            <Icon name="arrowDown" size={14} />
            New messages
          </motion.button>
        )}
      </AnimatePresence>
      <AnimatePresence>{menu && <MsgMenu key="menu" menu={menu} onClose={() => setMenu(null)} />}</AnimatePresence>
    </div>
  );
}

// ---- quick-action chips ----------------------------------------------------------------
// From what's going on: the open question's answers (one tap answers), a
// running task ("How's …"), an agent that needs you, a doc that just landed.
// With nothing going on, three good openers. Tapping a draft chip fills the
// composer; answers are sent at once (they're explicit).
function useChips(mia) {
  const local = useMC((s) => s.miaLocal);
  const agents = useMC((s) => s.agents);
  const docs = useMC((s) => s.docs);
  return useMemo(() => {
    const out = [];
    const qs = miaOpenQuestions(mia, local).slice(-1);
    // v5.3: no answer chips — the question's own card carries its answers
    void qs;
    for (const a of (agents || []).filter((x) => agentStatus(x) === 'waiting').slice(0, 1)) {
      out.push({ key: `ag:${a.id}`, icon: 'alert', label: `Answer ${agentName(a)}`, tone: 'warn', run: (el) => openFrom(el, 'agent', { id: a.id }) });
    }
    for (const t of (mia?.tasks || []).filter((x) => x.status === 'running').slice(0, 2)) {
      out.push({ key: `t:${t.id}`, icon: 'tasks', label: `How’s #${t.id} going?`, draft: `How’s task ${t.id} (${t.title}) going?` });
    }
    const fresh = (docs || []).filter((d) => Date.now() - (Date.parse(d.created || d.updatedAt || '') || 0) < 3 * 3600e3).slice(0, 1);
    for (const d of fresh) out.push({ key: `d:${d.id}`, icon: 'doc', label: `Open “${(d.title || d.id).slice(0, 28)}”`, run: (el) => openFrom(el, 'doc', { id: d.id }) });
    if (out.length < 3) {
      out.push({ key: 'x:status', icon: 'sparkles', label: 'What’s running?', draft: 'What’s running right now, and is anything stuck?' });
      out.push({ key: 'x:research', icon: 'research', label: 'Research…', draft: 'Research ' });
      out.push({ key: 'x:remind', icon: 'bell', label: 'Remind me…', draft: 'Remind me ' });
    }
    return out.slice(0, 4);

  }, [mia, local, agents, docs]);
}

// v5.3: suggestions are quiet text on the chat's glass, at the end of the
// conversation — no icons, no pills of colour; one that needs you gets a dot.
export function Chips({ mia }) {
  const chips = useChips(mia);
  return (
    <div className="v53-chips flex gap-1.5 overflow-x-auto" data-chips={chips.length}>
      <AnimatePresence initial={false} mode="popLayout">
        {chips.map((c) => (
          <motion.button
            key={c.key}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={(e) => (c.run ? c.run(e.currentTarget) : setDraft(c.draft))}
            title={c.hint || c.label}
            className={`v53-suggest ${c.tone === 'warn' ? 'warn' : ''}`}
            data-chip={c.key}
          >
            {c.tone === 'warn' && <i className="v53-tone-dot" />}
            <span className="max-w-[220px] truncate">{c.label}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---- composer --------------------------------------------------------------------------
export function ComposerBar({ mia }) {
  const staged = useMC((s) => s.miaStage);
  const refs = useAttach((s) => s.refs);
  const draft = useV53((s) => s.draft);
  const [value, setValue] = useState('');
  const [rec, setRec] = useState(false);
  const [focus, setFocus] = useState(false);
  const session = useRef(null);
  const field = useRef(null);
  useEffect(() => () => session.current?.stop(), []);
  useEffect(() => {
    if (!draft) return;
    setValue(draft.text);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [draft]);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [value]);

  const mic = () => {
    if (session.current) return session.current.stop();
    const end = () => {
      session.current = null;
      setRec(false);
    };
    const s = dictate({ base: value, onText: setValue, onEnd: end, onError: end });
    if (s) {
      session.current = s;
      setRec(true);
    }
  };
  const canEmpty = staged.length > 0 || refs.length > 0;
  const submit = () => {
    session.current?.stop();
    const t = value.trim();
    if (!t && !canEmpty) return;
    const text = withRefs(t, refs);
    const r = staged.length ? sendStaged(text) : miaSend(text);
    if (r === false) return;
    if (refs.length) clearRefs();
    setValue('');
  };
  const can = !!value.trim() || canEmpty;

  return (
    <div className="w-full" data-composer-bar>
      <AnimatePresence initial={false}>
        {(refs.length > 0 || staged.length > 0) && (
          <motion.div key="tray" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring.layout} className="overflow-hidden">
            <div className="flex flex-wrap gap-1.5 pb-2" aria-label="Attached for Mia" data-composer-refs>
              {refs.map((r) => (
                <RefChip key={`${r.kind}:${r.id}`} r={r} onRemove={() => detachRef(r)} />
              ))}
              {staged.map((x) => (
                <span key={x.id} className="inline-flex max-w-full items-center gap-2 rounded-full border border-hair bg-fill py-1 pl-3 pr-1 text-[0.8rem] text-ink2" data-staged={x.name}>
                  <Icon name={fileIcon(x.name, x.mime)} size={14} className="flex-none text-ink3" />
                  <span className="min-w-0 truncate font-medium">{x.name}</span>
                  <span className="v-num flex-none text-ink3">{fmtSize(x.size)}</span>
                  <button onClick={() => unstage(x.id)} aria-label={`Remove ${x.name}`} className="grid h-6 w-6 flex-none place-items-center rounded-full text-ink3 hover:bg-fill hover:text-ink">
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-end gap-2">
        <motion.button {...tap} onClick={() => openSheet('attach')} aria-label="Attach a report, task or file" data-attach-button className="v53-round grid h-[46px] w-[46px] flex-none place-items-center rounded-full text-ink2 hover:text-ink" data-lens data-depth="0.8">
          <Icon name="plus" size={19} strokeWidth={1.9} />
        </motion.button>
        <div className={`v53-field flex min-w-0 flex-1 items-end rounded-[23px] ${rec ? 'rec' : ''}`} data-lens data-depth="0.8" data-frost="0.6">
          <textarea
            ref={field}
            rows={1}
            value={value}
            placeholder={staged.length || refs.length ? 'Add a note (optional)' : mia?.enabled === false ? 'Message Mia — she’ll read it when she starts' : 'Message Mia'}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onPaste={(e) => {
              const list = e.clipboardData?.files;
              if (list && list.length) {
                e.preventDefault();
                stageFiles(list);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            className="v-scroll block max-h-[168px] min-h-[46px] min-w-0 flex-1 resize-none bg-transparent py-[12px] pl-4 pr-1 text-[0.97rem] leading-[1.4] text-ink outline-none placeholder:text-ink3"
            data-composer
            aria-label="Message Mia"
          />
          {speechSupported && (
            <motion.button {...tap} onClick={mic} aria-label={rec ? 'Stop dictation' : 'Dictate'} className={`mb-[5px] mr-1 grid h-9 w-9 flex-none place-items-center rounded-full ${rec ? 'bg-crit text-white' : 'text-ink3 hover:text-ink'}`} data-dictate>
              <Icon name="mic" size={16} />
            </motion.button>
          )}
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          {can ? (
            <motion.button
              key="send"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              whileTap={{ scale: 0.94 }}
              onClick={submit}
              aria-label="Send"
              className="v53-send grid h-[46px] w-[46px] flex-none place-items-center rounded-full"
              data-send
            >
              <Icon name="arrowUp" size={19} strokeWidth={2.2} />
            </motion.button>
          ) : (
            <motion.span key="talk" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 40 }} className="flex-none">
              <button onClick={() => startVoice()} aria-label="Talk to Mia" title="Talk to Mia" className="v53-round v53-talk grid h-[46px] w-[46px] place-items-center rounded-full text-ink" data-lens data-depth="0.8" data-talk>
                <Orb size={22} state="idle" />
              </button>
            </motion.span>

          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

