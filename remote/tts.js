// Spoken announcements in Mia's realtime voice.
//
// `mia say/notify/ask --speak` is read aloud on the primary panel
// (app/src/lib/announce.js). To sound the same as the live conversation, the
// panel asks the relay for audio: POST /tts → OpenAI's speech endpoint with
// the realtime session's voice (marin) and short delivery instructions → mp3
// streamed back. The panel falls back to the device's speechSynthesis when
// this fails or there is no key.
//
// OPENAI_API_KEY is for the voice layer only (realtime.js, this file).
//
// Cost guard: one announcement is trimmed to ~400 characters (whole
// sentences), a daily character cap stops synthesis (429 → the panel uses the
// device voice), and repeats of the same text within TTS_CACHE_SECONDS come
// from memory at no cost. Usage is tallied per day (/health, Settings › Voice).
//
// Env: OPENAI_API_KEY, TTS_MODEL (gpt-4o-mini-tts), TTS_VOICE (REALTIME_VOICE
// or marin), TTS_MAX_CHARS (400), TTS_DAILY_CHARS (20000), TTS_CACHE_SECONDS
// (600), TTS_STORE (usage file), OPENAI_BASE_URL (tests point this at a mock).
//
// HTTP (token auth, same as /api, /stt and /realtime):
//   GET  /tts   → { ok, available, model, voice, limits, today, days }
//   POST /tts   body { text } → audio/mpeg (headers X-TTS-Chars, X-TTS-Cache)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// gpt-4o-mini-tts: $0.60 / 1M text tokens in, $12 / 1M audio tokens out —
// OpenAI's own estimate is ≈ $0.015 per spoken minute. Speech runs at about
// 15 characters a second, so ≈ $0.0000167 per character. Only used for the
// running estimate.
const USD_PER_MINUTE = 0.015;
const CHARS_PER_SECOND = 15;
const USD_PER_CHAR = USD_PER_MINUTE / (60 * CHARS_PER_SECOND);

const INSTRUCTIONS = `Voice: Mia, a calm, capable personal assistant — like Jarvis. Composed, warm but understated, quietly confident.
Pacing: even and unhurried, slightly brisk; no long pauses.
Tone: matter-of-fact. No excitement, no drama, no sing-song; a light, dry touch at most.
Delivery: say exactly the text, clearly, as a brief spoken heads-up.`;

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

function createTts({ tokenOk, env = process.env, log = console, fetchImpl = globalThis.fetch } = {}) {
  const key = env.OPENAI_API_KEY || '';
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
  const model = env.TTS_MODEL || 'gpt-4o-mini-tts';
  const voice = env.TTS_VOICE || env.REALTIME_VOICE || 'marin';
  const maxChars = Number(env.TTS_MAX_CHARS) || 400;
  const dailyChars = Number(env.TTS_DAILY_CHARS) || 20000;
  const cacheMs = (Number(env.TTS_CACHE_SECONDS) || 600) * 1000;
  const storePath = path.resolve(env.TTS_STORE || './tts-usage.json');
  const limits = { maxChars, dailyChars };

  if (key) log.log(`tts: ${model} / ${voice}, ${dailyChars} chars/day`);

  // ---- usage tally: { days: { 'YYYY-MM-DD': { requests, chars, cached, usd } } }
  let store = { days: {} };
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!store || typeof store.days !== 'object') store = { days: {} };
  } catch {}
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keys = Object.keys(store.days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete store.days[k];
      try {
        const tmp = `${storePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
        fs.renameSync(tmp, storePath);
      } catch (e) {
        log.error('tts: could not save usage:', e.message);
      }
    }, 500);
    saveTimer.unref?.();
  }
  function dayRec(d) {
    if (!store.days[d]) store.days[d] = { requests: 0, chars: 0, cached: 0, usd: 0 };
    return store.days[d];
  }
  function summary(d = day()) {
    const r = store.days[d] || { requests: 0, chars: 0, cached: 0, usd: 0 };
    return { day: d, requests: r.requests, chars: r.chars, cached: r.cached, usd: Math.round(r.usd * 10000) / 10000 };
  }

  // ---- short-lived cache: sha256(voice|model|text) → { buf, at }
  const cache = new Map();
  const hashOf = (text) => crypto.createHash('sha256').update(`${model}|${voice}|${text}`).digest('hex');
  function cacheGet(h) {
    const hit = cache.get(h);
    if (!hit) return null;
    if (Date.now() - hit.at > cacheMs) {
      cache.delete(h);
      return null;
    }
    return hit.buf;
  }
  function cachePut(h, buf) {
    cache.set(h, { buf, at: Date.now() });
    for (const [k, v] of cache) if (cache.size > 40 || Date.now() - v.at > cacheMs) cache.delete(k);
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

  async function speak(res, text) {
    const h = hashOf(text);
    const hit = cacheGet(h);
    const head = (extra) => ({ 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-tts-chars': String(text.length), ...extra });
    if (hit) {
      dayRec(day()).cached += 1;
      save();
      res.writeHead(200, head({ 'x-tts-cache': 'hit', 'content-length': String(hit.length) }));
      return res.end(hit);
    }
    const today = summary();
    if (today.chars + text.length > dailyChars) return json(res, 429, { ok: false, error: `Daily speech limit reached (${dailyChars} characters)` });

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let r;
    try {
      r = await fetchImpl(`${base}/v1/audio/speech`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, voice, input: text, instructions: INSTRUCTIONS, response_format: 'mp3' }),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      log.error('tts: request failed:', e.message);
      return json(res, 502, { ok: false, error: `Speech failed: ${e.message}` });
    }
    if (!r.ok || !r.body) {
      clearTimeout(timer);
      const data = await r.json().catch(() => ({}));
      const msg = data?.error?.message || `status ${r.status}`;
      log.error('tts: OpenAI refused:', msg);
      return json(res, 502, { ok: false, error: `Speech failed: ${msg}` });
    }
    // Charged once OpenAI accepted it, whether or not the panel hears it all.
    const rec = dayRec(day());
    rec.requests += 1;
    rec.chars += text.length;
    rec.usd += text.length * USD_PER_CHAR;
    save();

    // Stream through to the panel while keeping a copy for the cache.
    res.writeHead(200, head({ 'x-tts-cache': 'miss' }));
    const parts = [];
    let complete = false;
    try {
      for await (const chunk of r.body) {
        const b = Buffer.from(chunk);
        parts.push(b);
        res.write(b);
      }
      complete = true;
    } catch (e) {
      log.error('tts: stream broke:', e.message);
    } finally {
      clearTimeout(timer);
      res.end();
    }
    if (complete) cachePut(h, Buffer.concat(parts));
  }

  async function handle(req, res, url) {
    if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const route = url.pathname.replace(/\/+$/, '');
    if (route !== '/tts') return json(res, 404, { ok: false, error: 'not found' });

    if (req.method === 'GET') {
      const days = Object.keys(store.days).sort().slice(-14).map((d) => summary(d));
      return json(res, 200, { ok: true, available: !!key, model, voice, limits, today: summary(), days });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const text = trimText(body.text, maxChars);
      if (!text) return json(res, 400, { ok: false, error: 'no text' });
      if (!key) return json(res, 503, { ok: false, error: 'OPENAI_API_KEY is not set on the relay' });
      return speak(res, text);
    }
    return json(res, 405, { ok: false, error: 'method not allowed' });
  }

  return {
    handle,
    info: () => ({ available: !!key, model, voice, limits, today: summary() }),
  };
}

module.exports = { createTts, trimText, INSTRUCTIONS, USD_PER_CHAR };
