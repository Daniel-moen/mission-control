// Spoken announcements in Mia's own voice, made on the Mac (task 0287).
//
// `mia say/notify/ask --speak` is read aloud on the primary panel
// (app/src/lib/announce.js). The panel asks the relay for audio: POST /tts.
// The relay doesn't synthesise anything itself any more (OpenAI TTS is gone:
// no credit, and Daniel chose Chatterbox). It hands the text to the Mac over
// the host socket and serves back what the Mac made:
//
//   relay → host  {type:"tts", id, text}
//   host  → relay {type:"ttsDone", id, ok, mime?, audio? (base64), engine?, ms?, detail?}
//
// On the Mac, RemoteBridge runs ~/voice-lab/server/mia-tts: Chatterbox Turbo
// (resident service com.mia.tts on 127.0.0.1:8788), falling back to Kokoro
// af_heart locally. Never OpenAI. The ttsDone frame stops here (never fanned
// out). Mac offline, an older Mac app without the "tts" capability, a failure
// or a timeout → 503/501/502/504 and the panel falls back to the device's
// speechSynthesis.
//
// Guards: one announcement is trimmed to ~400 characters (whole sentences);
// repeats of the same text within TTS_CACHE_SECONDS come from memory; a daily
// character cap keeps a runaway loop from keeping the Mac's GPU busy. Usage
// is tallied per day (/health, Settings › Voice). It's free, so usd stays 0.
//
// Env: TTS_MAX_CHARS (400), TTS_DAILY_CHARS (50000), TTS_CACHE_SECONDS (600),
// TTS_WAIT_MS (30000, how long to wait for the Mac), TTS_STORE (usage file).
//
// HTTP (token auth, same as /api, /stt and /realtime):
//   GET  /tts   → { ok, available, engine, voice, limits, today, days }
//   POST /tts   body { text } → audio (audio/mp4 from the Mac), headers
//               X-TTS-Chars, X-TTS-Cache, X-TTS-Engine

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataFile } = require('./datafile');

const VOICE = 'Chatterbox Turbo (on the Mac)';

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

// Whitespace-normalised, capped at `max` characters on a sentence boundary
// (the first sentences that fit). A single sentence longer than the cap is cut
// at a word and ends with "…".
function trimText(text, max = 400) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)\s*/g) || [t];
  let out = '';
  for (const s of sentences) {
    if ((out + s).trim().length > max) break;
    out += s;
  }
  out = out.trim();
  if (out) return out;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

function createTts({ tokenOk, sendToHost = () => false, hostOnline = () => false, hostCanSpeak = () => false, env = process.env, log = console } = {}) {
  const maxChars = Number(env.TTS_MAX_CHARS) || 400;
  const dailyChars = Number(env.TTS_DAILY_CHARS) || 50000;
  const cacheMs = (Number(env.TTS_CACHE_SECONDS) || 600) * 1000;
  const waitMs = Number(env.TTS_WAIT_MS) || 30000;
  const storePath = dataFile('tts-usage.json', { override: env.TTS_STORE, env, log, tag: 'tts' });
  const limits = { maxChars, dailyChars };

  log.log(`tts: made on the Mac (Chatterbox), ${dailyChars} chars/day · tally ${storePath}`);

  // ---- usage tally: { days: { 'YYYY-MM-DD': { requests, chars, cached, usd } } }
  let store = { days: {} };
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!store || typeof store.days !== 'object') store = { days: {} };
  } catch {}
  let saveTimer = null;
  function flushStore() {
    saveTimer = null;
    const keys = Object.keys(store.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete store.days[k];
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, storePath);
    } catch (e) {
      log.error('tts: could not save usage:', e.message);
    }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushStore, 500);
    saveTimer.unref?.();
  }
  function dayRec(d) {
    if (!store.days[d]) store.days[d] = { requests: 0, chars: 0, cached: 0, usd: 0 };
    return store.days[d];
  }
  function summary(d = day()) {
    const r = store.days[d] || { requests: 0, chars: 0, cached: 0, usd: 0 };
    return { day: d, requests: r.requests, chars: r.chars, cached: r.cached, usd: Math.round((r.usd || 0) * 10000) / 10000 };
  }

  // ---- short-lived cache: sha256(text) → { buf, mime, engine, at }
  const cache = new Map();
  const hashOf = (text) => crypto.createHash('sha256').update(`mac|${text}`).digest('hex');
  function cacheGet(h) {
    const hit = cache.get(h);
    if (!hit) return null;
    if (Date.now() - hit.at > cacheMs) {
      cache.delete(h);
      return null;
    }
    return hit;
  }
  function cachePut(h, rec) {
    cache.set(h, { ...rec, at: Date.now() });
    for (const [k, v] of cache) if (cache.size > 40 || Date.now() - v.at > cacheMs) cache.delete(k);
  }

  // ---- requests waiting for the Mac: id → { resolve, timer }
  const pending = new Map();
  function askHost(text) {
    return new Promise((resolve) => {
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, status: 504, detail: 'The Mac took too long to speak' });
      }, waitMs);
      timer.unref?.();
      pending.set(id, { resolve, timer });
      if (sendToHost({ type: 'tts', id, text }) === false) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, status: 503, detail: 'Mac is offline' });
      }
    });
  }
  // host → relay {type:"ttsDone", …}
  function onHostFrame(frame) {
    const p = pending.get(frame?.id);
    if (!p) return;
    pending.delete(frame.id);
    clearTimeout(p.timer);
    let buf = null;
    try {
      buf = frame.ok && typeof frame.audio === 'string' ? Buffer.from(frame.audio, 'base64') : null;
    } catch {}
    if (!buf || !buf.length) return p.resolve({ ok: false, status: 502, detail: frame.detail || 'The Mac could not make the audio' });
    const mime = /^audio\/[\w.+-]+$/.test(frame.mime || '') ? frame.mime : 'audio/mp4';
    p.resolve({ ok: true, buf, mime, engine: String(frame.engine || 'mac').replace(/[^\w.-]/g, '').slice(0, 20) });
  }
  // The Mac went away: everyone waiting gets the device voice now, not in 30 s.
  function onHostGone() {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, status: 503, detail: 'Mac went offline' });
      pending.delete(id);
    }
  }

  function json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function authed(req, url) {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    return tokenOk(bearer || url.searchParams.get('token') || '');
  }
  function readJson(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 16384) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });
  }

  function sendAudio(res, text, rec, cacheState) {
    res.writeHead(200, {
      'content-type': rec.mime,
      'cache-control': 'no-store',
      'content-length': String(rec.buf.length),
      'x-tts-chars': String(text.length),
      'x-tts-cache': cacheState,
      'x-tts-engine': rec.engine,
    });
    res.end(rec.buf);
  }

  async function speak(res, text) {
    const h = hashOf(text);
    const hit = cacheGet(h);
    if (hit) {
      dayRec(day()).cached += 1;
      save();
      return sendAudio(res, text, hit, 'hit');
    }
    if (!hostOnline()) return json(res, 503, { ok: false, error: 'Mac is offline' });
    if (!hostCanSpeak()) return json(res, 501, { ok: false, error: 'This Mac app can’t speak yet (update Mission Control)' });
    const today = summary();
    if (today.chars + text.length > dailyChars) return json(res, 429, { ok: false, error: `Daily speech limit reached (${dailyChars} characters)` });

    const r = await askHost(text);
    if (!r.ok) {
      log.error('tts: the Mac did not speak:', r.detail);
      return json(res, r.status, { ok: false, error: `Speech failed: ${r.detail}` });
    }
    const rec = dayRec(day());
    rec.requests += 1;
    rec.chars += text.length;
    save();
    cachePut(h, r);
    sendAudio(res, text, r, 'miss');
  }

  async function handle(req, res, url) {
    if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const route = url.pathname.replace(/\/+$/, '');
    if (route !== '/tts') return json(res, 404, { ok: false, error: 'not found' });

    if (req.method === 'GET') {
      const days = Object.keys(store.days).sort().slice(-14).map((d) => summary(d));
      return json(res, 200, { ok: true, ...info(), days });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const text = trimText(body.text, maxChars);
      if (!text) return json(res, 400, { ok: false, error: 'no text' });
      return speak(res, text);
    }
    return json(res, 405, { ok: false, error: 'method not allowed' });
  }

  function info() {
    return { available: hostOnline() && hostCanSpeak(), engine: 'mac', voice: VOICE, limits, today: summary() };
  }

  return {
    handle,
    onHostFrame,
    onHostGone,
    info,
    // Write a pending save now (SIGTERM on redeploy).
    close() { if (saveTimer) { clearTimeout(saveTimer); flushStore(); } },
  };
}

module.exports = { createTts, trimText };
