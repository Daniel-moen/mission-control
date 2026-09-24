import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, getMC, miaSend, miaAnswer, miaRead, VOICE_TAG, voiceText } from '../../lib/store.js';
import {
  openMic, takePrimed, primeTalk, transcribe, sttInfo, unlockSpeech, speak, stopSpeaking, listVoices, onVoices,
  ttsSupported, PAUSES,
} from '../../lib/voice.js';
import { useLocalStorage } from '../../lib/hooks.js';
import Icon from '../../ui/Icon.jsx';
import Button from '../../ui/Button.jsx';
import Select from '../../ui/Select.jsx';
import Segmented from '../../ui/Segmented.jsx';
import { LABEL, HINT, isMiaMsg, micError, spokenFor, Orb, Line } from './TalkParts.jsx';
import RealtimeTalk from './RealtimeTalk.jsx';
import { consumeWake } from '../../lib/wake.js';

// TALK — hands-free conversation with Mia, in one of two engines (Settings ›
// Voice, or the switch in the talk controls): Realtime (RealtimeTalk.jsx —
// OpenAI speech-to-speech that hands the work to Mia) or Basic, below. Basic
// is also where Realtime falls back to when it can't start or drops.
//
// BASIC — one tap opens the mic and it stays
// open: Daniel talks, a pause ends his turn, the relay transcribes it (stt.js)
// and it goes to Mia as an ordinary message tagged "(voice)". Whatever Mia says
// back while talk mode is on is read aloud, then the panel listens again.
// Talking over her (or tapping the orb) stops her mid-sentence.
//
// Phases: starting → listening ⇄ hearing → transcribing → thinking → speaking
// → listening …, plus paused (mic muted by a tap), interrupted (iOS took the
// audio session away — a tap brings it back) and error.

function BasicTalk({ mia, onExit, media = null, fellBack = '' }) {
  const link = useMC((s) => s.link);
  const local = useMC((s) => s.miaLocal);

  const [phase, setPhaseState] = useState('starting');
  const levels = useRef(new Set()).current;
  const [error, setError] = useState('');
  const [note, setNote] = useState(fellBack ? `Realtime voice unavailable (${fellBack}) — using the basic voice.` : ''); // transient line under the orb
  const [heard, setHeard] = useState([]); // turns awaiting transcription/echo
  const [speakingId, setSpeakingId] = useState('');
  const [stt, setStt] = useState(undefined); // undefined = checking, null = unavailable
  const [pauseKey, setPauseKey] = useLocalStorage('mc.talk.pause', 'normal');
  const [voiceURI, setVoiceURI] = useLocalStorage('mc.talk.voice', '');
  const [voices, setVoices] = useState([]);

  const phaseRef = useRef('starting');
  const mic = useRef(null);
  const handed = useRef(media);
  const seen = useRef(null); // Mia message ids that existed before / were handled
  const queue = useRef([]); // Mia messages waiting to be spoken
  const awaiting = useRef(false); // a turn went out and Mia hasn't answered
  const lastQ = useRef(null); // the open question Mia just read out
  const startedAt = useRef(Date.now());
  const noteTimer = useRef(null);
  const thinkTimer = useRef(null);
  const wake = useRef(null);
  const alive = useRef(true);
  const opts = useRef({});
  opts.current = { voiceURI, pause: PAUSES[pauseKey] || PAUSES.normal };

  function setPhase(p) {
    phaseRef.current = p;
    setPhaseState(p);
    const m = mic.current;
    if (m) m.setMode(p === 'speaking' ? 'guard' : p === 'paused' || p === 'interrupted' ? 'mute' : 'listen');
  }
  function flash(t) {
    setNote(t);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 4000);
  }
  // Where the loop rests when nothing is happening.
  function rest() {
    if (!alive.current) return;
    setPhase(awaiting.current ? 'thinking' : 'listening');
  }

  // ---- speaking -------------------------------------------------------------
  async function drain() {
    if (phaseRef.current === 'speaking' || !queue.current.length) return;
    if (['paused', 'interrupted', 'error', 'starting', 'hearing'].includes(phaseRef.current)) return;
    const m = queue.current.shift();
    awaiting.current = false;
    lastQ.current = m.kind === 'question' && m.questionId ? m : null;
    setSpeakingId(m.id || '');
    setPhase('speaking');
    await speak(spokenFor(m), { voiceURI: opts.current.voiceURI });
    if (!alive.current) return;
    setSpeakingId('');
    if (phaseRef.current === 'speaking') {
      rest();
      drain();
    }
  }

  function bargeIn() {
    stopSpeaking();
    queue.current = [];
    setSpeakingId('');
  }

  // ---- Daniel's turns ---------------------------------------------------------
  async function onUtterance(wav) {
    if (!alive.current) return;
    const id = `h${Date.now()}`;
    setHeard((h) => [...h, { id, text: '…', pending: true }]);
    setPhase('transcribing');
    let text = '';
    try {
      text = await transcribe(wav, getMC().token);
    } catch (e) {
      setHeard((h) => h.filter((x) => x.id !== id));
      flash(e.message || 'Transcription failed');
      rest();
      return;
    }
    if (!alive.current) return;
    if (!text) {
      setHeard((h) => h.filter((x) => x.id !== id));
      flash('Didn’t catch that');
      if (phaseRef.current === 'transcribing') rest();
      return;
    }
    // A question Mia just read out and nobody has answered yet: this is the
    // answer. Everything else is a new message.
    const q = lastQ.current;
    const qOpen = q && (getMC().mia?.pendingQuestions || []).some((p) => p.questionId === q.questionId);
    const ok = qOpen ? miaAnswer(q.questionId, VOICE_TAG + text) : miaSend(VOICE_TAG + text);
    lastQ.current = null;
    setHeard((h) => (ok ? h.filter((x) => x.id !== id) : h.map((x) => (x.id === id ? { ...x, text, pending: false, failed: true } : x))));
    if (ok) {
      if (qOpen) setHeard((h) => [...h, { id: `a${Date.now()}`, text, answered: true }]);
      awaiting.current = true;
      // Mia may go quiet on purpose (she's off doing the task); don't sit on
      // "thinking" forever — she'll still be read out whenever she replies.
      clearTimeout(thinkTimer.current);
      thinkTimer.current = setTimeout(() => {
        awaiting.current = false;
        if (phaseRef.current === 'thinking') rest();
      }, 90000);
    } else flash('Not sent — the Mac isn’t reachable');
    if (phaseRef.current === 'transcribing') rest();
    drain();
  }

  async function begin() {
    setError('');
    setPhase('starting');
    const handlers = {
      pauseMs: opts.current.pause,
      onLevel: (l) => levels.forEach((fn) => fn(l)),
      onSpeechStart: () => {
        if (!alive.current) return;
        if (phaseRef.current === 'speaking') bargeIn();
        setPhase('hearing');
      },
      onUtterance,
      onState: (s) => {
        if (!alive.current) return;
        if (s === 'interrupted' && phaseRef.current !== 'paused') {
          stopSpeaking();
          setPhase('interrupted');
        }
      },
    };
    // First start: adopt the mic the Talk tap already opened (or the one the
    // realtime view handed over when it failed). A retry from the orb is its
    // own tap, so opening fresh there is fine.
    const primed = handed.current || takePrimed();
    handed.current = null;
    consumeWake(); // basic has no greeting; just clear the flag
    if (!primed) unlockSpeech();
    try {
      mic.current?.close();
      mic.current = null;
      const m = await openMic(handlers, primed || {});
      m.setHandlers(handlers);
      if (!alive.current) {
        m.close();
        return;
      }
      mic.current = m;
      rest();
      drain();
    } catch (e) {
      mic.current = null;
      setError(micError(e));
      setPhase('error');
    }
    try {
      wake.current = await navigator.wakeLock?.request('screen');
    } catch {}
  }

  // The orb: stop Mia / pause / resume, depending on what's happening.
  async function tapOrb() {
    const p = phaseRef.current;
    if (p === 'speaking') {
      bargeIn();
      rest();
    } else if (p === 'paused') {
      rest();
      drain();
    } else if (p === 'interrupted' || p === 'error') {
      unlockSpeech();
      if (mic.current && (await mic.current.resume())) {
        rest();
        drain();
      } else begin();
    } else if (p !== 'starting') {
      setPhase('paused');
    }
  }

  // ---- lifecycle ------------------------------------------------------------
  // Talk mode is only ever mounted by a tap on "Talk", so begin() runs inside
  // that gesture's task — which is what iOS needs for the mic and speech.
  useEffect(() => {
    alive.current = true;
    begin();
    sttInfo(getMC().token).then((i) => alive.current && setStt(i && i.provider ? i : null));
    return () => {
      alive.current = false;
      clearTimeout(noteTimer.current);
      clearTimeout(thinkTimer.current);
      stopSpeaking();
      mic.current?.close();
      mic.current = null;
      wake.current?.release?.().catch?.(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => mic.current?.setPause(PAUSES[pauseKey] || PAUSES.normal), [pauseKey]);
  useEffect(() => onVoices(() => setVoices(listVoices())), []);

  // Coming back to the app: iOS may have suspended the audio session.
  useEffect(() => {
    const on = () => {
      if (document.visibilityState !== 'visible') {
        stopSpeaking();
        return;
      }
      const m = mic.current;
      if (m && !m.alive && phaseRef.current !== 'paused' && phaseRef.current !== 'error') setPhase('interrupted');
      navigator.wakeLock?.request('screen').then((w) => (wake.current = w)).catch(() => {});
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // New Mia messages → the speech queue. Anything already in the thread when
  // talk mode opened is history, not something to read out.
  const msgs = mia?.messages || [];
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(msgs.map((m) => m.id || m.at));
      return;
    }
    let added = false;
    for (const m of msgs) {
      const k = m.id || m.at;
      if (seen.current.has(k)) continue;
      seen.current.add(k);
      if (isMiaMsg(m)) {
        queue.current.push(m);
        added = true;
      }
    }
    if (added) drain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs]);

  // What's been read aloud has been read: keep the unread badge honest.
  const lastId = msgs.length ? msgs[msgs.length - 1].id : '';
  useEffect(() => {
    if (link === 'linked' && lastId && document.visibilityState === 'visible') miaRead(lastId);
  }, [link, lastId]);

  // ---- transcript -------------------------------------------------------------
  const start = startedAt.current;
  const rows = useMemo(() => {
    const out = [];
    const toMs = (at) => (typeof at === 'number' ? (at > 1e12 ? at : at * 1000) : Date.parse(at) || 0);
    for (const m of msgs) {
      if (m.from === 'system' || m.kind === 'event') continue;
      if (toMs(m.at) < start - 2000) continue; // history — the Thread has it
      if (m.from === 'daniel' && m.kind === 'answer') continue; // shown from `heard`
      const v = voiceText(m.text);
      out.push({ key: m.id || String(m.at), who: m.from === 'mia' ? 'mia' : 'you', text: m.from === 'mia' ? spokenFor(m) : v.text, voice: v.voice, live: m.id && m.id === speakingId });
    }
    for (const p of local.sent) {
      if (p.at < start) continue;
      const v = voiceText(p.text);
      out.push({ key: p.id, who: 'you', text: v.text, voice: v.voice, pending: true });
    }
    for (const h of heard) out.push({ key: h.id, who: 'you', text: h.failed ? `${h.text} — not sent` : h.text, voice: true, pending: h.pending || h.failed });
    return out;
  }, [msgs, local.sent, heard, speakingId, start]);

  const scroller = useRef(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [rows.length, rows[rows.length - 1]?.text]);

  const warn =
    stt === null
      ? 'Transcription isn’t set up on the relay, so your speech can’t be sent. Redeploy the relay with whisper.cpp or set OPENAI_API_KEY.'
      : link !== 'linked'
        ? link === 'relay'
          ? 'Your Mac is offline — Mia can’t hear you until it’s back.'
          : 'Reconnecting…'
        : mia && !mia.enabled
          ? 'Mia is off — what you say waits for her.'
          : !ttsSupported
            ? 'This browser can’t speak — Mia’s replies show here as text.'
            : '';

  const voiceOptions = [{ value: '', label: 'Auto voice' }, ...voices.slice(0, 12).map((v) => ({ value: v.voiceURI, label: v.name }))];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-talk={phase}>
      <div ref={scroller} className="noscroll min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">
        <div className="mx-auto flex max-w-[640px] flex-col">
          {!rows.length ? (
            <div className="pt-10 text-center text-[14px] leading-relaxed text-ink3">
              Say what you need — a task, a question, a reminder.
              <br />
              Mia answers out loud.
            </div>
          ) : (
            <AnimatePresence initial={false}>
              {rows.map((r) => (
                <Line key={r.key} {...r} />
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
              {error || note || HINT[phase] || ''}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="flex w-full max-w-[560px] flex-wrap items-center justify-center gap-2">
          <Segmented
            value={pauseKey}
            onChange={setPauseKey}
            options={[
              { value: 'short', label: 'Quick' },
              { value: 'normal', label: 'Normal' },
              { value: 'long', label: 'Patient' },
            ]}
          />
          {ttsSupported && voices.length > 1 && (
            <Select className="w-[150px]" aria-label="Mia's voice" value={voiceURI} onChange={setVoiceURI} options={voiceOptions} />
          )}
          <EngineSwitch />
          <Button variant="danger" icon="close" onClick={onExit}>
            End
          </Button>
        </div>
      </div>
    </div>
  );
}


// Realtime (OpenAI speech-to-speech, hands jobs to Mia) or Basic (whisper on
// the relay + the device's own voice). Realtime falls back to Basic by itself
// when it can't start or drops, handing over the mic it already holds.
export const ENGINE_KEY = 'mc.talk.engine';

function EngineSwitch() {
  const [engine, setEngine] = useLocalStorage(ENGINE_KEY, 'realtime');
  return (
    <Segmented
      value={engine}
      onChange={(v) => {
        if (v === engine) return;
        primeTalk(); // the tap re-arms mic + audio for the engine that mounts next
        setEngine(v);
        window.dispatchEvent(new CustomEvent('mc:talk-engine', { detail: v }));
      }}
      options={[
        { value: 'realtime', label: 'Realtime' },
        { value: 'basic', label: 'Basic' },
      ]}
    />
  );
}

export default function Talk({ mia, onExit }) {
  const [engine, setEngine] = useLocalStorage(ENGINE_KEY, 'realtime');
  const [fallback, setFallback] = useState(null); // { reason, media }
  useEffect(() => {
    const on = (e) => {
      setFallback(null);
      setEngine(e.detail);
    };
    window.addEventListener('mc:talk-engine', on);
    return () => window.removeEventListener('mc:talk-engine', on);
  }, [setEngine]);
  if (engine === 'realtime' && !fallback)
    return <RealtimeTalk mia={mia} onExit={onExit} onFallback={(reason, media) => setFallback({ reason, media })} switcher={<EngineSwitch />} />;
  return <BasicTalk key={fallback ? 'fb' : 'basic'} mia={mia} onExit={onExit} media={fallback?.media} fellBack={fallback?.reason} />;
}
