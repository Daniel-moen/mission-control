// Talk mode's audio plumbing: an always-open mic with end-of-speech detection
// (so there's no hold-to-talk), WAV encoding for the relay's /stt, and a
// speechSynthesis wrapper that reads Mia's replies aloud.
//
// Why not the Web Speech API (lib/speech.js)? On iPad in standalone Home Screen
// mode SpeechRecognition is missing or dies silently. getUserMedia + Web Audio
// work there, so we listen ourselves and let the relay transcribe (stt.js).
//
// iOS rules this file is built around:
// - AudioContext, getUserMedia and the first speechSynthesis.speak must all
//   start inside the tap that opens talk mode (openMic + unlockSpeech).
// - The mic stays open for the whole conversation. Re-asking getUserMedia per
//   turn can re-prompt in a Home Screen app, and the open stream also keeps the
//   audio session in play-and-record so replies play without a new gesture.
// - While Mia speaks, the same stream listens for barge-in at a raised
//   threshold, because the speaker's own echo reaches the mic.

const TARGET_RATE = 16000;
const PREROLL_MS = 700; // audio kept from before speech was detected
const PREROLL_GUARD_MS = 1300; // …and while Mia speaks, where the onset test is slower
const MIN_SPEECH_MS = 350; // shorter bursts (a cough, a door) are dropped
const MAX_UTTERANCE_MS = 60000;

export const PAUSES = { short: 700, normal: 1100, long: 1800 }; // silence that ends a turn

export const talkSupported =
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof window !== 'undefined' &&
  !!(window.AudioContext || window.webkitAudioContext);

export const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

// ---- mic + VAD ---------------------------------------------------------------

export const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
};
export const getMic = () => navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
export const newAudioContext = () => new (window.AudioContext || window.webkitAudioContext)();

// Safari 17+: tell iOS we both play and record, so speech output isn't ducked
// to the earpiece-level volume a capture-only session gets.
export function playAndRecord(on = true) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = on ? 'play-and-record' : 'auto';
  } catch {}
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('mc-tap', Tap);
`;

// Open the mic and start listening. Call from inside a user gesture.
//   onLevel(0..1)            ~20×/s, for the meter
//   onSpeechStart()          the user started talking (also fires on barge-in)
//   onUtterance(wavBlob, ms) the user finished a turn
//   onState('running'|'interrupted')  the audio session was suspended (app
//                            switched, call came in) or came back
// Returns a controller: { setMode('listen'|'guard'|'mute'), setPause(ms),
// resume(), close() }. 'guard' = listen for barge-in only (Mia is speaking).
// `media` = { ctx, stream } already opened inside the tap (primeTalk, or the
// realtime view handing over after a failure); the controller then owns them.
export async function openMic(handlers = {}, media = {}) {
  let h = handlers;
  const onLevel = (l) => h.onLevel && h.onLevel(l);
  const onSpeechStart = () => h.onSpeechStart && h.onSpeechStart();
  const onUtterance = (wav, ms) => h.onUtterance && h.onUtterance(wav, ms);
  const onState = (st) => h.onState && h.onState(st);
  const pauseMs = handlers.pauseMs || PAUSES.normal;
  playAndRecord();
  const borrowed = !!media.borrowed && !!media.stream;
  const ctx = media.ctx && media.ctx.state !== 'closed' ? media.ctx : newAudioContext();
  // Kick the context while we're still inside the gesture, before any await.
  const resumed = ctx.resume().catch(() => {});

  let stream;
  try {
    stream = await (media.stream || getMic());
  } catch (e) {
    if (borrowed) media.release?.();
    else ctx.close().catch(() => {});
    throw e;
  }
  await resumed;

  const src = ctx.createMediaStreamSource(stream);
  const rate = ctx.sampleRate;
  let node = null;
  let sink = null;

  // ---- detector state ----
  let mode = 'listen';
  let pause = pauseMs;
  let floor = 0; // running noise floor (RMS)
  let calibrated = 0; // ms of audio seen, for the floor's warm-up
  let speaking = false;
  let voicedMs = 0; // voiced time inside the current candidate onset
  let silentMs = 0;
  let uttMs = 0;
  let pre = []; // pre-roll chunks
  let preMs = 0;
  let rec = []; // chunks of the current utterance
  let lastLevel = 0;

  function reset() {
    speaking = false;
    voicedMs = 0;
    silentMs = 0;
    uttMs = 0;
    rec = [];
  }

  function chunk(f32) {
    if (mode === 'mute') return;
    const ms = (f32.length / rate) * 1000;
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);

    // Meter: a log-ish 0..1 for display.
    const now = performance.now();
    if (now - lastLevel > 45) {
      lastLevel = now;
      onLevel(Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-6) + 60) / 50)));
    }

    // Warm up the noise floor on the first ~300ms, then track it slowly —
    // only while nobody is talking, so a long sentence doesn't raise it.
    if (calibrated < 300) {
      floor = floor ? floor * 0.8 + rms * 0.2 : rms;
      calibrated += ms;
      return;
    }
    if (!speaking) floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.995 + rms * 0.005;
    floor = Math.max(floor, 0.0008);

    // Onset needs ~+10 dB over the floor; while Mia talks, ~+18 dB and longer,
    // so her own voice through the speaker doesn't count as Daniel.
    const guard = mode === 'guard';
    const onsetThr = Math.max(guard ? 0.04 : 0.012, floor * (guard ? 8 : 3.2));
    const holdThr = Math.max(0.008, floor * 2);
    const onsetNeed = guard ? 300 : 160;

    if (!speaking) {
      pre.push(f32);
      preMs += ms;
      while (preMs > (mode === 'guard' ? PREROLL_GUARD_MS : PREROLL_MS) && pre.length > 1) preMs -= (pre.shift().length / rate) * 1000;
      if (rms > onsetThr) voicedMs += ms;
      else voicedMs = Math.max(0, voicedMs - ms * 0.5);
      if (voicedMs >= onsetNeed) {
        speaking = true;
        silentMs = 0;
        uttMs = preMs;
        rec = pre;
        pre = [];
        preMs = 0;
        if (guard) mode = 'listen'; // barge-in: from here on it's a normal turn
        onSpeechStart();
      }
      return;
    }

    rec.push(f32);
    uttMs += ms;
    if (rms > holdThr) silentMs = 0;
    else silentMs += ms;
    if (silentMs >= pause || uttMs >= MAX_UTTERANCE_MS) {
      const took = rec;
      const dur = uttMs - silentMs;
      reset();
      if (dur >= MIN_SPEECH_MS) onUtterance(encodeWav(took, rate), dur);
    }
  }

  try {
    if (!ctx.audioWorklet) throw new Error('no worklet');
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    node = new AudioWorkletNode(ctx, 'mc-tap');
    node.port.onmessage = (e) => chunk(e.data);
  } catch {
    // Older Safari: the deprecated ScriptProcessor still works everywhere.
    node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => chunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  // A silent sink keeps the graph pulling on every browser without echoing
  // the mic to the speaker.
  sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);

  const onCtx = () => onState(ctx.state === 'running' ? 'running' : 'interrupted');
  ctx.addEventListener?.('statechange', onCtx);
  const track = stream.getAudioTracks()[0];
  const onEnded = () => onState('interrupted');
  track?.addEventListener('ended', onEnded);

  return {
    // Swap in the real callbacks once the view that owns the session mounts.
    setHandlers(next) {
      h = next || {};
      if (h.pauseMs) pause = h.pauseMs;
    },
    get alive() {
      return ctx.state === 'running' && track?.readyState === 'live';
    },
    setMode(m) {
      if (m === mode) return;
      // Leaving 'mute' or dropping into it abandons any half-heard turn.
      if (m === 'mute' || mode === 'mute') reset();
      mode = m;
    },
    setPause(ms) {
      pause = ms;
    },
    // After an interruption: must be called from a tap.
    async resume() {
      await ctx.resume().catch(() => {});
      return ctx.state === 'running' && track?.readyState === 'live';
    },
    close() {
      ctx.removeEventListener?.('statechange', onCtx);
      track?.removeEventListener('ended', onEnded);
      try {
        src.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {}
      if (borrowed) return media.release?.();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      playAndRecord(false);
    },
  };
}

// The tap that opens talk mode lives in the Mia header, but the session is
// owned by the Talk view that mounts a moment later — after the gesture has
// ended. So the tap does all the gesture-bound work here and Talk adopts it:
// speech unlock, an AudioContext, ONE mic request (a second getUserMedia on
// iOS mutes the first stream's track), and an <audio> element blessed by a
// play() inside the tap, which the realtime view later points at OpenAI's
// WebRTC audio. Either engine (realtime or basic) can take the same media.
let primed = null;
// The wake word (wake.js), while on, owns the mic and lends it instead.
let lender = null;
export function setMediaLender(fn) {
  lender = fn;
}
export function primeTalk() {
  unlockSpeech();
  if (!talkSupported) return;
  playAndRecord();
  const borrowed = lender?.();
  if (borrowed) {
    if (primed) releaseMedia(primed);
    borrowed.audio = blessedAudio(borrowed.audio);
    primed = borrowed;
    return;
  }
  if (primed) releaseMedia(primed);
  const ctx = newAudioContext();
  ctx.resume().catch(() => {});
  const stream = getMic();
  stream.catch(() => {});
  primed = { ctx, stream, audio: blessedAudio() };
}
export function takePrimed() {
  const p = primed || lender?.() || null;
  primed = null;
  return p;
}
// Done with media from primeTalk/takePrimed: stop it, or hand a borrowed mic
// back to the wake word.
export function releaseMedia(m) {
  if (!m) return;
  if (m.borrowed) return m.release?.();
  Promise.resolve(m.stream)
    .then((s) => s?.getTracks().forEach((t) => t.stop()))
    .catch(() => {});
  m.ctx?.close?.().catch(() => {});
}

let silentUrl = '';
export function blessedAudio(el) {
  const a = el || new Audio();
  a.autoplay = true;
  a.playsInline = true;
  a.setAttribute('playsinline', '');
  try {
    if (!silentUrl) silentUrl = URL.createObjectURL(encodeWav([new Float32Array(1600)], 16000));
    a.src = silentUrl;
    a.play().catch(() => {});
  } catch {}
  return a;
}

// Float32 chunks at `rate` → 16 kHz mono 16-bit PCM WAV.
export function encodeWav(chunks, rate) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const ratio = rate / TARGET_RATE;
  const outLen = Math.floor(len / ratio);
  const pcm = new Int16Array(outLen);
  // Box-filter decimation: average the input samples each output covers —
  // plenty for speech headed to Whisper, and no aliasing mush.
  let ci = 0;
  let off = 0;
  let pos = 0;
  for (let o = 0; o < outLen; o++) {
    const end = (o + 1) * ratio;
    let acc = 0;
    let n = 0;
    while (pos < end && ci < chunks.length) {
      acc += chunks[ci][off];
      n += 1;
      pos += 1;
      off += 1;
      if (off >= chunks[ci].length) {
        ci += 1;
        off = 0;
      }
    }
    const v = n ? acc / n : 0;
    pcm[o] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.byteLength, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, TARGET_RATE, true);
  dv.setUint32(28, TARGET_RATE * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

// POST a recorded turn to the relay. → text ('' = nothing intelligible).
export async function transcribe(wav, token, { timeoutMs = 30000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('/stt', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' },
      body: wav,
      signal: ctl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || `Transcription failed (${r.status})`);
    return String(data.text || '').trim();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Transcription timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function sttInfo(token) {
  try {
    const r = await fetch('/stt', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const data = await r.json();
    return data.ok ? data : null;
  } catch {
    return null;
  }
}

// ---- speech out --------------------------------------------------------------

// Must run inside the tap that starts talk mode: iOS only lets speechSynthesis
// talk once a gesture has spoken first. A silent utterance does it.
export function unlockSpeech() {
  if (!ttsSupported) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

function voicesNow() {
  try {
    return speechSynthesis.getVoices() || [];
  } catch {
    return [];
  }
}

// Voices worth offering: the device's language first, the good ones on top.
const GOOD = /samantha|ava|zoe|allison|susan|serena|karen|moira|tessa|kate|daniel|evan|nathan|google (us|uk) english/i;
function score(v, lang) {
  let s = 0;
  if (v.lang?.toLowerCase().startsWith(lang)) s += 100;
  else if (v.lang?.toLowerCase().startsWith('en')) s += 50;
  if (/premium/i.test(v.name)) s += 30;
  if (/enhanced|neural|natural/i.test(v.name)) s += 20;
  if (GOOD.test(v.name)) s += 10;
  if (/eloquence|bad news|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy|grandma|grandpa|rocko|shelley|sandy|flo|reed/i.test(v.name)) s -= 80;
  if (v.default) s += 2;
  return s;
}

export function listVoices() {
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return voicesNow()
    .filter((v) => v.lang?.toLowerCase().startsWith('en') || v.lang?.toLowerCase().startsWith(lang))
    .map((v) => ({ v, s: score(v, lang) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v);
}

// Voices load asynchronously on some engines.
export function onVoices(fn) {
  if (!ttsSupported) return () => {};
  fn();
  const h = () => fn();
  speechSynthesis.addEventListener?.('voiceschanged', h);
  return () => speechSynthesis.removeEventListener?.('voiceschanged', h);
}

// Markdown and chat shorthand → something that sounds right read aloud.
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?)\1/g, '$2')
    .replace(/#(\d{4})\b/g, (_, n) => `task ${Number(n)}`)
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/→/g, ' to ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Sentence-sized pieces: iOS and Chrome both stall on long utterances.
function pieces(text) {
  const out = [];
  for (const s of text.match(/[^.!?;]+[.!?;]*\s*/g) || [text]) {
    let rest = s.trim();
    while (rest.length > 220) {
      const cut = rest.lastIndexOf(',', 220) > 80 ? rest.lastIndexOf(',', 220) + 1 : rest.lastIndexOf(' ', 220);
      out.push(rest.slice(0, cut > 0 ? cut : 220).trim());
      rest = rest.slice(cut > 0 ? cut : 220).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

// Speak `text`; resolves true when done, false if cancelled. Only one speech at
// a time — a new speak() or stopSpeaking() cancels the current one.
let speechGen = 0;
export function speak(text, { voiceURI = '', rate = 1.04 } = {}) {
  if (!ttsSupported) return Promise.resolve(false);
  const gen = ++speechGen;
  const parts = pieces(speakable(text));
  const voice = voiceURI ? voicesNow().find((v) => v.voiceURI === voiceURI) : listVoices()[0];
  try {
    speechSynthesis.cancel();
  } catch {}
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (gen !== speechGen) return resolve(false);
      if (i >= parts.length) return resolve(true);
      const u = new SpeechSynthesisUtterance(parts[i++]);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = rate;
      // iOS sometimes never fires onend — a watchdog moves us along.
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(dog);
        next();
      };
      const dog = setTimeout(fin, 2500 + u.text.length * 95);
      u.onend = fin;
      u.onerror = fin;
      try {
        speechSynthesis.speak(u);
        // A paused engine (seen on iOS after an interruption) queues forever.
        if (speechSynthesis.paused) speechSynthesis.resume();
      } catch {
        fin();
      }
    };
    next();
  });
}

export function stopSpeaking() {
  speechGen += 1;
  if (!ttsSupported) return;
  try {
    speechSynthesis.cancel();
  } catch {}
}
