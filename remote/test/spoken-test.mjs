// Short-spoken announcements (app/src/lib/spoken.js): what "Speak Mia's
// updates" actually says for a long or markdown-heavy message.
//
//   node test/spoken-test.mjs

import { speakable, firstSentences, SPOKEN_MAX, talkParts, TALK_PIECE_MAX } from '../app/src/lib/spoken.js';

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};

console.log('speakable');
ok(speakable('**Done.** See [the report](https://x.y/z) and `mia uploads`.') === 'Done. See the report and mia uploads.', 'bold, links and code marks are dropped');
ok(speakable('Details at https://example.com/a?b=1 now') === 'Details at a link now', 'a bare URL is read as "a link"');
ok(speakable('## Summary\n- one\n- two\n\n1. three') === 'Summary. one. two. three', 'headings and list markers go; lines become sentences');
ok(speakable('Before:\n```js\nconst x = 1;\n```\nAfter.') === 'Before: After.', 'code blocks are skipped');
ok(speakable('Saved report_v2.pdf in snake_case_dir') === 'Saved report_v2.pdf in snake_case_dir', 'underscores in names survive');

console.log('firstSentences');
const short = 'Task 27 is done. Want the report?';
ok(JSON.stringify(firstSentences(short)) === JSON.stringify({ text: short, cut: false }), 'a short message is read whole');
const report = 'Morning brief: three meetings today, the first at 9:30 with Acme about the Q3 renewal. ' +
  'Mail: two need you — the invoice from Northwind and a contract question from legal. ' +
  'Executors finished tasks 24 and 25 overnight. Reminders: call the dentist. I suggest you start with the invoice.';
const r = firstSentences(report);
ok(r.cut && r.text === 'Morning brief: three meetings today, the first at 9:30 with Acme about the Q3 renewal.', `a long report → its first sentence (${r.text.length} chars)`);
const tiny = 'Done. ' + 'The migration ran across all four services and every check passed, including the slow integration suite that used to flake. '.repeat(3);
const t = firstSentences(tiny);
ok(t.cut && t.text.startsWith('Done. The migration ran') && t.text.length <= SPOKEN_MAX, 'a few-word first sentence takes the next one along');
const run = 'I looked at ' + Array.from({ length: 40 }, (_, i) => `item ${i}`).join(', ') + ' and all of it is fine';
const u = firstSentences(run);
ok(u.cut && u.text.endsWith('…') && u.text.length <= SPOKEN_MAX + 1 && !/,…$/.test(u.text), 'one endless sentence is cut on a word boundary with …');
const eg = 'Pick a model, e.g. Fable 5.1 or Opus 5.5, in the top corner of the Mia view. ' + 'x '.repeat(120);
ok(firstSentences(eg).text.startsWith('Pick a model, e.g. Fable 5.1 or Opus 5.5, in the top corner'), '"e.g." and version numbers don\'t end a sentence');

console.log('talkParts (talk mode, sentence by sentence, task 0447)');
{
  const three = 'Task 447 is running now and should be done in about twenty minutes. I checked the relay logs, e.g. the tts ones, and v2.1 looks fine. I will ping you when it is finished.';
  const p = talkParts(three);
  ok(p.length === 4 && p[0] === 'Task 447 is running now' && p[1] === 'and should be done in about twenty minutes.', `a long first sentence is split at its first clause so the first sound comes fast (${JSON.stringify(p.slice(0, 2))})`);
  ok(p[2] === 'I checked the relay logs, e.g. the tts ones, and v2.1 looks fine.', '"e.g." and "v2.1" don\'t end a sentence; later sentences stay whole');
  ok(JSON.stringify(talkParts('Your build finished and every check passed on the first run. More.')) === JSON.stringify(['Your build finished and every check passed on the first run.', 'More.']), 'a first sentence up to 60 characters stays whole');
  ok(talkParts(`${'x'.repeat(70)} today. Next one here.`)[0] === `${'x'.repeat(70)} today.`, 'no clause break → the first sentence stays whole');
  ok(JSON.stringify(talkParts('Sure. Task 447 is running now and should be done soon.')) === JSON.stringify(['Sure. Task 447 is running now and should be done soon.']), 'a tiny sentence is joined to the next (no half-second piece then a wait)');
  const long = 'Your build finished and every check passed on the first run. ' + 'I filed the three reports in the Library and flagged the one that needs you. '.repeat(8);
  const q = talkParts(long);
  ok(q.length === 9 && q.every((x) => x.length <= TALK_PIECE_MAX), `one piece per sentence (${q.length})`);
  ok(q.join(' ') === speakable(long), 'nothing dropped or repeated');
  const run = `We looked at ${'the relay, the panel, the Mac app, '.repeat(12)}and nothing else.`;
  const r = talkParts(run);
  ok(r.length > 1 && r.every((x) => x.length <= TALK_PIECE_MAX) && r.join(' ') === speakable(run), `one very long sentence is cut at commas (${r.map((x) => x.length).join(', ')})`);
  ok(JSON.stringify(talkParts('**Done.** See [the report](https://x.y/z).')) === JSON.stringify(['Done. See the report.']), 'markdown stripped, short reply is one piece');
  ok(talkParts('').length === 0, 'nothing to say → no pieces');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
