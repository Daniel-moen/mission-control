// ANSI → HTML for the terminal mirror. WezTerm captures arrive with their SGR
// color codes intact (`wezterm cli get-text --escapes`); iTerm2/Terminal.app
// can only be captured as plain text, which passes through here unchanged.
//
// Two exports:
//   stripAnsi(s)  — plain text, for regex logic (cleanScreen, parsePrompt) and
//                   for terminals that never had codes in the first place.
//   ansiToHtml(s) — HTML-escaped text with <span style="…"> runs for SGR
//                   styling. Every non-SGR escape (cursor movement, OSC titles,
//                   mode switches) is dropped; a truncated trailing escape
//                   (frames are tail-sliced by size caps) is dropped too.

// Any ESC-introduced sequence: CSI (ESC [ … final byte), OSC (ESC ] … BEL/ST),
// an intermediate-byte sequence like the charset designation ESC ( B that
// terminals emit as part of sgr0, or a lone two-byte escape. Also bare ESC at
// end-of-input (truncation).
const ANSI_RX = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]?|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[ -/]+[0-~]?|[@-Z\\-_]?)/g;

export function stripAnsi(s) {
  if (!s || s.indexOf('\x1b') === -1) return s;
  return String(s).replace(ANSI_RX, '');
}

// The classic 16, tuned for the panel's dark inset background: "black" is
// lifted so it stays visible, the rest are the readable mid-saturation set
// most dark terminal themes converge on.
const BASE16 = [
  '#4c5561', '#e0616d', '#8fc76a', '#d9a35a', '#57a5eb', '#c574dd', '#4fb8c6', '#c9ced6',
  '#697180', '#f2848e', '#a8dd8a', '#eabf7a', '#7fc0f5', '#d99aec', '#72d3e0', '#eceff3',
];

// xterm 256-color palette: 0-15 base, 16-231 6×6×6 cube, 232-255 grayscale.
function color256(n) {
  n |= 0;
  if (n < 16) return BASE16[n] || '';
  if (n < 232) {
    const c = n - 16;
    const step = (v) => (v ? 55 + v * 40 : 0);
    return `rgb(${step((c / 36) | 0)},${step(((c / 6) | 0) % 6)},${step(c % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const ESC_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ESC_HTML[c]);
}

function freshState() {
  return { fg: '', bg: '', bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false };
}

function styleOf(st) {
  let fg = st.fg;
  let bg = st.bg;
  if (st.inverse) {
    // Swap; where a side was never set, fall back to the theme's dark inset /
    // light ink so the run reads as a highlight (currentColor would resolve to
    // this very span's color and make the text invisible).
    [fg, bg] = [bg || '#14171a', fg || '#c9ced6'];
  }
  let css = '';
  if (fg) css += `color:${fg};`;
  if (bg) css += `background:${bg};`;
  if (st.bold) css += 'font-weight:700;';
  if (st.dim) css += 'opacity:.62;';
  if (st.italic) css += 'font-style:italic;';
  if (st.underline && st.strike) css += 'text-decoration:underline line-through;';
  else if (st.underline) css += 'text-decoration:underline;';
  else if (st.strike) css += 'text-decoration:line-through;';
  return css;
}

// Apply one SGR parameter list ("0;1;38;5;114") to the run state, mutating it.
function applySgr(params, st) {
  // Split on ';' but honor the colon sub-parameter form (38:5:114) too.
  const p = params.length ? params.split(';').map((x) => x) : [''];
  for (let i = 0; i < p.length; i++) {
    const seg = p[i].split(':');
    const n = seg[0] === '' ? 0 : +seg[0];
    if (Number.isNaN(n)) continue;
    if (n === 0) Object.assign(st, freshState());
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.underline = true;
    else if (n === 7) st.inverse = true;
    else if (n === 9) st.strike = true;
    else if (n === 22) { st.bold = false; st.dim = false; }
    else if (n === 23) st.italic = false;
    else if (n === 24) st.underline = false;
    else if (n === 27) st.inverse = false;
    else if (n === 29) st.strike = false;
    else if (n >= 30 && n <= 37) st.fg = BASE16[n - 30];
    else if (n === 39) st.fg = '';
    else if (n >= 40 && n <= 47) st.bg = BASE16[n - 40];
    else if (n === 49) st.bg = '';
    else if (n >= 90 && n <= 97) st.fg = BASE16[n - 90 + 8];
    else if (n >= 100 && n <= 107) st.bg = BASE16[n - 100 + 8];
    else if (n === 38 || n === 48) {
      // Extended color: inline (38:5:n / 38:2:r:g:b) or across ';' params.
      const args = seg.length > 1 ? seg.slice(1) : p.slice(i + 1);
      const inline = seg.length > 1;
      let used = 0;
      let col = '';
      if (+args[0] === 5 && args.length >= 2) { col = color256(+args[1]); used = 2; }
      else if (+args[0] === 2 && args.length >= 4) { col = `rgb(${+args[1]|0},${+args[2]|0},${+args[3]|0})`; used = 4; }
      if (!inline) i += used;
      if (col) { if (n === 38) st.fg = col; else st.bg = col; }
    }
  }
}

// Render to HTML. Styling state carries across newlines (a color set on one
// line legitimately runs on), so callers may slice LINES off the top freely —
// any state those lines set is simply re-derived from what remains, which for
// TUI output (every line restyles itself) looks right in practice.
export function ansiToHtml(s) {
  if (!s) return '';
  s = String(s);
  if (s.indexOf('\x1b') === -1) return escapeHtml(s);
  const st = freshState();
  let out = '';
  let last = 0;
  ANSI_RX.lastIndex = 0;
  let m;
  const flushText = (end) => {
    if (end <= last) return;
    const text = escapeHtml(s.slice(last, end));
    const css = styleOf(st);
    if (css) {
      out += `<span style="${css}">${text}</span>`;
    } else {
      out += text;
    }
  };
  while ((m = ANSI_RX.exec(s))) {
    flushText(m.index);
    last = m.index + m[0].length;
    const seq = m[0];
    // Only SGR ("ESC [ params m") changes styling; everything else is dropped.
    const sgr = /^\x1b\[([0-9;:]*)m$/.exec(seq);
    if (sgr) applySgr(sgr[1], st);
  }
  flushText(s.length);
  return out;
}
