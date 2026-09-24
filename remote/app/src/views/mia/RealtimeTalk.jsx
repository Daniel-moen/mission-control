import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, getMC, miaSend, miaAnswer, miaRead, miaOpenQuestions, VOICE_TAG } from '../../lib/store.js';
import { takePrimed, getMic, newAudioContext, blessedAudio, playAndRecord, unlockSpeech, speak, stopSpeaking, speakable } from '../../lib/voice.js';
import { connectRealtime, reportUsage, addUsage, emptyUsage, realtimeSupported } from '../../lib/realtime.js';
import Icon from '../../ui/Icon.jsx';
import Button from '../../ui/Button.jsx';
import { LABEL, HINT, isMiaMsg, micError, spokenFor, Orb, Line } from './TalkParts.jsx';

// REALTIME TALK — Mia's natural voice. The panel holds a WebRTC call with
// OpenAI's Realtime API (lib/realtime.js); the relay minted the session with
// Mia's voice persona and four tools, which run here:
//   send_to_mia(text)           → an ordinary chat message tagged "(voice) "
//   get_status()                → tasks + open questions from the snapshot
//   answer_question(id, option) → answers a pending `mia ask`
//   end_session()               → Daniel said he's done
// The realtime model only converses and relays — Mia does the work. Her
// replies (say / notify / ask) are fed back into the call as "Mia says: …"
// system items, so the voice reads them out and offers ask-options aloud.
//
// Cost safety: the call ends after ~60 s of quiet (3 min while waiting on a
// reply from Mia), when the app goes to the background, and at 15 minutes.
// Then the view sits in `standby`: mic off, Mia's replies read by the device's
// own voice, one tap to talk again. Minutes and tokens go to the relay's
// per-day tally (/realtime/usage).
//
// If the call can't start or drops, onFallback(reason, media) hands the live
// mic to the basic whisper voice (Talk.jsx).
//
// Phases: starting → connecting → listening ⇄ hearing → thinking → speaking
// → listening …, plus paused (mic muted by a tap), standby and error.

const REASON = {
  idle: 'Ended after a quiet minute.',
  cap: 'Ended at the 15-minute limit.',
  background: 'Ended when the app left the screen.',
  done: 'Bye for now.',
  lost: 'The connection dropped.',
};

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// What the voice reads for a Mia message: her words, plus the question id and
// options for an ask so answer_question can be called.
function injectText(m) {
  let t = `Mia says: ${speakable(m.text)}`;
  const opts = Array.isArray(m.options) ? m.options.filter(Boolean) : [];
  if (m.kind === 'question' && m.questionId)
    t += `\n(This is a question for Daniel, question id ${m.questionId}.${opts.length ? ` Options: ${opts.join(' | ')}.` : ''} Ask it${opts.length ? ' and offer the options' : ''}; when he answers, call answer_question.)`;
  else t += '\n(Read this to Daniel now.)';
  return t;
}

// ---- tools --------------------------------------------------------------------

function toolStatus() {
  const mc = getMC();
  const mia = mc.mia;
  if (!mia) return { ok: false, error: 'Mia is not reporting — the Mac may be offline.' };
  const live = ['queued', 'asking', 'running', 'checking'];
  const tasks = mia.tasks || [];
  const byTime = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  return {
    ok: true,
    mia: mc.link !== 'linked' ? 'Mac offline' : mia.online ? 'online' : 'offline',
    active: tasks.filter((t) => live.includes(t.status)).sort(byTime).slice(0, 12).map((t) => ({ id: t.id, title: t.title, status: t.status })),
    recentlyFinished: tasks
      .filter((t) => !live.includes(t.status))
      .sort(byTime)
      .slice(0, 4)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, result: t.result ? String(t.result).slice(0, 240) : undefined })),
    openQuestions: miaOpenQuestions(mia).map((q) => ({ id: q.questionId, task: q.taskId, question: q.text, options: q.options || [] })),
  };
}

function toolAnswer({ id, option }) {
  const open = miaOpenQuestions(getMC().mia);
  const q = open.find((x) => x.questionId === String(id || '').trim());
  if (!q) return { ok: false, error: 'No open question with that id.', openQuestions: open.map((x) => ({ id: x.questionId, question: x.text, options: x.options || [] })) };
  const said = String(option || '').trim();
  if (!said) return { ok: false, error: 'Empty answer.' };
  const opts = (q.options || []).map(String);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const choice = opts.find((o) => norm(o) === norm(said)) || opts.find((o) => norm(o).includes(norm(said)) || norm(said).includes(norm(o))) || said;
  return miaAnswer(q.questionId, VOICE_TAG + choice) ? { ok: true, answered: choice } : { ok: false, error: 'Not sent — the Mac is not reachable.' };
}

export default function RealtimeTalk({ mia, onExit, onFallback, switcher }) {
  const link = useMC((s) => s.link);

  const [phase, setPhaseState] = useState('starting');
  const levels = useRef(new Set()).current;
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([]); // { key, who: 'you'|'mia'|'note', text, pending }
  const [live, setLive] = useState(false); // a call is open (and billing)
  const [clock, setClock] = useState(0); // seconds into it

  const phaseRef = useRef('starting');
  const alive = useRef(true);
  const rt = useRef(null); // the live call
  const media = useRef(null); // { ctx, stream, audio }
  const meter = useRef(null);
  const tick = useRef(null);
  const noteTimer = useRef(null);
  const call = useRef(null); // per-call bookkeeping
  const seen = useRef(null);
  const wake = useRef(null);

  function setPhase(p) {
    phaseRef.current = p;
    setPhaseState(p);
  }
  function flash(t, ms = 5000) {
    setNote(t);
    clearTimeout(noteTimer.current);
    if (ms) noteTimer.current = setTimeout(() => setNote(''), ms);
  }
  function upsert(key, who, fn) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.key === key);
      if (i < 0) return [...ls, { key, who, ...fn(null) }];
      const next = ls.slice();
      next[i] = { ...next[i], ...fn(next[i]) };
      return next;
    });
  }
  const addNote = (text) => upsert(`n${Date.now()}${Math.random()}`, 'note', () => ({ text }));
  const touch = () => call.current && (call.current.lastActive = Date.now());

  // ---- media ------------------------------------------------------------------
  // The mic level for the orb, off an analyser on the same stream.
  function startMeter() {
    stopMeter();
    const m = media.current;
    if (!m?.ctx || !m.stream) return;
    try {
      const src = m.ctx.createMediaStreamSource(m.stream);
      const an = m.ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      const iv = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const l = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-6) + 60) / 50));
        levels.forEach((fn) => fn(l));
      }, 60);
      meter.current = () => {
        clearInterval(iv);
        try {
          src.disconnect();
        } catch {}
      };
    } catch {}
  }
  function stopMeter() {
    meter.current?.();
    meter.current = null;
    levels.forEach((fn) => fn(0));
  }
  function stopMic() {
    stopMeter();
    media.current?.stream?.getTracks().forEach((t) => t.stop());
    if (media.current) media.current.stream = null;
  }

  // ---- the call ---------------------------------------------------------------
  function send(ev) {
    return rt.current?.send(ev);
  }

  // Mia's replies wait until the voice isn't mid-sentence or mid-listen.
  function flush() {
    const c = call.current;
    if (!c || !rt.current || c.responding || c.userSpeaking || !c.inbox.length) return;
    for (const { text } of c.inbox.splice(0)) {
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
    }
    c.awaiting = 0;
    c.responding = true; // until response.created/done says otherwise
    send({ type: 'response.create' });
    touch();
  }

  function runTool(name, args) {
    const c = call.current;
    switch (name) {
      case 'send_to_mia': {
        const text = String(args.text || '').trim();
        if (!text) return { ok: false, error: 'Nothing to send.' };
        const ok = miaSend(VOICE_TAG + text);
        if (ok && c) c.awaiting = Date.now();
        addNote(ok ? `To Mia: ${text}` : `Not sent (Mac offline): ${text}`);
        return ok
          ? { ok: true, status: 'Sent. Mia is on it; her reply will arrive as a "Mia says:" message. Do not answer it yourself.' }
          : { ok: false, error: 'Not sent — the Mac is not reachable.' };
      }
      case 'get_status':
        return toolStatus();
      case 'answer_question': {
        const r = toolAnswer(args);
        if (r.ok) addNote(`Answered: ${r.answered}`);
        return r;
      }
      case 'end_session':
        if (c) c.ending = true;
        return { ok: true };
      default:
        return { ok: false, error: `Unknown tool ${name}` };
    }
  }

  function onEvent(ev) {
    const c = call.current;
    if (!alive.current || !c) return;
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        c.userSpeaking = true;
        touch();
        if (phaseRef.current !== 'paused') setPhase('hearing');
        if (ev.item_id) upsert(ev.item_id, 'you', (l) => ({ text: l?.text || '…', pending: true }));
        break;
      case 'input_audio_buffer.speech_stopped':
        c.userSpeaking = false;
        touch();
        if (phaseRef.current === 'hearing') setPhase('thinking');
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(ev.transcript || '').trim();
        if (text) upsert(ev.item_id, 'you', () => ({ text, pending: false }));
        else setLines((ls) => ls.filter((l) => l.key !== ev.item_id));
        break;
      }
      case 'response.created':
        c.responding = true;
        touch();
        break;
      case 'response.output_audio_transcript.delta':
        upsert(ev.item_id, 'mia', (l) => ({ text: (l?.text || '') + (ev.delta || '') }));
        break;
      case 'response.output_audio_transcript.done':
        if (ev.transcript) upsert(ev.item_id, 'mia', () => ({ text: ev.transcript }));
        break;
      case 'output_audio_buffer.started':
        c.voice = true;
        touch();
        if (phaseRef.current !== 'paused') setPhase('speaking');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        c.voice = false;
        touch();
        if (c.ending) return end('done');
        if (phaseRef.current === 'speaking') setPhase('listening');
        break;
      case 'response.done': {
        c.responding = false;
        touch();
        addUsage(c.usage, ev.response?.usage);
        const calls = (ev.response?.output || []).filter((o) => o.type === 'function_call');
        if (calls.length) {
          for (const fc of calls) {
            let args = {};
            try {
              args = JSON.parse(fc.arguments || '{}');
            } catch {}
            const out = runTool(fc.name, args);
            send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: fc.call_id, output: JSON.stringify(out) } });
          }
          if (c.ending) {
            // The goodbye is usually already spoken; don't wait on audio that
            // may never come.
            setTimeout(() => call.current === c && end('done'), c.voice ? 6000 : 1200);
            return;
          }
          c.responding = true;
          send({ type: 'response.create' });
          if (phaseRef.current === 'hearing' || phaseRef.current === 'listening') setPhase('thinking');
          return;
        }
        if (!c.voice && ['thinking', 'speaking'].includes(phaseRef.current)) setPhase('listening');
        flush();
        break;
      }
      case 'error': {
        const msg = ev.error?.message || 'Realtime error';
        if (/active response/i.test(msg)) break; // a response.create raced one already running
        console.warn('realtime:', msg);
        flash(msg);
        break;
      }
      default:
    }
  }

  // Open (or reopen) the call. Must be reached from a tap: the Talk button's
  // primed media, or the orb in standby.
  async function begin(fromTap = false) {
    setError('');
    setNote('');
    setPhase('starting');
    let m = media.current;
    if (!m?.stream) {
      const primed = !fromTap && takePrimed();
      if (primed) {
        m = { ctx: primed.ctx, stream: primed.stream, audio: primed.audio };
      } else {
        unlockSpeech();
        playAndRecord();
        const ctx = m?.ctx && m.ctx.state !== 'closed' ? m.ctx : newAudioContext();
        ctx.resume().catch(() => {});
        m = { ctx, stream: getMic(), audio: blessedAudio(m?.audio) };
      }
      media.current = m;
    }
    try {
      m.stream = await m.stream;
    } catch (e) {
      m.stream = null;
      setError(micError(e));
      setPhase('error');
      return;
    }
    if (!alive.current) return;
    startMeter();

    if (!realtimeSupported) return fallback('no WebRTC here');
    setPhase('connecting');
    const c = {
      startedAt: 0, lastActive: Date.now(), usage: emptyUsage(), inbox: [], awaiting: 0,
      responding: false, userSpeaking: false, voice: false, ending: false, reported: 0,
    };
    call.current = c;
    try {
      const session = await connectRealtime({
        token: getMC().token,
        stream: m.stream,
        audio: m.audio,
        onEvent,
        onState: (st) => {
          if (call.current !== c) return;
          if (st === 'failed') end('lost');
          else if (st === 'disconnected') {
            clearTimeout(c.dropTimer);
            c.dropTimer = setTimeout(() => call.current === c && rt.current?.pc.connectionState !== 'connected' && end('lost'), 5000);
          }
        },
      });
      if (!alive.current || call.current !== c) {
        session.close();
        return;
      }
      rt.current = session;
      c.id = session.id;
      c.limits = { idleSeconds: 60, awaitSeconds: 180, maxSeconds: 900, ...session.limits };
      c.startedAt = Date.now();
      c.lastActive = Date.now();
      setClock(0);
      setLive(true);
      setPhase('listening');
      try {
        wake.current = await navigator.wakeLock?.request('screen');
      } catch {}
    } catch (e) {
      call.current = null;
      if (!alive.current) return;
      console.warn('realtime: could not start:', e.message);
      fallback(e.status === 503 ? 'no OpenAI key on the relay' : e.status === 429 ? 'daily limit reached' : e.message);
    }
  }

  // Hand the mic to the basic voice.
  function fallback(reason) {
    stopMeter();
    const m = media.current;
    media.current = null; // now Basic's to close
    onFallback?.(reason, m?.stream ? { ctx: m.ctx, stream: m.stream } : null);
  }

  // End the live call. `why`: idle | cap | background | done | lost | exit.
  function end(why) {
    const c = call.current;
    call.current = null;
    clearTimeout(c?.dropTimer);
    if (c?.id) reportUsage(getMC().token, c.id, c.startedAt ? (Date.now() - c.startedAt) / 1000 : 0, c.usage, { final: true });
    rt.current?.close();
    rt.current = null;
    setLive(false);
    wake.current?.release?.().catch?.(() => {});
    if (!alive.current || why === 'exit') return;
    if (why === 'lost' && media.current?.stream) {
      fallback('connection dropped');
      return;
    }
    stopMic();
    setPhase('standby');
    flash(REASON[why] || '', 0);
    // Replies that arrived but never got their turn in the call.
    for (const { m } of c?.inbox || []) {
      upsert(m.id || String(m.at), 'mia', () => ({ text: spokenFor(m) }));
      speak(spokenFor(m));
    }
  }

  // The orb.
  function tapOrb() {
    const p = phaseRef.current;
    if (p === 'standby' || p === 'error') {
      stopSpeaking();
      begin(true);
    } else if (p === 'speaking') {
      send({ type: 'response.cancel' });
      send({ type: 'output_audio_buffer.clear' });
      setPhase('listening');
      touch();
    } else if (p === 'paused') {
      media.current?.stream?.getAudioTracks().forEach((t) => (t.enabled = true));
      setPhase('listening');
      touch();
    } else if (['listening', 'hearing', 'thinking'].includes(p)) {
      media.current?.stream?.getAudioTracks().forEach((t) => (t.enabled = false));
      setPhase('paused');
    }
  }

  // ---- lifecycle ----------------------------------------------------------------
  useEffect(() => {
    alive.current = true;
    begin(false);
    // 1 Hz: the clock, the quiet/length limits, and a usage report every 30 s.
    tick.current = setInterval(() => {
      const c = call.current;
      if (!c || !c.startedAt) return;
      const now = Date.now();
      const secs = (now - c.startedAt) / 1000;
      setClock(secs);
      if (c.responding || c.userSpeaking || c.voice) c.lastActive = now;
      const L = c.limits;
      const waiting = c.awaiting && now - c.awaiting < L.awaitSeconds * 1000;
      if (secs >= L.maxSeconds) return end('cap');
      if ((now - c.lastActive) / 1000 >= (waiting ? L.awaitSeconds : L.idleSeconds)) return end('idle');
      if (secs - c.reported >= 30) {
        c.reported = secs;
        reportUsage(getMC().token, c.id, secs, c.usage);
      }
    }, 1000);
    const onHide = () => {
      if (document.visibilityState !== 'visible') {
        stopSpeaking();
        if (call.current) end('background');
      }
    };
    const onPageHide = () => call.current && end('background');
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      clearInterval(tick.current);
      clearTimeout(noteTimer.current);
      alive.current = false;
      end('exit');
      stopSpeaking();
      stopMic();
      media.current?.ctx?.close?.().catch(() => {});
      if (media.current?.audio) media.current.audio.srcObject = null;
      media.current = null;
      playAndRecord(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New Mia messages → into the call (or, in standby, the device's voice).
  // Anything already in the thread when talk mode opened is history.
  const msgs = mia?.messages || [];
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(msgs.map((m) => m.id || m.at));
      return;
    }
    for (const m of msgs) {
      const k = m.id || m.at;
      if (seen.current.has(k)) continue;
      seen.current.add(k);
      if (!isMiaMsg(m)) continue;
      const c = call.current;
      if (c && rt.current) {
        c.inbox.push({ m, text: injectText(m) });
        touch();
      } else if (phaseRef.current === 'standby') {
        upsert(m.id || String(m.at), 'mia', () => ({ text: spokenFor(m) }));
        speak(spokenFor(m));
      }
    }
    flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs]);

  // What's been heard has been read: keep the unread badge honest.
  const lastId = msgs.length ? msgs[msgs.length - 1].id : '';
  useEffect(() => {
    if (link === 'linked' && lastId && document.visibilityState === 'visible') miaRead(lastId);
  }, [link, lastId]);

  const scroller = useRef(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [lines.length, lines[lines.length - 1]?.text]);

  const warn =
    link !== 'linked'
      ? link === 'relay'
        ? 'Your Mac is offline — Mia can’t take jobs until it’s back.'
        : 'Reconnecting…'
      : mia && !mia.enabled
        ? 'Mia is off — what you ask waits for her.'
        : '';
  const hint = phase === 'thinking' ? HINT.thinkingRt : HINT[phase];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-talk={phase} data-engine="realtime">
      <div ref={scroller} className="noscroll min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">
        <div className="mx-auto flex max-w-[640px] flex-col">
          {!lines.length ? (
            <div className="pt-10 text-center text-[14px] leading-relaxed text-ink3">
              Talk to Mia like a person — ask for anything.
              <br />
              She hands the work to herself on your Mac and tells you when it’s done.
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {lines.map((l) => (
                <Line key={l.key} who={l.who} text={l.text} voice={l.who === 'you'} pending={l.pending} />
              ))}
            </AnimatePresence>
          )}
        </div>
      </div>

      <div className="flex flex-none flex-col items-center gap-3 border-t border-glass-line px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-4 sm:px-5">
        {warn && (
          <div className="flex max-w-[520px] items-start gap-2 text-[12.5px] leading-snug text-warn">
            <Icon name="alert" size={14} className="mt-[2px] flex-none" />
            <span>{warn}</span>
          </div>
        )}
        {/* The live indicator: a realtime call is open (and billing). */}
        <AnimatePresence>
          {live && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              data-rt-live
              className="pill glass-soft inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-ink2"
            >
              <motion.span
                className="h-1.5 w-1.5 rounded-full bg-accent"
                animate={{ opacity: [1, 0.35, 1] }}
                transition={{ repeat: Infinity, duration: 1.8 }}
              />
              Realtime on · <span className="tnum">{fmt(clock)}</span>
            </motion.div>
          )}
        </AnimatePresence>
        <Orb phase={phase} levels={levels} onTap={tapOrb} />
        <div className="flex min-h-[44px] flex-col items-center text-center">
          <div className="display text-[17px] font-semibold tracking-tight text-ink" aria-live="polite">
            {LABEL[phase]}
          </div>
          <AnimatePresence mode="wait">
            <motion.div
              key={note || error || phase}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className={`max-w-[440px] text-[12.5px] leading-snug ${error ? 'text-crit' : 'text-ink3'}`}
            >
              {error || note || hint || ''}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="flex w-full max-w-[560px] flex-wrap items-center justify-center gap-2">
          {switcher}
          <Button variant="danger" icon="close" onClick={onExit}>
            End
          </Button>
        </div>
      </div>
    </div>
  );
}
