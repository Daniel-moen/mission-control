// Short-spoken announcements (app/src/lib/spoken.js): what "Speak Mia's
// updates" actually says for a long or markdown-heavy message.
//
//   node test/spoken-test.mjs

import { speakable, firstSentences, SPOKEN_MAX } from '../app/src/lib/spoken.js';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
