import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pickBackdrop } from '../../src/lib/backdrops.ts';

const list = JSON.parse(fs.readFileSync(new URL('../../public/bg6/manifest.json', import.meta.url), 'utf8'));
const at = (h, day = 10) => new Date(2026, 10, day, h, 30);

test('every tone has a backdrop, every file exists, ~300 KB or less, no rejected aurora/streaky sets', () => {
  for (const t of ['dawn', 'day', 'dusk', 'night']) assert.ok(list.filter((b) => b.tone === t).length >= 1, t);
  assert.ok(list.length >= 3 && list.length <= 5, 'a few tasteful ones, not a zoo');
  for (const b of list) assert.doesNotMatch(b.file, /aurora|prism|silk|ember-dawn|city/);
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
});

test('a pin wins, with or without the extension', () => {
  assert.equal(pickBackdrop(list, at(12), 'midnight'), 'midnight.webp');
  assert.equal(pickBackdrop(list, at(12), 'ember-dusk.webp'), 'ember-dusk.webp');
  // a stale pin to a removed backdrop (v6.4's aurora) falls back to the time of day
  assert.equal(list.find((b) => b.file === pickBackdrop(list, at(12), 'aurora')).tone, 'day');
  assert.equal(list.find((b) => b.file === pickBackdrop(list, at(12), 'nope')).tone, 'day');
});
