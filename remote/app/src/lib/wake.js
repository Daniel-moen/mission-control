// "Hey Mia" — the on-device wake word.
//
// Runs entirely in the browser: vosk-browser (Kaldi compiled to WASM, in its
// own Web Worker) with the small English model the relay serves once from
// /wake/model.tar.gz and the browser then caches. The recogniser is limited to
// a small grammar — the wake phrase plus common words that give near misses
// ("hey man", "hey Maya", "hey, me a…") somewhere better to land — so it's
// cheap, and an energy gate only feeds it while someone is actually talking,
// so a quiet room costs next to nothing. No audio leaves the device, and the
// OpenAI key is never involved: the realtime voice only starts after a hit.
//
// iOS rules: the mic can only be opened from a tap (the "Hey Mia" toggle),
// and listening only lasts while the app is open in the foreground with the
// screen on. Coming back from the background may need another tap
// (status 'interrupted').
//
// The wake listener owns the mic while it's on and *lends* it to talk mode
// (voice.js takePrimed → lend), because a second getUserMedia on iOS mutes
// the first stream. Talk hands it back with release(); listening resumes.

import { useSyncExternalStore } from 'react';
import { talkSupported, newAudioContext, getMic, blessedAudio, playAndRecord, unlockSpeech, setMediaLender } from './voice.js';

export const wakeSupported = talkSupported && typeof WebAssembly === 'object' && typeof Worker === 'function';

const MODEL_URL = '/wake/model.tar.gz';
const RATE = 16000;
const PHRASE = /\bhey mia\b/;
const COOLDOWN_MS = 4000;
// Competing words for the grammar: frequent English words, plus the usual
// sound-alikes of "Mia", so only a real "hey Mia" decodes as the phrase.
const DECOYS = `the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were am been has had did said okay yes yeah hi hello hey man guys there mister buddy mike mary nina leah maya maybe meet meeting media mama mamma mean mine milk mind miss`.split(' ');
export const GRAMMAR = JSON.stringify(['hey mia', ...new Set(DECOYS), '[unk]']);

const LS = 'mc.wake.on';

// ---- tiny store ----------------------------------------------------------------
let state = { on: false, status: 'off', error: '', wanted: readWanted() };
const subs = new Set();
function set(patch) {
  state = { ...state, ...patch };
  subs.forEach((fn) => fn());
}
export function useWake() {
  return useSyncExternalStore(
    (fn) => (subs.add(fn), () => subs.delete(fn)),
    () => state,
  );
}
export const getWake = () => state;

function readWanted() {
  try {
    return localStorage.getItem(LS) === '1';
  } catch {
    return false;
  }
}
function writeWanted(v) {
  try {
    localStorage.setItem(LS, v ? '1' : '0');
  } catch {}
}

// ---- wake events -----------------------------------------------------------------
const listeners = new Set();
export function onWake(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
// Set by a hit, read once by whoever opens talk mode for it (so the voice can
// greet instead of waiting in silence).
let pendingWake = 0;
export const wakePending = () => !!pendingWake && Date.now() - pendingWake < 15000;
export function consumeWake() {
  const fresh = pendingWake && Date.now() - pendingWake < 15000;
  pendingWake = 0;
  return !!fresh;
}

// ---- engine --------------------------------------------------------------------
let media = null; // { ctx, stream, audio }
let model = null;
let modelLoading = null;
let rec = null;
let node = null;
let src = null;
let lent = false;
let lastFire = 0;

function loadModel() {
  if (model) return Promise.resolve(model);
  if (!modelLoading) {
    modelLoading = import('vosk-browser')
      .then((m) => (m.createModel || m.default?.createModel)(MODEL_URL, -1))
      .then((m) => (model = m))
      .catch((e) => {
        modelLoading = null;
        throw e;
      });
  }
  return modelLoading;
}

function newRecognizer() {
  try {
    rec?.remove();
  } catch {}
  rec = new model.KaldiRecognizer(RATE, GRAMMAR);
  const check = (text) => {
    if (!text || lent || !state.on || !PHRASE.test(text)) return;
    if (Date.now() - lastFire < COOLDOWN_MS) return;
    lastFire = Date.now();
    pendingWake = Date.now();
    // Start the next listen from a clean slate.
    newRecognizer();
    listeners.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    });
  };
  rec.on('partialresult', (m) => check(m.result?.partial));
  rec.on('result', (m) => check(m.result?.text));
}

const TAP = `
class WakeTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('mc-wake-tap', WakeTap);
`;

// Energy gate: only feed the recogniser around speech. Pre-roll keeps the
// onset of "hey"; the hangover lets the recogniser see the phrase end.
function makeGate(inRate) {
  const ratio = inRate / RATE;
  let floor = 0;
  let warm = 0;
  let openUntil = 0;
  const pre = [];
  let preLen = 0;
  const down = (f) => {
    const n = Math.floor(f.length / ratio);
    const out = new Float32Array(n);
    for (let o = 0; o < n; o++) {
      const a = Math.floor(o * ratio);
      const b = Math.max(a + 1, Math.floor((o + 1) * ratio));
      let s = 0;
      for (let i = a; i < b && i < f.length; i++) s += f[i];
      out[o] = s / (b - a);
    }
    return out;
  };
  return (f32) => {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);
    const now = performance.now();
    if (warm < 8) {
      floor = floor ? floor * 0.7 + rms * 0.3 : rms;
      warm += 1;
      return;
    }
    const voiced = rms > Math.max(0.006, floor * 3);
    if (!voiced && now > openUntil) floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.995 + rms * 0.005;
    floor = Math.max(floor, 0.0005);
    const chunk = down(f32);
    if (voiced) {
      if (now > openUntil) {
        // Gate opening: send the pre-roll first.
        for (const p of pre) rec?.acceptWaveformFloat(p, RATE);
      }
      pre.length = 0;
      preLen = 0;
      openUntil = now + 1200;
    }
    if (now <= openUntil) rec?.acceptWaveformFloat(chunk, RATE);
    else {
      pre.push(chunk);
      preLen += chunk.length;
      while (preLen > RATE * 0.5 && pre.length > 1) preLen -= pre.shift().length;
    }
  };
}

async function attach() {
  const { ctx, stream } = media;
  src = ctx.createMediaStreamSource(stream);
  const gate = makeGate(ctx.sampleRate);
  const feed = (f) => {
    if (!lent && state.on && rec) gate(f);
  };
  try {
    if (!ctx.audioWorklet) throw new Error('no worklet');
    const url = URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    node = new AudioWorkletNode(ctx, 'mc-wake-tap');
    node.port.onmessage = (e) => feed(e.data);
  } catch {
    node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => feed(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  ctx.addEventListener?.('statechange', health);
  stream.getAudioTracks()[0]?.addEventListener('ended', health);
}

function detach() {
  try {
    src?.disconnect();
    node?.disconnect();
  } catch {}
  src = null;
  node = null;
}

function health() {
  if (!state.on || !media) return;
  const live = media.ctx.state === 'running' && media.stream.getAudioTracks()[0]?.readyState === 'live';
  if (!live && state.status === 'listening') set({ status: 'interrupted' });
  else if (live && state.status === 'interrupted') set({ status: lent ? 'lent' : 'listening' });
}

// Turn the wake word on. Call from a tap: it opens the mic.
export function enableWake() {
  if (!wakeSupported) return;
  unlockSpeech();
  playAndRecord();
  writeWanted(true);
  if (state.on && media) return resumeWake();
  const ctx = newAudioContext();
  ctx.resume().catch(() => {});
  const streamP = getMic();
  const audio = blessedAudio();
  set({ on: true, status: 'loading', error: '', wanted: true });
  (async () => {
    try {
      const [stream] = await Promise.all([streamP, loadModel()]);
      if (!state.on) {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        return;
      }
      media = { ctx, stream, audio };
      newRecognizer();
      await attach();
      lent = false;
      set({ status: 'listening' });
    } catch (e) {
      streamP.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      ctx.close().catch(() => {});
      media = null;
      const n = e?.name || '';
      set({
        on: false,
        status: 'error',
        error: n === 'NotAllowedError' ? 'Microphone access is blocked.' : /fetch|404|model/i.test(String(e?.message)) ? 'Couldn’t load the wake word model.' : e?.message || 'Wake word failed to start.',
      });
    }
  })();
}

// Back from the background (iOS may have suspended the audio). From a tap.
export async function resumeWake() {
  if (!state.on || !media) return enableWake();
  await media.ctx.resume().catch(() => {});
  if (media.stream.getAudioTracks()[0]?.readyState !== 'live') {
    // The track is gone for good: start over (we're inside a tap).
    disableWake({ keepWanted: true });
    return enableWake();
  }
  set({ status: lent ? 'lent' : 'listening' });
}

export function disableWake({ keepWanted = false } = {}) {
  if (!keepWanted) writeWanted(false);
  detach();
  try {
    rec?.remove();
  } catch {}
  rec = null;
  if (media && !lent) {
    media.stream.getTracks().forEach((t) => t.stop());
    media.ctx.close().catch(() => {});
  }
  // If talk mode is borrowing the mic, it keeps it until it's done; release()
  // then finds the wake word off and closes it.
  if (!lent) media = null;
  set({ on: false, status: 'off', error: '', wanted: keepWanted ? state.wanted : false });
}

// Talk mode borrows the mic (voice.js takePrimed). Only while listening.
function lend() {
  if (!state.on || !media || lent) return null;
  lent = true;
  set({ status: 'lent' });
  const m = media;
  let done = false;
  return {
    ctx: m.ctx,
    stream: m.stream,
    audio: m.audio,
    borrowed: true,
    release() {
      if (done) return;
      done = true;
      lent = false;
      m.stream.getAudioTracks().forEach((t) => (t.enabled = true));
      if (m.audio) m.audio.srcObject = null;
      if (!state.on || media !== m) {
        m.stream.getTracks().forEach((t) => t.stop());
        m.ctx.close().catch(() => {});
        if (media === m) media = null;
        return;
      }
      if (model) newRecognizer();
      set({ status: m.ctx.state === 'running' ? 'listening' : 'interrupted' });
    },
  };
}
setMediaLender(lend);

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(health, 300);
  });
}
