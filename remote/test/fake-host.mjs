// Fake Mission Control host — a dev rig that impersonates the Mac menu bar app
// so the web panel can be developed and tested without the real thing.
//
// Usage:
//   cd remote && MC_TOKEN=test PORT=8899 node server.js &   # the relay
//   MC_TOKEN=test PORT=8899 node test/fake-host.mjs         # this rig
//
// It connects as role=host, streams a realistic snapshot every second, answers
// viewer commands with acks, and streams per-session terminal buffers while a
// viewer holds a 'watch' lease on a session.
//
// It also impersonates the document library (DocLibrary.swift / RemoteBridge):
// the snapshot carries doc METADATA under `docs`, bodies travel on demand via
// docGet → {type:'doc'}, and docSave/docCreate/docDelete/docMeta/docSearch plus
// the one-shot `research` launch behave as the real host does — including a
// research doc that flips draft→active→done a few seconds after it is dispatched,
// so the panel's live-research path is exercisable without the Mac. The legacy
// plan* commands stay handled as doc* aliases, exactly as RemoteBridge does.

import WebSocket from 'ws';

const PORT = process.env.PORT || 8899;
const TOKEN = process.env.MC_TOKEN || 'test';
const URL = `ws://localhost:${PORT}/ws?role=host&token=${encodeURIComponent(TOKEN)}`;

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ---------------------------------------------------------------------------
// Simulated fleet state.

const FLEET_ID = 'F1E7A9C0-0000-4000-8000-DEMO0FLEET01';

const MODELS = [
  { flag: 'sonnet', label: 'Sonnet 4.5', short: 'S', blurb: 'Fast, great default' },
  { flag: 'opus', label: 'Opus 4.6', short: 'O', blurb: 'Deepest reasoning' },
  { flag: 'haiku', label: 'Haiku 4.5', short: 'H', blurb: 'Cheap and quick' },
  { flag: 'fable', label: 'Fable 5', short: 'F', blurb: 'Balanced flagship' },
];

const ACTIVITIES = [
  'Reading src/parser.ts',
  'Editing src/parser.ts',
  'Running npm test',
  'Grepping for tokenize()',
  'Thinking…',
  'Writing tests',
  'Running tsc --noEmit',
];

function makeLog(topic) {
  const lines = [
    { kind: 'command', text: `claude -p "${topic}"` },
    { kind: 'status', text: 'Session started' },
    { kind: 'text', text: `I'll start by exploring the codebase to understand ${topic}.` },
    { kind: 'tool', text: 'Grep(pattern: "export function")' },
    { kind: 'result', text: '14 matches in 6 files' },
    { kind: 'tool', text: 'Read(src/index.ts)' },
    { kind: 'result', text: '212 lines' },
    { kind: 'text', text: 'The entry point delegates to the parser; the bug is likely in tokenize().' },
    { kind: 'tool', text: 'Edit(src/parser.ts)' },
    { kind: 'result', text: 'ok' },
    { kind: 'tool', text: 'Bash(npm test)' },
    { kind: 'result', text: '42 passing, 1 failing' },
    { kind: 'text', text: 'One regression in the quote-escaping test — fixing.' },
    { kind: 'tool', text: 'Edit(src/parser.ts)' },
    { kind: 'result', text: 'ok' },
  ];
  return lines;
}

function workerScreen(name, extra) {
  return [
    '╭──────────────────────────────────────────────╮',
    `│ Claude Code · ${name}`.padEnd(47) + '│',
    '╰──────────────────────────────────────────────╯',
    '',
    `● Working on ${extra}`,
    '',
    '  ⎿ Bash(npm test)',
    '     42 passing, 1 failing',
    '',
    `  ⎿ Edit(${extra})`,
    '     Updated 12 lines',
    '',
    '✻ Churning… (esc to interrupt)',
  ].join('\n');
}

// The idle agent's screen ends in a real-looking AskUserQuestion menu so the
// panel's parsePrompt + attention queue light up.
const ASK_SCREEN = [
  '● I found two plausible root causes for the flaky test. How should I proceed?',
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ How should I proceed with the parser fix?                    │',
  '│                                                              │',
  '│ ❯ 1. [ ] Fix the parser                                      │',
  '│        Patch tokenize() to handle escaped quotes             │',
  '│   2. [ ] Rewrite the tokenizer                               │',
  '│        Replace the regex loop with a state machine           │',
  '│   3. [ ] Add a regression test first                         │',
  '│        Lock the behavior in before touching code             │',
  '│   4. [ ] Skip the flaky test                                 │',
  '│        Mark it test.skip and file an issue                   │',
  '│  ──────────────────────────────────────────────              │',
  '│   5. Chat about this                                         │',
  '╰──────────────────────────────────────────────────────────────╯',
  '  Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

function makeAgent(over) {
  return {
    id: over.id,
    // Claude Code's own per-session name — unique-ish; the panel prefers it
    // over `folder` as the display title (tells same-dir agents apart).
    name: over.name ?? `${over.folder}-${over.id.slice(-2)}`,
    folder: over.folder,
    dir: over.dir,
    prompt: over.prompt,
    status: over.status ?? 'active',
    statusLabel: over.statusLabel ?? 'Active',
    activity: over.activity ?? ACTIVITIES[0],
    isManager: over.isManager ?? false,
    controllable: true,
    cost: over.cost ?? 0.42,
    turns: over.turns ?? 7,
    tokens: over.tokens ?? 48_000,
    outputTokens: over.outputTokens ?? 6_200,
    tokensPerSec: over.tokensPerSec ?? 38.5,
    uptime: '12m30s',
    lastActive: over.lastActive ?? '3s ago',
    todos: over.todos ?? [
      { content: 'Reproduce the failing test', activeForm: 'Reproducing the failing test', status: 'completed' },
      { content: 'Fix tokenize() escaping', activeForm: 'Fixing tokenize() escaping', status: 'in_progress' },
      { content: 'Run full test suite', activeForm: 'Running full test suite', status: 'pending' },
    ],
    log: over.log ?? makeLog(over.prompt),
    screen: over.screen ?? workerScreen(over.folder, 'src/parser.ts'),
    pid: over.pid ?? 40000 + Math.floor(Math.random() * 9999),
    cpu: over.cpu ?? 12.5,
    mem: over.mem ?? 380,
    branch: over.branch ?? 'main',
    alive: true,
    ...(over.fleetId ? { fleetId: over.fleetId } : {}),
  };
}

// (a) Two workers in the SAME dir with DIFFERENT screens and different ids —
//     proves the panel isolates terminals per session, not per directory.
// (b) One idle agent whose screen ends in an AskUserQuestion menu.
// (c) A manager-led fleet: manager + two workers sharing FLEET_ID.
// (d) One done agent.
let agents = [
  makeAgent({
    id: 'acme-worker-1', folder: 'acme', dir: '/Users/demo/acme',
    prompt: 'Fix the flaky parser test',
    screen: workerScreen('acme · parser', 'src/parser.ts'),
  }),
  makeAgent({
    id: 'acme-worker-2', folder: 'acme', dir: '/Users/demo/acme',
    prompt: 'Add CSV export to reports',
    activity: 'Editing src/export/csv.ts',
    screen: workerScreen('acme · csv export', 'src/export/csv.ts'),
  }),
  makeAgent({
    id: 'webapp-ask', folder: 'webapp', dir: '/Users/demo/webapp',
    prompt: 'Investigate flaky checkout test',
    status: 'idle', statusLabel: 'Needs input',
    activity: 'Waiting for your answer',
    lastActive: '45s ago',
    screen: ASK_SCREEN,
  }),
  makeAgent({
    id: 'shop-manager', folder: 'shop', dir: '/Users/demo/shop',
    prompt: 'Coordinate the checkout revamp',
    isManager: true,
    activity: 'Reviewing worker progress',
    screen: workerScreen('shop · manager', 'PLAN.md'),
    fleetId: FLEET_ID,
  }),
  makeAgent({
    id: 'shop-worker-1', folder: 'shop', dir: '/Users/demo/shop',
    prompt: 'Implement the payment form',
    activity: 'Editing src/checkout/PaymentForm.svelte',
    screen: workerScreen('shop · payments', 'src/checkout/PaymentForm.svelte'),
    fleetId: FLEET_ID,
  }),
  makeAgent({
    id: 'shop-worker-2', folder: 'shop', dir: '/Users/demo/shop',
    prompt: 'Wire up the tax service',
    activity: 'Running integration tests',
    screen: workerScreen('shop · tax', 'src/tax/client.ts'),
    fleetId: FLEET_ID,
  }),
  makeAgent({
    id: 'tools-done', folder: 'tools', dir: '/Users/demo/tools',
    prompt: 'Bump dependencies and fix lint',
    status: 'done', statusLabel: 'Done',
    activity: 'Finished',
    lastActive: '8m ago',
    cost: 0.18, turns: 12, tokensPerSec: 0,
    todos: [
      { content: 'Bump dependencies', activeForm: 'Bumping dependencies', status: 'completed' },
      { content: 'Fix lint errors', activeForm: 'Fixing lint errors', status: 'completed' },
    ],
    screen: workerScreen('tools', 'package.json') + '\n\n● Done. All 57 tests pass.',
  }),
];

const fleets = [
  { id: FLEET_ID, title: 'Shop checkout revamp', dir: '/Users/demo/shop', hasManager: true },
];

// ---------------------------------------------------------------------------
// Document library — mirrors ~/.mission-control/library on the real host
// (DocLibrary.swift). The snapshot carries only each doc's METADATA; a body is
// pulled on demand via docGet → {type:'doc'}. Title/preview/words are DERIVED
// from the body and never stored — which is why docMeta, which only rewrites
// frontmatter, can't and doesn't move a doc's title. `updatedAt`/`created`
// cross the wire as epoch SECONDS.

const nowSec = () => Date.now() / 1000;

// First `#` heading in the body, else its first non-empty line (≤90 chars) —
// DocLibrary.title(ofBody:).
function docTitle(body) {
  let fallback = '';
  for (const line of String(body).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const s = t.replace(/^#+/, '').trim();
      if (s) return s.slice(0, 90);
    }
    if (!fallback) fallback = t.slice(0, 90);
  }
  return fallback;
}

// A couple of plain lines after the title, ≤180 chars — DocLibrary.preview(ofBody:).
function docPreview(body) {
  let sawTitle = false;
  const out = [];
  for (const line of String(body).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!sawTitle) { sawTitle = true; if (t.startsWith('#')) continue; }
    out.push(t);
    if (out.join(' ').length > 180) break;
  }
  return out.join(' ').slice(0, 180);
}

function wordCount(body) {
  return String(body).split(/\s+/).filter(Boolean).length;
}

// DocLibrary.slug(): letters/digits kept, runs of space/-/_ collapse to one '-',
// capped at 40 chars, never empty.
function docSlug(s) {
  let out = '';
  for (const ch of String(s).toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (ch === ' ' || ch === '-' || ch === '_') { if (!out.endsWith('-')) out += '-'; }
    if (out.length >= 40) break;
  }
  out = out.replace(/-+$/, '');
  return out || 'doc';
}

// DocLibrary.uniqueId(): first writer keeps the bare slug; a collision gets a
// numeric suffix, so two same-titled creates don't clobber each other.
function newDocId(seed) {
  const base = docSlug(seed);
  let id = `${base}.md`;
  let n = 2;
  while (docs.has(id)) { id = `${base}-${n}.md`; n += 1; }
  return id;
}

const PLAN_BODY = `# Checkout revamp — implementation plan

## Context
The checkout flow lives in \`src/checkout/\` and currently posts to the legacy
\`/api/v1/order\` endpoint. Payment and tax are entangled in one component.

## Steps
1. **Split PaymentForm** — extract \`TaxSummary.svelte\` from \`PaymentForm.svelte\`
2. **New client** — add \`src/tax/client.ts\` wrapping the tax service
3. **Wire the API** — move order posting to \`/api/v2/orders\`
4. **Tests** — cover rounding edge cases (\`0.005\` boundaries)

## Risks
- Tax service rate limits (100 rpm) — add retry with backoff
- Legacy orders in flight during deploy

## Verification
Run \`npm test\` and the checkout E2E suite; place a staging order end-to-end.
`;

// A finished research report: headings + a Sources section so the panel's reader
// is exercised, and one deliberately unique token (`zephyrite`) that appears in
// NO other body — the full-text docSearch fixture the wire test greps for.
const RESEARCH_BODY = `# Acme Corp — pricing teardown

## Executive summary
Acme Corp positions itself as the premium option in the workflow-automation
market, list-pricing roughly 30% above the median competitor. Discounting is
aggressive but opaque: the public zephyrite tier exists only to anchor the
enterprise quote.

## Plans and packaging
- **Starter** — $19/seat/mo, 3-seat minimum, no SSO
- **Team** — $49/seat/mo, adds SSO and audit logs
- **Enterprise** — "contact us", volume-based, custom SLAs

## Competitive position
Against Globex and Initech, Acme wins on integrations and loses on price. The
gap widens above 50 seats, where Globex's flat-rate plan undercuts Acme.

## Risks
- Heavy reliance on annual prepay masks churn in the monthly cohort.
- No published usage limits invites bill shock, a recurring support theme.

## Sources
- Acme public pricing page — https://example.com/acme/pricing
- Globex plan comparison — https://example.com/globex/plans
- G2 reviews, "billing" filter — https://example.com/g2/acme
`;

const NOTE_BODY = `# Standup notes — 2026-07-08

- Shipped the tax client behind a feature flag
- Blocked on staging credentials for the payment sandbox
- Follow up with design on the empty-state copy
`;

// id → { kind, status, subject, tags, dir, session, created, updatedAt, content }.
// A realistic mix: a captured plan, a finished research report, a hand-written note.
const docs = new Map([
  ['checkout-revamp--3fa9c2d1.md', {
    kind: 'plan', status: 'draft', subject: '', tags: [],
    dir: '/Users/demo/shop', session: 'shop-manager',
    created: nowSec() - 3600, updatedAt: nowSec() - 600, content: PLAN_BODY,
  }],
  ['acme-corp-pricing-teardown--7b2e9f14.md', {
    kind: 'research', status: 'done', subject: 'Acme Corp',
    tags: ['pricing', 'competitors'],
    dir: '/Users/demo/acme', session: '',
    created: nowSec() - 86400, updatedAt: nowSec() - 5400, content: RESEARCH_BODY,
  }],
  ['standup-notes.md', {
    kind: 'note', status: 'draft', subject: '', tags: ['meeting'],
    dir: '', session: '',
    created: nowSec() - 7200, updatedAt: nowSec() - 1800, content: NOTE_BODY,
  }],
]);

function docMetaList() {
  return [...docs.entries()]
    .map(([id, d]) => ({
      id,
      title: docTitle(d.content),
      kind: d.kind, status: d.status, subject: d.subject, tags: d.tags,
      dir: d.dir,
      folder: d.dir ? d.dir.split('/').pop() : '',
      session: d.session,
      preview: docPreview(d.content),
      words: wordCount(d.content),
      created: d.created, updatedAt: d.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function sendDoc(id) {
  const d = docs.get(id);
  if (!d) return false;
  send({
    type: 'doc', id, title: docTitle(d.content),
    kind: d.kind, status: d.status, subject: d.subject, tags: d.tags,
    dir: d.dir, content: d.content, updatedAt: d.updatedAt,
  });
  return true;
}

// The report a dispatched research agent writes back a few seconds after launch.
function researchReport(title, topic, subject) {
  const subj = subject ? `**Subject:** ${subject}\n\n` : '';
  return `# ${title}

${subj}## Executive summary
${topic} is well-established, with three credible approaches in active use. The
recommended path balances delivery speed against long-term maintenance cost.

## Findings
1. The dominant approach is widely documented and battle-tested.
2. A newer alternative trades a steeper learning curve for lower overhead.
3. Tooling has consolidated over the last year, reducing integration risk.

## Recommendation
Adopt the mainstream approach now; revisit the alternative once the team has
the capacity to absorb the migration.

## Sources
- Primary reference — https://example.com/reference
- Community discussion — https://example.com/thread
`;
}

let tick = 0;
let launchSeq = 0;

function snapshot() {
  tick += 1;
  // Make it look alive: activity rotates, tokens/cost tick up.
  for (const a of agents) {
    if (a.status !== 'active') continue;
    if (tick % 4 === 0) {
      a.activity = ACTIVITIES[(tick / 4 + a.pid) % ACTIVITIES.length | 0];
    }
    a.tokens += 30 + Math.floor(Math.random() * 60);
    a.outputTokens += 10 + Math.floor(Math.random() * 25);
    a.cost += 0.0004;
    a.tokensPerSec = 25 + Math.random() * 30;
    a.cpu = 5 + Math.random() * 30;
    if (tick % 10 === 0) a.turns += 1;
    a.lastActive = `${1 + (tick % 3)}s ago`;
  }
  const active = agents.filter((a) => a.status === 'active').length;
  const idle = agents.filter((a) => a.status === 'idle').length;
  const done = agents.filter((a) => a.status === 'done').length;
  const sum = (f) => agents.reduce((n, a) => n + f(a), 0);
  const totalTokens = sum((a) => a.tokens);
  return {
    type: 'snapshot',
    at: Date.now() / 1000,
    summary: {
      active, idle, done, total: agents.length,
      attention: idle,
      totalCost: sum((a) => a.cost),
      totalTurns: sum((a) => a.turns),
      totalTokens,
      outputTokens: sum((a) => a.outputTokens),
      inputTokens: Math.floor(totalTokens * 0.15),
      cacheReadTokens: Math.floor(totalTokens * 0.7),
      cacheCreateTokens: Math.floor(totalTokens * 0.08),
      tokensPerSec: sum((a) => a.tokensPerSec),
    },
    agents,
    fleets,
    docs: docMetaList(),
    knownDirs: ['/Users/demo/acme', '/Users/demo/webapp', '/Users/demo/shop', '/Users/demo/tools'],
    lastDir: '/Users/demo/acme',
    models: MODELS,
    system: { cpu: 18 + Math.random() * 20, cores: 12, memUsedMB: 14200, memTotalMB: 32768 },
  };
}

// ---------------------------------------------------------------------------
// Watch leases → per-session streamed terminal buffers.

const leases = new Map(); // sessionId -> { lastSeen, seq, lines }
const LEASE_TTL_MS = 8000;

const CHROME_LINES = [
  '  ⎿ Bash(npm test) — 42 passing',
  '  ⎿ Read(src/parser.ts) — 212 lines',
  '  ⎿ Edit(src/parser.ts) — updated 4 lines',
  '✻ Simmering… (esc to interrupt · ctrl+t to show todos)',
  '● Now updating the escape handling in tokenize().',
  '  ⎿ Grep("tokenize") — 9 matches in 3 files',
];

function screenFrame(sessionId, lease) {
  // Buffer gains a couple of lines per second, capped at ~120 lines of
  // scrollback — simulates streaming output on top of history.
  const gained = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < gained; i++) {
    lease.seq += 1;
    const chrome = CHROME_LINES[lease.seq % CHROME_LINES.length];
    lease.lines.push(
      lease.seq % 5 === 0 ? chrome : `    [${sessionId}] output line ${lease.seq}: computed chunk ${lease.seq * 7 % 997}`
    );
  }
  if (lease.lines.length > 120) lease.lines = lease.lines.slice(-120);
  return { type: 'screen', sessionId, seq: lease.seq, text: lease.lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Connection loop with 1s reconnect backoff.

let ws = null;

function connect() {
  ws = new WebSocket(URL);

  ws.on('open', () => log(`connected as host → ${URL}`));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // A panel cached before the plan library became the document library still
    // speaks plan*. They are the doc* handlers under old names — a plan is just a
    // doc of kind `plan` — so normalize here exactly as RemoteBridge does.
    let type = msg.type;
    switch (type) {
      case 'planGet': type = 'docGet'; break;
      case 'planSave': type = 'docSave'; break;
      case 'planDelete': type = 'docDelete'; break;
      case 'planCreate': type = 'docCreate'; if (msg.kind == null) msg.kind = 'plan'; break;
    }

    switch (type) {
      case 'viewers':
        log(`relay: ${msg.count} viewer(s)`);
        return;

      case 'watch': {
        const lease = leases.get(msg.sessionId) ?? { lastSeen: 0, seq: 0, lines: seedBuffer(msg.sessionId) };
        const fresh = lease.lastSeen === 0;
        lease.lastSeen = Date.now();
        leases.set(msg.sessionId, lease);
        if (fresh) log(`watch lease opened for ${msg.sessionId}`);
        return;
      }

      case 'reply':
        log(`reply → ${msg.sessionId ?? '?'}: ${JSON.stringify(msg.text ?? '')}`);
        send({ type: 'ack', ok: true, cmd: 'reply', detail: `Sent to ${msg.sessionId ?? 'agent'}` });
        return;

      case 'broadcast':
        log(`broadcast: ${JSON.stringify(msg.text ?? '')}`);
        send({ type: 'ack', ok: true, cmd: 'broadcast', detail: `Sent to ${agents.length} agents` });
        return;

      case 'key':
        log(`key → ${msg.sessionId ?? '?'}: ${msg.key ?? '?'}`);
        send({ type: 'ack', ok: true, cmd: 'key', detail: `Sent ${msg.key ?? 'key'}` });
        return;

      case 'kill': {
        log(`kill → ${msg.sessionId ?? '?'}`);
        agents = agents.filter((a) => a.id !== msg.sessionId);
        leases.delete(msg.sessionId);
        send({ type: 'ack', ok: true, cmd: 'kill', detail: `Stopped ${msg.sessionId ?? 'agent'}` });
        return;
      }

      // ---- document library ----------------------------------------------
      // Markdown files in ~/.mission-control/library/. The snapshot carries
      // their metadata; bodies travel on demand as {type:'doc'}. `cmd` on every
      // ack is the ORIGINAL wire type so a legacy plan* caller sees plan* back.

      case 'docGet': {
        log(`docGet → ${msg.id}`);
        // On success only the doc frame is sent, no ack — mirrors RemoteBridge.
        if (!sendDoc(msg.id)) send({ type: 'ack', ok: false, cmd: 'docGet', detail: 'That document is gone' });
        return;
      }

      case 'docSave': {
        const d = docs.get(msg.id);
        log(`docSave → ${msg.id} (${(msg.content ?? '').length} chars)`);
        if (!d || typeof msg.content !== 'string') {
          send({ type: 'ack', ok: false, cmd: 'docSave', detail: "Couldn't save that document" });
          return;
        }
        // Only the body changes; frontmatter (kind/status/subject/tags/dir) is
        // untouched, and title/preview/words re-derive from the new body.
        d.content = msg.content;
        d.updatedAt = nowSec();
        send({ type: 'ack', ok: true, cmd: 'docSave', detail: 'Document saved' });
        return;
      }

      case 'docCreate': {
        const title = (msg.title || '').trim();
        // DocLibrary.Kind(loose:) — unknown/garbage degrades to `note`.
        const kind = ['plan', 'research', 'note'].includes(msg.kind) ? msg.kind : 'note';
        const content = (typeof msg.content === 'string' && msg.content.length)
          ? msg.content
          : `# ${title || `Untitled ${kind}`}\n\n`;
        const id = newDocId(title || docTitle(content) || 'doc');
        docs.set(id, {
          kind, status: 'draft',
          subject: msg.subject || '', tags: Array.isArray(msg.tags) ? msg.tags : [],
          dir: (msg.dir || '').trim(), session: '',
          created: nowSec(), updatedAt: nowSec(), content,
        });
        log(`docCreate → ${id}`);
        // Ack carries the new id (so the panel can jump to the doc), THEN the
        // body frame — RemoteBridge's exact order.
        send({ type: 'ack', ok: true, cmd: 'docCreate', detail: 'Document created', id });
        sendDoc(id);
        return;
      }

      case 'docDelete': {
        log(`docDelete → ${msg.id}`);
        const ok = docs.delete(msg.id);
        send({ type: 'ack', ok, cmd: 'docDelete', detail: ok ? 'Document deleted' : 'That document is already gone' });
        return;
      }

      case 'docMeta': {
        const d = docs.get(msg.id);
        log(`docMeta → ${msg.id}`);
        if (!d) { send({ type: 'ack', ok: false, cmd: 'docMeta', detail: "Couldn't update that document" }); return; }
        // Patch semantics: only keys PRESENT in the frame move. An absent key
        // leaves that field alone (RemoteBridge maps a missing key to nil, which
        // DocLibrary.update reads as "leave alone"). Title lives in the body, so
        // it is never sent here and never changes. Any write bumps updatedAt.
        if ('kind' in msg) d.kind = ['plan', 'research', 'note'].includes(msg.kind) ? msg.kind : 'note';
        if ('status' in msg) d.status = ['draft', 'active', 'done', 'archived'].includes(msg.status) ? msg.status : 'draft';
        if ('subject' in msg) d.subject = msg.subject;
        if ('tags' in msg && Array.isArray(msg.tags)) d.tags = msg.tags;
        if ('dir' in msg) d.dir = msg.dir;
        d.updatedAt = nowSec();
        send({ type: 'ack', ok: true, cmd: 'docMeta', detail: 'Updated' });
        return;
      }

      case 'docSearch': {
        const q = String(msg.q ?? '').trim().toLowerCase();
        log(`docSearch → ${JSON.stringify(q)}`);
        const hits = [];
        if (q) {
          for (const meta of docMetaList()) { // newest-first, like DocLibrary.list()
            const d = docs.get(meta.id);
            const snippets = [];
            for (const line of d.content.split('\n')) {
              if (!line.toLowerCase().includes(q)) continue;
              const t = line.trim();
              if (!t) continue;
              snippets.push(t.slice(0, 220));
              if (snippets.length >= 3) break;
            }
            // A title/subject/tag hit counts even when the body never says it.
            const metaHay = `${meta.title} ${d.subject} ${d.tags.join(' ')}`.toLowerCase();
            if (!snippets.length && !metaHay.includes(q)) continue;
            hits.push({ id: meta.id, snippets });
            if (hits.length >= 40) break;
          }
        }
        send({ type: 'docSearchResult', q: String(msg.q ?? '').trim(), hits });
        return;
      }

      case 'research': {
        const topic = String(msg.topic ?? '').trim();
        if (!topic) { send({ type: 'ack', ok: false, cmd: 'research', detail: 'Research topic is empty' }); return; }
        const subject = String(msg.subject ?? '').trim();
        const rdir = String(msg.dir ?? '').trim();
        const tags = Array.isArray(msg.tags) ? msg.tags : [];
        const title = subject ? `${subject} — ${topic}` : topic;
        // Seed the file NOW so it shows up as `active` the instant the agent
        // starts and the agent has a path to write to.
        const id = newDocId(title);
        docs.set(id, {
          kind: 'research', status: 'active',
          subject, tags, dir: rdir, session: '',
          created: nowSec(), updatedAt: nowSec(),
          content: `# ${title}\n\n_Research in progress…_\n`,
        });
        log(`research → ${id} (${JSON.stringify(topic)})`);
        send({ type: 'ack', ok: true, cmd: 'research', detail: 'Researching on your Mac', id });
        // Imitate the dispatched agent: a few seconds later it overwrites the
        // stub with a finished report and flips the doc to `done`, bumping
        // updatedAt — the active → (snapshot) → done+longer-body sequence the
        // panel's live-research path watches for.
        setTimeout(() => {
          const d = docs.get(id);
          if (!d) return;
          d.content = researchReport(title, topic, subject);
          d.status = 'done';
          d.updatedAt = nowSec();
          log(`research done → ${id}`);
        }, 4000);
        return;
      }

      case 'launch': {
        log(`launch in ${msg.dir ?? '?'}${msg.planId ? ` [plan:${msg.planId}]` : ''}${msg.planMode ? ' [planMode]' : ''}: ${JSON.stringify(msg.mission ?? '')}`);
        send({ type: 'ack', ok: true, cmd: 'launch', detail: 'Launching…' });
        setTimeout(() => {
          launchSeq += 1;
          const dir = msg.dir || '/Users/demo/acme';
          agents.push(makeAgent({
            id: `launched-${launchSeq}`,
            folder: dir.split('/').pop() || 'new',
            dir,
            prompt: msg.mission || 'New task',
            activity: 'Starting up…',
            cost: 0, turns: 0, tokens: 0, outputTokens: 0,
            uptime: '0m05s', lastActive: 'just now',
            screen: workerScreen('launched', 'starting…'),
          }));
          log(`launched agent launched-${launchSeq}`);
        }, 2000);
        return;
      }

      default:
        log(`unhandled message: ${msg.type}`);
    }
  });

  ws.on('close', (code) => {
    log(`socket closed (${code}) — reconnecting in 1s`);
    ws = null;
    setTimeout(connect, 1000);
  });

  ws.on('error', (err) => {
    log(`socket error: ${err.message}`);
    // 'close' follows and schedules the reconnect.
  });
}

function seedBuffer(sessionId) {
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(i % 7 === 0
      ? CHROME_LINES[i % CHROME_LINES.length]
      : `    [${sessionId}] scrollback line ${i}`);
  }
  return lines;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// 1 Hz: snapshot + any live screen streams.
setInterval(() => {
  send(snapshot());
  const now = Date.now();
  for (const [sessionId, lease] of leases) {
    if (now - lease.lastSeen > LEASE_TTL_MS) {
      log(`watch lease expired for ${sessionId}`);
      leases.delete(sessionId);
      continue;
    }
    send(screenFrame(sessionId, lease));
  }
}, 1000);

connect();
log(`fake host starting (relay port ${PORT}, token ${TOKEN === 'test' ? "'test'" : 'set'})`);
