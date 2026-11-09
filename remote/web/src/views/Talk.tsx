'use client';
// Talk: hands-free with Mia. Records until Daniel stops speaking, the relay
// transcribes on its own whisper (POST /stt — never OpenAI), the words go to
// Mia as a (voice) message, and her reply is spoken in her Kokoro voice made
// on the Mac (POST /tts), falling back to the device voice.

import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { getMC, miaSend, useMC } from '@/lib/store';
import { setTalk } from '@/lib/nav';
import { MiaMark } from './MiaMark';
import { Glass, Icon, spring } from '@/ui/kit';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
const RATE = 16000;

function wav(chunks: Float32Array[], inRate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = inRate / RATE;
  const n = Math.floor(total / ratio);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(all[Math.floor(i * ratio)] * 32767)));
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const w = (p: number, s: string) => [...s].forEach((ch, i) => dv.setUint8(p + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.byteLength, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, RATE, true);
  dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

export function Talk() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [err, setErr] = useState('');
  const stopRef = useRef<() => void>(() => {});
  const waitFor = useRef<{ after: number } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const msgs = useMC((s) => s.mia?.messages);

  async function listen() {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      let spoke = false;
      let quietSince = 0;
      const started = Date.now();
      setPhase('listening');
      const finish = async (send: boolean) => {
        proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close();
        setLevel(0);
        if (!send || !spoke) return setPhase('idle');
        setPhase('thinking');
        try {
          const r = await fetch('/stt', { method: 'POST', headers: { Authorization: `Bearer ${getMC().token}`, 'Content-Type': 'audio/wav' }, body: wav(chunks, ctx.sampleRate) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || `Transcription failed (${r.status})`);
          const text = String(j.text || '').trim();
          if (!text) { setPhase('idle'); return setErr('I didn’t catch that.'); }
          setHeard(text);
          waitFor.current = { after: Date.now() };
          miaSend(text, { voice: true });
        } catch (e: any) {
          setPhase('error'); setErr(e.message || 'Something went wrong');
        }
      };
      stopRef.current = () => finish(true);
      proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += d[i] * d[i];
        const rms = Math.sqrt(s / (d.length / 4));
        setLevel(rms);
        if (rms > 0.03) { spoke = true; quietSince = 0; } else if (spoke && !quietSince) quietSince = Date.now();
        if ((spoke && quietSince && Date.now() - quietSince > 1300) || Date.now() - started > 60000) finish(true);
      };
      src.connect(proc);
      proc.connect(ctx.destination);
    } catch {
      setPhase('error');
      setErr('Microphone not available. Allow it for this site.');
    }
  }

  // Mia's reply → speak it.
  useEffect(() => {
    const w = waitFor.current;
    if (!w || !msgs) return;
    const m = [...msgs].reverse().find((x) => x.from === 'mia' && x.at && Date.parse(x.at) >= w.after - 2000);
    if (!m?.text) return;
    waitFor.current = null;
    setSaid(m.text);
    setPhase('speaking');
    (async () => {
      try {
        const r = await fetch('/tts', { method: 'POST', headers: { Authorization: `Bearer ${getMC().token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: m.text!.slice(0, 600) }) });
        if (!r.ok || !/^audio\//.test(r.headers.get('content-type') || '')) throw new Error();
        const url = URL.createObjectURL(await r.blob());
        const a = audio.current || new Audio();
        audio.current = a;
        a.src = url;
        a.onended = () => { setPhase('idle'); listen(); };
        await a.play();
      } catch {
        const u = new SpeechSynthesisUtterance(m.text);
        u.onend = () => { setPhase('idle'); listen(); };
        speechSynthesis.speak(u);
      }
    })();
  }, [msgs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { stopRef.current = () => {}; audio.current?.pause(); speechSynthesis?.cancel(); }, []);

  const label = phase === 'listening' ? 'Listening…' : phase === 'thinking' ? 'Mia is thinking' : phase === 'speaking' ? 'Mia' : phase === 'error' ? 'Hmm' : 'Tap to talk';
  return (
    <motion.div className="talk" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} data-talk>
      <div className="row" style={{ width: '100%', maxWidth: 700 }}>
        <span className="eyebrow grow">Talk to Mia</span>
        <Glass as="button" variant="thin" radius={999} className="icon-btn" onClick={() => { stopRef.current(); setTalk(false); }} aria-label="Close talk">
          <Icon name="close" size={18} />
        </Glass>
      </div>
      <motion.button initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring} onClick={() => (phase === 'listening' ? stopRef.current() : phase === 'idle' || phase === 'error' ? listen() : null)} style={{ display: 'grid', placeItems: 'center' }} aria-label={label}>
        <div style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
          {[0, 1, 2].map((i) => (
            <motion.i key={i} style={{ position: 'absolute', width: 220, height: 220, borderRadius: '50%', border: '1px solid rgba(255,255,255,.18)' }} animate={{ scale: 1 + (phase === 'listening' ? level * (3 + i * 2) : phase === 'speaking' ? 0.08 * (i + 1) : 0.02 * i), opacity: phase === 'idle' ? 0.25 : 0.6 - i * 0.15 }} transition={{ type: 'spring', stiffness: 200, damping: 16 }} />
          ))}
          <MiaMark size={160} state={phase === 'error' ? 'idle' : phase === 'idle' ? 'idle' : phase} level={level} />
        </div>
      </motion.button>
      <div style={{ textAlign: 'center', maxWidth: 620, minHeight: 130 }}>
        <div className="title-m" style={{ marginBottom: 8 }}>{label}</div>
        {heard ? <div className="small" style={{ marginBottom: 8 }}>“{heard}”</div> : null}
        {said ? <div style={{ fontSize: 18, lineHeight: 1.45 }} className="clamp3">{said}</div> : null}
        {err ? <div className="small" style={{ color: 'var(--amber)' }}>{err}</div> : null}
      </div>
    </motion.div>
  );
}
