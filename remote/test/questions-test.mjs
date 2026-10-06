// Mia's open questions: dismiss, expire, the "old" age — unit checks for the
// server-side rules (docs/mia.md §8.4).
//
//   node test/questions-test.mjs
//
// 1. Builds Sources/AgentWidget/MiaQuestions.swift with a small harness
//    (test/mac-questions/main.swift) and runs its checks — the rules the Mac
//    app applies to the snapshot and to the panel's miaDismiss.
// 2. Drives the REAL `mia` CLI (scripts/mia) against a temp MIA_DIR:
//    `mia question list|dismiss|expire|max-age` and `mia status [--all]`.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const MIA_CLI = path.join(ROOT, 'scripts', 'mia');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-questions-'));
const MIA_DIR = path.join(TMP, 'mia');

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};

// ---- 1. Swift rules ---------------------------------------------------------
console.log('MiaQuestions.swift');
const bin = path.join(TMP, 'questions-harness');
execFileSync('swiftc', [path.join(ROOT, 'Sources/AgentWidget/MiaQuestions.swift'), path.join(DIR, 'mac-questions/main.swift'), '-o', bin], { stdio: 'inherit' });
const sw = spawnSync(bin, { encoding: 'utf8' });
process.stdout.write(sw.stdout);
const swPass = (sw.stdout.match(/✓/g) || []).length;
const swFail = (sw.stdout.match(/✗/g) || []).length;
passed += swPass;
failed += swFail + (sw.status === 0 ? 0 : swFail ? 0 : 1);

// ---- 2. The CLI -------------------------------------------------------------
console.log('mia question / mia status');
const mia = (...args) => {
  const r = spawnSync('bash', [MIA_CLI, ...args], { env: { ...process.env, MIA_DIR }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const iso = (hAgo) => new Date(Date.now() - hAgo * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
fs.mkdirSync(path.join(MIA_DIR, 'tasks'), { recursive: true });
const q = (id, h, extra = {}) => ({ id: `m_${id}`, at: iso(h), from: 'mia', kind: 'question', text: `Question ${id}?`, options: [], questionId: `q_${id}`, ...extra });
const lines = [
  q(1, 300, { taskId: '0007' }), q(2, 100), q(3, 60), q(4, 30), q(5, 2),
  { id: 'm_6', at: iso(1), from: 'daniel', kind: 'answer', questionId: 'q_4', text: 'yes' },
];
fs.writeFileSync(path.join(MIA_DIR, 'messages.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(path.join(MIA_DIR, 'tasks', '0007.json'), JSON.stringify({
  id: '0007', title: 'T', status: 'asking', priority: 3, log: [],
  questions: [{ id: 'q_1', text: 'Question 1?', options: [], askedAt: iso(300), answer: null, answeredAt: null }],
}));
const qfile = () => JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'questions.json'), 'utf8'));
const task7 = () => JSON.parse(fs.readFileSync(path.join(MIA_DIR, 'tasks', '0007.json'), 'utf8'));

let r = mia('question', 'max-age');
ok(r.out.trim() === '2d', 'default max age is 48 h (prints 2d)');
r = mia('status');
ok(/Open questions: 1\n/.test(r.out) && r.out.includes('q_5') && !r.out.includes('q_3'), 'mia status lists only questions under 48 h');
ok(/\+3 older than 2d hidden/.test(r.out), 'mia status says how many old ones are hidden');
r = mia('status', '--all');
ok(/Open questions: 4\n/.test(r.out) && r.out.includes('q_1') && /q_3.*\[old\]/.test(r.out), 'mia status --all shows old ones, tagged [old]');
ok(!r.out.includes('q_4 '), 'answered questions never show');
r = mia('question', 'list', '--json', '--all');
const js = JSON.parse(r.out);
ok(js.length === 4 && js.find((x) => x.id === 'q_1').old === true && js.find((x) => x.id === 'q_5').old === false, 'question list --json --all marks old');

r = mia('question', 'dismiss', 'q_2', 'q_4', 'q_nope');
ok(r.code === 0 && /q_2\tdismissed/.test(r.out) && /q_4\tnot open/.test(r.out) && /q_nope\tnot open/.test(r.out), 'dismiss closes open ids, skips answered/unknown');
ok(qfile().closed.q_2?.state === 'dismissed' && qfile().closed.q_2?.by === 'mia', 'questions.json records the dismissal');
ok(fs.readFileSync(path.join(MIA_DIR, 'messages.jsonl'), 'utf8').includes('"q_2"'), 'the question itself stays in the history');
r = mia('question', 'dismiss', 'q_2');
ok(r.code === 1, 'dismissing a closed question exits 1');

r = mia('question', 'expire', '--older-than', '3d', '--dry-run');
ok(/would expire 1 question\b/.test(r.out) && !qfile().closed.q_1, '--dry-run changes nothing');
r = mia('question', 'expire', '--older-than', '3d');
ok(/expired 1 question older than 3d: q_1/.test(r.out) && qfile().closed.q_1?.state === 'expired', 'expire --older-than 3d closes the 300 h one');
const t = task7();
ok(t.questions[0].expiredAt && t.status === 'queued', 'the task record is marked and leaves "asking"');
ok(t.log.some((l) => /Expired question q_1/.test(l.text)), 'the task log notes it');
r = mia('question', 'expire');
ok(/expired 1 question older than 2d: q_3/.test(r.out), 'expire with no flag uses the max age (48 h)');
r = mia('question', 'list', '--all');
ok(r.out.trim().startsWith('q_5') || /^\s*q_5/.test(r.out), 'only the fresh question is left open');

r = mia('question', 'max-age', '12h');
ok(r.code === 0 && qfile().maxAgeHours === 12 && mia('question', 'max-age').out.trim() === '12h', 'max-age 12h is saved');
r = mia('question', 'max-age', 'never');
ok(qfile().maxAgeHours === 0 && /never hidden/.test(r.out), 'max-age never turns hiding off');
r = mia('question', 'max-age', 'soon');
ok(r.code !== 0 && /bad duration/.test(r.err), 'a bad duration is refused');
mia('question', 'max-age', '48h');
r = mia('question', 'expire', '--older-than', '0');
ok(r.code !== 0, 'expire --older-than 0 is refused');
r = mia('help');
ok(r.out.includes('mia question dismiss') && r.out.includes('mia question expire'), 'help documents the new commands');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
