// Realtime voice: a WebRTC call from the panel straight to OpenAI's Realtime
// API (speech to speech). The relay mints the ephemeral session (realtime.js
// on the server: model, persona, voice and tools are baked into it), relays
// the one SDP offer/answer so it can watch and hang up the call, and keeps
// the usage tally and daily $ cap; the OpenAI key never reaches this device.
//
// The caller opens the mic and the <audio> element inside a tap (voice.js
// primeTalk) and passes them in; this file does the signalling, a noise gate
// on the mic, and the "oai-events" data channel, and hands every server event
// to onEvent.

export const realtimeSupported = typeof window !== 'undefined' && typeof window.RTCPeerConnection === 'function';

const auth = (token) => ({ Authorization: `Bearer ${token}` });

// Settings › Voice (per device). Standard is gpt-realtime-2.1-mini, Premium
// gpt-realtime-2.1; the transcript of what Daniel says is billed separately,
// so it's off unless he wants to read along.
export const QUALITY_KEY = 'mc.talk.quality';
export const TRANSCRIPT_KEY = 'mc.talk.transcript';
function pref(k, dflt) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? dflt : JSON.parse(v);
  } catch {
    return dflt;
  }
}
export const voicePrefs = () => ({ quality: pref(QUALITY_KEY, 'standard') === 'premium' ? 'premium' : 'standard', transcript: pref(TRANSCRIPT_KEY, false) === true });

export async function realtimeInfo(token) {
  try {
    const r = await fetch('/realtime', { headers: auth(token), cache: 'no-store' });
    const data = await r.json();
    return data.ok ? data : null;
  } catch {
    return null;
  }
}

// Running totals for one session; the relay adds only the growth since the
// last report, so reporting often is safe. The reports double as the relay's
// heartbeat: when they stop, its watchdog hangs the call up. The final one
// (`final`: why it ended) goes as a beacon, which survives the page being
// hidden or torn down on iOS.
export function reportUsage(token, id, seconds, usage, { final = '' } = {}) {
  if (!id) return;
  const body = JSON.stringify({ id, seconds: Math.round(seconds), usage, final: final || undefined });
  if (final && navigator.sendBeacon?.(`/realtime/usage?token=${encodeURIComponent(token)}`, new Blob([body], { type: 'application/json' }))) return;
  fetch('/realtime/usage', {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body,
    keepalive: !!final,
  }).catch(() => {});
}

// A noise gate between the mic and the call: near-silent audio (room hum, a
// distant TV) goes out as digital silence, so the server VAD never commits it
// and it's never billed as input. Opens at once on speech, closes after a
// short hold. Needs a running AudioContext; without one the raw mic is used.
const GATE = { openDb: -50, closeDb: -56, holdMs: 700, everyMs: 20 };
export function noiseGate(ctx, stream) {
  if (!ctx || ctx.state !== 'running' || typeof ctx.createMediaStreamDestination !== 'function') return null;
  try {
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    src.connect(an);
    src.connect(gain);
    gain.connect(dest);
    const buf = new Float32Array(an.fftSize);
    let open = false;
    let quietSince = 0;
    const iv = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
      const now = performance.now();
      if (db >= GATE.openDb) {
        quietSince = 0;
        if (!open) {
          open = true;
          gain.gain.setTargetAtTime(1, ctx.currentTime, 0.004);
        }
      } else if (open && db < GATE.closeDb) {
        if (!quietSince) quietSince = now;
        else if (now - quietSince >= GATE.holdMs) {
          open = false;
          gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
        }
      }
    }, GATE.everyMs);
    return {
      stream: dest.stream,
      isOpen: () => open,
      stop() {
        clearInterval(iv);
        try {
          src.disconnect();
          gain.disconnect();
        } catch {}
        dest.stream.getTracks().forEach((t) => t.stop());
      },
    };
  } catch {
    return null;
  }
}

// Token counts from a response.done event, folded into `acc` (cached input
// tokens are billed at a fraction, so they're kept apart).
export function addUsage(acc, u) {
  if (!u) return acc;
  const i = u.input_token_details || {};
  const o = u.output_token_details || {};
  const c = i.cached_tokens_details || {};
  acc.audioInCached += c.audio_tokens || 0;
  acc.textInCached += c.text_tokens || 0;
  acc.audioIn += Math.max(0, (i.audio_tokens || 0) - (c.audio_tokens || 0));
  acc.textIn += Math.max(0, (i.text_tokens || 0) - (c.text_tokens || 0));
  acc.audioOut += o.audio_tokens || 0;
  acc.textOut += o.text_tokens || 0;
  return acc;
}
export const emptyUsage = () => ({ audioIn: 0, audioInCached: 0, audioOut: 0, textIn: 0, textInCached: 0, textOut: 0 });

class RealtimeError extends Error {
  constructor(message, { status = 0, stage = '' } = {}) {
    super(message);
    this.status = status;
    this.stage = stage;
  }
}

// → { id, limits, model, voice, transcript, budget, send(event), close(), pc }
export async function connectRealtime({ token, stream, audio, ctx, onEvent, onState, timeoutMs = 15000, prefs = voicePrefs() }) {
  if (!realtimeSupported) throw new RealtimeError('This browser has no WebRTC', { stage: 'support' });

  const r = await fetch('/realtime/session', {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(prefs),
  }).catch(() => null);
  const s = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok || !s.ok) throw new RealtimeError(s.error || (r ? `Relay said ${r.status}` : 'Relay unreachable'), { status: r?.status || 0, stage: 'mint' });

  const pc = new RTCPeerConnection();
  const gate = noiseGate(ctx, stream);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      dc.close();
    } catch {}
    try {
      pc.getSenders().forEach((x) => pc.removeTrack?.(x));
      pc.close();
    } catch {}
    gate?.stop();
    if (audio) {
      audio.srcObject = null;
    }
  };

  pc.ontrack = (e) => {
    if (!audio) return;
    audio.srcObject = e.streams[0] || new MediaStream([e.track]);
    audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);
  const out = gate?.stream || stream;
  for (const track of out.getAudioTracks()) pc.addTrack(track, out);

  const dc = pc.createDataChannel('oai-events');
  dc.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    onEvent?.(ev);
  };
  const opened = new Promise((resolve, reject) => {
    dc.onopen = resolve;
    dc.onerror = () => reject(new RealtimeError('Event channel failed', { stage: 'channel' }));
  });

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let answer;
    try {
      // Through the relay, which passes it on with the ephemeral secret and
      // keeps OpenAI's call id for its watchdog.
      answer = await fetch(s.callsUrl, {
        method: 'POST',
        body: offer.sdp,
        headers: { ...auth(token), 'Content-Type': 'application/sdp' },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!answer.ok) throw new RealtimeError(`OpenAI said ${answer.status}`, { status: answer.status, stage: 'sdp' });
    await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
    await Promise.race([
      opened,
      new Promise((_, reject) => setTimeout(() => reject(new RealtimeError('Timed out connecting', { stage: 'channel' })), timeoutMs)),
    ]);
  } catch (e) {
    close();
    if (e instanceof RealtimeError) throw e;
    throw new RealtimeError(e?.name === 'AbortError' ? 'Timed out reaching OpenAI' : e?.message || 'Could not connect', { stage: 'connect' });
  }

  return {
    id: s.id,
    limits: s.limits || {},
    model: s.model,
    voice: s.voice,
    transcript: !!s.transcript,
    budget: s.budget || null,
    gated: !!gate,
    pc,
    send(ev) {
      if (dc.readyState !== 'open') return false;
      dc.send(JSON.stringify(ev));
      return true;
    },
    close,
  };
}
