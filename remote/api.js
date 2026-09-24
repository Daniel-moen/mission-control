// Mission Control REST API — the relay's HTTP face, built for machine callers
// (OpenClaw, scripts, cron jobs) that can make outbound HTTPS requests but
// can't hold a WebSocket open or accept inbound connections.
//
// Everything here rides the EXISTING viewer→host wire protocol: an HTTP request
// becomes one wire command sent to the Mac, and the response is the host's ack
// (or doc/docSearchResult/screen frame) matched back to the request. No new
// message types, so the Mac app needs no rebuild.
//
// Correlation: host frames carry no request ids, so waiters are matched FIFO by
// frame shape (ack.cmd === expected, doc.id === requested, …). With one host and
// a handful of callers that's unambiguous in practice; a panel-triggered ack of
// the same cmd arriving in the same instant could in theory be claimed by an API
// waiter — both callers still see a truthful ack, so the failure mode is benign.
//
// Panel HTTP fallback: where a network blocks WebSocket upgrades, the panel
// polls GET /snapshot, sends its socket frames verbatim through POST /cmd, and
// reads watched terminals from GET /screens — a buffer the relay assembles from
// the host's screen frames (full + `keep` deltas) so pollers get coherent text.
//
// Auth: same shared secret as the WebSocket — `Authorization: Bearer <MC_TOKEN>`
// (or ?token= for quick tests).

'use strict';

const zlib = require('zlib');

const MAX_BODY = 2 * 1024 * 1024; // doc bodies travel through here
const ACK_TIMEOUT_MS = 15000;
const SCREEN_TIMEOUT_MS = 4500; // host streams screens at 1 Hz once a lease opens

// Legacy plan* spellings the host treats as their doc* equivalents; an ack may
// come back under either name.
const DOC_ALIAS = { planGet: 'docGet', planSave: 'docSave', planCreate: 'docCreate', planDelete: 'docDelete' };

function createApi({
  tokenOk,
  sendToHost,
  hostOnline,
  latestSnapshot,
  snapshotMeta = () => ({ seq: 0, at: 0 }),
  allowedTypes = [],
  notePoller = () => {},
}) {
  // ---------------------------------------------------------------------------
  // Assembled terminal screens for HTTP pollers: sessionId → { seq, text, at }.
  // Mirrors the panel's ingestScreen(): a `keep` delta applies only on top of
  // the exact previous frame (seq + 1); anything else is dropped until the
  // host's next full frame. Pruned to the sessions in the latest snapshot.

  const screens = new Map();

  function ingestScreen(f) {
    if (!f.sessionId || typeof f.sessionId !== 'string') return;
    const prev = screens.get(f.sessionId);
    let text = f.text;
    if (typeof f.keep === 'number') {
      if (!prev || f.seq !== prev.seq + 1 || prev.text.length < f.keep) return;
      text = prev.text.slice(0, f.keep) + (f.text || '');
    }
    if (typeof text !== 'string') return;
    if (prev && typeof f.seq === 'number' && f.seq <= prev.seq && f.seq > prev.seq - 1000) return;
    screens.set(f.sessionId, { seq: f.seq ?? 0, text, at: Date.now() });
  }

  function pruneScreens(snap) {
    if (!Array.isArray(snap.agents)) return;
    const live = new Set(snap.agents.map((a) => a && a.id));
    for (const id of screens.keys()) if (!live.has(id)) screens.delete(id);
  }


  // ---------------------------------------------------------------------------
  // Waiters: pending HTTP requests, resolved by matching host frames.

  const waiters = []; // { match(frame), resolve, timer }

  function waitForFrame(match, timeoutMs = ACK_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const w = { match, resolve, timer: null };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i !== -1) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      waiters.push(w);
    });
  }

  // Called by the relay for every parsed host frame (snapshots included).
  function onHostFrame(frame) {
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'screen') ingestScreen(frame);
    else if (frame.type === 'snapshot') pruneScreens(frame);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].match(frame)) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(frame);
        return; // one frame settles at most one waiter
      }
    }
  }

  const ackOf = (cmd) => (f) => f.type === 'ack' && f.cmd === cmd;

  // ---------------------------------------------------------------------------
  // Helpers.

  // Big bodies (the snapshot, screens) are gzipped when the caller accepts it —
  // the socket path gets permessage-deflate, pollers on cellular deserve the same.
  function json(res, status, obj) {
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    let body = Buffer.from(JSON.stringify(obj));
    if (res.mcGzip && body.length > 1024) {
      body = zlib.gzipSync(body);
      headers['content-encoding'] = 'gzip';
      headers.vary = 'accept-encoding';
    }
    res.writeHead(status, headers);
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('body is not valid JSON')); }
      });
      req.on('error', reject);
    });
  }

  function snapshot() {
    const raw = latestSnapshot();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // Exact sessionId first; otherwise a unique case-insensitive name/folder match,
  // so a conversational caller can say "reply to acme" and land on the agent.
  function findAgent(snap, id) {
    if (!snap || !Array.isArray(snap.agents)) return { agent: null, ambiguous: false };
    const exact = snap.agents.find((a) => a.id === id);
    if (exact) return { agent: exact, ambiguous: false };
    const q = String(id).toLowerCase();
    const loose = snap.agents.filter(
      (a) => String(a.name || '').toLowerCase() === q || String(a.folder || '').toLowerCase() === q
    );
    if (loose.length === 1) return { agent: loose[0], ambiguous: false };
    return { agent: null, ambiguous: loose.length > 1 };
  }

  // The list view stays light — screens and logs are per-agent detail.
  function agentSummary(a) {
    const { screen, log, ...rest } = a;
    return rest;
  }

  async function sendAndAck(res, cmd, payload) {
    if (!hostOnline()) return json(res, 502, { ok: false, error: 'Mac is offline' });
    sendToHost(payload);
    const frame = await waitForFrame(ackOf(cmd));
    if (!frame) return json(res, 504, { ok: false, error: `no answer from the Mac within ${ACK_TIMEOUT_MS / 1000}s` });
    const { type, cmd: _c, ...rest } = frame;
    return json(res, frame.ok ? 200 : 422, rest);
  }

  // POST /cmd: which host frame answers a given viewer frame — the same
  // per-type matching the dedicated routes above use. null ⇒ no answer exists
  // (a watch lease, console typing), so the route replies {ok:true} at once.
  function replyMatcher(msg) {
    const type = msg.type;
    const alias = DOC_ALIAS[type] || type;
    const isAck = (f) => f.type === 'ack' && (f.cmd === type || f.cmd === alias);
    if (type === 'watch') return null;
    if (type === 'key' && typeof msg.text === 'string' && msg.text) return null; // acks only on failure
    if (alias === 'docGet') return (f) => (f.type === 'doc' && f.id === msg.id) || isAck(f);
    if (type === 'docSearch') {
      const q = String(msg.q ?? '').trim();
      return (f) => f.type === 'docSearchResult' && f.q === q;
    }
    return isAck;
  }

  // ---------------------------------------------------------------------------
  // The router.

  const INDEX = {
    ok: true,
    service: 'mission-control',
    doc: 'Mission Control REST API v1. Auth: Authorization: Bearer <token> on every request. An agent :id is its sessionId, or a unique agent name/folder.',
    endpoints: {
      'GET  /api/v1': 'this index',
      'GET  /api/v1/status': 'relay + Mac link state',
      'GET  /api/v1/snapshot': 'the full raw fleet snapshot (heavy): {ok, hostOnline, seq, ageMs, snapshot}; seq bumps per host snapshot, ageMs = since it arrived; 502 when the relay has none yet. Send X-MC-Client: <id> to count as a viewer (panel fallback).',
      'POST /api/v1/cmd {type, ...}': 'panel fallback: one viewer→host frame, exactly as sent over /ws (same type allowlist; 400 otherwise). 200 → the host\'s answering frame verbatim (ack / doc / docSearchResult); watch and console typing (key+text) → {ok:true} at once; 502 Mac offline; 504 no answer in 15s',
      'GET  /api/v1/screens?ids=a,b': 'panel fallback: latest assembled terminal buffer per watched session: {ok, screens:{id:{seq, text}}}; ids the relay has nothing for are omitted. Hold a lease via POST /cmd {type:"watch", sessionId}',
      'GET  /api/v1/agents': 'fleet summary + agents (light: no screens/logs)',
      'GET  /api/v1/agents/:id': 'one agent, full detail incl. last screen',
      'GET  /api/v1/agents/:id/screen': 'live terminal scrollback (opens a watch lease)',
      'POST /api/v1/agents/:id/reply {text}': 'type a message into that agent\'s terminal and submit it',
      'POST /api/v1/agents/:id/key {key}': 'press one key: a digit/letter, or up/down/left/right/enter/esc/tab/space',
      'POST /api/v1/agents/:id/kill': 'kill that agent\'s process',
      'POST /api/v1/broadcast {text}': 'send a message to every reachable agent',
      'POST /api/v1/launch {mission, dir?, workerModels?, managerModel?, planMode?, docId?, docMode?}': 'launch an agent or fleet on the Mac',
      'POST /api/v1/research {topic, subject?, dir?, model?, tags?}': 'one-shot research agent; report lands in the library',
      'GET  /api/v1/docs': 'document library metadata (plans/research/notes)',
      'GET  /api/v1/docs/search?q=': 'full-text search over the library',
      'GET  /api/v1/docs/:id': 'one document with its markdown body',
      'POST /api/v1/docs {title, kind?, content?, subject?, tags?, dir?}': 'create a document',
      'PUT  /api/v1/docs/:id {content}': 'overwrite a document body',
      'PATCH /api/v1/docs/:id {kind?, status?, subject?, tags?, dir?}': 'update document metadata',
      'DELETE /api/v1/docs/:id': 'delete a document',
      'GET  /api/v1/mia': 'Mia, the assistant: status, conversation, tasks, pending questions, schedule',
      'POST /api/v1/mia/message {text}': 'send Mia a chat message',
      'POST /api/v1/mia/answer {questionId, text}': 'answer one of Mia\'s pending questions',
      'POST /api/v1/mia/tasks {title, detail?, dir?, priority?}': 'queue a task for Mia (priority 1 = highest, default 3)',
    },
  };

  async function handle(req, res, url) {
    const pathname = decodeURIComponent(url.pathname);

    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenOk(bearer) && !tokenOk(url.searchParams.get('token') || '')) {
      return json(res, 401, { ok: false, error: 'missing or bad token — send Authorization: Bearer <MC_TOKEN>' });
    }

    res.mcGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const pollerId = String(req.headers['x-mc-client'] || '').slice(0, 64);

    const seg = pathname.split('/').filter(Boolean); // ['api','v1',...]
    if (seg[1] !== 'v1') return json(res, 404, { ok: false, error: 'unknown API version — use /api/v1' });
    const route = seg.slice(2); // after /api/v1
    const m = req.method;

    let body = {};
    if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
      try { body = await readBody(req); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }

    // ---- meta ------------------------------------------------------------
    if (route.length === 0) return json(res, 200, INDEX);

    if (route[0] === 'status' && m === 'GET') {
      const snap = snapshot();
      return json(res, 200, {
        ok: true,
        host: hostOnline(),
        snapshotAgeSec: snap ? Math.max(0, Math.round(Date.now() / 1000 - snap.at)) : null,
        agents: snap ? snap.agents.length : 0,
        summary: snap ? snap.summary : null,
      });
    }

    if (route[0] === 'snapshot' && m === 'GET') {
      if (pollerId) notePoller(pollerId);
      const snap = snapshot();
      if (!snap) return json(res, 502, { ok: false, hostOnline: hostOnline(), error: 'no snapshot yet — Mac may be offline' });
      const meta = snapshotMeta();
      return json(res, 200, {
        ok: true,
        hostOnline: hostOnline(),
        seq: meta.seq,
        ageMs: meta.at ? Math.max(0, Date.now() - meta.at) : null,
        snapshot: snap,
      });
    }

    // ---- panel HTTP fallback ------------------------------------------------
    if (route[0] === 'cmd' && route.length === 1 && m === 'POST') {
      if (pollerId) notePoller(pollerId);
      if (!body || typeof body.type !== 'string' || !allowedTypes.includes(body.type)) {
        return json(res, 400, { ok: false, error: `type ${JSON.stringify(body && body.type)} is not an allowed command` });
      }
      if (!hostOnline()) return json(res, 502, { ok: false, error: 'Mac is offline' });
      const match = replyMatcher(body);
      // Register the waiter BEFORE forwarding, so a fast host can't answer first.
      const pending = match ? waitForFrame(match) : null;
      sendToHost(body);
      if (!pending) return json(res, 200, { ok: true });
      const frame = await pending;
      if (!frame) return json(res, 504, { ok: false, error: `no answer from the Mac within ${ACK_TIMEOUT_MS / 1000}s` });
      return json(res, 200, frame);
    }

    if (route[0] === 'screens' && route.length === 1 && m === 'GET') {
      if (pollerId) notePoller(pollerId);
      const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
      const out = {};
      for (const id of ids) {
        const s = screens.get(id);
        if (s) out[id] = { seq: s.seq, text: s.text };
      }
      return json(res, 200, { ok: true, screens: out });
    }

    // ---- agents ----------------------------------------------------------
    if (route[0] === 'agents') {
      const snap = snapshot();
      if (!snap) return json(res, 502, { ok: false, error: 'no snapshot yet — Mac may be offline' });

      if (route.length === 1 && m === 'GET') {
        return json(res, 200, {
          ok: true,
          at: snap.at,
          summary: snap.summary,
          fleets: snap.fleets || [],
          system: snap.system || null,
          knownDirs: snap.knownDirs || [],
          models: snap.models || [],
          agents: snap.agents.map(agentSummary),
        });
      }

      const { agent, ambiguous } = findAgent(snap, route[1]);
      if (ambiguous) return json(res, 409, { ok: false, error: `several agents match "${route[1]}" — use the exact id` });
      if (!agent) return json(res, 404, { ok: false, error: `no agent "${route[1]}"` });
      const sid = agent.id;

      if (route.length === 2 && m === 'GET') return json(res, 200, { ok: true, agent });

      if (route[2] === 'screen' && m === 'GET') {
        if (!hostOnline()) return json(res, 502, { ok: false, error: 'Mac is offline' });
        // A watch lease makes the host stream full scrollback at 1 Hz; grab the
        // first frame. If none arrives (host busy, capture failed), fall back to
        // the ~50-line tail already riding in the snapshot.
        sendToHost({ type: 'watch', sessionId: sid });
        const frame = await waitForFrame((f) => f.type === 'screen' && f.sessionId === sid, SCREEN_TIMEOUT_MS);
        if (frame) return json(res, 200, { ok: true, sessionId: sid, source: 'live', text: frame.text });
        return json(res, 200, { ok: true, sessionId: sid, source: 'snapshot', text: agent.screen || '' });
      }

      if (route[2] === 'reply' && m === 'POST') {
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { ok: false, error: 'text is required' });
        return sendAndAck(res, 'reply', { type: 'reply', sessionId: sid, text });
      }

      if (route[2] === 'key' && m === 'POST') {
        const key = String(body.key ?? '').trim();
        if (!key) return json(res, 400, { ok: false, error: 'key is required' });
        return sendAndAck(res, 'key', { type: 'key', sessionId: sid, key });
      }

      if (route[2] === 'kill' && m === 'POST') {
        return sendAndAck(res, 'kill', { type: 'kill', sessionId: sid });
      }
    }

    // ---- fleet-wide actions ------------------------------------------------
    if (route[0] === 'broadcast' && m === 'POST') {
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { ok: false, error: 'text is required' });
      return sendAndAck(res, 'broadcast', { type: 'broadcast', text });
    }

    if (route[0] === 'launch' && m === 'POST') {
      const payload = { type: 'launch' };
      if (body.mission != null) payload.mission = String(body.mission);
      if (body.dir != null) payload.dir = String(body.dir);
      if (body.managerModel != null) payload.managerModel = String(body.managerModel);
      if (Array.isArray(body.workerModels)) payload.workerModels = body.workerModels.map(String);
      else if (body.model != null) payload.workerModels = [String(body.model)]; // convenience: single agent
      if (body.planMode != null) payload.planMode = !!body.planMode;
      if (body.docId != null) payload.docId = String(body.docId);
      if (body.docMode != null) payload.docMode = String(body.docMode);
      if (!payload.workerModels && !payload.managerModel) payload.workerModels = ['']; // '' ⇒ CLI default model
      return sendAndAck(res, 'launch', payload);
    }

    if (route[0] === 'research' && m === 'POST') {
      const topic = String(body.topic ?? '').trim();
      if (!topic) return json(res, 400, { ok: false, error: 'topic is required' });
      const payload = { type: 'research', topic };
      if (body.subject != null) payload.subject = String(body.subject);
      if (body.dir != null) payload.dir = String(body.dir);
      if (body.model != null) payload.model = String(body.model);
      if (Array.isArray(body.tags)) payload.tags = body.tags.map(String);
      return sendAndAck(res, 'research', payload);
    }

    // ---- document library --------------------------------------------------
    if (route[0] === 'docs') {
      if (route.length === 1 && m === 'GET') {
        const snap = snapshot();
        if (!snap) return json(res, 502, { ok: false, error: 'no snapshot yet — Mac may be offline' });
        return json(res, 200, { ok: true, docs: snap.docs || [] });
      }

      if (route.length === 1 && m === 'POST') {
        const payload = { type: 'docCreate' };
        if (body.title != null) payload.title = String(body.title);
        if (body.kind != null) payload.kind = String(body.kind);
        if (body.content != null) payload.content = String(body.content);
        if (body.subject != null) payload.subject = String(body.subject);
        if (Array.isArray(body.tags)) payload.tags = body.tags.map(String);
        if (body.dir != null) payload.dir = String(body.dir);
        return sendAndAck(res, 'docCreate', payload);
      }

      if (route[1] === 'search' && m === 'GET') {
        const q = String(url.searchParams.get('q') ?? '').trim();
        if (!q) return json(res, 400, { ok: false, error: 'q is required' });
        if (!hostOnline()) return json(res, 502, { ok: false, error: 'Mac is offline' });
        sendToHost({ type: 'docSearch', q });
        const frame = await waitForFrame((f) => f.type === 'docSearchResult' && f.q === q);
        if (!frame) return json(res, 504, { ok: false, error: 'no answer from the Mac' });
        return json(res, 200, { ok: true, q, hits: frame.hits || [] });
      }

      const id = route[1];
      if (!id) return json(res, 400, { ok: false, error: 'doc id is required' });

      if (m === 'GET') {
        if (!hostOnline()) return json(res, 502, { ok: false, error: 'Mac is offline' });
        // Success is a {type:'doc'} frame; a missing doc is an ack ok:false.
        sendToHost({ type: 'docGet', id });
        const frame = await waitForFrame(
          (f) => (f.type === 'doc' && f.id === id) || (f.type === 'ack' && f.cmd === 'docGet')
        );
        if (!frame) return json(res, 504, { ok: false, error: 'no answer from the Mac' });
        if (frame.type === 'ack') return json(res, 404, { ok: false, error: frame.detail || 'no such document' });
        const { type, ...doc } = frame;
        return json(res, 200, { ok: true, doc });
      }

      if (m === 'PUT') {
        if (typeof body.content !== 'string') return json(res, 400, { ok: false, error: 'content (string) is required' });
        return sendAndAck(res, 'docSave', { type: 'docSave', id, content: body.content });
      }

      if (m === 'PATCH') {
        const payload = { type: 'docMeta', id };
        for (const k of ['kind', 'status', 'subject', 'dir']) if (body[k] != null) payload[k] = String(body[k]);
        if (Array.isArray(body.tags)) payload.tags = body.tags.map(String);
        return sendAndAck(res, 'docMeta', payload);
      }

      if (m === 'DELETE') {
        return sendAndAck(res, 'docDelete', { type: 'docDelete', id });
      }
    }

    // ---- Mia, the assistant (docs/mia.md §8) --------------------------------
    if (route[0] === 'mia') {
      if (route.length === 1 && m === 'GET') {
        const snap = snapshot();
        if (!snap) return json(res, 502, { ok: false, error: 'no snapshot yet — Mac may be offline' });
        if (!snap.mia) return json(res, 404, { ok: false, error: 'the Mac is not reporting Mia (app too old, or Mia not set up)' });
        return json(res, 200, { ok: true, mia: snap.mia });
      }

      if (route[1] === 'message' && route.length === 2 && m === 'POST') {
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { ok: false, error: 'text is required' });
        return sendAndAck(res, 'miaSend', { type: 'miaSend', text });
      }

      if (route[1] === 'answer' && route.length === 2 && m === 'POST') {
        const questionId = String(body.questionId ?? '').trim();
        const text = String(body.text ?? '').trim();
        if (!questionId || !text) return json(res, 400, { ok: false, error: 'questionId and text are required' });
        return sendAndAck(res, 'miaAnswer', { type: 'miaAnswer', questionId, text });
      }

      if (route[1] === 'tasks' && route.length === 2 && m === 'POST') {
        const title = String(body.title ?? '').trim();
        if (!title) return json(res, 400, { ok: false, error: 'title is required' });
        const payload = { type: 'miaTaskAdd', title };
        if (body.detail != null) payload.detail = String(body.detail);
        if (body.dir != null) payload.dir = String(body.dir);
        if (body.priority != null) {
          const p = Number(body.priority);
          if (!Number.isInteger(p) || p < 1) return json(res, 400, { ok: false, error: 'priority must be a positive integer (1 = highest)' });
          payload.priority = p;
        }
        return sendAndAck(res, 'miaTaskAdd', payload);
      }
    }

    return json(res, 404, { ok: false, error: `no route ${m} ${pathname} — GET /api/v1 lists the API` });
  }

  return { handle, onHostFrame };
}

module.exports = { createApi };
