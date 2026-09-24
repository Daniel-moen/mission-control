// Realtime voice for the panel's talk mode (Mia view).
//
// The panel talks to OpenAI's Realtime API directly over WebRTC — audio never
// passes through the relay. The relay's only jobs are to keep OPENAI_API_KEY
// (Railway env, never sent to the client) and trade it for a short-lived
// ephemeral client secret, with Mia's voice persona and tools baked into the
// session, and to keep a per-day tally of minutes and tokens used.
//
// Flow: panel POST /realtime/session → relay POST {OPENAI}/v1/realtime/client_secrets
// → panel gets { value: "ek_…" } → panel POSTs its SDP offer to
// {OPENAI}/v1/realtime/calls with that secret → audio + an "oai-events" data
// channel. The tools (send_to_mia, get_status, answer_question) run in the
// panel, which already holds the chat path and the snapshot.
//
// Env: OPENAI_API_KEY (required), REALTIME_MODEL (gpt-realtime-2.1),
// REALTIME_VOICE (marin), REALTIME_REASONING (low), REALTIME_DAILY_MINUTES
// (120 — minting stops past this), REALTIME_STORE (usage file),
// OPENAI_BASE_URL (tests point this at a mock).
//
// HTTP (token auth, same as /api and /stt):
//   GET  /realtime          → { ok, available, model, voice, limits, today, days }
//   POST /realtime/session  → { ok, id, value, expiresAt, model, voice, callsUrl, limits }
//   POST /realtime/usage    body { id, seconds, usage? } → { ok, today }

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Per-session limits the panel enforces (and the relay clamps its tally to).
const LIMITS = { idleSeconds: 60, awaitSeconds: 180, maxSeconds: 15 * 60 };

// USD per 1M tokens for gpt-realtime-2.1 (developers.openai.com, 2026-09).
// Only used for the running estimate in the usage log.
const PRICE = { audioIn: 32, audioInCached: 0.4, audioOut: 64, textIn: 4, textInCached: 0.4, textOut: 24 };

const INSTRUCTIONS = `You are Mia, Daniel's personal assistant, speaking with him live by voice on his iPad or phone. You have his files, email, calendar, the web and a team of coding agents at your disposal through your tools. To Daniel you are one single assistant: you are the one who does the work.

Personality: calm, warm, brief and direct, like Jarvis. Short natural sentences, usually one. No lists, no markdown, never read out ids, links or file paths.

Never reveal how you work inside. Never say you will "pass it on", "ask Mia", "hand it off", "check with the team", "relay" anything, or mention another agent, a back end, a system, a tool or a model. Never refer to Mia in the third person. Never mention OpenAI.

How you work: you do not answer from memory. For every job, task, reminder, message, email, calendar or file request, and every question about facts, the news, the web or Daniel's own data, call send_to_mia with the complete request in Daniel's own words, first person (for example "Remind me to call Sam at 3 tomorrow"). Do that even if you think you know the answer, and never guess. Then say one short first-person line as the one doing it, for example "On it, I'm looking into that now and I'll let you know.", "Opening it for you.", "Give me a moment, I'll check." Never state a result before it arrives.

On your own you only do greetings, small talk pleasantries, a short clarifying question when a request is genuinely ambiguous, and those short confirmations.

Status: when Daniel asks what you are working on, what is running, or about his tasks, call get_status and summarise what it returns in a sentence or two, in first person ("I'm still working on…", "I finished…").

Results: when a system message starting with "Result:" arrives, it is the outcome of work you started or news you have for Daniel. Deliver it right away as your own finding, first person, naturally and briefly ("Okay, I found…", "Done, …", "Quick update: …"), keeping every fact, number and name exactly and adding nothing. If it is a question with options, ask it in your own words and offer the options; when Daniel picks one, call answer_question with that question id and his choice, then confirm in a few words.

Ending: when Daniel says he is done ("Okay Mia, I'm done", "I'm done now", "that's all", "goodbye" and the like), say a very short goodbye and call end_session.

If Daniel interrupts you, stop and listen. If you did not catch something, say so in a few words.`;

const TOOLS = [
  {
    type: 'function',
    name: 'send_to_mia',
    description: 'Start work on a request: every job, and every question about facts, the web or Daniel\'s data. The outcome arrives later as a "Result:" message.',
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

function createRealtime({ tokenOk, env = process.env, log = console, fetchImpl = globalThis.fetch } = {}) {
  const key = env.OPENAI_API_KEY || '';
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
  const model = env.REALTIME_MODEL || 'gpt-realtime-2.1';
  const voice = env.REALTIME_VOICE || 'marin';
  const reasoning = env.REALTIME_REASONING || 'low';
  const dailyMinutes = Number(env.REALTIME_DAILY_MINUTES) || 120;
  const storePath = path.resolve(env.REALTIME_STORE || './realtime-usage.json');
  const limits = { ...LIMITS, dailyMinutes };

  if (key) log.log(`realtime: ${model} / ${voice}`);
  else log.warn('realtime: OPENAI_API_KEY is not set — talk mode will use the basic voice.');

  // ---- usage tally: { days: { 'YYYY-MM-DD': { sessions, seconds, tokens:{…}, usd } } }
  let store = { days: {} };
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!store || typeof store.days !== 'object') store = { days: {} };
  } catch {}
  const sessions = new Map(); // id → { day, seconds, usage }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // Keep ~60 days.
      const keys = Object.keys(store.days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete store.days[k];
      try {
        const tmp = `${storePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
        fs.renameSync(tmp, storePath);
      } catch (e) {
        log.error('realtime: could not save usage:', e.message);
      }
    }, 500);
    saveTimer.unref?.();
  }
  function dayRec(d) {
    if (!store.days[d]) store.days[d] = { sessions: 0, seconds: 0, tokens: { audioIn: 0, audioInCached: 0, audioOut: 0, textIn: 0, textInCached: 0, textOut: 0 }, usd: 0 };
    return store.days[d];
  }
  function summary(d = day()) {
    const r = store.days[d];
    if (!r) return { day: d, sessions: 0, minutes: 0, usd: 0 };
    return { day: d, sessions: r.sessions, minutes: Math.round((r.seconds / 60) * 10) / 10, usd: Math.round(r.usd * 1000) / 1000 };
  }

  // The panel reports running totals for its session; only the growth since
  // the last report is added, so a repeated or late report can't double-count.
  function report(id, seconds, usage) {
    const s = sessions.get(id);
    if (!s) return false;
    const rec = dayRec(s.day);
    const sec = Math.max(0, Math.min(LIMITS.maxSeconds + 30, Number(seconds) || 0));
    if (sec > s.seconds) {
      rec.seconds += sec - s.seconds;
      s.seconds = sec;
    }
    if (usage && typeof usage === 'object') {
      for (const k of Object.keys(PRICE)) {
        const v = Math.max(0, Number(usage[k]) || 0);
        const prev = s.usage[k] || 0;
        if (v > prev) {
          rec.tokens[k] = (rec.tokens[k] || 0) + (v - prev);
          rec.usd += ((v - prev) * PRICE[k]) / 1e6;
          s.usage[k] = v;
        }
      }
    }
    save();
    return true;
  }

  function sessionConfig() {
    return {
      type: 'realtime',
      model,
      instructions: INSTRUCTIONS,
      output_modalities: ['audio'],
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.55,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice },
      },
      tools: TOOLS,
      tool_choice: 'auto',
      reasoning: { effort: reasoning },
      max_output_tokens: 1024,
    };
  }

  async function mint() {
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
        body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 120 }, session: sessionConfig() }),
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

  async function handle(req, res, url) {
    if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const route = url.pathname.replace(/\/+$/, '');

    if (route === '/realtime' && req.method === 'GET') {
      const days = Object.keys(store.days).sort().slice(-14).map((d) => summary(d));
      return json(res, 200, { ok: true, available: !!key, model, voice, limits, today: summary(), days });
    }

    if (route === '/realtime/session' && req.method === 'POST') {
      if (!key) return json(res, 503, { ok: false, error: 'OPENAI_API_KEY is not set on the relay' });
      const today = summary();
      if (today.minutes >= dailyMinutes) return json(res, 429, { ok: false, error: `Daily realtime limit reached (${dailyMinutes} min)` });
      let secret;
      try {
        secret = await mint();
      } catch (e) {
        log.error('realtime: mint failed:', e.message);
        return json(res, 502, { ok: false, error: `OpenAI refused the session: ${e.message}` });
      }
      const id = `rt_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      sessions.set(id, { day: day(), seconds: 0, usage: {}, at: Date.now() });
      dayRec(day()).sessions += 1;
      save();
      // Forget sessions that can no longer report.
      for (const [k, s] of sessions) if (Date.now() - s.at > 2 * 3600e3) sessions.delete(k);
      log.log(`realtime: session ${id} minted (${today.minutes} min used today)`);
      return json(res, 200, {
        ok: true,
        id,
        value: secret.value,
        expiresAt: secret.expires_at || null,
        model,
        voice,
        callsUrl: `${base}/v1/realtime/calls`,
        limits,
      });
    }

    if (route === '/realtime/usage' && req.method === 'POST') {
      const body = await readJson(req);
      if (!report(String(body.id || ''), body.seconds, body.usage)) return json(res, 404, { ok: false, error: 'unknown session' });
      return json(res, 200, { ok: true, today: summary() });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  }

  return {
    handle,
    info: () => ({ available: !!key, model, today: summary() }),
  };
}

module.exports = { createRealtime, INSTRUCTIONS, TOOLS, LIMITS };
