import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { kindLabel, toast } from '../../lib/store.js';
import { loadDocBody, markdownFile, pdfFile, deliver, isIOS } from '../../lib/exportDoc.js';
import { press } from '../../lib/motion.js';
import Sheet from '../../ui/Sheet.jsx';
import Button from '../../ui/Button.jsx';
import IconButton from '../../ui/IconButton.jsx';
import Icon from '../../ui/Icon.jsx';
import Spinner from '../../ui/Spinner.jsx';

// "Download" for one library doc: PDF (laid out for reading) or the markdown
// source. Opening the sheet starts building BOTH files, so by the time a
// finger lands on a row the file is ready and the share sheet can open inside
// that tap — iOS refuses navigator.share once the tap's moment has passed.

const FORMATS = [
  { key: 'pdf', icon: 'doc', label: 'PDF', hint: 'Formatted for reading — headings, tables and code intact' },
  { key: 'md', icon: 'markdown', label: 'Markdown', hint: 'The source file, as it lives on your Mac' },
];

export function DownloadSheet({ open, onClose, docId, meta, title }) {
  // key → { state: 'busy' | 'ready' | 'error', file?, error? }
  const [files, setFiles] = useState({});
  // A format tapped while it was still building, or refused by the browser
  // for want of a fresh tap: its row turns into "Tap to save".
  const [retry, setRetry] = useState(null);
  const gen = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    const n = ++gen.current;
    const live = () => gen.current === n;
    setFiles({ pdf: { state: 'busy' }, md: { state: 'busy' } });
    setRetry(null);
    const name = title || meta?.title || 'document';
    const fail = (key) => (e) => live() && setFiles((f) => ({ ...f, [key]: { state: 'error', error: e?.message || 'Failed' } }));
    loadDocBody(docId)
      .then((doc) => {
        if (!live()) return;
        setFiles((f) => ({ ...f, md: { state: 'ready', file: markdownFile(doc, name) } }));
        return pdfFile(doc, name, { kind: kindLabel(meta?.kind || doc.kind), subject: meta?.subject || doc.subject, updatedAt: meta?.updatedAt || doc.updatedAt })
          .then((file) => live() && setFiles((f) => ({ ...f, pdf: { state: 'ready', file } })))
          .catch(fail('pdf'));
      })
      .catch((e) => {
        fail('md')(e);
        fail('pdf')(e);
      });
    return () => {
      gen.current++;
    };
  }, [open, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tap that arrived early: desktop browsers download without a fresh tap,
  // so finish it the moment the file lands. iOS keeps the "Tap to save" row.
  useEffect(() => {
    if (!retry || isIOS()) return;
    const f = files[retry];
    if (f?.state === 'ready') save(retry);
  }, [retry, files]); // eslint-disable-line react-hooks/exhaustive-deps

  function save(key) {
    const f = files[key];
    if (f?.state !== 'ready') {
      if (f?.state === 'busy') setRetry(key);
      return;
    }
    // Synchronous from the tap: deliver() reaches navigator.share before any await.
    deliver(f.file)
      .then((how) => {
        if (how === 'cancelled') return;
        setRetry(null);
        onClose?.();
        toast(how === 'shared' ? `${f.file.name} ready` : `Downloaded ${f.file.name}`);
      })
      .catch((e) => {
        if (e?.name === 'NotAllowedError') setRetry(key);
        else toast(`Couldn't save: ${e?.message || e}`);
      });
  }

  return (
    <Sheet open={open} onClose={onClose} title="Download" size="sm">
      <div className="flex flex-col gap-2.5">
        <div className="truncate text-[12.5px] text-ink3">{title || meta?.title}</div>
        {FORMATS.map((fm) => {
          const f = files[fm.key] || { state: 'busy' };
          const tapAgain = retry === fm.key && f.state === 'ready';
          return (
            <motion.button
              key={fm.key}
              {...press}
              onClick={() => save(fm.key)}
              disabled={f.state === 'error'}
              data-format={fm.key}
              data-state={f.state}
              className={`glass-soft glass-soft-hover flex items-center gap-3 rounded-xl3 p-3.5 text-left transition-colors disabled:opacity-60 ${
                tapAgain ? 'border-accent/50' : ''
              }`}
            >
              <span className="grid h-10 w-10 flex-none place-items-center rounded-xl2 border border-glass-line bg-white/[0.06] text-ink2">
                <Icon name={fm.icon} size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-semibold text-ink">{fm.label}</span>
                <span className="block text-[12px] leading-snug text-ink3">
                  {f.state === 'error' ? f.error : tapAgain ? 'Ready — tap to save' : fm.hint}
                </span>
              </span>
              <span className="flex-none text-ink2">
                {f.state === 'busy' ? (
                  <Spinner size={16} />
                ) : f.state === 'ready' ? (
                  <Icon name={isIOS() ? 'share' : 'download'} size={17} />
                ) : (
                  <Icon name="alert" size={17} className="text-crit" />
                )}
              </span>
            </motion.button>
          );
        })}
        {isIOS() && (
          <p className="px-1 text-[11.5px] leading-snug text-ink3">
            Opens the share sheet — choose <span className="text-ink2">Save to Files</span>, Books, AirDrop or Mail.
          </p>
        )}
      </div>
    </Sheet>
  );
}

// The trigger + its sheet. `compact` is the round icon for list cards and
// tight headers; otherwise a labelled pill.
export default function DownloadButton({ docId, meta, title, compact = false, disabled = false, className = '' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {compact ? (
        <IconButton
          icon="download"
          label="Download"
          size="sm"
          variant="glass"
          disabled={disabled}
          className={className}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        />
      ) : (
        <Button icon="download" onClick={() => setOpen(true)} disabled={disabled} className={`flex-none ${className}`}>
          Download
        </Button>
      )}
      <DownloadSheet open={open} onClose={() => setOpen(false)} docId={docId} meta={meta} title={title} />
    </>
  );
}
