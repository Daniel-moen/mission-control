// Voice dispatcher: resolve a SPOKEN project reference against the host's
// known directories. Dictation garbles names ("cover V3" for cover-v3,
// "widget claude" for widget-claude), so matching is fuzzy — normalized to
// lowercase alphanumerics and scored exact > affix > substring > edit
// distance. Used by Car mode's mic to launch agents "in the <x> directory".

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[n];
}

export function dirBase(dir) {
  return String(dir || '').split('/').filter(Boolean).pop() || String(dir || '');
}

// 0..1 — how well a spoken phrase names this directory.
export function scoreDirMatch(phrase, dir) {
  const p = norm(phrase);
  const b = norm(dirBase(dir));
  if (!p || !b) return 0;
  if (p === b) return 1;
  if (b.startsWith(p) || p.startsWith(b)) return 0.92;
  if (b.includes(p) || p.includes(b)) return 0.84;
  const d = editDistance(p, b);
  return Math.max(0, 1 - d / Math.max(p.length, b.length));
}

export function resolveDir(phrase, dirs) {
  let best = null;
  let score = 0;
  for (const d of dirs || []) {
    const s = scoreDirMatch(phrase, d);
    if (s > score) {
      score = s;
      best = d;
    }
  }
  return { dir: best, score };
}

// "… in the cover v3 directory" — an EXPLICIT marker word means the speaker
// definitely named a project, so a failed lookup should be reported, not
// silently ignored.
const MARKED = /\b(?:in|into|inside|under|at|to)\s+(?:the\s+)?(.{1,60}?)\s+(?:directory|folder|project|repo(?:sitory)?)\b/i;
// "… in webapp" at the END of the utterance — only trusted when the match is
// strong, since "in production" etc. must not hijack the mission.
const TRAILING = /\b(?:in|into|inside)\s+(?:the\s+)?([a-z0-9 ._-]{2,40}?)[.!?]?$/i;

// Pull a spoken directory reference out of a mission. Returns null when no
// reference is found; otherwise { dir, score, phrase, cleaned, ok } where
// `cleaned` is the mission with the reference removed and `ok` says the match
// cleared the confidence bar.
export function extractDir(mission, dirs) {
  const attempt = (re, minScore, requireOk) => {
    const m = String(mission || '').match(re);
    if (!m) return null;
    const { dir, score } = resolveDir(m[1], dirs);
    if (!dir) return null;
    const ok = score >= minScore;
    if (requireOk && !ok) return null;
    const cleaned = (mission.slice(0, m.index) + ' ' + mission.slice(m.index + m[0].length))
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.!?])/g, '$1')
      .trim();
    return { dir, score, phrase: m[1].trim(), cleaned, ok };
  };
  return attempt(MARKED, 0.5, false) ?? attempt(TRAILING, 0.8, true);
}
