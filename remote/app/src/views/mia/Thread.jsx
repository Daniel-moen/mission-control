import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, miaSend, miaRead, miaAnswerFor, miaQuestionState, miaDismiss, miaStart, voiceText, fmtQuestionAge } from '../../lib/store.js';
import { spring, press } from '../../lib/motion.js';
import Icon from '../../ui/Icon.jsx';
import Button from '../../ui/Button.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import MicField from '../agent/MicField.jsx';
import Answer from './Answer.jsx';
import { DismissButton, OldQuestionsBar } from './Dismiss.jsx';
import Progress from '../../ui/Progress.jsx';
import {
  pickFiles, stageFiles, unstage, sendStaged, retryUpload, dismissUpload, fmtSize, fileIcon, MAX_BYTES,
} from '../../lib/upload.js';
import { useAttach, detachRef, clearRefs, withRefs, splitRefs } from '../../lib/attach.js';
import AttachSheet from './AttachSheet.jsx';

// The Mia ↔ Daniel conversation (messages.jsonl), rendered as rows of ink on
// glass — a name, a time, the words. No bubbles: who is speaking is carried by
// the name line, and colour is kept for meaning only (a notify gets a thin
// accent rule, an open question a thin amber one, system events go quiet).

export const toMs = (at) => {
  if (!at) return 0;
  if (typeof at === 'number') return at > 1e12 ? at : at * 1000;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
};
const hhmm = (ms) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
function dayLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function TaskChip({ id, onTask }) {
  if (!id) return null;
  return (
    <button
      onClick={() => onTask?.(id)}
      className="pill glass-soft glass-soft-hover inline-flex h-5 items-center px-2 font-mono text-[10.5px] text-ink3 transition-colors hover:text-ink2"
      title={`Show task ${id}`}
    >
      #{id}
    </button>
  );
}

// A file Daniel sent Mia: icon, name, type · size, and while it's in flight a
// progress rule. `upload` is the local row (lib/upload.js) until the Mac has it.
const STATUS_LINE = {
  waiting: 'Waiting…',
  uploading: 'Uploading',
  delivering: 'Handing to the Mac…',
  done: 'Saved on the Mac',
  queued: 'Waiting for the Mac to collect it',
};
function kindOf(name = '', mime = '') {
  const e = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
  if (e) return e.toUpperCase();
  return (mime.split('/')[1] || 'file').toUpperCase();
}
function FileCard({ file, upload }) {
  const name = file?.name || upload?.name || 'file';
  const mime = file?.mime || upload?.mime || '';
  const size = file?.size ?? upload?.size;
  const busy = upload && (upload.status === 'uploading' || upload.status === 'delivering' || upload.status === 'waiting');
  const failed = upload?.status === 'error';
  const pct = upload && upload.size ? upload.loaded / upload.size : 0;
  return (
    <div
      className={`flex w-full max-w-[420px] items-center gap-3 rounded-xl2 border px-3 py-2.5 ${failed ? 'border-crit/40 bg-crit/[0.06]' : 'border-glass-line bg-white/[0.04]'}`}
      title={file?.path || name}
    >
      <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-white/[0.06] text-ink2">
        <Icon name={fileIcon(name, mime)} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-ink">{name}</span>
        <span className={`block truncate text-[11.5px] ${failed ? 'text-crit' : 'text-ink3'}`}>
          {failed
            ? upload.error
            : [kindOf(name, mime), fmtSize(size), upload ? `${STATUS_LINE[upload.status] || ''}${upload.status === 'uploading' ? ` ${Math.round(pct * 100)}%` : ''}` : 'Saved on the Mac']
                .filter(Boolean)
                .join(' · ')}
        </span>
        {busy && <Progress value={upload.status === 'delivering' ? 1 : pct} className="mt-1.5" tone={upload.status === 'delivering' ? 'neutral' : 'accent'} />}
      </span>
      {failed && (
        <span className="flex flex-none gap-1">
          <button onClick={() => retryUpload(upload.id)} aria-label="Retry upload" className="grid h-8 w-8 place-items-center rounded-lg text-ink2 hover:text-ink">
            <Icon name="retry" size={15} />
          </button>
          <button onClick={() => dismissUpload(upload.id)} aria-label="Dismiss" className="grid h-8 w-8 place-items-center rounded-lg text-ink3 hover:text-ink2">
            <Icon name="close" size={15} />
          </button>
        </span>
      )}
      {upload?.status === 'done' && <Icon name="check" size={16} className="flex-none text-ok" />}
    </div>
  );
}

function EventRow({ m }) {
  return (
    <div className="flex items-baseline gap-2 py-1 pl-0.5 text-[12px] leading-snug text-ink3">
      <span className="mt-[5px] h-1 w-1 flex-none self-start rounded-full bg-ink3/70" />
      <span className="min-w-0 flex-1 break-words">{m.text}</span>
      <span className="tnum flex-none text-[10.5px] text-ink3/70">{hhmm(toMs(m.at))}</span>
    </div>
  );
}

// A clipped report or task: tap opens it (a doc in the reader, a task on the board).
function RefChip({ r, onTask, onRemove }) {
  const open = () => (r.kind === 'doc' ? (location.hash = `doc/${encodeURIComponent(r.id)}`) : onTask?.(r.id));
  return (
    <span className="glass-soft inline-flex max-w-full items-center gap-1.5 rounded-xl py-1 pl-2 pr-1 text-[12.5px] text-ink2" data-ref={`${r.kind}:${r.id}`}>
      <button onClick={open} className="flex min-w-0 items-center gap-1.5 hover:text-ink" title={r.kind === 'doc' ? `Open ${r.id}` : `Task ${r.id}`}>
        <Icon name={r.kind === 'doc' ? 'doc' : 'tasks'} size={13} className="flex-none text-ink3" />
        <span className="min-w-0 truncate">{r.title || r.id}</span>
        {r.kind === 'task' && <span className="flex-none font-mono text-[11px] text-ink3">#{r.id}</span>}
      </button>
      {onRemove ? (
        <button onClick={onRemove} aria-label={`Remove ${r.title || r.id}`} className="grid h-6 w-6 flex-none place-items-center rounded-lg text-ink3 hover:text-ink">
          <Icon name="close" size={12} />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}

export function MessageRow({ m, head, mia, onTask, pending, upload, showCaption = true }) {
  const fromMia = m.from === 'mia';
  const isFile = m.kind === 'upload';
  const isQ = m.kind === 'question';
  const isNotify = m.kind === 'notify';
  const open = isQ && m.questionId && mia.openIds.has(m.questionId);
  const qState = isQ && !open ? miaQuestionState(mia.block, m.questionId, mia.local) : null;
  const answer = qState === 'answered' ? miaAnswerFor(mia.block, m.questionId, mia.local) : null;
  // Reports / tasks Daniel clipped in (task 0290) ride as lines in the text.
  const clipped = !fromMia && !isFile ? splitRefs(m.text) : { text: m.text, refs: [] };
  const said = voiceText(clipped.text);

  const rule = isNotify
    ? m.urgent
      ? 'border-l-2 border-warn/70 pl-3'
      : 'border-l-2 border-accent/60 pl-3'
    : open
      ? 'border-l-2 border-warn/70 pl-3'
      : '';

  return (
    <div className={head ? 'pt-3.5' : 'pt-1.5'}>
      {head && (
        <div className="mb-1 flex items-center gap-2">
          <span className={`text-[12.5px] font-semibold tracking-tight ${fromMia ? 'text-ink' : 'text-ink2'}`}>
            {fromMia ? 'Mia' : 'You'}
          </span>
          <span className="tnum text-[11px] text-ink3">{hhmm(toMs(m.at))}</span>
        </div>
      )}
      <div className={rule}>
        {(isNotify || isQ) && (
          <div className={`mb-0.5 flex items-center gap-1.5 text-[11px] font-medium ${isNotify ? (m.urgent ? 'text-warn' : 'text-accent') : open ? 'text-warn' : 'text-ink3'}`}>
            <Icon name={isNotify ? 'bell' : 'chat'} size={11} />
            {isNotify ? (m.urgent ? 'Urgent' : 'Update') : open ? 'Question' : qState === 'old' ? 'Old question' : 'Asked'}
            {isQ && (open || qState === 'old') && m.questionId && (
              <DismissButton questionId={m.questionId} className="-my-2 ml-auto" />
            )}
          </div>
        )}
        {isFile ? (
          <>
            <FileCard file={m.file} upload={upload} />
            {showCaption && m.caption && (
              <div className="mt-1.5 whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-ink2">{m.caption}</div>
            )}
          </>
        ) : (
          <div className={`whitespace-pre-wrap break-words text-[14.5px] leading-relaxed ${pending ? 'text-ink3' : fromMia ? 'text-ink' : 'text-ink2'}`}>
            {said.voice && (
              <Icon name="mic" size={12} className="mr-1.5 inline-block align-[-1px] text-ink3" aria-label="Spoken" />
            )}
            {said.text}
            {clipped.refs.length > 0 && (
              <span className={`flex flex-wrap gap-1.5 ${said.text ? 'mt-1.5' : ''}`}>
                {clipped.refs.map((r) => (
                  <RefChip key={`${r.kind}:${r.id}`} r={r} onTask={onTask} />
                ))}
              </span>
            )}
          </div>
        )}
        {(m.taskId || (pending && !isFile)) && (
          <div className="mt-1 flex items-center gap-2">
            <TaskChip id={m.taskId} onTask={onTask} />
            {pending && !isFile && <span className="text-[11px] text-ink3">Sending…</span>}
          </div>
        )}
        {isQ &&
          (open ? (
            <div className="mt-2.5">
              <Answer question={m} />
            </div>
          ) : (
            <div className="mt-1.5 flex items-start gap-1.5 text-[13px] leading-snug text-ink2">
              <Icon name={qState === 'answered' || qState == null ? 'check' : 'close'} size={14} className="mt-[2px] flex-none text-ink3" />
              {answer != null ? (
                <span className="min-w-0 break-words">
                  <span className="text-ink3">You answered · </span>
                  {voiceText(answer).text}
                </span>
              ) : qState === 'old' ? (
                <span className="text-ink3">
                  Hidden — unanswered for over {fmtQuestionAge(mia.block?.questionMaxAgeHours) || 'a while'}.{' '}
                  <button onClick={() => miaDismiss(m.questionId)} className="font-medium text-ink2 underline-offset-2 hover:text-ink hover:underline">
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
}

// "Visible" for read-marking: the tab is foregrounded AND this region is shown.
function usePageVisible() {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setV(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}

export default function Thread({ mia, active = true, onTask }) {
  const local = useMC((s) => s.miaLocal);
  const link = useMC((s) => s.link);
  const staged = useMC((s) => s.miaStage);
  const uploads = useMC((s) => s.uploads);
  const refs = useAttach((s) => s.refs);
  const [attachOpen, setAttachOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pageVisible = usePageVisible();

  const openIds = useMemo(
    () =>
      new Set(
        mia.pendingQuestions
          .map((q) => q.questionId)
          .filter((id) => id && !(id in local.answered) && !(id in (local.dismissed || {}))),
      ),
    [mia.pendingQuestions, local.answered, local.dismissed],
  );

  // Rows: the thread, minus answer lines whose question is on screen (the
  // answer renders inline under it), plus local echoes still in flight.
  const rows = useMemo(() => {
    const asked = new Set(mia.messages.filter((m) => m.kind === 'question' && m.questionId).map((m) => m.questionId));
    const out = [];
    let prev = null;
    let prevDay = '';
    const push = (m, key, pending = false, extra = {}) => {
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
    // A batch's note shows once, under its last file.
    const lastCaption = (m) => !m.batch || m.batch.split('/')[0] === m.batch.split('/')[1];
    const landed = new Set();
    mia.messages.forEach((m, i) => {
      if (m.kind === 'answer' && m.questionId && asked.has(m.questionId)) return;
      if (m.kind === 'upload' && m.uploadId) landed.add(m.uploadId);
      push(m, m.id || `i${i}`, false, m.kind === 'upload' ? { showCaption: lastCaption(m) } : {});
    });
    for (const p of local.sent) push({ from: 'daniel', kind: 'chat', text: p.text, at: p.at }, p.id, true);
    // Uploads in flight (or just done) that the thread doesn't show yet.
    for (const u of uploads) {
      if (u.relayId && landed.has(u.relayId)) continue;
      const m = { from: 'daniel', kind: 'upload', at: u.at, caption: u.caption, batch: u.batch };
      push(m, u.id, true, { upload: u, showCaption: lastCaption(m) });
    }
    return out;
  }, [mia.messages, local.sent, uploads]);

  // ---- auto-scroll ---------------------------------------------------------
  // Follow new messages only while you're at the bottom; scrolled up reading
  // history, you get a "New messages" pill instead of being yanked down.
  const scroller = useRef(null);
  const stuck = useRef(true);
  const [behind, setBehind] = useState(false);
  const lastKey = rows.length ? rows[rows.length - 1].key : '';

  const toBottom = (smooth) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stuck.current = true;
    setBehind(false);
  };
  useLayoutEffect(() => {
    if (stuck.current) toBottom(false);
    else setBehind(true);
  }, [lastKey, openIds.size]);
  // Re-shown on a phone tab switch: land on the latest again.
  useLayoutEffect(() => {
    if (active) toBottom(false);
  }, [active]);

  // ---- read marker ---------------------------------------------------------
  const lastId = useMemo(() => {
    for (let i = mia.messages.length - 1; i >= 0; i--) if (mia.messages[i].id) return mia.messages[i].id;
    return '';
  }, [mia.messages]);
  useEffect(() => {
    if (active && pageVisible && link === 'linked' && lastId) miaRead(lastId);
  }, [active, pageVisible, link, lastId]);

  const ctx = { block: mia, local, openIds };

  // Drag files from Files/Finder onto the thread, or paste an image.
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const dropProps = {
    onDragEnter: (e) => { if (hasFiles(e)) { e.preventDefault(); setDragging(true); } },
    onDragOver: (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); },
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
    <div className="relative flex min-h-0 flex-1 flex-col" {...dropProps}>
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl3 border-2 border-dashed border-glass-line2 bg-black/40">
          <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <Icon name="attach" size={17} /> Drop to send to Mia
          </span>
        </div>
      )}
      {!mia.enabled && (
        <div className="mx-4 mb-2 flex flex-none items-center gap-3 rounded-xl3 border border-glass-line bg-white/[0.04] px-3.5 py-2.5 sm:mx-5">
          <span className="h-2 w-2 flex-none rounded-full bg-ink3" />
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink2">
            Mia is off. Messages and tasks wait here until she starts.
          </span>
          <Button size="sm" variant="primary" icon="play" onClick={() => miaStart()}>
            Start
          </Button>
        </div>
      )}

      <OldQuestionsBar className="mx-4 mb-2 flex-none sm:mx-5" />

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          stuck.current = atEnd;
          if (atEnd && behind) setBehind(false);
        }}
        className="noscroll min-h-0 flex-1 overflow-y-auto px-4 pb-3 sm:px-5"
      >
        {!rows.length ? (
          <EmptyState
            icon="mia"
            title="Nothing here yet"
            hint="Tell Mia what you need — a task, a question, a reminder. She hands the work to an agent, asks only when she has to, and tells you when it's done."
          />
        ) : (
          <div className="mx-auto flex max-w-[720px] flex-col">
            {rows.map((r) =>
              r.type === 'day' ? (
                <div key={r.key} className="flex items-center gap-3 pb-1 pt-5 first:pt-1">
                  <span className="h-px flex-1 bg-glass-line" />
                  <span className="text-[11px] font-medium text-ink3">{r.label}</span>
                  <span className="h-px flex-1 bg-glass-line" />
                </div>
              ) : r.type === 'event' ? (
                <EventRow key={r.key} m={r.m} />
              ) : (
                <MessageRow key={r.key} m={r.m} head={r.head} mia={ctx} onTask={onTask} pending={r.pending} upload={r.upload} showCaption={r.showCaption} />
              ),
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {behind && (
          <motion.button
            {...press}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={spring.snappy}
            onClick={() => toBottom(true)}
            className="glass-strong pill absolute bottom-[84px] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-medium text-ink"
          >
            <Icon name="arrowDown" size={13} />
            New messages
          </motion.button>
        )}
      </AnimatePresence>

      <div className="flex-none border-t border-glass-line px-3 pb-3 pt-2.5 sm:px-5" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        <div className="mx-auto max-w-[720px]">
          {refs.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Attached for Mia" data-composer-refs>
              {refs.map((r) => (
                <RefChip key={`${r.kind}:${r.id}`} r={r} onTask={onTask} onRemove={() => detachRef(r)} />
              ))}
            </div>
          )}
          {staged.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-2" aria-label="Files to send">
              {staged.map((x) => (
                <span key={x.id} className="glass-soft flex max-w-full items-center gap-2 rounded-xl py-1.5 pl-2.5 pr-1 text-[12.5px] text-ink2">
                  <Icon name={fileIcon(x.name, x.mime)} size={14} className="flex-none text-ink3" />
                  <span className="min-w-0 truncate">{x.name}</span>
                  <span className="tnum flex-none text-ink3">{fmtSize(x.size)}</span>
                  <button onClick={() => unstage(x.id)} aria-label={`Remove ${x.name}`} className="grid h-7 w-7 flex-none place-items-center rounded-lg text-ink3 hover:text-ink">
                    <Icon name="close" size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <MicField
            onSend={(t) => {
              const text = withRefs(t, refs);
              const r = staged.length ? sendStaged(text) : miaSend(text);
              if (r !== false && refs.length) clearRefs();
              return r;
            }}
            canSendEmpty={staged.length > 0 || refs.length > 0}
            leading={
              <motion.button
                {...press}
                onClick={() => setAttachOpen(true)}
                aria-label="Attach a report, task or file"
                title={`Attach a Library report or a task — or send Mia a file (PDF, photo, Office/iWork, text/CSV or audio, up to ${MAX_BYTES / 1024 / 1024} MB)`}
                data-attach-button
                className="glass-soft glass-soft-hover grid h-12 w-12 flex-none place-items-center rounded-xl2 text-ink2"
              >
                <Icon name="attach" size={20} />
              </motion.button>
            }
            placeholder={
              staged.length || refs.length
                ? 'Add a note (optional)'
                : mia.enabled ? 'Message Mia…' : 'Message Mia — she’ll read it when she starts'
            }
          />
        </div>
      </div>
      <AttachSheet open={attachOpen} onClose={() => setAttachOpen(false)} onFiles={() => pickFiles()} />
    </div>
  );
}
