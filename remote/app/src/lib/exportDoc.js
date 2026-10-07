// Library downloads: a doc as its markdown source, or as a PDF laid out for
// reading on an iPad (A4, real tables, headings, code blocks). The body comes
// over the relay's usual docGet path; the PDF is built right here in the
// browser, so the Mac needs no new command.
//
// pdfmake (and its fonts) are ~1 MB, so they load on first use only — a
// dynamic import that Vite splits into its own chunk.
//
// Delivery is the fiddly part. In an iOS Home Screen web app a plain
// <a download> of a blob can open the file in a viewer with no way back, so on
// iOS we hand the File to the share sheet (Save to Files, Books, AirDrop…).
// navigator.share needs a fresh tap — so callers PREPARE the file first and
// call deliver() synchronously inside the tap handler.

import { marked } from 'marked';
import { useMC, docGet } from './store.js';
// IBM Plex Mono (OFL), latin subset — the @fontsource WOFF unwrapped to plain
// TrueType, because pdfkit misreads WOFF tables.
import monoUrl from '../assets/fonts/IBMPlexMono-Regular-latin.ttf?url';

// ---- body -----------------------------------------------------------------

// Resolve a doc's body, fetching it over the relay if it isn't cached yet.
export function loadDocBody(id, timeout = 15000) {
  const cached = useMC.getState().docDocs[id];
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      clearTimeout(timer);
      unsub();
      fn(v);
    };
    const unsub = useMC.subscribe((s) => {
      if (s.docDocs[id]) done(resolve, s.docDocs[id]);
    });
    const timer = setTimeout(() => done(reject, new Error('Your Mac did not send the document')), timeout);
    if (!docGet(id)) done(reject, new Error('Not connected to your Mac'));
  });
}

// ---- file names -----------------------------------------------------------

export function fileBase(title) {
  const s = String(title || 'document')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\w\s.-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
  return s || 'document';
}

// ---- markdown file --------------------------------------------------------

export function markdownFile(doc, title) {
  // Prefer text/markdown; iOS's share sheet only takes types it knows, so fall
  // back to text/plain (the .md name still tells Files what it is).
  const name = `${fileBase(title)}.md`;
  const md = new File([doc.content], name, { type: 'text/markdown' });
  if (!canShareFile(md) && canShareFile(new File([''], name, { type: 'text/plain' })))
    return new File([doc.content], name, { type: 'text/plain' });
  return md;
}

// ---- PDF ------------------------------------------------------------------

let pdfLib = null;
async function loadPdf() {
  if (pdfLib) return pdfLib;
  const [{ default: pdfMake }, fonts, mono] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
    fetch(monoUrl)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null),
  ]);
  const vfs = { ...(fonts.default?.pdfMake?.vfs || fonts.pdfMake?.vfs || fonts.default?.vfs || fonts.default || {}) };
  const families = {
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  };
  if (mono) {
    vfs['PlexMono.ttf'] = toBase64(mono);
    families.Mono = { normal: 'PlexMono.ttf', bold: 'PlexMono.ttf', italics: 'PlexMono.ttf', bolditalics: 'PlexMono.ttf' };
  }
  pdfLib = { pdfMake, vfs, families, mono: !!mono };
  return pdfLib;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const INK = '#1d2320';
const INK2 = '#4a534e';
const INK3 = '#7c857f';
const LINE = '#dfe4e1';
const ACCENT = '#1f7a55';
const CODE_BG = '#f3f5f4';

// Inline tokens → pdfmake text runs, carrying bold/italic/code/link down.
function inline(tokens, st = {}, mono = 'Mono') {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'strong':
        out.push(...inline(t.tokens, { ...st, bold: true }, mono));
        break;
      case 'em':
        out.push(...inline(t.tokens, { ...st, italics: true }, mono));
        break;
      case 'del':
        out.push(...inline(t.tokens, { ...st, decoration: 'lineThrough' }, mono));
        break;
      case 'codespan':
        out.push({ text: unescape(t.text), ...st, font: mono, fontSize: 9, background: CODE_BG, color: INK });
        break;
      case 'link':
        out.push(...inline(t.tokens, { ...st, link: t.href, color: ACCENT, decoration: 'underline' }, mono));
        break;
      case 'image':
        out.push({ text: `[${t.text || 'image'}]`, ...st, color: INK3 });
        break;
      case 'br':
        out.push({ text: '\n', ...st });
        break;
      case 'html':
        out.push({ text: t.text.replace(/<[^>]+>/g, ''), ...st });
        break;
      case 'text':
      case 'escape':
        if (t.tokens?.length) out.push(...inline(t.tokens, st, mono));
        else out.push({ text: unescape(t.text).replace(/\n/g, ' '), ...st });
        break;
      default:
        if (t.tokens) out.push(...inline(t.tokens, st, mono));
        else if (t.text) out.push({ text: unescape(t.text), ...st });
    }
  }
  return out;
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescape = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m]);

// Neither bundled font carries box-drawing glyphs (directory trees, ASCII
// tables in code blocks) — draw them with plain ASCII rather than blanks.
const BOX = { '─': '-', '━': '-', '│': '|', '┃': '|', '└': '`', '╰': '`' };
const asciiBoxes = (s) => String(s).replace(/[\u2500-\u257f]/g, (c) => BOX[c] || '+');

const H = [null, 20, 15.5, 13, 11.5, 11, 10.5];

function blocks(tokens, mono) {
  const out = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'heading': {
        const node = {
          text: inline(t.tokens, {}, mono),
          fontSize: H[t.depth] || 11,
          bold: true,
          color: INK,
          margin: [0, t.depth <= 2 ? 14 : 10, 0, t.depth <= 2 ? 4 : 3],
          headlineLevel: t.depth,
        };
        out.push(node);
        if (t.depth <= 2)
          out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.6, lineColor: LINE }], margin: [0, 0, 0, 6] });
        break;
      }
      case 'paragraph':
        out.push({ text: inline(t.tokens, {}, mono), margin: [0, 0, 0, 8] });
        break;
      case 'text':
        out.push({ text: inline(t.tokens || [{ type: 'text', text: t.text }], {}, mono), margin: [0, 0, 0, 4] });
        break;
      case 'list': {
        const items = t.items.map((it) => {
          const body = blocks(it.tokens, mono);
          const stack = body.length ? body : [{ text: '' }];
          if (it.task) stack[0] = { ...stack[0], text: [{ text: it.checked ? '[x] ' : '[ ] ', font: mono }, ...[].concat(stack[0].text || [])] };
          // tighten paragraph spacing inside list items
          return { stack: stack.map((b) => ({ ...b, margin: b.margin ? [b.margin[0], 0, b.margin[2], 3] : [0, 0, 0, 3] })) };
        });
        const node = t.ordered ? { ol: items, start: Number(t.start) || 1 } : { ul: items };
        out.push({ ...node, margin: [4, 0, 0, 8], markerColor: INK3 });
        break;
      }
      case 'table': {
        const n = t.header.length;
        const align = (i) => (t.align?.[i] === 'right' ? 'right' : t.align?.[i] === 'center' ? 'center' : 'left');
        const head = t.header.map((c, i) => ({ text: inline(c.tokens, { bold: true }, mono), alignment: align(i), fillColor: '#eef2f0' }));
        const rows = t.rows.map((r) => r.map((c, i) => ({ text: inline(c.tokens, {}, mono), alignment: align(i) })));
        // Short columns stay tight, prose columns share what's left.
        const widths = Array.from({ length: n }, (_, i) => {
          const longest = Math.max(
            (t.header[i]?.text || '').length,
            ...t.rows.map((r) => (r[i]?.text || '').length),
          );
          return longest > 24 ? '*' : 'auto';
        });
        if (!widths.includes('*')) widths[widths.length - 1] = '*';
        out.push({
          table: { headerRows: 1, widths, body: [head, ...rows], dontBreakRows: true },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.8 : 0.5),
            vLineWidth: () => 0.5,
            hLineColor: () => LINE,
            vLineColor: () => LINE,
            paddingLeft: () => 6,
            paddingRight: () => 6,
            paddingTop: () => 4,
            paddingBottom: () => 4,
          },
          fontSize: n > 5 ? 8.5 : 9.5,
          margin: [0, 2, 0, 10],
        });
        break;
      }
      case 'code':
        out.push({
          table: {
            widths: ['*'],
            body: [[{ text: asciiBoxes(t.text), font: mono, fontSize: 8.5, color: INK, preserveLeadingSpaces: true, lineHeight: 1.25 }]],
          },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: () => 0,
            fillColor: () => CODE_BG,
            paddingLeft: () => 8,
            paddingRight: () => 8,
            paddingTop: () => 6,
            paddingBottom: () => 6,
          },
          margin: [0, 0, 0, 10],
        });
        break;
      case 'blockquote':
        out.push({
          table: { widths: ['*'], body: [[{ stack: blocks(t.tokens, mono), color: INK2 }]] },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: (i) => (i === 0 ? 2 : 0),
            vLineColor: () => '#b9c4be',
            paddingLeft: () => 10,
            paddingTop: () => 2,
            paddingBottom: () => 0,
          },
          margin: [0, 0, 0, 8],
        });
        break;
      case 'hr':
        out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.6, lineColor: LINE }], margin: [0, 6, 0, 10] });
        break;
      // :::pair / :::facts / :::callout … (md.js, task 0124): the PDF keeps
      // the content (images as their [alt]); a callout's title goes bold.
      case 'mdBlock': {
        const m = t.kind === 'callout' ? /^(?:ok|good|warn|bad|info|note|risk|crit|yes|no|high|low|medium|maybe|mid)?\s*(.*)$/i.exec(t.args || '') : null;
        if (m && m[1]) out.push({ text: m[1], bold: true, margin: [0, 4, 0, 3] });
        out.push(...blocks(t.tokens, mono));
        break;
      }
      case 'html': {
        const text = t.text.replace(/<[^>]+>/g, '').trim();
        if (text) out.push({ text, margin: [0, 0, 0, 8] });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// Strip a YAML frontmatter block — it's metadata, not reading matter (the
// header already shows kind/status/subject).
const stripFrontmatter = (s) => String(s || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

export async function pdfFile(doc, title, meta = {}) {
  const lib = await loadPdf();
  const mono = lib.mono ? 'Mono' : 'Roboto';
  const tokens = marked.lexer(stripFrontmatter(doc.content), { gfm: true });
  // Skip a leading H1 that just repeats the title we print above it.
  if (tokens[0]?.type === 'heading' && tokens[0].depth === 1 && tokens[0].text.trim() === String(title).trim()) tokens.shift();

  const when = meta.updatedAt ? new Date(meta.updatedAt > 1e12 ? meta.updatedAt : meta.updatedAt * 1000) : new Date();
  const byline = [meta.kind, meta.subject, when.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })]
    .filter(Boolean)
    .join('  ·  ');

  const def = {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 52],
    info: { title: String(title), creator: 'Mission Control' },
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.35, color: INK },
    content: [
      { text: String(title), fontSize: 22, bold: true, color: INK, margin: [0, 0, 0, 4] },
      byline && { text: byline, fontSize: 9.5, color: INK3, margin: [0, 0, 0, 6] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: ACCENT }], margin: [0, 2, 0, 14] },
      ...blocks(tokens, mono),
    ].filter(Boolean),
    footer: (page, pages) => ({
      columns: [
        { text: String(title), color: INK3, fontSize: 8, margin: [40, 0, 0, 0] },
        { text: `${page} / ${pages}`, color: INK3, fontSize: 8, alignment: 'right', margin: [0, 0, 40, 0] },
      ],
      margin: [0, 18, 0, 0],
    }),
    // Never strand a heading at the bottom of a page.
    pageBreakBefore: (node, after) => node.headlineLevel && after.length === 0,
  };

  // pdfmake reports failures as unhandled rejections from inside its own
  // promise chain, never through the callback — listen for them while we wait.
  const blob = await new Promise((resolve, reject) => {
    const fail = (e) => {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e?.reason?.message || e?.reason || e || 'PDF failed')));
    };
    const onReject = (ev) => fail(ev.reason instanceof Error ? ev.reason : ev);
    const timer = setTimeout(() => fail(new Error('Building the PDF took too long')), 45000);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('unhandledrejection', onReject);
    };
    window.addEventListener('unhandledrejection', onReject);
    try {
      lib.pdfMake.createPdf(def, null, lib.families, lib.vfs).getBlob((b) => {
        cleanup();
        resolve(b);
      });
    } catch (e) {
      fail(e);
    }
  });
  return new File([blob], `${fileBase(title)}.pdf`, { type: 'application/pdf' });
}

// ---- delivery -------------------------------------------------------------

export const isIOS = () =>
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches);

function canShareFile(file) {
  try {
    return !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

// Hand the file over. Call this synchronously from a tap. Resolves to
// 'shared' | 'downloaded' | 'cancelled'; rejects with name 'NotAllowedError'
// when the browser wants a fresh tap (the caller then offers one).
export async function deliver(file) {
  // iOS (and any touch device that can share files): the share sheet is the
  // one path that works in a Home Screen app.
  const preferShare = isIOS() || (isStandalone() && navigator.maxTouchPoints > 0);
  if (preferShare && canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
