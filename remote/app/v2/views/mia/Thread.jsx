import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  useMC, miaSend, miaRead, miaAnswerFor, miaQuestionState, miaDismiss, miaDismissOld, miaOldQuestions, miaCanDismiss, miaStart, voiceText, fmtQuestionAge,
} from '../../../src/lib/store.js';
import { stageFiles, unstage, sendStaged, retryUpload, dismissUpload, fmtSize, fileIcon } from '../../../src/lib/upload.js';
import { useAttach, detachRef, clearRefs, withRefs, splitRefs } from '../../../src/lib/attach.js';
import { openSheet, push } from '../../lib/nav.js';
import { usePrefs } from '../../lib/prefs.js';
import { spring, tap } from '../../lib/motion.js';
import { usePageVisible } from '../../ui/hooks.js';
import { Button, Composer, Empty, Icon } from '../../ui/kit.jsx';
import { Answer } from '../parts/Needs.jsx';

// The conversation with Mia. Her words sit on the page as prose; yours are
// set off in a soft card on the right — who's speaking is obvious at a
// glance, no names needed on every line. Questions carry their answers
// inline (one tap), files show their upload progress, clipped reports and
// tasks come back as chips. Long threads stay light: off-screen rows skip
// layout and paint (content-visibility).

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
    <div className={`flex w-[min(100%,380px)] items-center gap-3 rounded-[16px] p-2.5 pr-3 ${failed ? 'bg-crit/10' : 'bg-card'} border border-hair`} title={file?.path || name} data-file={name}>
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

function RefChip({ r, onRemove, onTask }) {
  const open = () => (r.kind === 'doc' ? push('doc', { id: r.id }) : onTask?.(r.id));
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-hair bg-card py-1 pl-2.5 pr-1 text-[0.8rem] text-ink2" data-ref={`${r.kind}:${r.id}`}>
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

const Message = memo(function Message({ m, head, ctx, onTask, pending, upload, showCaption = true }) {
  const fromMia = m.from === 'mia';
  const isFile = m.kind === 'upload';
  const isQ = m.kind === 'question';
  const isNotify = m.kind === 'notify';
  const open = isQ && m.questionId && ctx.openIds.has(m.questionId);
  const qState = isQ && !open ? miaQuestionState(ctx.block, m.questionId, ctx.local) : null;
  const answer = qState === 'answered' ? miaAnswerFor(ctx.block, m.questionId, ctx.local) : null;
  const clipped = !fromMia && !isFile ? splitRefs(m.text) : { text: m.text, refs: [] };
  const said = voiceText(clipped.text);

  if (!fromMia) {
    // Daniel — right-aligned, a soft card.
    return (
      <div className={`flex flex-col items-end ${head ? 'pt-4' : 'pt-1.5'} v-cv`} data-msg="daniel">
        {isFile ? (
          <>
            <FileCard file={m.file} upload={upload} />
            {showCaption && m.caption && <div className="mt-1.5 max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-[8px] bg-fill2 px-4 py-2.5 text-[0.98rem] leading-relaxed text-ink">{m.caption}</div>}
          </>
        ) : (
          <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-[8px] px-4 py-2.5 text-[0.98rem] leading-relaxed ${pending ? 'bg-fill text-ink3' : 'bg-fill2 text-ink'}`}>
            {said.voice && <Icon name="mic" size={13} className="mr-1.5 inline-block align-[-1px] text-ink3" aria-label="Spoken" />}
            {said.text}
            {clipped.refs.length > 0 && (
              <span className={`flex flex-wrap justify-end gap-1.5 ${said.text ? 'mt-2' : ''}`}>
                {clipped.refs.map((r) => (
                  <RefChip key={`${r.kind}:${r.id}`} r={r} onTask={onTask} />
                ))}
              </span>
            )}
          </div>
        )}
        {(head || pending) && (
          <div className="mt-1 px-1 text-[0.7rem] text-ink3">
            {pending && !isFile ? 'Sending…' : hhmm(toMs(m.at))}
            {m.taskId && (
              <button onClick={() => onTask?.(m.taskId)} className="ml-1.5 font-mono hover:text-ink2">
                #{m.taskId}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // Mia — prose on the page, a mark at the head of a run.
  const accent = isNotify ? (m.urgent ? 'warn' : 'accent') : open ? 'warn' : null;
  return (
    <div className={`${head ? 'pt-5' : 'pt-2'} v-cv`} data-msg="mia" data-kind={m.kind || 'chat'}>
      {head && (
        <div className="mb-1.5 flex items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-accent/15 text-accent">
            <Icon name="mia" size={12} strokeWidth={2.3} />
          </span>
          <span className="text-[0.82rem] font-semibold text-ink">Mia</span>
          <span className="v-num text-[0.72rem] text-ink3">{hhmm(toMs(m.at))}</span>
        </div>
      )}
      <div className={accent ? `rounded-[18px] border p-3.5 ${accent === 'warn' ? 'border-warn/30 bg-warn/[0.06]' : 'border-accent/25 bg-accent/[0.05]'}` : ''}>
        {(isNotify || isQ) && (
          <div className={`mb-1 flex items-center gap-1.5 text-[0.74rem] font-semibold ${isNotify ? (m.urgent ? 'text-warn' : 'text-accent') : open ? 'text-warn' : 'text-ink3'}`}>
            <Icon name={isNotify ? 'bell' : 'chat'} size={12} />
            {isNotify ? (m.urgent ? 'Urgent' : 'Update') : open ? 'Question' : qState === 'old' ? 'Old question' : 'Asked'}
            {m.taskId && (
              <button onClick={() => onTask?.(m.taskId)} className="font-mono font-medium text-ink3 hover:text-ink2">
                #{m.taskId}
              </button>
            )}
            {isQ && (open || qState === 'old') && m.questionId && ctx.canDismiss && (
              <button onClick={() => miaDismiss(m.questionId)} aria-label="Dismiss question" data-dismiss={m.questionId} className="-my-1.5 ml-auto grid h-7 w-7 place-items-center rounded-full text-ink3 hover:bg-fill hover:text-ink">
                <Icon name="close" size={13} />
              </button>
            )}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words text-[1rem] leading-[1.62] text-ink">{said.text}</div>
        {!isQ && !isNotify && m.taskId && (
          <button onClick={() => onTask?.(m.taskId)} className="mt-1 font-mono text-[0.72rem] text-ink3 hover:text-ink2">
            #{m.taskId}
          </button>
        )}
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
    </div>
  );
});

function OldBar() {
  const mia = useMC((s) => s.mia);
  const local = useMC((s) => s.miaLocal);
  const n = miaOldQuestions(mia, local).length;
  if (!n || !miaCanDismiss(mia)) return null;
  return (
    <div className="mx-auto mb-1 flex w-full max-w-[760px] items-center gap-2 rounded-full bg-fill py-1 pl-4 pr-1" data-old-questions={n}>
      <span className="min-w-0 flex-1 truncate text-[0.78rem] text-ink3">
        {n} old question{n === 1 ? '' : 's'} hidden · over {fmtQuestionAge(mia?.questionMaxAgeHours)}
      </span>
      <Button size="sm" tone="ghost" icon="close" onClick={() => miaDismissOld()}>
        Dismiss all
      </Button>
    </div>
  );
}

export default function Thread({ mia, active = true, onTask }) {
  const local = useMC((s) => s.miaLocal);
  const link = useMC((s) => s.link);
  const staged = useMC((s) => s.miaStage);
  const uploads = useMC((s) => s.uploads);
  const refs = useAttach((s) => s.refs);
  const reduce = usePrefs((s) => s.reduce);
  const pageVisible = usePageVisible();
  const [dragging, setDragging] = useState(false);

  const openIds = useMemo(
    () => new Set(mia.pendingQuestions.map((q) => q.questionId).filter((id) => id && !(id in local.answered) && !(id in (local.dismissed || {})))),
    [mia.pendingQuestions, local.answered, local.dismissed],
  );

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
    mia.messages.forEach((m, i) => {
      if (m.kind === 'answer' && m.questionId && asked.has(m.questionId)) return;
      if (m.kind === 'upload' && m.uploadId) landed.add(m.uploadId);
      add(m, m.id || `i${i}`, false, m.kind === 'upload' ? { showCaption: lastCaption(m) } : {});
    });
    for (const p of local.sent) add({ from: 'daniel', kind: 'chat', text: p.text, at: p.at }, p.id, true);
    for (const u of uploads) {
      if (u.relayId && landed.has(u.relayId)) continue;
      const m = { from: 'daniel', kind: 'upload', at: u.at, caption: u.caption, batch: u.batch };
      add(m, u.id, true, { upload: u, showCaption: lastCaption(m) });
    }
    return out;
  }, [mia.messages, local.sent, uploads]);

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
  }, [lastKey, openIds.size]);
  useLayoutEffect(() => {
    if (active) toBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  // Rows measure themselves lazily (content-visibility), so the thread's
  // height settles over a few frames — keep hugging the bottom while it does.
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
    onPaste: (e) => {
      const list = e.clipboardData?.files;
      if (list && list.length) {
        e.preventDefault();
        stageFiles(list);
      }
    },
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop} data-thread>
      <AnimatePresence>
        {dragging && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-[24px] border-2 border-dashed border-hair2 bg-page/80">
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
        className="v-scroll min-h-0 flex-1 px-4 pb-4 sm:px-6"
        data-reader="thread"
      >
        <div ref={inner} className="mx-auto flex w-full max-w-[760px] flex-col">
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
            <Empty icon="mia" title="Nothing here yet" hint="Tell Mia what you need — a task, a question, a reminder. She hands the work to an agent, asks only when she must, and tells you when it’s done." />
          ) : (
            rows.map((r) =>
              r.type === 'day' ? (
                <div key={r.key} className="flex items-center justify-center pb-1 pt-6">
                  <span className="rounded-full bg-fill px-3 py-1 text-[0.72rem] font-semibold text-ink3">{r.label}</span>
                </div>
              ) : r.type === 'event' ? (
                <div key={r.key} className="v-cv flex items-baseline justify-center gap-2 px-6 pt-3 text-center text-[0.76rem] leading-snug text-ink3" data-msg="event">
                  <span className="min-w-0 break-words">{r.m.text}</span>
                  <span className="v-num flex-none text-[0.68rem] opacity-70">{hhmm(toMs(r.m.at))}</span>
                </div>
              ) : (
                <Message key={r.key} m={r.m} head={r.head} ctx={ctx} onTask={onTask} pending={r.pending} upload={r.upload} showCaption={r.showCaption} />
              ),
            )
          )}
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
            style={{ bottom: 'calc(var(--composer-h, 76px) + var(--tabbar-space) + 8px)' }}
          >
            <Icon name="arrowDown" size={14} />
            New messages
          </motion.button>
        )}
      </AnimatePresence>

      <div className="flex-none px-3 pt-2 sm:px-6" style={{ paddingBottom: 'var(--tabbar-space)' }}>
        <div className="mx-auto w-full max-w-[760px]">
          <AnimatePresence initial={false}>
            {(refs.length > 0 || staged.length > 0) && (
              <motion.div
                key="tray"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring.layout}
                className="overflow-hidden"
              >
                <div className="flex flex-wrap gap-1.5 pb-2" aria-label="Attached for Mia" data-composer-refs>
                  {refs.map((r) => (
                    <RefChip key={`${r.kind}:${r.id}`} r={r} onTask={onTask} onRemove={() => detachRef(r)} />
                  ))}
                  {staged.map((x) => (
                    <span key={x.id} className="inline-flex max-w-full items-center gap-2 rounded-full border border-hair bg-card py-1 pl-3 pr-1 text-[0.8rem] text-ink2" data-staged={x.name}>
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
          <Composer
            onSend={(t) => {
              const text = withRefs(t, refs);
              const r = staged.length ? sendStaged(text) : miaSend(text);
              if (r !== false && refs.length) clearRefs();
              return r;
            }}
            canSendEmpty={staged.length > 0 || refs.length > 0}
            placeholder={staged.length || refs.length ? 'Add a note (optional)' : mia.enabled ? 'Message Mia' : 'Message Mia — she’ll read it when she starts'}
            leading={
              <motion.button
                {...tap}
                onClick={() => openSheet('attach')}
                aria-label="Attach a report, task or file"
                data-attach-button
                className="grid h-11 w-11 flex-none place-items-center rounded-full bg-fill text-ink2 hover:text-ink"
              >
                <Icon name="plus" size={21} strokeWidth={2.1} />
              </motion.button>
            }
          />
        </div>
      </div>
    </div>
  );
}
