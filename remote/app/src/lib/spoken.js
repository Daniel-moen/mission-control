// Turning Mia's written messages into something short to say aloud
// (lib/announce.js). Pure — no DOM, no store — so test/spoken-test.mjs runs it
// in plain Node.

// Written for the eye, not the ear: drop markdown and read links as "a link".
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^\s{0,3}(#{1,6}|[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/\*+/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/([!?:])\./g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Short-spoken: a long message is read as its first sentence (two when the
// first is only a few words), never a whole report. → { text, cut } where cut
// says something was left for the panel. A sentence ends at . ! ? … followed
// by a space and a capital, digit or quote, and not after "e.g." & co — so
// "v2.1" and "e.g. Fable" don't.
export const SPOKEN_MAX = 180;
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|incl|Mr|Mrs|Ms|Dr|St|No)\.$/i;
// Where sentences end in already-speakable text: indexes just past the
// punctuation.
function sentenceEnds(t) {
  const ends = [];
  const rx = /[.!?…]+["'”’)]*(?=\s+["'“‘(]?[A-Z0-9])/g;
  let m;
  while ((m = rx.exec(t))) {
    const e = m.index + m[0].length;
    if (!ABBREV.test(t.slice(Math.max(0, e - 8), e))) ends.push(e);
  }
  return ends;
}

export function firstSentences(text, max = SPOKEN_MAX) {
  const t = speakable(text);
  if (t.length <= max) return { text: t, cut: false };
  const ends = sentenceEnds(t);
  let out = '';
  for (const e of ends) {
    const cand = t.slice(0, e).trim();
    if (cand.length > max) break;
    out = cand;
    if (out.length >= 60) break; // one proper sentence is enough
  }
  if (!out) {
    // One very long sentence: cut on a word boundary.
    const cut = t.slice(0, max);
    out = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[,;:\s—–-]+$/, '')}…`;
  }
  return { text: out, cut: true };
}

// Talk mode, sentence by sentence (task 0447): the Mac makes one sentence in
// ~0.4–1 s, much less than it takes to say, so each piece is one sentence —
// the first one is heard almost at once and the next is ready before it ends.
// A tiny sentence ("Sure.", "OK, done.") is joined to the one after it so a
// half-second piece isn't followed by a wait; a sentence longer than `max`
// is cut at a comma or a word. The Mac needs ~0.25 s + ~0.2 s per second of
// speech, so a long FIRST sentence is split at its first clause break (a
// comma, or before "and", "but", "so"…) to keep the first sound under ~1 s.
export const TALK_SHORT = 40; // shorter than this: join it to the next sentence
export const TALK_PIECE_MAX = 220;
export const TALK_FIRST_MAX = 60; // a longer first sentence is split at a clause
export function talkParts(text, { max = TALK_PIECE_MAX, short = TALK_SHORT, firstMax = TALK_FIRST_MAX } = {}) {
  const t = speakable(text);
  if (!t) return [];
  const sentences = [];
  let from = 0;
  for (const e of [...sentenceEnds(t), t.length]) {
    const s = t.slice(from, e).trim();
    from = e;
    if (s) sentences.push(...cutLong(s, max));
  }
  const out = [];
  for (const s of sentences) {
    const prev = out[out.length - 1];
    if (prev && prev.length < short && prev.length + 1 + s.length <= max) out[out.length - 1] = `${prev} ${s}`;
    else out.push(s);
  }
  if (out[0]?.length > firstMax) out.splice(0, 1, ...splitClause(out[0], firstMax));
  return out;
}

// "Task 447 is running now and should be done soon." → ["Task 447 is running
// now", "and should be done soon."]: the first clause break in 20…firstMax+20
// characters that leaves at least 20 behind; no break → unchanged.
const CLAUSE = /(?:[,;:] |\s[–—] |\s(?=(?:and|but|so|because|which|then|while|though|although|since|or)\s))/g;
function splitClause(s, firstMax) {
  CLAUSE.lastIndex = 0;
  let m;
  while ((m = CLAUSE.exec(s))) {
    const e = m.index + m[0].length;
    if (e < 20) continue;
    if (e > firstMax + 20 || s.length - e < 20) break;
    return [s.slice(0, e).trim(), s.slice(e).trim()];
  }
  return [s];
}

function cutLong(s, max) {
  const out = [];
  let rest = s;
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '), win.lastIndexOf(' – '), win.lastIndexOf(' — '));
    cut = cut > max / 3 ? cut + 1 : win.lastIndexOf(' ') > max / 3 ? win.lastIndexOf(' ') : max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
