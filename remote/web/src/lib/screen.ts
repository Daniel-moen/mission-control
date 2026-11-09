// Terminal text helpers: strip colour codes, trim Claude Code's TUI chrome,
// and find an interactive menu (permission ask, AskUserQuestion) at the bottom
// of a session's screen so it can be answered with one tap.

// eslint-disable-next-line no-control-regex
const ANSI_RX = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export function stripAnsi(s: string): string {
  if (!s || s.indexOf('\x1b') === -1) return s || '';
  return String(s).replace(ANSI_RX, '');
}

const SPINNER_RX = /^\s*[✢✳✶✻✽·∗＊+*]\s*\S+…/;
const BOXTOP_RX = /^\s*[╭┌][─┄╌]/;
const RULE_RX = /^[\s]*[─━_]{8,}[\s]*$/;
const FOOTER_RX = /auto mode on|shift\+tab to cycle|esc to interrupt|\? for shortcuts|accept edits|bypass permissions|plan mode on|for agents$/i;

export function cleanScreen(raw: string): string {
  if (!raw) return '';
  const lines = stripAnsi(String(raw)).replace(/\s+$/, '').split('\n');
  const win = Math.max(0, lines.length - 16);
  let cut = lines.length;
  for (let i = win; i < lines.length; i++) if (SPINNER_RX.test(lines[i])) { cut = i; break; }
  if (cut === lines.length) {
    for (let i = win; i < lines.length; i++) if (BOXTOP_RX.test(lines[i]) || RULE_RX.test(lines[i])) { cut = i; break; }
  }
  const tail = Math.max(0, cut - 8);
  const kept: string[] = [];
  for (let i = 0; i < cut; i++) {
    if (i >= tail && (FOOTER_RX.test(lines[i]) || /^\s*[❯>]\s*$/.test(lines[i]))) continue;
    kept.push(lines[i]);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
}

export interface Prompt {
  question: string;
  multi: boolean;
  options: { n: number; label: string; desc: string; selected: boolean }[];
}

export function parsePrompt(screen: string): Prompt | null {
  if (!screen) return null;
  const lines = stripAnsi(String(screen)).replace(/\s+$/, '').split('\n').slice(-40);
  const optRx = /^[\s│|]*([❯>›])?\s*(\d{1,2})[.)]\s+(.+?)[\s│|]*$/;
  const raw: { i: number; n: number; selected: boolean; text: string }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(optRx);
    if (m) raw.push({ i, n: +m[2], selected: !!m[1], text: m[3] });
  });
  if (raw.length < 2) return null;
  let opts: typeof raw = [];
  for (const o of raw) {
    if (!opts.length) { if (o.n === 1) opts = [o]; }
    else if (o.n === opts[opts.length - 1].n + 1) opts.push(o);
    else if (o.n === 1) opts = [o];
  }
  if (opts.length < 2 || opts[opts.length - 1].i < lines.length - 10) return null;
  const cbRx = /^\[[ xX✔✓·]?\]\s*/;
  const hintRx = /(Enter to|to navigate|to select|esc to|shift\+tab|↑\/↓)/i;
  const multi = opts.some((o) => cbRx.test(o.text));
  const options = opts.map((o, k) => {
    const next = k + 1 < opts.length ? opts[k + 1].i : lines.length;
    const desc: string[] = [];
    for (let j = o.i + 1; j < next; j++) {
      const t = lines[j].replace(/[│|]/g, '').trim();
      if (!t) continue;
      if (/^[─━]{4,}$/.test(t) || hintRx.test(t)) break;
      desc.push(t);
    }
    return { n: o.n, label: o.text.replace(cbRx, '').replace(/\s*\(esc\)\s*$/i, '').trim(), desc: desc.join(' ').slice(0, 200), selected: o.selected };
  });
  const q: string[] = [];
  for (let j = opts[0].i - 1; j >= 0 && j > opts[0].i - 12; j--) {
    const t = lines[j].replace(/[│|╭╮╰╯]/g, '').replace(/^[\s►❯]+/, '').trim();
    if (!t || /^[─━]{4,}$/.test(t)) { if (q.length) break; else continue; }
    if (hintRx.test(t) || /^[←→]|✔ Submit|☐ /.test(t)) continue;
    q.unshift(t);
  }
  return { question: q.join(' ').replace(/\s+/g, ' ').trim(), multi, options };
}
