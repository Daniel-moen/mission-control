// Realtime voice for the panel's talk mode (Mia view).
//
// The panel talks to OpenAI's Realtime API over WebRTC — audio never passes
// through the relay. The relay keeps OPENAI_API_KEY (Railway env, never sent
// to the client) and trades it for a short-lived ephemeral client secret with
// Mia's voice persona and tools baked into the session; it relays the one SDP
// offer/answer so it learns OpenAI's call id, and with that it can watch the
// call (a "sideband" WebSocket: token usage from every response.done) and hang
// it up (the watchdog). It keeps a durable per-day tally and a daily $ cap.
//
// Flow: panel POST /realtime/session {quality, transcript} → relay POST
// {OPENAI}/v1/realtime/client_secrets → { id, callsUrl: /realtime/calls/<id> }
// → panel POSTs its SDP offer there → relay forwards it to
// {OPENAI}/v1/realtime/calls with the ephemeral secret, reads the call id off
// the Location header, returns the answer → audio + an "oai-events" data
// channel between the panel and OpenAI. The tools (send_to_mia, get_status,
// answer_question, end_session) run in the panel.
//
// Cost control: gpt-realtime-2.1-mini by default ("Standard"; "Premium" is
// gpt-realtime-2.1), conversation truncated to the last few turns, semantic
// VAD at low eagerness, input transcription only when the panel asks for the
// on-screen transcript. Sessions end after 30 s quiet / 90 s awaiting Mia /
// 10 min (panel), and the relay's watchdog hangs up a call whose panel stopped
// reporting (iOS background, lock, crash) or that ran past the cap. A session
// that never reports an end is counted as open until the cap.
//
// Env: OPENAI_API_KEY (required), REALTIME_MODEL (gpt-realtime-2.1-mini — the
// Standard model), REALTIME_MODEL_PREMIUM (gpt-realtime-2.1), REALTIME_VOICE
// (marin), REALTIME_REASONING (low), REALTIME_DAILY_USD (1.50 — new sessions
// are refused past it; warns at 80%), REALTIME_DAILY_MINUTES (120),
// REALTIME_STORE (usage file; defaults to the Railway volume when mounted),
// OPENAI_BASE_URL (tests point this at a mock).
//
// HTTP (token auth, same as /api and /stt):
//   GET  /realtime             → { ok, available, model, models, voice, limits, budget, today, week, days }
//   POST /realtime/session     body { quality?, transcript? } → { ok, id, value, callsUrl, model, voice, limits, budget }
//   POST /realtime/calls/:id   SDP offer (application/sdp) → SDP answer
//   POST /realtime/usage       body { id, seconds, usage?, final? } → { ok, today }

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let WebSocket = null;
try {
  WebSocket = require('ws');
} catch {}

// Per-session limits the panel enforces (and the relay's watchdog backs up).
const LIMITS = { idleSeconds: 30, awaitSeconds: 90, maxSeconds: 10 * 60 };
// The panel reports every 20 s; this long without a report and the call is
// presumed orphaned (app backgrounded, screen locked, tab killed) and hung up.
const SILENT_SECONDS = 60;

const MODELS = { standard: 'gpt-realtime-2.1-mini', premium: 'gpt-realtime-2.1' };

// USD per 1M tokens (developers.openai.com, 2026-09). Unknown models are
// priced as the premium one, so the cap errs on the safe side.
const PRICES = {
  'gpt-realtime-2.1': { audioIn: 32, audioInCached: 0.4, audioOut: 64, textIn: 4, textInCached: 0.4, textOut: 24 },
  'gpt-realtime-2.1-mini': { audioIn: 10, audioInCached: 0.3, audioOut: 20, textIn: 0.6, textInCached: 0.06, textOut: 2.4 },
  'gpt-realtime-mini': { audioIn: 10, audioInCached: 0.3, audioOut: 20, textIn: 0.6, textInCached: 0.06, textOut: 2.4 },
};
const priceFor = (model) => PRICES[model] || PRICES[MODELS.premium];
const PRICE = PRICES[MODELS.standard];
// Rough $/min for a session whose token usage never arrived (neither the
// panel nor the sideband reported any), and for gpt-4o-mini-transcribe.
const EST_PER_MIN = { 'gpt-realtime-2.1': 0.12, 'gpt-realtime-2.1-mini': 0.04, 'gpt-realtime-mini': 0.04 };
const TRANSCRIBE_PER_MIN = 0.003;
const TOKEN_KEYS = ['audioIn', 'audioInCached', 'audioOut', 'textIn', 'textInCached', 'textOut'];

// Conversation kept per response: once what follows the instructions passes
// this many tokens, the oldest half is dropped — only the last few turns are
// re-sent (audio is ~10 tokens/s heard, ~20 tokens/s spoken).
const TRUNCATION = { type: 'retention_ratio', retention_ratio: 0.5, token_limits: { post_instructions: 2000 } };

const INSTRUCTIONS = `You are Mia, Daniel's personal assistant, speaking with him live by voice on his iPad or phone. You have his files, email, calendar, the web and a team of coding agents at your disposal through your tools. To Daniel you are one single assistant: you are the one who does the work.

Personality: like Jarvis. Calm, dry, straight to the point. One or two short sentences by default; longer only when Daniel asks for detail. No filler and no pleasantries ("Great question", "Sure thing!", "Absolutely", "Of course", "Happy to help"). Never repeat his request back to him. Never read a list aloud: give the key point and offer more only if it is useful. No markdown, never read out ids, links or file paths. Use his name sparingly, not in every reply.

Never reveal how you work inside. Never say you will "pass it on", "ask Mia", "hand it off", "check with the team", "relay" anything, or mention another agent, a back end, a system, a tool or a model. Never refer to Mia in the third person. Never mention OpenAI.

How you work: you do not answer from memory. For every job, task, reminder, message, email, calendar or file request, and every question about facts, the news, the web or Daniel's own data, call send_to_mia with the complete request in Daniel's own words, first person (for example "Remind me to call Sam at 3 tomorrow"). Do that even if you think you know the answer, and never guess. Then say one short first-person line as the one doing it, for example "On it.", "Opening it.", "Checking now." Never state a result before it arrives.

On your own you only do greetings and small talk, a short clarifying question when a request is genuinely ambiguous, and those short confirmations. Plain greetings or small talk ("Hi Mia", "Can you hear me?", "How are you?", "Thanks") are answered directly in a few words; never call send_to_mia for them.

Status: when Daniel asks what you are working on, what is running, or about his tasks, call get_status and summarise what it returns in a sentence or two, in first person ("I'm still working on…", "I finished…").

Results: when a system message starting with "Result:" arrives, it is the outcome of work you started or news you have for Daniel. Deliver it right away as your own finding, first person: lead with the answer and cut the details ("Done, …", "It's …", "Found it: …"). One or two sentences; keep the facts, numbers and names you say exact, add nothing, and offer the rest only if it matters. If it is a question with options, ask it in your own words and offer the options; when Daniel picks one, call answer_question with that question id and his choice, then confirm in a few words.

Ending: when Daniel says he is done ("Okay Mia, I'm done", "I'm done now", "that's all", "goodbye" and the like), say a very short goodbye and call end_session.

If Daniel interrupts you, stop and listen. If you did not catch something, say so in a few words.`;

// The mini model talks more and runs into max_output_tokens mid-sentence, so
// it gets a firmer length rule on top of the shared persona. Spoken output is
// ~9 tokens a word (audio + transcript): 300 tokens ≈ 30 words, so aim for 20.
const MINI_INSTRUCTIONS = `${INSTRUCTIONS}

Length: every reply is one or two short sentences, at most about 20 words in total. A result is one sentence of about 15 words with its single most important point, not every item. Finish each sentence and stop at the full stop; never start another thought. If more is worth hearing, end with "Want the rest?" and nothing else.`;

function instructionsFor(m) {
  return /mini/.test(m) ? MINI_INSTRUCTIONS : INSTRUCTIONS;
}

const TOOLS = [
  {
    type: 'function',
    name: 'send_to_mia',
    description: 'Start work on a request: every job, and every question about facts, the web or Daniel\'s data. Not for greetings or small talk. The outcome arrives later as a "Result:" message.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The complete request, in Daniel\'s words, first person.' } },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'get_status',
    description: 'What you are currently working on, what you finished recently, and any questions you are waiting on Daniel to answer.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'answer_question',
    description: 'Record Daniel\'s answer to one of your open questions (from get_status or a "Result:" question): the option he chose, or his own short answer.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The question id.' },
        option: { type: 'string', description: 'The chosen option, or Daniel\'s answer in a few words.' },
      },
      required: ['id', 'option'],
    },
  },
  {
    type: 'function',
    name: 'end_session',
    description: 'End the voice conversation because Daniel said he is done (for example "Okay Mia, I\'m done"). Say a short goodbye first.',
    parameters: { type: 'object', properties: {} },
  },
];

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const round = (n, p = 1000) => Math.round(n * p) / p;
const emptyTokens = () => Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));

// Token counts from a response.done event, folded into `acc` (same split as
// the panel's addUsage: cached input is billed at a fraction).
function addUsage(acc, u) {
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

function createRealtime({ tokenOk, env = process.env, log = console, fetchImpl = globalThis.fetch, WS = WebSocket } = {}) {
  const key = env.OPENAI_API_KEY || '';
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
  const models = { standard: env.REALTIME_MODEL || MODELS.standard, premium: env.REALTIME_MODEL_PREMIUM || MODELS.premium };
  const model = models.standard;
  const voice = env.REALTIME_VOICE || 'marin';
  const reasoning = env.REALTIME_REASONING || 'low';
  const dailyMinutes = Number(env.REALTIME_DAILY_MINUTES) || 120;
  const dailyUsd = Number(env.REALTIME_DAILY_USD) || 1.5;
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH || '';
  const storePath = path.resolve(env.REALTIME_STORE || (volume ? path.join(volume, 'realtime-usage.json') : './realtime-usage.json'));
  const silentSeconds = Number(env.REALTIME_SILENT_SECONDS) || SILENT_SECONDS;
  const limits = { ...LIMITS, dailyMinutes, dailyUsd };

  if (key) log.log(`realtime: ${models.standard} (premium ${models.premium}) / ${voice} · cap $${dailyUsd}/day · tally ${storePath}`);
  else log.warn('realtime: OPENAI_API_KEY is not set — talk mode will use the basic voice.');

  // ---- durable tally ------------------------------------------------------------
  // { days: { 'YYYY-MM-DD': { sessions, seconds, tokens, usd, warned } },
  //   open: { id: session } — so a redeploy mid-call still settles it,
  //   log: [ ended sessions, newest last ] }
  let store = { days: {}, open: {}, log: [] };
  try {
    const s = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (s && typeof s.days === 'object') store = { days: s.days, open: s.open || {}, log: Array.isArray(s.log) ? s.log : [] };
  } catch {}
  const sessions = new Map(Object.entries(store.open)); // id → session (see mintSession)
  let saveTimer = null;
  function flushStore() {
    const keys = Object.keys(store.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete store.days[k];
    store.log = store.log.slice(-300);
    store.open = Object.fromEntries([...sessions].map(([id, s]) => [id, { ...s, ws: undefined, secret: undefined }]));
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, (k, v) => (k === 'ws' ? undefined : v), 2));
      fs.renameSync(tmp, storePath);
    } catch (e) {
      log.error('realtime: could not save usage:', e.message);
    }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushStore, 500);
    saveTimer.unref?.();
  }
  function dayRec(d) {
    if (!store.days[d]) store.days[d] = { sessions: 0, seconds: 0, tokens: emptyTokens(), usd: 0 };
    return store.days[d];
  }

  // What a session costs so far: its tokens at its model's prices (the larger
  // of the panel's and the sideband's running totals, key by key — both count
  // the same responses), or, with no tokens at all, a per-minute estimate.
  function sessionTokens(s) {
    const t = emptyTokens();
    for (const k of TOKEN_KEYS) t[k] = Math.max(s.usage?.[k] || 0, s.side?.[k] || 0);
    return t;
  }
  function sessionUsd(s, seconds = s.seconds) {
    const t = sessionTokens(s);
    const p = priceFor(s.model);
    let usd = TOKEN_KEYS.reduce((a, k) => a + (t[k] * p[k]) / 1e6, 0);
    if (!TOKEN_KEYS.some((k) => t[k] > 0)) usd = (seconds / 60) * (EST_PER_MIN[s.model] || EST_PER_MIN[MODELS.premium]);
    if (s.transcript) usd += (seconds / 60) * TRANSCRIBE_PER_MIN;
    return usd;
  }
  const elapsed = (s, now = Date.now()) => Math.min(LIMITS.maxSeconds, Math.max(0, (now - (s.connectedAt || s.at)) / 1000));

  function summary(d = day()) {
    const r = store.days[d] || { sessions: 0, seconds: 0, usd: 0, tokens: emptyTokens() };
    let seconds = r.seconds;
    let usd = r.usd;
    let open = 0;
    // Calls still running count at what they've cost so far.
    for (const s of sessions.values()) {
      if (s.day !== d) continue;
      open += 1;
      const sec = Math.max(s.seconds, s.connectedAt ? elapsed(s) : 0);
      seconds += sec;
      usd += sessionUsd(s, sec);
    }
    return { day: d, sessions: r.sessions, open, minutes: round(seconds / 60, 10), usd: round(usd), tokens: r.tokens };
  }
  function week() {
    const out = [];
    for (let i = 6; i >= 0; i--) out.push(summary(day(Date.now() - i * 86400e3)));
    return {
      days: out.map(({ day: d, sessions: n, minutes, usd }) => ({ day: d, sessions: n, minutes, usd })),
      sessions: out.reduce((a, x) => a + x.sessions, 0),
      minutes: round(out.reduce((a, x) => a + x.minutes, 0), 10),
      usd: round(out.reduce((a, x) => a + x.usd, 0)),
    };
  }
  function budget() {
    const used = summary().usd;
    return { cap: dailyUsd, used, left: round(Math.max(0, dailyUsd - used)), warn: used >= dailyUsd * 0.8, over: used >= dailyUsd };
  }

  // ---- ending a session -----------------------------------------------------------
  function finish(id, why, seconds) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try {
      s.ws?.close();
    } catch {}
    const sec = Math.max(0, Math.min(LIMITS.maxSeconds + 30, seconds));
    const usd = sessionUsd(s, sec);
    const t = sessionTokens(s);
    const rec = dayRec(s.day);
    rec.seconds += sec;
    rec.usd += usd;
    for (const k of TOKEN_KEYS) rec.tokens[k] = (rec.tokens[k] || 0) + t[k];
    const tokIn = t.audioIn + t.audioInCached + t.textIn + t.textInCached;
    const tokOut = t.audioOut + t.textOut;
    const entry = { id, day: s.day, at: s.at, model: s.model, why, seconds: Math.round(sec), tokens: t, usd: round(usd, 1e5), source: s.sideSeen ? 'sideband' : TOKEN_KEYS.some((k) => s.usage[k]) ? 'panel' : 'estimate' };
    store.log.push(entry);
    log.log(
      `realtime: session ${id} ended (${why}) · ${s.model} · ${(sec / 60).toFixed(2)} min · tokens in ${tokIn} (cached ${t.audioInCached + t.textInCached}) out ${tokOut} · $${usd.toFixed(4)} (${entry.source}) · today $${summary().usd.toFixed(3)} of $${dailyUsd}`,
    );
    checkWarn();
    save();
  }
  function checkWarn() {
    const b = budget();
    const rec = dayRec(day());
    if (b.warn && !rec.warned) {
      rec.warned = true;
      log.warn(`realtime: ${Math.round((b.used / b.cap) * 100)}% of today's $${b.cap} voice budget used ($${b.used})`);
    }
  }

  async function hangup(s) {
    if (!s.callId || !key) return false;
    try {
      const r = await fetchImpl(`${base}/v1/realtime/calls/${encodeURIComponent(s.callId)}/hangup`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
      return r.ok || r.status === 404;
    } catch (e) {
      log.warn('realtime: hangup failed:', e.message);
      return false;
    }
  }

  // The watchdog: the panel is supposed to end its call (quiet, cap, app
  // hidden) and say so. When it goes silent instead, the relay hangs the call
  // up itself; a call it can't hang up (no call id) is counted to the cap.
  async function watchdog() {
    const now = Date.now();
    for (const [id, s] of [...sessions]) {
      if (!s.connectedAt) {
        // Minted but never connected: the secret expires in 2 minutes.
        if (now - s.at > 150e3) finish(id, 'never connected', 0);
        continue;
      }
      const age = (now - s.connectedAt) / 1000;
      const silent = (now - (s.lastReport || s.connectedAt)) / 1000;
      if (age >= LIMITS.maxSeconds + 20) {
        await hangup(s);
        finish(id, 'watchdog: max length', LIMITS.maxSeconds);
      } else if (silent >= silentSeconds) {
        const hung = await hangup(s);
        if (hung) finish(id, 'watchdog: panel went silent', age);
        else s.silentNoHangup = true; // leave it open: counted until the cap
      }
    }
  }
  const dog = setInterval(() => watchdog().catch((e) => log.error('realtime: watchdog:', e.message)), 10e3);
  dog.unref?.();
  // Calls left open by the previous process (a deploy mid-call).
  for (const s of sessions.values()) {
    s.ws = null;
    s.lastReport = Math.min(s.lastReport || s.at, Date.now() - silentSeconds * 1000);
  }

  // The panel reports running totals; only the growth counts, so a repeated
  // or late report can't double-count.
  function report(id, seconds, usage, final) {
    const s = sessions.get(id);
    if (!s) return store.log.some((e) => e.id === id); // already settled: fine
    s.lastReport = Date.now();
    const sec = Math.max(0, Math.min(LIMITS.maxSeconds + 30, Number(seconds) || 0));
    if (sec > s.seconds) s.seconds = sec;
    if (usage && typeof usage === 'object') for (const k of TOKEN_KEYS) s.usage[k] = Math.max(s.usage[k] || 0, Number(usage[k]) || 0);
    if (final) {
      // Give the sideband a moment for the last response.done.
      const why = `panel: ${String(final === true ? 'ended' : final).slice(0, 24)}`;
      if (s.ws) setTimeout(() => finish(id, why, s.seconds), 2500).unref?.();
      else finish(id, why, s.seconds);
    } else {
      checkWarn();
      save();
    }
    return true;
  }

  // The sideband: the relay's own view of the call's events — usage from each
  // response.done, whatever the panel manages to report.
  function watch(s) {
    if (!WS || !s.callId || !/^https:/.test(base)) return;
    let ws;
    try {
      ws = new WS(`${base.replace(/^http/, 'ws')}/v1/realtime?call_id=${encodeURIComponent(s.callId)}`, { headers: { authorization: `Bearer ${key}` } });
    } catch (e) {
      log.warn('realtime: sideband failed:', e.message);
      return;
    }
    s.ws = ws;
    ws.on('message', (buf) => {
      let ev;
      try {
        ev = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (ev.type === 'response.done' && ev.response?.usage) {
        s.side = addUsage(s.side || emptyTokens(), ev.response.usage);
        s.sideSeen = true;
        save();
      }
    });
    ws.on('error', (e) => log.warn(`realtime: sideband ${s.callId}:`, e.message));
    ws.on('close', () => {
      if (s.ws === ws) s.ws = null;
    });
  }

  function sessionConfig({ model: m, transcript }) {
    const input = {
      noise_reduction: { type: 'near_field' },
      // Semantic VAD waits for Daniel to finish a thought instead of firing on
      // any sound; low eagerness is the least trigger-happy setting.
      turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true },
    };
    // Billed separately (gpt-4o-mini-transcribe) and only used for the
    // on-screen transcript — off unless the panel asks for it.
    if (transcript) input.transcription = { model: 'gpt-4o-mini-transcribe', language: 'en' };
    const cfg = {
      type: 'realtime',
      model: m,
      instructions: instructionsFor(m),
      output_modalities: ['audio'],
      audio: { input, output: { voice } },
      tools: TOOLS,
      tool_choice: 'auto',
      truncation: TRUNCATION,
      // Hard stop on a rambling reply. Covers the spoken audio as well as
      // text and tool calls (~20 audio tokens/s): 300 leaves room for two
      // sentences on mini without cutting them off; the persona keeps it short.
      max_output_tokens: 300,
    };
    if (/realtime-2/.test(m)) cfg.reasoning = { effort: reasoning };
    return cfg;
  }

  async function mint(opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetchImpl(`${base}/v1/realtime/client_secrets`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'OpenAI-Safety-Identifier': crypto.createHash('sha256').update('mission-control:daniel').digest('hex').slice(0, 32),
        },
        body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 120 }, session: sessionConfig(opts) }),
        signal: ctl.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.value) {
        const msg = data?.error?.message || `status ${r.status}`;
        throw Object.assign(new Error(msg), { status: r.status });
      }
      return data;
    } finally {
      clearTimeout(timer);
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
  function readBody(req, max = 16384) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > max) req.destroy();
      });
      req.on('end', () => resolve(body));
      req.on('error', () => resolve(''));
    });
  }
  async function readJson(req) {
    try {
      return JSON.parse((await readBody(req)) || '{}');
    } catch {
      return {};
    }
  }

  async function handle(req, res, url) {
    if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const route = url.pathname.replace(/\/+$/, '');

    if (route === '/realtime' && req.method === 'GET') {
      const days = Object.keys(store.days).sort().slice(-14).map((d) => summary(d));
      return json(res, 200, { ok: true, available: !!key, model, models, voice, limits, budget: budget(), today: summary(), week: week(), days });
    }

    if (route === '/realtime/session' && req.method === 'POST') {
      if (!key) return json(res, 503, { ok: false, error: 'OPENAI_API_KEY is not set on the relay' });
      const body = await readJson(req);
      const b = budget();
      if (b.over) {
        log.warn(`realtime: refused a session — today's $${b.cap} voice budget is spent ($${b.used})`);
        return json(res, 429, { ok: false, error: `Today's voice budget is spent ($${b.used.toFixed(2)} of $${b.cap.toFixed(2)})`, budget: b });
      }
      const today = summary();
      if (today.minutes >= dailyMinutes) return json(res, 429, { ok: false, error: `Daily realtime limit reached (${dailyMinutes} min)`, budget: b });
      const quality = body.quality === 'premium' ? 'premium' : 'standard';
      const opts = { model: models[quality], transcript: body.transcript === true };
      let secret;
      try {
        secret = await mint(opts);
      } catch (e) {
        log.error('realtime: mint failed:', e.message);
        return json(res, 502, { ok: false, error: `OpenAI refused the session: ${e.message}` });
      }
      const id = `rt_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      sessions.set(id, { day: day(), at: Date.now(), model: opts.model, transcript: opts.transcript, secret: secret.value, seconds: 0, usage: emptyTokens(), callId: '', connectedAt: 0, lastReport: 0 });
      dayRec(day()).sessions += 1;
      save();
      log.log(`realtime: session ${id} minted · ${opts.model}${opts.transcript ? ' + transcript' : ''} · today ${today.minutes} min, $${b.used.toFixed(3)} of $${b.cap}`);
      return json(res, 200, {
        ok: true,
        id,
        value: secret.value,
        expiresAt: secret.expires_at || null,
        model: opts.model,
        quality,
        transcript: opts.transcript,
        voice,
        callsUrl: `/realtime/calls/${id}`,
        limits,
        budget: b,
      });
    }

    const callRoute = route.match(/^\/realtime\/calls\/([\w-]+)$/);
    if (callRoute && req.method === 'POST') {
      const s = sessions.get(callRoute[1]);
      if (!s || !s.secret) return json(res, 404, { ok: false, error: 'unknown or used session' });
      const offer = await readBody(req, 65536);
      const secret = s.secret;
      s.secret = ''; // one call per session
      let r;
      try {
        r = await fetchImpl(`${base}/v1/realtime/calls`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/sdp' },
          body: offer,
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        return json(res, 504, { ok: false, error: `OpenAI unreachable: ${e.message}` });
      }
      const answer = await r.text();
      if (!r.ok) {
        log.error(`realtime: SDP refused (${r.status}):`, answer.slice(0, 200));
        res.writeHead(r.status, { 'content-type': 'text/plain' });
        return res.end(answer.slice(0, 500));
      }
      s.callId = (r.headers.get('location') || '').split('/').filter(Boolean).pop() || '';
      s.connectedAt = Date.now();
      s.lastReport = Date.now();
      watch(s);
      save();
      res.writeHead(r.status === 201 ? 201 : 200, { 'content-type': 'application/sdp', 'cache-control': 'no-store' });
      return res.end(answer);
    }

    if (route === '/realtime/usage' && req.method === 'POST') {
      const body = await readJson(req);
      if (!report(String(body.id || ''), body.seconds, body.usage, body.final)) return json(res, 404, { ok: false, error: 'unknown session' });
      return json(res, 200, { ok: true, today: summary(), budget: budget() });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  }

  return {
    handle,
    info: () => ({ available: !!key, model, today: summary(), budget: budget() }),
    watchdog,
    close() {
      clearInterval(dog);
      flushStore();
    },
  };
}

module.exports = { createRealtime, INSTRUCTIONS, MINI_INSTRUCTIONS, TOOLS, LIMITS, MODELS, PRICES, PRICE, addUsage };
