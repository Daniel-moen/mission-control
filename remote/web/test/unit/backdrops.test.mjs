import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pickBackdrop } from '../../src/lib/backdrops.ts';

const list = JSON.parse(fs.readFileSync(new URL('../../public/bg6/manifest.json', import.meta.url), 'utf8'));
const at = (h, day = 10) => new Date(2026, 10, day, h, 30);

test('every tone has at least two backdrops and every file exists, ~300 KB or less', () => {
  for (const t of ['dawn', 'day', 'dusk', 'night']) assert.ok(list.filter((b) => b.tone === t).length >= 2, t);
  for (const b of list) {
    const st = fs.statSync(new URL(`../../public/bg6/${b.file}`, import.meta.url));
    assert.ok(st.size < 330 * 1024, `${b.file} ${st.size}`);
  }
});

test('time of day picks the tone, the date rotates within it', () => {
  const tone = (h) => list.find((b) => b.file === pickBackdrop(list, at(h))).tone;
  assert.equal(tone(6), 'dawn');
  assert.equal(tone(12), 'day');
  assert.equal(tone(18), 'dusk');
  assert.equal(tone(23), 'night');
  assert.equal(tone(2), 'night');
  assert.notEqual(pickBackdrop(list, at(23, 10)), pickBackdrop(list, at(23, 11)));
});

test('a pin wins, with or without the extension', () => {
  assert.equal(pickBackdrop(list, at(12), 'aurora'), 'aurora.webp');
  assert.equal(pickBackdrop(list, at(12), 'city-night.webp'), 'city-night.webp');
  assert.equal(list.find((b) => b.file === pickBackdrop(list, at(12), 'nope')).tone, 'day');
});
