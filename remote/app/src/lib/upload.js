// Files for Mia — the panel's upload button (docs/mia.md §8.4).
//
// Pick (Files, Photos, camera — the iPad's own picker), drop or paste files;
// they wait in a tray above the composer, and Send uploads them one at a time
// to the relay's POST /upload with the composer text as Daniel's note. The
// relay validates each file, hands it to the Mac, and answers once the Mac has
// saved it (200) — or 202 if the Mac hasn't collected it yet (it will on
// reconnect). Progress comes from XHR (fetch can't report upload progress).
// The file then shows up in the thread from the snapshot like any message.

import { useMC, getMC, toast } from './store.js';

// Keep in step with remote/upload.js TYPES (the relay is the enforcer).
export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 10;
const EXTS = [
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff',
  'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'pages', 'numbers', 'key', 'rtf',
  'txt', 'md', 'csv', 'tsv', 'json',
  'mp3', 'm4a', 'aac', 'wav', 'aif', 'aiff', 'caf', 'flac', 'ogg', 'oga', 'opus', 'webm',
];
// The picker's filter: extensions plus broad MIME families, so iOS offers
// Photo Library and Take Photo alongside Browse (Files).
export const ACCEPT = ['image/*', 'audio/*', 'application/pdf', 'text/plain', 'text/csv', ...EXTS.map((e) => `.${e}`)].join(',');

// A photo from the camera or clipboard can arrive as "image" with no extension.
const EXT_FOR_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif',
  'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac',
};

export function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function nameFor(file) {
  const n = (file.name || '').trim();
  if (extOf(n)) return n;
  const ext = EXT_FOR_MIME[(file.type || '').toLowerCase()];
  const stem = n || (file.type?.startsWith('image/') ? 'photo' : 'file');
  return ext ? `${stem}.${ext}` : stem;
}

export function fmtSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Icon name for a file (ui/Icon.jsx).
export function fileIcon(name = '', mime = '') {
  const e = extOf(name);
  if (mime.startsWith('image/')) return 'fileImage';
  if (mime.startsWith('audio/')) return 'fileAudio';
  if (['xlsx', 'xls', 'csv', 'tsv', 'numbers', 'ods'].includes(e)) return 'fileSheet';
  if (['pptx', 'ppt', 'key'].includes(e)) return 'fileSlides';
  if (['pdf', 'docx', 'doc', 'txt', 'md', 'rtf', 'pages', 'odt'].includes(e)) return 'doc';
  return 'file';
}

// Why this file can't go, or '' if it can.
export function checkFile(file) {
  const name = nameFor(file);
  const e = extOf(name);
  if (!EXTS.includes(e)) return `${name}: .${e || '?'} files aren't supported`;
  if (!file.size) return `${name} is empty`;
  if (file.size > MAX_BYTES) return `${name} is over the ${MAX_BYTES / 1024 / 1024} MB limit`;
  return '';
}

const patch = (fn) => useMC.setState((s) => fn(s));
let seq = 0;
const files = new Map(); // row id → File (kept for retry until the row goes)

// ---- the tray -----------------------------------------------------------------

export function stageFiles(list) {
  const incoming = Array.from(list || []);
  if (!incoming.length) return 0;
  const bad = [];
  const ok = [];
  for (const f of incoming) {
    const why = checkFile(f);
    if (why) bad.push(why);
    else ok.push({ id: `s${++seq}`, file: f, name: nameFor(f), size: f.size, mime: f.type || '' });
  }
  const room = MAX_FILES - getMC().miaStage.length;
  if (ok.length > room) bad.push(`Up to ${MAX_FILES} files at a time`);
  const take = ok.slice(0, Math.max(0, room));
  if (take.length) patch((s) => ({ miaStage: [...s.miaStage, ...take] }));
  if (bad.length) toast(bad.length === 1 ? bad[0] : `${bad[0]} (+${bad.length - 1} more)`);
  return take.length;
}

export function unstage(id) {
  patch((s) => ({ miaStage: s.miaStage.filter((x) => x.id !== id) }));
}

// Open the system picker. Must run inside a tap/click handler (iOS only opens
// it from a user gesture). One hidden input, reused.
let input = null;
export function pickFiles({ onPicked } = {}) {
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT;
    input.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0';
    input.setAttribute('aria-hidden', 'true');
    document.body.appendChild(input);
  }
  input.onchange = () => {
    const n = stageFiles(input.files);
    input.value = ''; // picking the same file again still fires change
    if (n) onPicked?.(n);
  };
  input.click();
}

// ---- sending ------------------------------------------------------------------

function setRow(id, fields) {
  patch((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...fields } : u)) }));
}

export function dismissUpload(id) {
  files.delete(id);
  patch((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
}

// Why the Mac can't take a file right now, or ''.
function blocked() {
  const mc = getMC();
  if (mc.link !== 'linked') return 'The Mac is offline — files can go once it’s back';
  if (mc.snapshot && !(mc.snapshot.caps || []).includes('upload')) return 'Update Mission Control on the Mac to send it files';
  return '';
}

// Upload everything in the tray with this note. Returns false (tray kept) if
// nothing can go right now.
export function sendStaged(caption = '') {
  const staged = getMC().miaStage;
  if (!staged.length) return false;
  const why = blocked();
  if (why) {
    toast(why);
    return false;
  }
  const note = caption.trim();
  const batchId = staged.length > 1 ? `b${Date.now().toString(36)}` : '';
  const rows = staged.map((x, i) => {
    const id = `up${++seq}`;
    files.set(id, x.file);
    return {
      id, name: x.name, size: x.size, mime: x.mime, loaded: 0, status: 'waiting', error: '',
      relayId: '', at: Date.now(), caption: note,
      batch: staged.length > 1 ? `${i + 1}/${staged.length}` : '', batchId,
    };
  });
  patch((s) => ({ miaStage: [], uploads: [...s.uploads, ...rows] }));
  runQueue(rows.map((r) => r.id));
  return true;
}

export function retryUpload(id) {
  const why = blocked();
  if (why) return toast(why);
  setRow(id, { status: 'waiting', error: '', loaded: 0 });
  runQueue([id]);
}

let chain = Promise.resolve();
function runQueue(ids) {
  chain = chain.then(async () => {
    let sent = 0;
    let queued = 0;
    for (const id of ids) {
      const r = await uploadOne(id);
      if (r === 'done') sent += 1;
      if (r === 'queued') queued += 1;
    }
    if (queued) toast('The Mac hasn’t collected it yet — it will when it reconnects');
    else if (sent) toast(sent === 1 ? 'Sent to Mia' : `${sent} files sent to Mia`);
  });
}

function uploadOne(id) {
  const row = getMC().uploads.find((u) => u.id === id);
  const file = files.get(id);
  if (!row || !file) return Promise.resolve('gone');
  setRow(id, { status: 'uploading', loaded: 0 });
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader('Authorization', `Bearer ${getMC().token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-MC-Name', encodeURIComponent(row.name));
    if (row.caption) xhr.setRequestHeader('X-MC-Caption', encodeURIComponent(row.caption));
    if (row.batch) {
      xhr.setRequestHeader('X-MC-Batch', row.batch);
      xhr.setRequestHeader('X-MC-Batch-Id', row.batchId);
    }
    let lastPaint = 0;
    xhr.upload.onprogress = (e) => {
      const now = Date.now();
      if (e.lengthComputable && (now - lastPaint > 120 || e.loaded === e.total)) {
        lastPaint = now;
        setRow(id, { loaded: e.loaded });
      }
    };
    // Bytes are up; the relay is now handing it to the Mac.
    xhr.upload.onload = () => setRow(id, { loaded: row.size, status: 'delivering' });
    const fail = (error) => {
      setRow(id, { status: 'error', error });
      resolve('error');
    };
    xhr.onerror = () => fail('Network error — check the connection and retry');
    xhr.ontimeout = () => fail('Timed out');
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* a proxy's error page */
      }
      if (xhr.status === 401) return fail('The relay rejected the panel token');
      if (xhr.status === 200 && data?.ok) {
        files.delete(id);
        setRow(id, { status: 'done', relayId: data.id || '', path: data.path || '', loaded: row.size, doneAt: Date.now() });
        // The thread shows the real message from the next snapshot; drop the
        // local row a little later in case that never comes (old snapshot).
        setTimeout(() => dismissUpload(id), 20000);
        return resolve('done');
      }
      if (xhr.status === 202 && data?.ok) {
        files.delete(id);
        setRow(id, { status: 'queued', relayId: data.id || '', doneAt: Date.now() });
        setTimeout(() => dismissUpload(id), 60000);
        return resolve('queued');
      }
      if (xhr.status === 413) return fail(data?.error || 'Too large');
      return fail(data?.error || `Upload failed (${xhr.status || 'no answer'})`);
    };
    xhr.send(file);
  });
}
