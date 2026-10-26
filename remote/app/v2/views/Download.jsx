import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { kindLabel, toast } from '../../src/lib/store.js';
import { loadDocBody, markdownFile, pdfFile, deliver, isIOS } from '../../src/lib/exportDoc.js';
import { tap } from '../lib/motion.js';
import Sheet from '../ui/Sheet.jsx';
import { Icon, Spinner } from '../ui/kit.jsx';

// Download a Library doc as PDF or markdown. Both files start building the
// moment the sheet opens, so the share sheet can open inside the tap (iOS
// refuses navigator.share once the tap's moment has passed).

const FORMATS = [
  { key: 'pdf', icon: 'doc', label: 'PDF', hint: 'Laid out for reading — headings, tables and code intact' },
  { key: 'md', icon: 'markdown', label: 'Markdown', hint: 'The source file, as it lives on your Mac' },
];

export default function DownloadSheet({ open, onClose, docId, meta, title }) {
  const [files, setFiles] = useState({});
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
        if (!live()) return undefined;
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
      gen.current += 1;
    };
  }, [open, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  function save(key) {
    const f = files[key];
    if (f?.state !== 'ready') {
      if (f?.state === 'busy') setRetry(key);
      return;
    }
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
  useEffect(() => {
    if (retry && files[retry]?.state === 'ready' && !isIOS()) save(retry);
  }, [retry, files]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Sheet open={open} onClose={onClose} title="Download" size="sm">
      <div className="flex flex-col gap-2.5" data-download>
        <div className="truncate pb-1 text-[0.84rem] text-ink3">{title || meta?.title}</div>
        {FORMATS.map((fm) => {
          const f = files[fm.key] || { state: 'busy' };
          const again = retry === fm.key && f.state === 'ready';
          return (
            <motion.button
              key={fm.key}
              {...tap}
              onClick={() => save(fm.key)}
              disabled={f.state === 'error'}
              data-format={fm.key}
              data-state={f.state}
              className={`flex items-center gap-3.5 rounded-[18px] bg-fill p-3.5 text-left disabled:opacity-60 ${again ? 'ring-2 ring-accent/50' : ''}`}
            >
              <span className="grid h-11 w-11 flex-none place-items-center rounded-[13px] bg-card text-ink2">
                <Icon name={fm.icon} size={19} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.98rem] font-semibold text-ink">{fm.label}</span>
                <span className="block text-[0.78rem] leading-snug text-ink3">{f.state === 'error' ? f.error : again ? 'Ready — tap to save' : fm.hint}</span>
              </span>
              <span className="flex-none text-ink2">
                {f.state === 'busy' ? <Spinner size={16} /> : f.state === 'ready' ? <Icon name={isIOS() ? 'share' : 'download'} size={18} /> : <Icon name="alert" size={18} className="text-crit" />}
              </span>
            </motion.button>
          );
        })}
        {isIOS() && <p className="px-1 pt-1 text-[0.76rem] leading-snug text-ink3">Opens the share sheet — Save to Files, Books, AirDrop or Mail.</p>}
      </div>
    </Sheet>
  );
}
