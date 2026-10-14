// Jarvis HQ on the relay (task 0199): the meeting point between the HQ view
// in the panel and the registry on the Mac (~/.mission-control/mia/jarvis/).
//
//   PUT  /api/v1/jarvis/state     the Mac (`mia jarvis sync`) pushes the public
//                                 view of its registry + findings + recent
//                                 tasks, and lists the control ids it applied
//   GET  /api/v1/jarvis           the panel reads it, plus the controls still
//                                 waiting for the Mac (it overlays those itself)
//   POST /api/v1/jarvis/control   the panel queues one change (autonomy level,
//                                 pause/resume, pitch, scout, a company
//                                 action button) for the Mac
//   GET  /api/v1/jarvis/controls  the Mac pulls the queue
//
// The relay never decides anything: the registry on the Mac is the truth, the
// queue only carries Daniel's taps across until the Mac has applied them. Both
// halves live in one small JSON file on the Railway volume, so a redeploy
// loses neither the last picture nor a tap made while the Mac was asleep.
// Same bearer token as the rest of the API (api.js checks it before routing).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataFile } = require('./datafile');

const ACTIONS = new Set(['level', 'pause', 'resume', 'pitch', 'scout', 'action']);
const MAX_PENDING = 200;
const MAX_STATE_BYTES = 1.5 * 1024 * 1024;

function createJarvis({ file, log = console } = {}) {
  const store = file || dataFile('jarvis.json', { override: process.env.JARVIS_STORE, tag: 'jarvis', log });
  let data = { state: null, receivedAt: 0, controls: [] };
  try {
    const d = JSON.parse(fs.readFileSync(store, 'utf8'));
    if (d && typeof d === 'object') {
      data = { state: d.state || null, receivedAt: Number(d.receivedAt) || 0, controls: Array.isArray(d.controls) ? d.controls : [] };
    }
  } catch {}

  function save() {
    try {
      fs.mkdirSync(path.dirname(store), { recursive: true });
      const tmp = `${store}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, store);
    } catch (e) {
      log.warn(`jarvis: could not save ${store}: ${e.message}`);
    }
  }

  const str = (v, n = 80) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

  // One control from the panel → a clean record, or an error string.
  function cleanControl(b) {
    if (!b || typeof b !== 'object') return 'body must be a JSON object';
    const action = str(b.action, 16);
    if (!ACTIONS.has(action)) return `action must be one of ${[...ACTIONS].join(', ')}`;
    const c = { action };
    if (action === 'level' || action === 'scout') {
      c.project = str(b.project, 64);
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(c.project)) return 'project id missing or malformed';
    }
    if (action === 'level') {
      const lv = Number(b.level);
      if (!Number.isInteger(lv) || lv < 0 || lv > 3) return 'level must be 0-3';
      c.level = lv;
    }
    if (action === 'pitch') {
      c.value = str(b.value, 16);
      if (c.value !== 'quieter' && c.value !== 'louder') return 'pitch value must be quieter or louder';
    }
    if (action === 'action') {
      // A company-page button (task 0204): which one, and what Daniel typed
      // into its inputs. The Mac renders the prompt from its own registry.
      c.company = str(b.company, 64);
      c.actionId = str(b.actionId, 64);
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(c.company)) return 'company id missing or malformed';
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(c.actionId)) return 'actionId missing or malformed';
      const inputs = b.inputs && typeof b.inputs === 'object' && !Array.isArray(b.inputs) ? b.inputs : {};
      c.inputs = {};
      for (const [k, v] of Object.entries(inputs).slice(0, 8)) {
        if (/^\w{1,32}$/.test(k) && typeof v === 'string') c.inputs[k] = v.trim().slice(0, 400);
      }
      c.label = str(b.label, 80);
    }
    c.told = b.told === true; // the panel also sent Mia the [MC] line
    return c;
  }

  // null ⇒ not a jarvis route; else { status, body }.
  function route(rest, method, body) {
    if (rest.length === 0 && method === 'GET') {
      return { status: 200, body: { ok: true, state: data.state, receivedAt: data.receivedAt || null, pending: data.controls } };
    }
    if (rest[0] === 'state' && rest.length === 1 && method === 'PUT') {
      if (!body || typeof body !== 'object' || !body.registry || typeof body.registry !== 'object') {
        return { status: 400, body: { ok: false, error: 'state needs a registry object' } };
      }
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_STATE_BYTES) {
        return { status: 413, body: { ok: false, error: 'state too large' } };
      }
      const applied = new Set(Array.isArray(body.applied) ? body.applied.map(String) : []);
      data.controls = data.controls.filter((c) => !applied.has(c.id));
      const { applied: _a, ...state } = body;
      data.state = state;
      data.receivedAt = Date.now();
      save();
      return { status: 200, body: { ok: true, pending: data.controls.length } };
    }
    if (rest[0] === 'controls' && rest.length === 1 && method === 'GET') {
      return { status: 200, body: { ok: true, controls: data.controls } };
    }
    if (rest[0] === 'control' && rest.length === 1 && method === 'POST') {
      const c = cleanControl(body);
      if (typeof c === 'string') return { status: 400, body: { ok: false, error: c } };
      c.id = `c_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      c.at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      data.controls.push(c);
      if (data.controls.length > MAX_PENDING) data.controls = data.controls.slice(-MAX_PENDING);
      save();
      return { status: 200, body: { ok: true, control: c, pending: data.controls } };
    }
    return null;
  }

  return { route, file: store, _data: () => data };
}

module.exports = { createJarvis };
