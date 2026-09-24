// Realtime voice: a WebRTC call from the panel straight to OpenAI's Realtime
// API (speech to speech). The relay only mints the ephemeral client secret
// (realtime.js on the server: persona, voice and tools are baked into it) and
// keeps the usage tally; the OpenAI key never reaches this device.
//
// The caller opens the mic and the <audio> element inside a tap (voice.js
// primeTalk) and passes them in; this file does the signalling and the
// "oai-events" data channel, and hands every server event to onEvent.

export const realtimeSupported = typeof window !== 'undefined' && typeof window.RTCPeerConnection === 'function';

const auth = (token) => ({ Authorization: `Bearer ${token}` });

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
// last report, so reporting often (and once more with keepalive at the end)
// is safe.
export function reportUsage(token, id, seconds, usage, { final = false } = {}) {
  if (!id) return;
  fetch('/realtime/usage', {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, seconds: Math.round(seconds), usage }),
    keepalive: final,
  }).catch(() => {});
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

// → { id, limits, model, voice, send(event), close(), pc }
export async function connectRealtime({ token, stream, audio, onEvent, onState, timeoutMs = 15000 }) {
  if (!realtimeSupported) throw new RealtimeError('This browser has no WebRTC', { stage: 'support' });

  const r = await fetch('/realtime/session', { method: 'POST', headers: auth(token) }).catch(() => null);
  const s = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok || !s.ok) throw new RealtimeError(s.error || (r ? `Relay said ${r.status}` : 'Relay unreachable'), { status: r?.status || 0, stage: 'mint' });

  const pc = new RTCPeerConnection();
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
  for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

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
      answer = await fetch(s.callsUrl, {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${s.value}`, 'Content-Type': 'application/sdp' },
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
    pc,
    send(ev) {
      if (dc.readyState !== 'open') return false;
      dc.send(JSON.stringify(ev));
      return true;
    },
    close,
  };
}
