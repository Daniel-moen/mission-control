// Number/time formatting shared by every view. Figures render with
// `tabular-nums`, so these strings are also what keeps columns aligned.

export function fmtTokens(n) {
  n = n ?? 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function fmtInt(n) {
  return (n ?? 0).toLocaleString();
}

export function fmtMem(mb) {
  if (mb == null) return '';
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

// Wall clock for activity rows: "14:03:07".
export function clockOf(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Spend. Always two decimals — cost moves in cents and a jumping decimal count
// would make the ticker twitch: '$0.42', '$12.30', '$1,204.00'.
// en-US on purpose: the '$' is hard-coded, so a locale that pairs it with a
// comma decimal separator ('$0,42') would read as wrong.
export function fmtMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Age of a sample, in the shortest honest unit: 'live' | '3s' | '2m' | '1h'.
// Anything under 2s reads as live — a 1 Hz snapshot is never "1s old" in a way
// a human cares about.
export function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return 'live';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Elapsed time, two units at most: '45s', '3m 20s', '1h 4m', '2d 3h'.
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// Burn rate: '38 tok/s' (one decimal only while it is small enough to matter).
export function fmtRate(tokensPerSec) {
  const v = Number(tokensPerSec) || 0;
  if (v > 0 && v < 10) return `${v.toFixed(1)} tok/s`;
  return `${Math.round(v)} tok/s`;
}
