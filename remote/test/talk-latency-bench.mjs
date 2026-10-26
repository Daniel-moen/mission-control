// Talk-mode voice lag, measured (task 0447): time from Mia's reply reaching
// the panel to the first audio, the gaps between pieces and the total, for a
// 3-sentence reply. Real relay, real Mac voice; playback is simulated by
// sleeping for each piece's real audio length (afinfo), so the numbers are
// what Daniel hears minus the device's own decode time.
//
//   node test/talk-latency-bench.mjs after               local relay + fake host with the warm worker (0447)
//   node test/talk-latency-bench.mjs after-cold          the same without the warm-up (first reply after 30 idle min)
//   SPOKEN_OLD=/tmp/spoken-main.mjs node test/talk-latency-bench.mjs before
//                                                        local relay + mia-tts per piece, main's ttsParts + schedule
//   RELAY=https://… RELAY_TOKEN=… SPOKEN_OLD=… node test/talk-latency-bench.mjs before
//                                                        the same against the live relay and Mac
//
// SPOKEN_OLD = main's remote/app/src/lib/spoken.js before 0447 (git show
// <rev>:remote/app/src/lib/spoken.js > /tmp/spoken-main.mjs). RUNS=n repeats.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { talkParts } from '../app/src/lib/spoken.js';
import { createSentenceQueue } from '../app/src/lib/sentenceQueue.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || 'after';
const RUNS = Number(process.env.RUNS) || 3;
const REPLY = [ // each run adds a word to every sentence so the relay's cache never answers
  'Task four forty seven is running now and should be done in about twenty minutes.',
  'I checked the relay logs and the voice service, and both look healthy.',
  'I will ping you the moment it is finished.',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-talkbench-'));
const procs = [];
let BASE = process.env.RELAY;
let TOKEN = process.env.RELAY_TOKEN;

async function bootLocal(ttsMode) {
  const PORT = 8941;
  BASE = `http://localhost:${PORT}`;
  TOKEN = 'test';
  const env = { ...process.env, MC_TOKEN: TOKEN, PORT: String(PORT), TTS_STORE: path.join(TMP, 'tts.json'), PUSH_STORE: path.join(TMP, 'push.json'), REALTIME_STORE: path.join(TMP, 'rt.json'), FAKE_HOST_TTS: ttsMode, OPENAI_API_KEY: '' };
  for (const [args, name] of [[['server.js'], 'relay'], [['test/fake-host.mjs'], 'host']]) {
    const p = spawn('node', args, { cwd: path.join(DIR, '..'), env, stdio: ['ignore', 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore'] });
    procs.push(p);
    if (name === 'relay') await sleep(800);
  }
  for (let i = 0; i < 60; i++) {
    const h = await fetch(`${BASE}/health`).then((r) => r.json(), () => null);
    if (h?.tts?.available) return;
    await sleep(250);
  }
  throw new Error('local relay/host did not come up');
}

async function fetchTts(text) {
  const r = await fetch(`${BASE}/tts`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!r.ok) return null;
  const f = path.join(TMP, `${Math.random().toString(36).slice(2)}.m4a`);
  fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
const durMs = (f) => Math.round(Number(/estimated duration: ([\d.]+)/.exec(execFileSync('afinfo', [f], { encoding: 'utf8' }))[1]) * 1000);
const playSim = async (f) => {
  await sleep(durMs(f));
  return true;
};

// main before 0447: ttsParts, piece i+1 asked for only once piece i is back.
async function before(text, ttsParts) {
  const t0 = Date.now();
  const parts = ttsParts(text);
  const audio = [];
  const want = (i) => (i < parts.length && !audio[i] ? (audio[i] = fetchTts(parts[i])) : audio[i]);
  const timing = { parts: parts.length, firstAudioMs: null, gapsMs: [], totalMs: null };
  let lastEnd = null;
  for (let i = 0; i < parts.length; i++) {
    const f = await want(i);
    want(i + 1);
    const at = Date.now() - t0;
    if (timing.firstAudioMs == null) timing.firstAudioMs = at;
    if (lastEnd != null) timing.gapsMs.push(at - lastEnd);
    if (f) await playSim(f);
    lastEnd = Date.now() - t0;
  }
  timing.totalMs = Date.now() - t0;
  return timing;
}

async function after(text) {
  const q = createSentenceQueue({ parts: talkParts(text), fetchAudio: fetchTts, play: playSim });
  await q.run();
  return q.timing;
}

async function main() {
  let ttsParts = null;
  if (mode === 'before') {
    if (!process.env.SPOKEN_OLD) throw new Error('set SPOKEN_OLD to main\'s spoken.js before 0447');
    ({ ttsParts } = await import(path.resolve(process.env.SPOKEN_OLD)));
  }
  if (!BASE) await bootLocal(mode === 'before' ? 'real' : 'worker');
  console.log(`mode ${mode} · relay ${BASE} · ${RUNS} runs`);
  const rows = [];
  for (let run = 1; run <= RUNS; run++) {
    const tag = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][run - 1] || String(run);
    const text = REPLY.map((s) => s.replace(/(running now|relay logs|it is finished)/, `$1 ${tag}`)).join(' ');
    if (mode === 'after') {
      // Talk mode open: the panel warmed the voice when it started listening.
      await fetch(`${BASE}/tts`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ warm: true }) });
      await sleep(4000);
    }
    if (mode === 'after-cold' && run > 1) {
      // Kill the worker between runs to measure the cold start every time.
      procs[1]?.kill();
      procs.pop();
      const p = spawn('node', ['test/fake-host.mjs'], { cwd: path.join(DIR, '..'), env: { ...process.env, MC_TOKEN: TOKEN, PORT: '8941', FAKE_HOST_TTS: 'worker' }, stdio: 'ignore' });
      procs.push(p);
      await sleep(2000);
    }
    const t = mode === 'before' ? await before(text, ttsParts) : await after(text);
    rows.push(t);
    console.log(`  run ${run}: ${t.parts} pieces · first audio ${t.firstAudioMs} ms · gaps [${t.gapsMs.join(', ')}] ms · total ${t.totalMs} ms`);
  }
  const med = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const maxGap = Math.max(0, ...rows.flatMap((r) => r.gapsMs));
  console.log(`median first audio ${med('firstAudioMs')} ms · median total ${med('totalMs')} ms · worst gap ${maxGap} ms`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of procs) p.kill();
    setTimeout(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }), 300);
  });
