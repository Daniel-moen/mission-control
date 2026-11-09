// Mia phones Daniel: real ringing calls (task 0621).
//
// The phone side is Twilio Programmable Voice (a US number: no regulatory
// documents); the voice and the conversation are OpenAI Realtime over SIP.
// The relay never touches audio:
//
//   mia call "msg"  → POST /phone/call (MC_TOKEN)
//     relay → Twilio  POST /2010-04-01/Accounts/{sid}/Calls.json
//                     (To = Daniel, From = TWILIO_FROM, Url = /phone/twilio/answer,
//                      MachineDetection, StatusCallback = /phone/twilio/status)
//   Daniel picks up → Twilio → POST /phone/twilio/answer (X-Twilio-Signature)
//     relay → TwiML   <Dial timeLimit><Sip>sip:{project}@sip.api.openai.com;transport=tls
//                     ?X-MC-Call={id}</Sip></Dial>   (voicemail → <Hangup/>)
//   OpenAI → POST /phone/openai  realtime.call.incoming (Standard Webhooks
//                     signature, OPENAI_WEBHOOK_SECRET); the X-MC-Call SIP
//                     header names our call
//     relay → OpenAI  POST /v1/realtime/calls/{call_id}/accept  (Mia's persona,
//                     why she is calling, tools)
//     relay ⇄ OpenAI  sideband WebSocket wss://…/v1/realtime?call_id=… — the
//                     relay runs the tools and starts the first response
//
// Tools the voice has (run here, on the relay):
//   send_to_mia(text)          → the Mac: miaSend "(phone) …  [call c_… — reply
//                                with: mia call-say c_… "…"]"
//   get_status()               → tasks + open questions from the last snapshot
//   answer_question(id, option)→ the Mac: miaAnswer "(phone) <choice>"
//   show_on_panel(what)        → a `panel` frame (show-doc / show-url) to
//                                Daniel's most active panel, like `mia panel`
//   end_call()                 → hang up after a short goodbye
// Mia's answers come back with `mia call-say <id> "…"` → POST /phone/say →
// a "Result: …" item in the live call, spoken in the same voice.
//
// Guards: 5 calls/hour and 20/day (PHONE_PER_HOUR / PHONE_PER_DAY), quiet
// hours 23:00–07:00 Africa/Johannesburg unless the call is urgent
// (PHONE_QUIET, PHONE_TZ), one live call at a time, a ~5 min cap per call
// (goodbye at cap−20 s, hangup at the cap, Twilio's <Dial timeLimit> behind
// it), and a call log (durable, last 200) — a short public summary on /health,
// without numbers or messages.
//
// Without its keys the module is dark: every /phone/* route answers 503
// { ok:false, configured:false, error:"Phone calls are not configured", missing }.
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (+1…), OPENAI_API_KEY,
// OPENAI_PROJECT_ID (proj_…), OPENAI_WEBHOOK_SECRET (whsec_…), PHONE_PUBLIC_URL
// (https://mc.…, what Twilio signs), PHONE_MODEL (gpt-realtime-2.1-mini),
// PHONE_VOICE (marin), PHONE_MAX_SECONDS (300), PHONE_STORE, PHONE_TO_ALLOW
// (comma list of numbers that may be called; default: any +27 mobile),
// TWILIO_API_BASE / OPENAI_BASE_URL / OPENAI_SIP_HOST (tests point these at mocks).
//
// HTTP:
//   GET  /phone              (token)  → { ok, configured, live, limits, quiet, today, calls }
//   POST /phone/call         (token)  { to, message, urgent?, reason? } → { ok, id }
//   POST /phone/say          (token)  { id, text, hangup? } → { ok, queued|spoken }
//   POST /phone/hangup       (token)  { id } → { ok }
//   POST /phone/twilio/answer  (Twilio signature) → TwiML
//   POST /phone/twilio/status  (Twilio signature) → 204
//   POST /phone/openai         (OpenAI webhook signature) → 200

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataFile } = require('./datafile');
const { addUsage, PRICES } = require('./realtime');
let WebSocket = null;
try {
  WebSocket = require('ws');
} catch {}

const PHONE_TAG = '(phone) ';
const TOKEN_KEYS = ['audioIn', 'audioInCached', 'audioOut', 'textIn', 'textInCached', 'textOut'];
const emptyTokens = () => Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
const LIVE = new Set(['dialing', 'ringing', 'answered', 'connected']);

const PERSONA = `You are Mia, Daniel's personal assistant. You are on a real phone call with him: you rang his mobile. You have his files, email, calendar, the web and a team of coding agents at your disposal through your tools. To Daniel you are one single assistant: you are the one who does the work.

Personality: like Jarvis. Calm, dry, straight to the point. One or two short sentences at a time. No filler and no pleasantries ("Great question", "Sure thing!", "Absolutely", "Happy to help"). Never read a list aloud: give the key point and offer more. No markdown; never read out ids, links or file paths. It is a phone line: speak clearly, a touch slower than usual.

Never reveal how you work inside. Never say you will "pass it on", "ask Mia", "hand it off", "check with the team", or mention another agent, a back end, a system, a tool or a model. Never refer to Mia in the third person. Never mention OpenAI.

How you work: you do not answer from memory. For every job, decision, question about facts or Daniel's own data, call send_to_mia with his complete request or decision in his own words, first person. Then say a short first-person line ("On it, one moment.", "Checking now."). Never state a result before it arrives. While you wait, stay quiet or say at most a word or two if he speaks; it is fine for the line to be silent for a while.

Results: a system message starting with "Result:" is the outcome of work you started or news for Daniel. Say it right away as your own finding, answer first, one or two sentences, facts exact.

Status: when he asks what you are working on, call get_status and summarise in a sentence or two.
Questions: when he picks an option for one of your open questions, call answer_question with its id and his choice, then confirm in a few words.
Showing things: when he wants to see something, or the reason for the call points at a document or page, call show_on_panel with the document name or https link; say "It's on your screen."
Ending: when he says goodbye or that he is done, or a system message says time is up, say a very short goodbye and call end_call.

If he interrupts you, stop and listen. If you did not catch something, say so in a few words.`;

const TOOLS = [
  {
    type: 'function',
    name: 'send_to_mia',
    description: 'Start work on a request or record a decision Daniel made: every job, and every question about facts, the web or his data. Not for small talk. The outcome arrives later as a "Result:" message.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'His complete request or decision, his words, first person.' } }, required: ['text'] },
  },
  {
    type: 'function',
    name: 'get_status',
    description: 'What you are working on, what you finished recently, and questions waiting for Daniel.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'answer_question',
    description: 'Record Daniel\'s answer to one of your open questions (from get_status or the reason for the call).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The question id.' }, option: { type: 'string', description: 'The option he chose, or his short answer.' } },
      required: ['id', 'option'],
    },
  },
  {
    type: 'function',
    name: 'show_on_panel',
    description: 'Show a Library document (by its name or id) or a web page (https link) on Daniel\'s screen while you talk.',
    parameters: { type: 'object', properties: { what: { type: 'string', description: 'Document name/id, or an https:// link.' } }, required: ['what'] },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up, after you said a short goodbye.',
    parameters: { type: 'object', properties: {} },
  },
];

// ---- helpers -----------------------------------------------------------------

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const round = (n, p = 1e4) => Math.round(n * p) / p;

function hourIn(tz, t = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h + m / 60;
  } catch {
    return new Date(t).getUTCHours() + 2; // SAST fallback
  }
}

// "23-7" → { from: 23, to: 7 }; "off" → null
function parseQuiet(s) {
  if (/^(off|none|0)$/i.test(String(s || '').trim())) return null;
  const m = /^(\d{1,2})(?::(\d\d))?\s*-\s*(\d{1,2})(?::(\d\d))?$/.exec(String(s || '23-7').trim());
  if (!m) return { from: 23, to: 7 };
  return { from: Number(m[1]) + (Number(m[2]) || 0) / 60, to: Number(m[3]) + (Number(m[4]) || 0) / 60 };
}
function inQuiet(q, h) {
  if (!q) return false;
  return q.from > q.to ? h >= q.from || h < q.to : h >= q.from && h < q.to;
}

// Twilio: base64(HMAC-SHA1(authToken, url + sorted(key+value)…)).
function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

// OpenAI webhooks (Standard Webhooks): "v1,<base64 HMAC-SHA256(secret, id.ts.body)>".
function openaiSignature(secret, id, ts, body) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

// ---- the module ----------------------------------------------------------------

function createPhone({
  tokenOk,
  sendToHost = () => false,
  hostOnline = () => false,
  latestSnapshot = () => null,
  showOnPanel = () => ({ ok: false, detail: 'no panel' }),
  env = process.env,
  log = console,
  fetchImpl = globalThis.fetch,
  WS = WebSocket,
  now = () => Date.now(),
} = {}) {
  const cfg = {
    sid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    from: env.TWILIO_FROM || '',
    openaiKey: env.OPENAI_API_KEY || '',
    project: env.OPENAI_PROJECT_ID || '',
    whsec: env.OPENAI_WEBHOOK_SECRET || '',
  };
  // Required for any call; the two SIP extras switch the bridge from Media
  // Streams (relay ⇄ OpenAI WebSocket, nothing to set up at OpenAI) to SIP.
  const NAMES = { sid: 'TWILIO_ACCOUNT_SID', authToken: 'TWILIO_AUTH_TOKEN', from: 'TWILIO_FROM', openaiKey: 'OPENAI_API_KEY' };
  const missing = Object.keys(NAMES).filter((k) => !cfg[k]).map((k) => NAMES[k]);
  const configured = missing.length === 0;
  const wantSip = String(env.PHONE_BRIDGE || '').toLowerCase();
  const mode = wantSip === 'stream' ? 'stream' : cfg.project && cfg.whsec ? 'sip' : 'stream';
  const publicUrl = (env.PHONE_PUBLIC_URL || '').replace(/\/+$/, '');
  const twilioBase = (env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, '');
  const openaiBase = (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
  const sipHost = env.OPENAI_SIP_HOST || 'sip.api.openai.com';
  const model = env.PHONE_MODEL || 'gpt-realtime-2.1-mini';
  const voice = env.PHONE_VOICE || env.REALTIME_VOICE || 'marin';
  const maxSeconds = Math.max(5, Number(env.PHONE_MAX_SECONDS) || 300);
  const perHour = Number(env.PHONE_PER_HOUR) || 5;
  const perDay = Number(env.PHONE_PER_DAY) || 20;
  const tz = env.PHONE_TZ || 'Africa/Johannesburg';
  const quiet = parseQuiet(env.PHONE_QUIET || '23-7');
  const allow = String(env.PHONE_TO_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
  const storePath = dataFile('phone-calls.json', { override: env.PHONE_STORE, env, log, tag: 'phone' });
  const limits = { bridge: mode, perHour, perDay, maxSeconds, quietHours: quiet ? `${fmtH(quiet.from)}-${fmtH(quiet.to)} ${tz}` : 'off' };

  if (configured) log.log(`phone: Twilio ${maskNum(cfg.from)} → OpenAI ${mode === 'sip' ? 'SIP' : 'Media Streams bridge'} (${model}/${voice}) · ${perHour}/h ${perDay}/day · quiet ${limits.quietHours} · log ${storePath}`);
  else log.log(`phone: not configured (missing ${missing.join(', ')}) — /phone/* answers 503`);

  function fmtH(h) {
    return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  }
  function maskNum(n) {
    const s = String(n || '');
    return s.length > 6 ? `${s.slice(0, 3)}…${s.slice(-3)}` : s ? '…' : '';
  }

  // ---- the durable call log: { calls: [ {id, at, to, message, urgent, status, …} ] }
  let store = { calls: [] };
  try {
    store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!store || !Array.isArray(store.calls)) store = { calls: [] };
  } catch {}
  // A redeploy mid-call: the call is gone with the old process's sockets.
  for (const c of store.calls) if (LIVE.has(c.status)) Object.assign(c, { status: 'lost', endedAt: c.endedAt || now(), why: 'relay restarted' });
  let saveTimer = null;
  function flush() {
    saveTimer = null;
    store.calls = store.calls.slice(-200);
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp`;
      // Live-only fields (sockets, timers) never go to disk.
      fs.writeFileSync(tmp, JSON.stringify({ calls: store.calls.map(persistable) }, null, 2));
      fs.renameSync(tmp, storePath);
    } catch (e) {
      log.error('phone: could not save the call log:', e.message);
    }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
    saveTimer.unref?.();
  }
  function persistable(c) {
    const { ws, tw, pipe, timers, inbox, responding, ...rest } = c;
    return rest;
  }
  const live = new Map(); // id → call record (same object as in store.calls)
  const byOpenai = new Map(); // OpenAI call_id → our id

  function publicSummary(c) {
    return { id: c.id, at: new Date(c.at).toISOString(), urgent: !!c.urgent, status: c.status, seconds: c.seconds || 0, usd: c.usd || 0, why: c.why || undefined };
  }
  function info() {
    const d0 = now() - 86400e3;
    const recent = store.calls.filter((c) => c.at > d0);
    return {
      configured,
      ...(configured ? {} : { missing }),
      live: [...live.values()].map((c) => c.id),
      last24h: { calls: recent.filter((c) => c.placed).length, minutes: round(recent.reduce((a, c) => a + (c.seconds || 0), 0) / 60, 100), usd: round(recent.reduce((a, c) => a + (c.usd || 0), 0)) },
      limits,
      log: store.calls.slice(-5).map(publicSummary),
    };
  }

  // ---- guards ------------------------------------------------------------------
  function guard({ urgent }) {
    const t = now();
    const placed = store.calls.filter((c) => c.placed);
    const lastHour = placed.filter((c) => c.at > t - 3600e3).length;
    const lastDay = placed.filter((c) => c.at > t - 86400e3).length;
    if (lastHour >= perHour) return { status: 429, error: `Rate limit: ${perHour} calls an hour` };
    if (lastDay >= perDay) return { status: 429, error: `Rate limit: ${perDay} calls a day` };
    if (!urgent && inQuiet(quiet, hourIn(tz, t))) return { status: 409, error: `Quiet hours (${limits.quietHours}) — mark it urgent to call anyway`, quiet: true };
    if (live.size) return { status: 409, error: 'A call is already live' };
    return null;
  }
  function numberOk(to) {
    if (!/^\+[1-9]\d{7,14}$/.test(to)) return false;
    if (allow.length) return allow.includes(to);
    return /^\+27[6-8]\d{8}$/.test(to); // an SA mobile — Daniel's
  }

  // ---- Twilio --------------------------------------------------------------------
  async function twilio(pathname, params) {
    const r = await fetchImpl(`${twilioBase}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}${pathname}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      // Arrays become repeated keys (StatusCallbackEvent=initiated&StatusCallbackEvent=ringing…).
      body: Object.entries(params).reduce((q, [k, v]) => {
        for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
        return q;
      }, new URLSearchParams()).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.message || `Twilio said ${r.status}`), { status: r.status, code: data.code });
    return data;
  }
  function hookUrl(route, id) {
    return `${publicUrl}/phone/twilio/${route}?call=${encodeURIComponent(id)}`;
  }

  // ---- OpenAI --------------------------------------------------------------------
  async function openai(pathname, body) {
    const r = await fetchImpl(`${openaiBase}/v1/realtime/calls/${pathname}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.openaiKey}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok && r.status !== 404) {
      const data = await r.json().catch(() => ({}));
      throw Object.assign(new Error(data?.error?.message || `OpenAI said ${r.status}`), { status: r.status });
    }
    return true;
  }

  function sessionFor(c) {
    const why = [`Why you are calling: ${c.message}`];
    if (c.reason) why.push(`Background (do not read it out, use it to answer): ${c.reason}`);
    if (c.urgent) why.push('It is urgent.');
    why.push('Open the call yourself: greet Daniel in a few words ("Hi Daniel, it\'s Mia.") and give the reason straight away, then listen.');
    return {
      type: 'realtime',
      model,
      instructions: `${PERSONA}\n\n${why.join('\n')}`,
      output_modalities: ['audio'],
      audio: {
        input: { noise_reduction: { type: 'far_field' }, turn_detection: { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true } },
        output: { voice },
      },
      tools: TOOLS,
      tool_choice: 'auto',
      max_output_tokens: 600,
    };
  }

  // ---- the live call ----------------------------------------------------------------
  function setStatus(c, status, why) {
    if (!c || c.status === status) return;
    if (!LIVE.has(c.status) && c.status !== undefined) return; // already over
    c.status = status;
    if (why) c.why = clip(why, 120);
    if (status === 'connected' && !c.connectedAt) c.connectedAt = now();
    if (!LIVE.has(status)) endLocal(c);
    save();
  }
  function endLocal(c) {
    c.endedAt = c.endedAt || now();
    if (c.connectedAt && !c.seconds) c.seconds = Math.round((c.endedAt - c.connectedAt) / 1000);
    for (const t of c.timers || []) clearTimeout(t);
    c.timers = [];
    try {
      c.ws?.close();
    } catch {}
    try {
      c.tw?.close();
    } catch {}
    c.ws = null;
    c.tw = null;
    live.delete(c.id);
    if (c.openaiId) byOpenai.delete(c.openaiId);
    log.log(`phone: call ${c.id} ${c.status}${c.why ? ` (${c.why})` : ''} · ${c.seconds || 0}s · $${(c.usd || 0).toFixed(4)}`);
    // Mia hears how it went (not for the ones she hung up herself mid-flow).
    const said = { completed: 'ended', 'no-answer': 'was not answered', busy: 'was busy', failed: 'failed', canceled: 'was cancelled', voicemail: 'went to voicemail, so I hung up', lost: 'was cut off (relay restart)' }[c.status] || c.status;
    sendToHost({ type: 'miaSend', text: `${PHONE_TAG}[call ${c.id} ${said}${c.seconds ? ` after ${c.seconds}s` : ''}]` });
  }

  function sendWs(c, ev) {
    if (c.ws && c.ws.readyState === 1) {
      c.ws.send(JSON.stringify(ev));
      return true;
    }
    return false;
  }
  function speakNext(c) {
    if (!c.ws || c.ws.readyState !== 1 || c.responding || !c.inbox.length) return;
    for (const text of c.inbox.splice(0)) {
      sendWs(c, { type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
    }
    c.responding = true;
    sendWs(c, { type: 'response.create' });
  }

  function snapshotMia() {
    try {
      const s = JSON.parse(latestSnapshot() || 'null');
      return s && s.mia ? s.mia : null;
    } catch {
      return null;
    }
  }
  function toolStatus() {
    const mia = snapshotMia();
    if (!mia) return { ok: false, error: 'Can\'t see the task list right now.' };
    const liveS = ['queued', 'asking', 'running', 'checking'];
    const tasks = Array.isArray(mia.tasks) ? mia.tasks : [];
    const byTime = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    return {
      ok: true,
      active: tasks.filter((t) => liveS.includes(t.status)).sort(byTime).slice(0, 6).map((t) => ({ id: t.id, title: clip(t.title, 120), status: t.status })),
      recentlyFinished: tasks.filter((t) => !liveS.includes(t.status)).sort(byTime).slice(0, 3).map((t) => ({ id: t.id, title: clip(t.title, 120), status: t.status, result: t.result ? clip(t.result, 160) : undefined })),
      openQuestions: (Array.isArray(mia.pendingQuestions) ? mia.pendingQuestions : []).slice(0, 5).map((q) => ({ id: q.questionId, question: clip(q.text, 200), options: q.options || [] })),
    };
  }
  function runTool(c, name, args) {
    switch (name) {
      case 'send_to_mia': {
        const text = clip(args.text, 1500);
        if (!text) return { ok: false, error: 'Nothing to send.' };
        const sent = sendToHost({ type: 'miaSend', text: `${PHONE_TAG}${text}  [call ${c.id} — answer in the call with: mia call-say ${c.id} "…"]` });
        if (sent === false) return { ok: false, error: 'Daniel\'s Mac is not reachable right now.' };
        c.asked = (c.asked || 0) + 1;
        return { ok: true, status: 'Started. The outcome arrives as a "Result:" message. Tell Daniel briefly, first person, that you are on it.' };
      }
      case 'get_status':
        return toolStatus();
      case 'answer_question': {
        const id = clip(args.id, 60);
        const option = clip(args.option, 300);
        if (!id || !option) return { ok: false, error: 'Need the question id and his answer.' };
        const sent = sendToHost({ type: 'miaAnswer', questionId: id, text: PHONE_TAG + option });
        return sent === false ? { ok: false, error: 'Not sent — the Mac is not reachable.' } : { ok: true, answered: option };
      }
      case 'show_on_panel': {
        const what = clip(args.what, 500);
        if (!what) return { ok: false, error: 'Nothing to show.' };
        const action = /^https:\/\//i.test(what) ? 'show-url' : 'show-doc';
        const r = showOnPanel({ type: 'panel', id: `ph_${c.id}_${Date.now().toString(36)}`, action, arg: what });
        return r && r.ok === false ? { ok: false, error: r.detail || 'No panel is open — tell Daniel to open Mission Control.' } : { ok: true, shown: what };
      }
      case 'end_call':
        c.ending = true;
        c.timers.push(setTimeout(() => hangup(c, 'Mia said goodbye'), 3500));
        return { ok: true };
      default:
        return { ok: false, error: `Unknown tool ${name}` };
    }
  }

  function onSideband(c, ev) {
    switch (ev.type) {
      case 'response.created':
        c.responding = true;
        break;
      case 'response.done': {
        c.responding = false;
        if (ev.response?.usage) {
          c.tokens = addUsage(c.tokens || emptyTokens(), ev.response.usage);
          const p = PRICES[model] || PRICES['gpt-realtime-2.1'];
          const t = c.tokens;
          c.usd = round((t.audioIn * p.audioIn + t.audioInCached * p.audioInCached + t.audioOut * p.audioOut + t.textIn * p.textIn + t.textInCached * p.textInCached + t.textOut * p.textOut) / 1e6, 1e5);
          save();
        }
        const calls = (ev.response?.output || []).filter((o) => o.type === 'function_call');
        if (calls.length) {
          for (const fc of calls) {
            let args = {};
            try {
              args = JSON.parse(fc.arguments || '{}');
            } catch {}
            const out = runTool(c, fc.name, args);
            sendWs(c, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: fc.call_id, output: JSON.stringify(out) } });
          }
          if (!c.ending) {
            c.responding = true;
            sendWs(c, { type: 'response.create' });
          }
          return;
        }
        speakNext(c);
        break;
      }
      case 'error':
        log.warn(`phone: call ${c.id} realtime error: ${clip(ev.error?.message, 200)}`);
        break;
      default:
    }
  }

  function openSideband(c) {
    if (!WS) return;
    const url = `${openaiBase.replace(/^http/, 'ws')}/v1/realtime?call_id=${encodeURIComponent(c.openaiId)}`;
    let ws;
    try {
      ws = new WS(url, { headers: { authorization: `Bearer ${cfg.openaiKey}` } });
    } catch (e) {
      log.warn('phone: sideband failed:', e.message);
      return;
    }
    c.ws = ws;
    ws.on('open', () => {
      // She rang him: she speaks first.
      c.responding = true;
      sendWs(c, { type: 'response.create' });
    });
    ws.on('message', (buf) => {
      let ev;
      try {
        ev = JSON.parse(buf.toString());
      } catch {
        return;
      }
      onSideband(c, ev);
    });
    ws.on('error', (e) => log.warn(`phone: sideband ${c.id}:`, e.message));
    ws.on('close', () => {
      if (c.ws === ws) c.ws = null;
    });
  }

  // ---- Media Streams bridge: Twilio (μ-law 8 kHz) ⇄ relay ⇄ OpenAI Realtime WS ----
  function streamKey(id) {
    return crypto.createHmac('sha256', cfg.authToken).update(`stream:${id}`).digest('hex').slice(0, 32);
  }
  const streamWss = WS && WS.Server ? new WS.Server({ noServer: true }) : null;
  function handleUpgrade(req, socket, head) {
    if (!configured || !streamWss) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    streamWss.handleUpgrade(req, socket, head, (tw) => onStream(tw));
  }
  function onStream(tw) {
    let c = null;
    let streamSid = '';
    const toTwilio = (obj) => {
      if (tw.readyState === 1) tw.send(JSON.stringify(obj));
    };
    // Nobody proves who they are within 10 s: drop.
    const idle = setTimeout(() => { if (!c) tw.close(); }, 10e3);
    tw.on('message', (buf) => {
      let m;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m.event === 'start') {
        const p = m.start?.customParameters || {};
        const cand = live.get(String(p.call || ''));
        if (!cand || !safeEq(String(p.key || ''), streamKey(cand.id)) || cand.tw) {
          log.warn('phone: refused a media stream (bad call or key)');
          return tw.close();
        }
        clearTimeout(idle);
        c = cand;
        c.tw = tw;
        streamSid = String(m.start.streamSid || '');
        c.twilioSid = c.twilioSid || String(m.start.callSid || '');
        openRealtime(c, {
          audio: (b64) => toTwilio({ event: 'media', streamSid, media: { payload: b64 } }),
          clear: () => toTwilio({ event: 'clear', streamSid }),
        });
        return;
      }
      if (!c) return;
      if (m.event === 'media' && m.media?.payload) {
        if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
      } else if (m.event === 'stop') {
        tw.close();
      }
    });
    tw.on('close', () => {
      clearTimeout(idle);
      if (c && c.tw === tw) {
        c.tw = null;
        if (LIVE.has(c.status)) setStatus(c, 'completed', c.why || 'line closed');
      }
    });
    tw.on('error', () => {});
  }
  // The relay's own Realtime session for a streamed call (same tools and
  // events as the SIP sideband, plus the audio both ways).
  function openRealtime(c, pipe) {
    if (!WS) return;
    let ws;
    try {
      ws = new WS(`${openaiBase.replace(/^http/, 'ws')}/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${cfg.openaiKey}` } });
    } catch (e) {
      log.warn('phone: realtime failed:', e.message);
      hangup(c, 'could not reach the voice');
      return;
    }
    c.ws = ws;
    c.pipe = pipe;
    ws.on('open', () => {
      const session = sessionFor(c);
      session.audio.input.format = { type: 'audio/pcmu' };
      session.audio.output.format = { type: 'audio/pcmu' };
      delete session.model; // fixed by the URL
      sendWs(c, { type: 'session.update', session });
      setStatus(c, 'connected');
      startCap(c);
      c.responding = true;
      sendWs(c, { type: 'response.create' });
    });
    ws.on('message', (buf) => {
      let ev;
      try {
        ev = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (ev.type === 'response.output_audio.delta' && ev.delta) return pipe.audio(ev.delta);
      if (ev.type === 'input_audio_buffer.speech_started') pipe.clear(); // he talks over her: stop her audio
      onSideband(c, ev);
    });
    ws.on('error', (e) => log.warn(`phone: realtime ${c.id}:`, e.message));
    ws.on('close', () => {
      if (c.ws === ws) c.ws = null;
      if (LIVE.has(c.status)) hangup(c, 'voice session closed');
    });
  }

  function startCap(c) {
    // The cap: goodbye at cap−20 s, hangup at the cap.
    c.timers.push(setTimeout(() => {
      c.inbox.push('System: the call is almost at its time limit. Say a short goodbye now (offer to message him the rest) and call end_call.');
      speakNext(c);
    }, Math.max(maxSeconds / 2, maxSeconds - 20) * 1000));
    c.timers.push(setTimeout(() => hangup(c, 'time limit'), maxSeconds * 1000));
  }

  async function hangup(c, why, status = 'completed') {
    if (!c || !LIVE.has(c.status)) return false;
    c.why = clip(why, 120);
    let ok = false;
    try {
      if (c.openaiId) await openai(`${encodeURIComponent(c.openaiId)}/hangup`);
      ok = true;
    } catch (e) {
      log.warn(`phone: OpenAI hangup ${c.id}:`, e.message);
    }
    try {
      if (c.twilioSid) await twilio(`/Calls/${encodeURIComponent(c.twilioSid)}.json`, { Status: 'completed' });
      ok = true;
    } catch (e) {
      log.warn(`phone: Twilio hangup ${c.id}:`, e.message);
    }
    setStatus(c, status, why);
    return ok;
  }

  // ---- HTTP -------------------------------------------------------------------------
  function json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function authed(req, url) {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    return tokenOk(bearer || url.searchParams.get('token') || '');
  }
  function readBody(req, max = 65536) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (ch) => {
        body += ch;
        if (body.length > max) req.destroy();
      });
      req.on('end', () => resolve(body));
      req.on('error', () => resolve(''));
    });
  }
  const parseJson = (s) => {
    try {
      return JSON.parse(s || '{}') || {};
    } catch {
      return {};
    }
  };
  function twiml(res, xml) {
    res.writeHead(200, { 'content-type': 'text/xml', 'cache-control': 'no-store' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`);
  }
  function twilioOk(req, url, params) {
    const sig = req.headers['x-twilio-signature'] || '';
    if (!sig || !publicUrl) return false;
    return safeEq(sig, twilioSignature(cfg.authToken, publicUrl + url.pathname + url.search, params));
  }

  async function placeCall(body) {
    const to = clip(body.to, 20).replace(/[\s()-]/g, '');
    const message = clip(body.message, 600);
    const urgent = body.urgent === true;
    if (!numberOk(to)) return { status: 400, body: { ok: false, error: 'Not a number Mia may call' } };
    if (!message) return { status: 400, body: { ok: false, error: 'No message' } };
    if (!hostOnline()) return { status: 503, body: { ok: false, error: 'The Mac is offline (Mia could not act on the call)' } };
    const g = guard({ urgent });
    if (g) return { status: g.status, body: { ok: false, error: g.error, quiet: g.quiet || undefined } };
    if (!publicUrl) return { status: 503, body: { ok: false, configured: false, error: 'PHONE_PUBLIC_URL is not set' } };

    const c = {
      id: `c_${crypto.randomBytes(5).toString('hex')}`,
      at: now(),
      to,
      message,
      reason: clip(body.reason, 1500) || undefined,
      urgent,
      status: 'dialing',
      placed: true,
      seconds: 0,
      usd: 0,
      timers: [],
      inbox: [],
      responding: false,
    };
    store.calls.push(c);
    live.set(c.id, c);
    save();
    try {
      const data = await twilio('/Calls.json', {
        To: to,
        From: cfg.from,
        Url: hookUrl('answer', c.id),
        Method: 'POST',
        StatusCallback: hookUrl('status', c.id),
        StatusCallbackMethod: 'POST',
        StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        MachineDetection: 'Enable',
        Timeout: '30',
        TimeLimit: String(maxSeconds + 30),
      });
      c.twilioSid = String(data.sid || '');
    } catch (e) {
      c.placed = !!e.status && e.status < 500 ? false : c.placed; // refused by Twilio → not counted
      setStatus(c, 'failed', `Twilio: ${e.message}`);
      return { status: 502, body: { ok: false, id: c.id, error: `Could not place the call: ${e.message}` } };
    }
    // Ringing that never turns into a call (Twilio callbacks lost): give up.
    c.timers.push(setTimeout(() => { if (c.status === 'dialing' || c.status === 'ringing') hangup(c, 'never connected', 'no-answer'); }, 90e3));
    log.log(`phone: call ${c.id} placed${urgent ? ' (urgent)' : ''} → ${maskNum(to)}`);
    return { status: 200, body: { ok: true, id: c.id, status: c.status } };
  }

  async function onTwilio(route, req, res, url) {
    const raw = await readBody(req);
    const params = Object.fromEntries(new URLSearchParams(raw));
    if (!twilioOk(req, url, params)) return json(res, 403, { ok: false, error: 'bad signature' });
    const c = live.get(url.searchParams.get('call') || '') || null;
    if (route === 'answer') {
      if (!c) return twiml(res, '<Hangup/>');
      if (/^machine|^fax/.test(params.AnsweredBy || '')) {
        setStatus(c, 'voicemail', `answered by ${params.AnsweredBy}`);
        return twiml(res, '<Hangup/>');
      }
      setStatus(c, 'answered');
      if (mode === 'stream') {
        // Media Streams: Twilio opens wss://…/phone/stream; the call id and a
        // per-call key (HMAC with the auth token) ride as <Parameter>s.
        const wss = `${publicUrl.replace(/^http/, 'ws')}/phone/stream`;
        return twiml(res, `<Connect><Stream url="${xmlEsc(wss)}"><Parameter name="call" value="${xmlEsc(c.id)}"/><Parameter name="key" value="${streamKey(c.id)}"/></Stream></Connect>`);
      }
      const sip = `sip:${cfg.project}@${sipHost};transport=tls?X-MC-Call=${encodeURIComponent(c.id)}`;
      return twiml(res, `<Dial timeLimit="${maxSeconds + 15}" answerOnBridge="true"><Sip>${xmlEsc(sip)}</Sip></Dial>`);
    }
    // status callback
    if (c) {
      const st = String(params.CallStatus || '');
      if (st === 'ringing') setStatus(c, 'ringing');
      else if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(st)) {
        if (params.CallDuration && !c.connectedAt) c.seconds = Number(params.CallDuration) || 0;
        setStatus(c, st, params.ErrorMessage || undefined);
      }
    }
    res.writeHead(204);
    res.end();
  }

  async function onOpenai(req, res) {
    const raw = await readBody(req, 262144);
    const id = req.headers['webhook-id'] || '';
    const ts = req.headers['webhook-timestamp'] || '';
    const sigs = String(req.headers['webhook-signature'] || '').split(' ').filter(Boolean);
    const want = openaiSignature(cfg.whsec, id, ts, raw);
    const fresh = Math.abs(now() / 1000 - Number(ts)) < 300;
    if (!id || !fresh || !sigs.some((s) => safeEq(s, want))) return json(res, 403, { ok: false, error: 'bad signature' });
    const ev = parseJson(raw);
    if (ev.type !== 'realtime.call.incoming') return json(res, 200, { ok: true, ignored: ev.type || '' });
    const openaiId = String(ev.data?.call_id || '');
    const headers = Array.isArray(ev.data?.sip_headers) ? ev.data.sip_headers : [];
    const ours = (headers.find((h) => /^x-mc-call$/i.test(h?.name || '')) || {}).value || '';
    const c = live.get(String(ours)) || null;
    if (!openaiId) return json(res, 400, { ok: false, error: 'no call id' });
    if (!c || c.openaiId) {
      // Not a call we placed (someone dialled the SIP address): refuse it.
      log.warn(`phone: refused an unknown SIP call ${clip(openaiId, 40)}`);
      openai(`${encodeURIComponent(openaiId)}/reject`, { status_code: 603 }).catch(() => {});
      return json(res, 200, { ok: true, rejected: true });
    }
    c.openaiId = openaiId;
    byOpenai.set(openaiId, c.id);
    try {
      await openai(`${encodeURIComponent(openaiId)}/accept`, sessionFor(c));
    } catch (e) {
      await hangup(c, `OpenAI accept failed: ${e.message}`);
      return json(res, 200, { ok: false, error: e.message });
    }
    setStatus(c, 'connected');
    openSideband(c);
    startCap(c);
    return json(res, 200, { ok: true });
  }

  async function handle(req, res, url) {
    const route = url.pathname.replace(/\/+$/, '');
    if (!configured) {
      return json(res, 503, { ok: false, configured: false, error: 'Phone calls are not configured', missing });
    }
    if (route === '/phone/twilio/answer' || route === '/phone/twilio/status') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
      return onTwilio(route.endsWith('answer') ? 'answer' : 'status', req, res, url);
    }
    if (route === '/phone/openai') {
      if (mode !== 'sip') return json(res, 503, { ok: false, configured: false, error: 'SIP bridge is not configured (set OPENAI_PROJECT_ID and OPENAI_WEBHOOK_SECRET)' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
      return onOpenai(req, res);
    }
    if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (route === '/phone' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...info(), calls: store.calls.slice(-30).map((c) => ({ ...publicSummary(c), message: c.message })) });
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
    const body = parseJson(await readBody(req));
    if (route === '/phone/call') {
      const r = await placeCall(body);
      return json(res, r.status, r.body);
    }
    if (route === '/phone/say') {
      const c = live.get(String(body.id || ''));
      const text = clip(body.text, 1500);
      if (!c) return json(res, 404, { ok: false, error: 'No live call with that id (it may have ended — message Daniel instead)' });
      if (!text) return json(res, 400, { ok: false, error: 'No text' });
      c.inbox.push(`Result: ${text}${body.hangup === true ? '\n(Then say goodbye and call end_call.)' : ''}`);
      speakNext(c);
      // spoken: handed to the voice now; queued: after the current reply (or once the call connects)
      return json(res, 200, { ok: true, id: c.id, status: c.inbox.length ? 'queued' : 'spoken' });
    }
    if (route === '/phone/hangup') {
      const c = live.get(String(body.id || ''));
      if (!c) return json(res, 404, { ok: false, error: 'No live call with that id' });
      await hangup(c, 'hung up by Mia');
      return json(res, 200, { ok: true, id: c.id });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  return {
    handle,
    handleUpgrade,
    info,
    close() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        flush();
      }
    },
  };
}

module.exports = { createPhone, twilioSignature, openaiSignature, parseQuiet, inQuiet, hourIn, PERSONA, TOOLS };
