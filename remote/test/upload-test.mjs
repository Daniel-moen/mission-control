// Upload test — files for Mia (upload.js, docs/mia.md §8.4). Boots the real
// relay (server.js) and the fake host (test/fake-host.mjs, which pulls and
// saves uploads the way MiaUploads.swift does), then drives POST /upload the
// way the panel does.
//
//   cd remote && npm run test:upload
//
// Asserts: auth; the Mac offline → 503 before anything is stored; an older
// Mac app (no "upload" cap) → 501; type allow-list and byte sniffing (415),
// empty (400), the size cap (413); the happy path (200 delivered → file on disk
// byte-for-byte under MIA_DIR/uploads/<date>/, safe + unique names, the [MC]
// event line, uploads.jsonl, the thread message in the snapshot, the relay's
// temp copy deleted, the fetch URL dead afterwards); batches ("1 of 2");
// `mia uploads`; a Mac that doesn't collect → 202 queued, then delivered when
// a host reconnects; and the TTL purge on a second relay.

import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8893;
const TTL_PORT = 8892;
const TOKEN = 'test';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-upload-'));
const MIA = path.join(TMP, 'mia');
const RELAY_TMP = path.join(TMP, 'relay-tmp');
const MIA_CLI = path.join(DIR, '..', '..', 'scripts', 'mia');

let passed = 0;
let failed = 0;
const procs = [];

function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

function boot(args, name, extraEnv = {}) {
  const p = spawn('node', args, {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      MC_TOKEN: TOKEN,
      PORT: String(PORT),
      PUSH_STORE: path.join(TMP, 'push.json'),
      REALTIME_STORE: path.join(TMP, 'rt.json'),
      TTS_STORE: path.join(TMP, 'tts.json'),
      OPENAI_API_KEY: '',
      UPLOAD_TMP: RELAY_TMP,
      UPLOAD_MAX_MB: '2',
      UPLOAD_WAIT_MS: '3000',
      MIA_DIR: MIA,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.env.UPLOAD_TEST_VERBOSE && console.log(`[${name}]`, d.toString().trim()));
  p.stderr.on('data', (d) => console.error(`[${name}!]`, d.toString().trim()));
  procs.push(p);
  return p;
}

async function stop(p) {
  if (p.exitCode !== null || p.signalCode) return;
  await new Promise((r) => { p.once('exit', r); p.kill(); });
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await sleep(150);
  }
  return false;
}

const health = async (port = PORT) => (await fetch(`http://localhost:${port}/health`)).json();

// The Mac is ready once a snapshot from THIS host (with its caps) has reached
// the relay — the relay keeps the last host's snapshot, so check the caps.
async function hostReady(port = PORT, { caps = ['upload', 'miaRestart', 'tts'] } = {}) {
  const up = await waitFor(async () => {
    const r = await fetch(`http://localhost:${port}/api/v1/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const d = await r.json();
    return d.hostOnline && d.snapshot && JSON.stringify(d.snapshot.caps || []) === JSON.stringify(caps);
  });
  if (!up) throw new Error('host never came up');
  await sleep(1200); // an old host's snapshot may still be the latest for a tick
}

async function upload(body, name, { caption, batch, batchId, token = TOKEN, port = PORT, type = 'application/octet-stream' } = {}) {
  const headers = { 'content-type': type, 'X-MC-Name': encodeURIComponent(name) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (caption) headers['X-MC-Caption'] = encodeURIComponent(caption);
  if (batch) { headers['X-MC-Batch'] = batch; headers['X-MC-Batch-Id'] = batchId || 'b1'; }
  const r = await fetch(`http://localhost:${port}/upload`, { method: 'POST', headers, body });
  let data = null;
  try { data = await r.json(); } catch { /* */ }
  return { status: r.status, data };
}

const relayFiles = () => (fs.existsSync(RELAY_TMP) ? fs.readdirSync(RELAY_TMP) : []);
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog >> endobj\n'), Buffer.alloc(40000, 7), Buffer.from('\n%%EOF\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 1)]);

async function main() {
  const relay = boot(['server.js'], 'relay');
  if (!(await waitFor(async () => (await fetch(`http://localhost:${PORT}/health`)).ok))) throw new Error('relay never came up');

  console.log('relay, no Mac');
  ok((await health()).uploads?.pending === 0, '/health reports uploads');
  ok((await upload(PDF, 'a.pdf', { token: '' })).status === 401, 'no token → 401');
  ok((await upload(PDF, 'a.pdf', { token: 'nope' })).status === 401, 'bad token → 401');
  const info = await (await fetch(`http://localhost:${PORT}/upload`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  ok(info.ok && info.maxBytes === 2 * 1024 * 1024 && info.types.includes('pdf') && info.types.includes('m4a'), 'GET /upload states the cap and the types');
  const off = await upload(PDF, 'a.pdf');
  ok(off.status === 503 && /offline/i.test(off.data?.error), `Mac offline → 503 "${off.data?.error}"`);
  ok(relayFiles().length === 0, 'nothing stored while the Mac is offline');

  console.log('older Mac app');
  let host = boot(['test/fake-host.mjs'], 'old-host', { FAKE_HOST_CAPS: '' });
  await hostReady(PORT, { caps: [] });
  const old = await upload(PDF, 'a.pdf');
  ok(old.status === 501 && /Mac app/i.test(old.data?.error), `no "upload" cap → 501 "${old.data?.error}"`);
  await stop(host);

  console.log('validation');
  host = boot(['test/fake-host.mjs'], 'host');
  await hostReady();
  const exe = await upload(Buffer.from('MZ\x90\x00'), 'setup.exe');
  ok(exe.status === 415, '.exe → 415');
  const noExt = await upload(PDF, 'report');
  ok(noExt.status === 415, 'no extension → 415');
  const fakePdf = await upload(Buffer.from('<html>not a pdf</html>'), 'invoice.pdf');
  ok(fakePdf.status === 415 && /real \.pdf/.test(fakePdf.data?.error), 'HTML named .pdf → 415 (byte sniff)');
  const fakeJpg = await upload(PNG, 'photo.jpg');
  ok(fakeJpg.status === 415, 'PNG bytes named .jpg → 415');
  const binTxt = await upload(Buffer.from([0x68, 0x69, 0x00, 0x01]), 'notes.txt');
  ok(binTxt.status === 415, 'binary named .txt → 415');
  const empty = await upload(Buffer.alloc(0), 'empty.csv');
  ok(empty.status === 400, 'empty file → 400');
  const big = await upload(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2.5 * 1024 * 1024)]), 'big.pdf');
  ok(big.status === 413 && /2 MB/.test(big.data?.error), `over the cap → 413 "${big.data?.error}"`);
  await sleep(200);
  ok(relayFiles().length === 0, 'refused uploads leave nothing on the relay');

  console.log('delivery');
  const caption = 'Summarise this for me —\nand file it for Oblivion ✨';
  const t0 = Date.now();
  const r1 = await upload(PDF, '../../etc/Q3 report.pdf', { caption });
  ok(r1.status === 200 && r1.data.delivered === true, `delivered → 200 in ${Date.now() - t0} ms`);
  const day = new Date().toISOString().slice(0, 10);
  const expected = path.join(MIA, 'uploads', day, 'etc Q3 report.pdf');
  ok(r1.data.path === expected, `saved at a safe path: ${r1.data.path}`);
  ok(fs.existsSync(expected) && fs.readFileSync(expected).equals(PDF), 'the file on disk is byte-for-byte what was sent');
  ok((fs.statSync(expected).mode & 0o777) === 0o600, 'saved private (0600)');
  ok(r1.data.mime === 'application/pdf' && r1.data.size === PDF.length, 'mime and size come back');
  const ev = lines(path.join(MIA, 'events.jsonl')).at(-1);
  const wantLine = `[MC] Daniel uploaded a file: ${expected} (application/pdf, 39 KB) — note: Summarise this for me — and file it for Oblivion ✨`;
  ok(ev?.kind === 'upload' && ev.text === wantLine, `Mia's event: ${ev?.text}`);
  const rec = lines(path.join(MIA, 'uploads.jsonl')).at(-1);
  ok(rec?.id === r1.data.id && rec.path === expected && rec.caption === caption && rec.sha256?.length === 64, 'uploads.jsonl records it');
  const snap = await (await fetch(`http://localhost:${PORT}/api/v1/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  const msg = await waitFor(async () => {
    const s = await (await fetch(`http://localhost:${PORT}/api/v1/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    return s.snapshot.mia.messages.find((m) => m.kind === 'upload' && m.uploadId === r1.data.id && m.file?.path === expected && m.caption === caption);
  });
  ok(snap && msg, 'the thread shows the file (snapshot mia.messages, kind "upload")');
  ok(relayFiles().length === 0, 'the relay deleted its copy once the Mac confirmed');
  ok((await health()).uploads.pending === 0, 'nothing pending on the relay');
  const again = await fetch(`http://localhost:${PORT}/upload/${r1.data.id}`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-MC-Key': 'guess' } });
  ok(again.status === 404, 'the fetch URL is dead after delivery');

  const r2 = await upload(PDF, 'Q3 report.pdf');
  ok(r2.status === 200 && r2.data.path === path.join(MIA, 'uploads', day, 'Q3 report.pdf'), 'plain name kept');
  const r3 = await upload(PDF, 'Q3 report.pdf');
  ok(r3.status === 200 && r3.data.path === path.join(MIA, 'uploads', day, 'Q3 report-2.pdf'), 'same name again → "-2" suffix, nothing overwritten');

  const csv = Buffer.from('name,amount\nCafé,12.50\n');
  const b1 = await upload(PNG, 'IMG_0001.png', { caption: 'receipts', batch: '1/2', batchId: 'bX' });
  const b2 = await upload(csv, 'totals.csv', { caption: 'receipts', batch: '2/2', batchId: 'bX' });
  ok(b1.status === 200 && b2.status === 200, 'a two-file batch is delivered');
  const evs = lines(path.join(MIA, 'events.jsonl')).slice(-2).map((e) => e.text);
  ok(/uploaded a file \(1 of 2\): .*IMG_0001\.png \(image\/png, 2\.9 KB\) — note: receipts$/.test(evs[0]) && /\(2 of 2\): .*totals\.csv \(text\/csv, 24 B\)/.test(evs[1]), 'batch events are numbered "(n of N)"');
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(500, 3)]);
  ok((await upload(m4a, 'Voice memo.m4a')).status === 200, 'audio (.m4a) accepted');

  const cli = execFileSync('bash', [MIA_CLI, 'uploads', '-n', '3'], { env: { ...process.env, MIA_DIR: MIA } }).toString();
  ok(cli.includes('totals.csv (2 of 2) — note: receipts') && cli.includes('Voice memo.m4a') && cli.split('\n').filter(Boolean).length === 3, '`mia uploads -n 3` lists the latest');
  const cliJson = JSON.parse(execFileSync('bash', [MIA_CLI, 'uploads', '--json'], { env: { ...process.env, MIA_DIR: MIA } }).toString());
  ok(cliJson.length === 6 && cliJson[0].path === expected, '`mia uploads --json` returns the records');

  console.log('Mac slow to collect → queued, then delivered on reconnect');
  await stop(host);
  host = boot(['test/fake-host.mjs'], 'lazy-host', { FAKE_UPLOAD_IGNORE: '1' });
  await hostReady();
  const q = await upload(PDF, 'later.pdf', { caption: 'no rush' });
  ok(q.status === 202 && q.data.queued === true, `not collected in time → 202 queued ("${q.data?.detail}")`);
  ok((await health()).uploads.pending === 1 && relayFiles().length === 1, 'the relay holds it (one private temp file)');
  await stop(host);
  host = boot(['test/fake-host.mjs'], 'host2');
  const later = path.join(MIA, 'uploads', day, 'later.pdf');
  ok(await waitFor(() => fs.existsSync(later)), 'a reconnecting Mac is re-offered it and saves it');
  ok(await waitFor(async () => (await health()).uploads.pending === 0 && relayFiles().length === 0), 'then the relay copy is gone');
  ok(lines(path.join(MIA, 'events.jsonl')).at(-1)?.text.endsWith('— note: no rush'), 'Mia gets the event with the note');
  await stop(host);

  console.log('TTL purge');
  const ttlTmp = path.join(TMP, 'relay-ttl');
  boot(['server.js'], 'relay-ttl', { PORT: String(TTL_PORT), UPLOAD_TMP: ttlTmp, UPLOAD_TTL_MS: '1500', UPLOAD_WAIT_MS: '500' });
  await waitFor(async () => (await fetch(`http://localhost:${TTL_PORT}/health`)).ok);
  boot(['test/fake-host.mjs'], 'lazy-host-ttl', { PORT: String(TTL_PORT), FAKE_UPLOAD_IGNORE: '1' });
  await hostReady(TTL_PORT);
  const t = await upload(PDF, 'stale.pdf', { port: TTL_PORT });
  ok(t.status === 202, 'queued on the TTL relay');
  ok(fs.readdirSync(ttlTmp).length === 1, 'held while fresh');
  ok(await waitFor(async () => fs.readdirSync(ttlTmp).length === 0 && (await health(TTL_PORT)).uploads.pending === 0, 5000), 'purged after the TTL, never delivered');

  void relay;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    await Promise.all(procs.map(stop));
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  });
