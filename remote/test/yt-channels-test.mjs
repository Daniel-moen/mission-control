// YouTube Channels on the relay (channels.js, task 0260): the action queue, the state the Mac pushes and the media
// cache with Range, through the real server with the bearer token.   node test/yt-channels-test.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-channels-'));
let passed = 0;
let failed = 0;
const ok = (c, label) => {
  if (c) { passed += 1; console.log(`  ✓ ${label}`); } else { failed += 1; console.error(`  ✗ ${label}`); }
};

const PORT = 18000 + Math.floor(Math.random() * 1000);
const TOKEN = 'test-token-channels';
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [path.join(DIR, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), MC_TOKEN: TOKEN, CHANNELS_STORE: path.join(TMP, 'channels.json'),
    CHANNELS_MEDIA: path.join(TMP, 'media'), CHANNELS_MEDIA_MB: '1', JARVIS_STORE: path.join(TMP, 'j.json'),
    PUSH_STORE: path.join(TMP, 'push.json'), DOC_ASSETS: path.join(TMP, 'da'), DOC_PAGES: path.join(TMP, 'dp'),
    RAILWAY_VOLUME_MOUNT_PATH: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const auth = { Authorization: `Bearer ${TOKEN}` };
const j = async (method, p, body, headers = {}) => {
  const r = await fetch(BASE + p, { method, headers: { ...auth, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let b = {};
  try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
};

try {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    await sleep(100);
  }
  console.log('channels.js through the server');
  ok((await fetch(`${BASE}/api/v1/channels`)).status === 401, 'no token → 401');
  let r = await j('GET', '/api/v1/channels');
  ok(r.status === 200 && r.body.state === null && r.body.pending.length === 0, 'empty: no state, no queue');

  for (const [body, why] of [
    [{ action: 'nope', channel: 'raw-incident' }, 'unknown action'],
    [{ action: 'approve', channel: 'raw-incident' }, 'approve without a video'],
    [{ action: 'reject', channel: 'raw-incident', video: 'ri:x' }, 'reject without a note'],
    [{ action: 'publish_now', channel: 'raw-incident', video: 'ri:x' }, 'publish_now without confirmed'],
    [{ action: 'pause_channel', channel: '../etc' }, 'malformed channel'],
  ]) ok((await j('POST', '/api/v1/channels/action', body)).status === 400, `rejects ${why}`);

  r = await j('POST', '/api/v1/channels/action', { action: 'publish_now', channel: 'raw-incident', video: 'ri:x', confirmed: true, told: true });
  ok(r.status === 200 && r.body.action.id.startsWith('a_') && r.body.action.status === 'queued' && r.body.action.told, 'publish_now with confirm is queued');
  const id = r.body.action.id;
  r = await j('POST', '/api/v1/channels/action', { action: 'make_next_10', channel: 'stories-soft-wild' });
  ok(r.status === 200 && r.body.pending.length === 2, 'second action queued');

  r = await j('GET', '/api/v1/channels/actions');
  ok(r.body.actions.length === 2 && Array.isArray(r.body.wanted), 'the Mac sees the queue');
  r = await j('PUT', '/api/v1/channels/state', { state: { schema: 1, channels: [{ key: 'raw-incident' }] }, applied: [id] });
  ok(r.status === 200 && r.body.queued === 1, 'state stored, applied id leaves the queue');
  r = await j('GET', '/api/v1/channels');
  ok(r.body.state.channels[0].key === 'raw-incident' && r.body.receivedAt > 0 && r.body.pending.length === 1, 'panel reads the state + what is still queued');
  ok((await j('PUT', '/api/v1/channels/state', { nope: 1 })).status === 400, 'state without a state object → 400');

  // media: missing → 202 + wanted; the Mac uploads; Range works; types are checked
  const fid = 'Ym9keWNhbTpvdXQveC94Lm1wNA';
  r = await fetch(`${BASE}/api/v1/channels/media/${fid}?size=full&token=${TOKEN}`);
  ok(r.status === 202, 'missing media → 202 (asked the Mac)');
  r = await j('GET', '/api/v1/channels/actions');
  ok(r.body.wanted.some((w) => w.id === fid && w.size === 'full'), 'the Mac sees the wanted file');
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(1000, 7)]);
  r = await fetch(`${BASE}/api/v1/channels/media/${fid}?size=full`, { method: 'PUT', headers: { ...auth, 'content-type': 'video/mp4' }, body: mp4 });
  ok(r.status === 200, 'Mac uploads the mp4');
  r = await fetch(`${BASE}/api/v1/channels/media/${fid}?size=full&token=${TOKEN}`, { headers: { Range: 'bytes=4-11' } });
  ok(r.status === 206 && r.headers.get('content-range') === `bytes 4-11/${mp4.length}` && Buffer.from(await r.arrayBuffer()).toString() === 'ftypmp42', 'Range request → 206 with the right bytes');
  r = await fetch(`${BASE}/api/v1/channels/media/${fid}?size=full&token=${TOKEN}`);
  ok(r.status === 200 && r.headers.get('accept-ranges') === 'bytes' && (await r.arrayBuffer()).byteLength === mp4.length, 'full GET');
  ok((await j('GET', '/api/v1/channels/actions')).body.wanted.length === 0, 'uploaded file leaves the wanted list');
  r = await fetch(`${BASE}/api/v1/channels/media/${fid}?size=thumb`, { method: 'PUT', headers: { ...auth, 'content-type': 'image/jpeg' }, body: Buffer.from('<svg/>') });
  ok(r.status === 415, 'bytes that are not a jpeg → 415');
  r = await fetch(`${BASE}/api/v1/channels/media/${fid}?size=huge&token=${TOKEN}`);
  ok(r.status === 400, 'unknown size → 400');
  r = await fetch(`${BASE}/api/v1/channels/media/..%2F..%2Fetc?size=full&token=${TOKEN}`);
  ok(r.status === 400 || r.status === 404, 'path tricks refused');
  // LRU cap (1 MB in this run): a 900 KB file pushes the older one out
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(900 * 1024, 1)]);
  await fetch(`${BASE}/api/v1/channels/media/BIGBIGBIGBIG?size=thumb`, { method: 'PUT', headers: { ...auth, 'content-type': 'image/jpeg' }, body: big });
  await fetch(`${BASE}/api/v1/channels/media/BIGBIGBIGBI2?size=thumb`, { method: 'PUT', headers: { ...auth, 'content-type': 'image/jpeg' }, body: big });
  r = await fetch(`${BASE}/api/v1/channels/media/BIGBIGBIGBIG?size=thumb&token=${TOKEN}`);
  ok(r.status === 202, 'cache stays under its cap (oldest evicted)');
  r = await fetch(`${BASE}/health`);
  ok(typeof (await r.json()).channels.bytes === 'number', '/health reports the channels cache');
} catch (e) {
  failed += 1;
  console.error(e);
} finally {
  srv.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
