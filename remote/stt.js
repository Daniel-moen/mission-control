// Speech-to-text for the panel's talk mode (Mia view).
//
// The panel records Daniel's utterance itself (16 kHz mono WAV, cut by its own
// end-of-speech detector) and POSTs it here; the relay answers with the text,
// which the panel then sends to Mia as an ordinary miaSend. The Web Speech API
// isn't used for this because it is unreliable on iPad in standalone Home
// Screen mode — a plain fetch of a WAV works everywhere.
//
// Provider: whisper.cpp's `whisper-cli` running here on the relay, with a ggml
// model baked into the Docker image. Free, no key, no third party.
// WHISPER_BIN / WHISPER_MODEL / WHISPER_THREADS / WHISPER_LANG.
//
// Deliberately local only. The OpenAI transcription path from 0011 is gone:
// OPENAI_API_KEY is for the realtime voice session (realtime.js) and nothing
// else, and this basic voice is the fallback for when that session fails.
//
// HTTP (token auth, same as /api):
//   GET  /stt  → { ok, provider, model }             provider null = unavailable
//   POST /stt  body = audio (audio/wav) → { ok, text, provider, ms }

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_AUDIO = 8 * 1024 * 1024; // ~4 min of 16 kHz 16-bit mono
const TIMEOUT_MS = 45000;
const MAX_QUEUE = 4;

// Whisper's stock hallucinations on silence or noise — a clip that transcribes
// to only one of these was nobody speaking.
const PHANTOMS = new Set([
  '', 'you', 'thank you', 'thanks', 'thank you for watching', 'thanks for watching',
  'bye', 'okay', 'so', 'uh', 'um', 'hmm', 'mm', '.',
]);

function clean(text) {
  const t = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ') // [BLANK_AUDIO], [MUSIC]
    .replace(/\([^)]*\)/g, ' ') // (music), (wind blowing)
    .replace(/\*[^*]*\*/g, ' ') // *sighs*
    .replace(/\s+/g, ' ')
    .trim();
  const bare = t.toLowerCase().replace(/[^a-z ]/g, '').trim();
  return PHANTOMS.has(bare) ? '' : t;
}

function which(bin) {
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

function createStt({ tokenOk, env = process.env, log = console } = {}) {
  const whisperBin = which(env.WHISPER_BIN || 'whisper-cli');
  const whisperModel = env.WHISPER_MODEL || '';
  const whisperOk = !!(whisperBin && whisperModel && fs.existsSync(whisperModel));
  const provider = whisperOk ? 'whisper' : null;

  const model = provider ? path.basename(whisperModel) : null;
  if (provider) log.log(`stt: ${provider} (${model})`);
  else log.warn('stt: no transcriber — set WHISPER_MODEL (+ whisper-cli on PATH). Basic talk mode will be unavailable.');

  // One transcription at a time: whisper uses every thread it's given, and two
  // overlapping runs are slower than two in a row.
  let chain = Promise.resolve();
  let queued = 0;
  function serial(fn) {
    queued += 1;
    const run = chain.then(fn, fn);
    chain = run.catch(() => {}).finally(() => { queued -= 1; });
    return run;
  }

  function runWhisper(audio) {
    const file = path.join(os.tmpdir(), `mc-stt-${crypto.randomBytes(6).toString('hex')}.wav`);
    fs.writeFileSync(file, audio);
    const threads = String(Number(env.WHISPER_THREADS) || Math.max(1, Math.min(4, os.cpus().length)));
    const args = ['-m', whisperModel, '-f', file, '-t', threads, '-nt', '-np', '-l', env.WHISPER_LANG || 'en'];
    return new Promise((resolve, reject) => {
      const p = spawn(whisperBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(timer); fs.rm(file, () => {}); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        fs.rm(file, () => {});
        if (code === 0) resolve(out);
        else reject(new Error(`whisper-cli exited ${code}: ${err.trim().split('\n').slice(-2).join(' ')}`));
      });
    });
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

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_AUDIO) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handle(req, res, url) {
    if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method === 'GET') return json(res, 200, { ok: true, provider, model });
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET or POST' });
    if (!provider) return json(res, 503, { ok: false, error: 'No transcriber is configured on the relay' });
    if (queued >= MAX_QUEUE) return json(res, 503, { ok: false, error: 'Transcriber is busy — try again' });

    let audio;
    try {
      audio = await readBody(req);
    } catch (e) {
      return json(res, e.status || 400, { ok: false, error: e.status === 413 ? 'Recording is too long' : 'bad body' });
    }
    const type = String(req.headers['content-type'] || 'audio/wav').toLowerCase();
    if (audio.length < 1000) return json(res, 400, { ok: false, error: 'Recording is empty' });
    if (!(type.includes('wav') && audio.subarray(0, 4).toString() === 'RIFF')) {
      return json(res, 415, { ok: false, error: 'Send 16 kHz mono WAV' });
    }

    const t0 = Date.now();
    try {
      const raw = await serial(() => runWhisper(audio));
      const ms = Date.now() - t0;
      const text = clean(raw);
      log.log(`stt: ${(audio.length / 32000).toFixed(1)}s audio → ${text.length} chars in ${ms}ms`);
      return json(res, 200, { ok: true, text, provider, ms });
    } catch (e) {
      log.error('stt error:', e.message);
      return json(res, 502, { ok: false, error: 'Transcription failed' });
    }
  }

  return { handle, info: () => ({ provider, model }) };
}

module.exports = { createStt, clean };
