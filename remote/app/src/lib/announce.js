import { create } from 'zustand';
import { getMC } from './store.js';
import { getTalk } from './talkSession.js';
import { speak, stopSpeaking, unlockSpeech, newAudioContext, ttsSupported, blessedAudio } from './voice.js';
import { spokenFor, isMiaMsg } from '../views/mia/TalkParts.jsx';
import { speakable, firstSentences } from './spoken.js';

// ANNOUNCEMENTS — Mia speaks up on an open panel even when talk mode is off
// ("Hey Daniel, I have a question for you…"), docs/mia.md §8.3.
//
// Which messages: Settings › Announcements › "Speak Mia's updates" (stored per
// device in localStorage — the sound comes out of this device):
//   important (default): "Important only" — anything Mia flagged `--speak`,
//                        every `mia ask` and every `mia notify`;
//   all:                 "Everything" — every message from her (`mia say` too);
//   off:                 none.
// Short-spoken: a long message is read as its first sentence + "More on the
// panel." (firstSentences), markdown and URLs stripped (speakable).
// Never while talk mode is on (the talk engine reads her out already), never
// when the app is in the background (Web Push covers that), never during
// quiet hours (default 22:00–07:00), and only on the panel the relay marks as
// the one Daniel is using (store.panelPrimary).
//
// The words are spoken in Mia's realtime voice: the relay's POST /tts (tts.js,
// OpenAI TTS with the realtime session's voice) returns mp3 that plays through
// an <audio> element blessed on the first tap. If /tts fails (no key, daily
// cap, offline) the device's speechSynthesis reads it instead.
//
// iOS only lets a page make sound after a tap in this page session. The first
// tap anywhere unlocks speech, the chime and the audio element; until then an
// announcement shows as "Mia wants to talk — tap to hear" in the top-bar pill
// (TalkPill).

export const ANNOUNCE_MODE_KEY = 'mc.announce.mode';
export const QUIET_KEY = 'mc.announce.quiet';
export const QUIET_DEFAULT = { on: true, from: '22:00', to: '07:00' };
const FRESH_MS = 3 * 60000; // older than this when it reaches us = stale news
const SHOW_MS = 45000; // how long the pill offers "answer" after speaking

function readLS(key, dflt) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? dflt : JSON.parse(raw);
  } catch {
    return dflt;
  }
}
export const announceMode = () => {
  const m = readLS(ANNOUNCE_MODE_KEY, 'important');
  return m === 'all' || m === 'off' ? m : 'important';
};
export const quietHours = () => ({ ...QUIET_DEFAULT, ...(readLS(QUIET_KEY, QUIET_DEFAULT) || {}) });

const mins = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? (Number(m[1]) % 24) * 60 + Math.min(59, Number(m[2])) : null;
};
export function inQuietHours(q = quietHours(), d = new Date()) {
  if (!q.on) return false;
  const a = mins(q.from);
  const b = mins(q.to);
  if (a == null || b == null || a === b) return false;
  const n = d.getHours() * 60 + d.getMinutes();
  return a < b ? n >= a && n < b : n >= a || n < b; // wraps midnight
}

// ---- what gets said ------------------------------------------------------------
export function wantsAnnounce(m, mode = announceMode()) {
  if (!isMiaMsg(m) || mode === 'off') return false;
  if (mode === 'all') return true;
  return !!m.speak || m.kind === 'question' || m.kind === 'notify';
}

const MORE = ' More on the panel.';

export function announceText(m) {
  const said = spokenFor(m);
  if (m.kind === 'question') {
    const q = speakable(said);
    return `Hey Daniel, I have a question for you. ${q.length <= 200 ? q : 'It’s on the panel.'}`;
  }
  const { text, cut } = firstSentences(said);
  if (!text) return '';
  const more = cut ? MORE : '';
  if (m.speak || m.kind === 'chat') return text + more;
  return `Hey Daniel, ${text.charAt(0).toLowerCase()}${text.slice(1)}${more}`;
}

// ---- audio unlock + chime --------------------------------------------------------
let unlocked = false;
let ctx = null;
let player = null; // the <audio> element /tts plays through, blessed in a tap
export const audioUnlocked = () => unlocked;

function unlockNow() {
  if (!unlocked) {
    unlocked = true;
    unlockSpeech();
    try {
      player = blessedAudio();
    } catch {}
  }
  try {
    if (!ctx) ctx = newAudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch {}
}
if (typeof window !== 'undefined') {
  // touchend/click are the gestures iOS accepts for audio; keydown for desks.
  for (const ev of ['touchend', 'click', 'keydown']) window.addEventListener(ev, unlockNow, { capture: true, passive: true });
}

// Two soft notes — "Mia has something" — before the words.
function chime() {
  return new Promise((resolve) => {
    try {
      if (!ctx) ctx = newAudioContext();
      const t0 = ctx.currentTime + 0.02;
      [
        [659.25, 0],
        [987.77, 0.14],
      ].forEach(([f, dt]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + dt);
        g.gain.linearRampToValueAtTime(0.12, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.4);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + dt);
        o.stop(t0 + dt + 0.45);
      });
      setTimeout(resolve, 520);
    } catch {
      resolve();
    }
  });
}

// ---- the pill's state ---------------------------------------------------------------
// current: { msg, text, state: 'locked' | 'speaking' | 'said', at } | null
export const useAnnounce = create(() => ({ current: null, link: null }));
const setA = (p) => useAnnounce.setState(p);
let hideTimer = null;
let queue = [];

function show(cur) {
  clearTimeout(hideTimer);
  setA({ current: cur });
  if (cur && cur.state === 'said') hideTimer = setTimeout(() => dismissAnnounce(), SHOW_MS);
}

export function dismissAnnounce() {
  clearTimeout(hideTimer);
  queue = [];
  const cur = useAnnounce.getState().current;
  if (cur?.state === 'speaking') stopAll();
  setA({ current: null });
}

// ---- the voice: /tts through the blessed <audio>, else speechSynthesis --------------
let stopPlayer = null;
function stopAll() {
  stopPlayer?.();
  stopSpeaking();
}

// Fetch the mp3 for `text` → a blob URL, or null (no key, cap, offline, slow).
async function fetchTts(text, { timeoutMs = 8000 } = {}) {
  const token = getMC().token;
  if (!token) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ctl.signal,
    });
    if (!r.ok || !/^audio\//.test(r.headers.get('content-type') || '')) return null;
    const blob = await r.blob();
    return blob.size ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Play a blob URL on the blessed element. → true when it played to the end
// (or was stopped), false when it couldn't start (then the device voice speaks).
function playUrl(url) {
  return new Promise((resolve) => {
    const a = player;
    if (!a) return resolve(false);
    let started = false;
    const done = (ok) => {
      a.onended = a.onerror = a.onpause = null;
      stopPlayer = null;
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    stopPlayer = () => {
      try {
        a.pause();
      } catch {}
      done(true);
    };
    a.onended = () => done(true);
    a.onerror = () => done(started);
    a.onpause = () => started && !a.ended && done(true);
    try {
      a.srcObject = null;
      a.src = url;
      a.play().then(
        () => (started = true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  });
}

async function play(msg, text) {
  show({ msg, text, state: 'speaking', at: Date.now() });
  const audio = player ? fetchTts(text) : Promise.resolve(null); // fetched while the chime plays
  await chime();
  if (useAnnounce.getState().current?.msg !== msg) return audio.then((u) => u && URL.revokeObjectURL(u));
  const url = await audio;
  if (useAnnounce.getState().current?.msg !== msg) return url && URL.revokeObjectURL(url);
  const played = url ? await playUrl(url) : false;
  if (!played && ttsSupported) {
    const voiceURI = readLS('mc.talk.voice', '');
    await speak(text, { voiceURI });
  }
  if (useAnnounce.getState().current?.msg !== msg) return;
  const next = queue.shift();
  if (next) play(next.msg, next.text);
  else show({ msg, text, state: 'said', at: Date.now() });
}

// A link Mia opened that the browser blocked (no tap): offered in the pill.
let linkTimer = null;
export function offerLink(url, host) {
  clearTimeout(linkTimer);
  setA({ link: { url, host } });
  linkTimer = setTimeout(() => setA({ link: null }), 60000);
}
export function dismissLink() {
  clearTimeout(linkTimer);
  setA({ link: null });
}

// A tap on "Mia wants to talk — tap to hear": the tap itself is the unlock.
export function hearAnnouncement() {
  const cur = useAnnounce.getState().current;
  if (!cur) return;
  unlockNow();
  play(cur.msg, cur.text);
}

export function announce(msg) {
  const text = announceText(msg);
  if (!text) return;
  const cur = useAnnounce.getState().current;
  if (!unlocked || !(ttsSupported || player)) {
    // Can't make a sound yet: show it and wait for a tap.
    show({ msg, text, state: 'locked', at: Date.now() });
    return;
  }
  if (cur?.state === 'speaking') {
    queue.push({ msg, text });
    return;
  }
  play(msg, text);
}

const msgMs = (at) => (typeof at === 'number' ? (at > 1e12 ? at : at * 1000) : Date.parse(at) || 0);

// A question worth reading out: not dismissed/expired, not past the max age.
function questionLive(m) {
  const mia = getMC().mia;
  if (mia?.closedQuestions?.[m.questionId]) return false;
  const h = mia?.questionMaxAgeHours;
  return !h || Date.now() - msgMs(m.at) <= h * 3600e3;
}

// Called with each new snapshot's messages (TalkHost). History present when
// the panel first sees Mia is never announced.
let seen = null;
export function considerMessages(msgs) {
  if (!Array.isArray(msgs)) return;
  if (!seen) {
    seen = new Set(msgs.map((m) => m.id || m.at));
    return;
  }
  for (const m of msgs) {
    const k = m.id || m.at;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!wantsAnnounce(m)) continue;
    if (m.kind === 'question' && !questionLive(m)) continue; // old or already closed
    if (getTalk().on) continue; // the talk session reads it out itself
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') continue;
    if (!getMC().panelPrimary) continue;
    if (inQuietHours()) continue;
    if (Date.now() - msgMs(m.at) > FRESH_MS) continue;
    announce(m);
  }
}

// Going to the background mid-announcement: stop talking.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && useAnnounce.getState().current?.state === 'speaking') {
      stopAll();
      show({ ...useAnnounce.getState().current, state: 'said' });
    }
  });
}
