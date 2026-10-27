// Talk mode's sentence queue (app/src/lib/sentenceQueue.js, task 0447): Mia's
// reply spoken sentence by sentence — sentence 1 as soon as its audio is back,
// the rest made while it plays, in order, one at a time, stoppable.
// Fake audio with real timers (scaled down), no browser.
//
//   node test/sentence-queue-test.mjs

import { createSentenceQueue } from '../app/src/lib/sentenceQueue.js';

let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Mac + speaker. makeMs(text) = time to make the audio (requests are
// made one at a time, in the order asked, like the Mac's worker queue);
// playMs(text) = how long it plays. Records everything.
function rig({ makeMs = () => 40, playMs = () => 120, fail = () => false } = {}) {
  const log = [];
  const released = [];
  let macFree = 0;
  let playing = 0;
  let maxPlaying = 0;
  let cutPlay = null;
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  return {
    log, released,
    get maxPlaying() { return maxPlaying; },
    fetchAudio: (text, i) => {
      log.push(['ask', i, at()]);
      const start = Math.max(at(), macFree);
      macFree = start + makeMs(text);
      return sleep(macFree - at()).then(() => (fail(text, i) ? null : `blob:${i}`));
    },
    play: (url) => new Promise((resolve) => {
      playing += 1;
      maxPlaying = Math.max(maxPlaying, playing);
      log.push(['play', url, at()]);
      const t = setTimeout(() => { playing -= 1; cutPlay = null; log.push(['ended', url, at()]); resolve(true); }, playMs(url));
      cutPlay = () => { clearTimeout(t); playing -= 1; cutPlay = null; log.push(['cut', url, at()]); resolve(true); };
    }),
    cut: () => cutPlay?.(),
    release: (u) => released.push(u),
  };
}

console.log('three sentences, Mac faster than speech');
{
  const r = rig({ makeMs: () => 40, playMs: () => 150 });
  const q = createSentenceQueue({ parts: ['One.', 'Two two.', 'Three three three.'], ...r, fallback: async () => { throw new Error('no fallback expected'); } });
  const done = await q.run();
  const plays = r.log.filter((e) => e[0] === 'play').map((e) => e[1]);
  ok(done === true, 'finishes → true');
  ok(JSON.stringify(plays) === JSON.stringify(['blob:0', 'blob:1', 'blob:2']), 'played in order');
  ok(r.maxPlaying === 1, 'never two at once');
  const asks = r.log.filter((e) => e[0] === 'ask');
  ok(asks.length === 3 && asks.every((e) => e[2] < 10), 'all three asked for at once (sentence 2+ made while 1 plays)');
  ok(q.timing.firstAudioMs >= 35 && q.timing.firstAudioMs < 90, `first audio as soon as sentence 1 is made (${q.timing.firstAudioMs} ms), not after the whole reply`);
  ok(q.timing.gapsMs.length === 2 && q.timing.gapsMs.every((g) => g < 15), `back to back, no waiting between sentences (gaps ${q.timing.gapsMs.join(', ')} ms)`);
  ok(r.released.length === 0, 'nothing released (all played)');
}

console.log('lookahead caps how far ahead it asks');
{
  const r = rig({ makeMs: () => 10, playMs: () => 60 });
  const q = createSentenceQueue({ parts: ['a.', 'b.', 'c.', 'd.', 'e.'], ...r, lookahead: 2 });
  const p = q.run();
  await sleep(5);
  ok(r.log.filter((e) => e[0] === 'ask').length === 2, 'only 2 asked for up front');
  await p;
  ok(r.log.filter((e) => e[0] === 'ask').length === 5 && r.log.filter((e) => e[0] === 'play').length === 5, 'all 5 asked and played in the end');
}

console.log('a piece the Mac can\'t make is read by the device voice, in its place');
{
  const r = rig({ fail: (_t, i) => i === 1 });
  const said = [];
  const q = createSentenceQueue({ parts: ['One.', 'Two.', 'Three.'], ...r, fallback: async (t) => { r.log.push(['device', t]); said.push(t); return true; } });
  await q.run();
  const order = r.log.filter((e) => e[0] === 'play' || e[0] === 'device').map((e) => e[1]);
  ok(JSON.stringify(order) === JSON.stringify(['blob:0', 'Two.', 'blob:2']), `order kept: ${order.join(' → ')}`);
}

console.log('a rejecting fetch and a play that can\'t start fall back too');
{
  const r = rig();
  const said = [];
  const q = createSentenceQueue({
    parts: ['One.', 'Two.'],
    fetchAudio: (t, i) => (i === 0 ? Promise.reject(new Error('net')) : r.fetchAudio(t, i)),
    play: async () => false,
    fallback: async (t) => { said.push(t); return true; },
  });
  ok((await q.run()) === true && JSON.stringify(said) === JSON.stringify(['One.', 'Two.']), 'device voice reads both');
}

console.log('stop() — Daniel talks or taps');
{
  const r = rig({ makeMs: () => 30, playMs: () => 200 });
  const q = createSentenceQueue({ parts: ['One.', 'Two.', 'Three.', 'Four.'], ...r, lookahead: 4 });
  const p = q.run();
  await sleep(120); // sentence 1 playing, 2–4 made or being made
  q.stop();
  const res = await p;
  await sleep(150); // let the late ones arrive
  ok(res === false, 'run() → false');
  ok(r.log.some((e) => e[0] === 'cut' && e[1] === 'blob:0'), 'the sentence playing is cut at once');
  ok(r.log.filter((e) => e[0] === 'play').length === 1, 'nothing else starts');
  ok(JSON.stringify([...r.released].sort()) === JSON.stringify(['blob:1', 'blob:2', 'blob:3']), `unplayed audio released (${r.released.join(', ')})`);
  q.stop();
  ok(true, 'a second stop() is harmless');
}

console.log('stop() before the first sentence is back');
{
  const r = rig({ makeMs: () => 80 });
  const q = createSentenceQueue({ parts: ['One.', 'Two.'], ...r });
  const p = q.run();
  await sleep(20);
  q.stop();
  ok((await p) === false && r.log.filter((e) => e[0] === 'play').length === 0, 'nothing plays');
  await sleep(200);
  ok(r.released.length === 2, 'both late arrivals released');
}

console.log('no parts');
{
  const q = createSentenceQueue({ parts: [], fetchAudio: () => null, play: async () => true });
  ok((await q.run()) === true && q.timing.firstAudioMs === null, 'nothing to say → true at once');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
