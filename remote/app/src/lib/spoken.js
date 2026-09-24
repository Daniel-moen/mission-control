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
export function firstSentences(text, max = SPOKEN_MAX) {
  const t = speakable(text);
  if (t.length <= max) return { text: t, cut: false };
  const ends = [];
  const rx = /[.!?…]+["'”’)]*(?=\s+["'“‘(]?[A-Z0-9])/g;
  let m;
  while ((m = rx.exec(t))) {
    const e = m.index + m[0].length;
    if (!ABBREV.test(t.slice(Math.max(0, e - 8), e))) ends.push(e);
  }
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
