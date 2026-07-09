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
// Plan library — mirrors ~/.mission-control/plans on the real host. Snapshot
// carries metadata; bodies travel on demand via planGet → {type:'plan'}.

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

let planSeq = 0;
const plans = new Map([
  ['checkout-revamp--3fa9c2d1.md', {
    title: 'Checkout revamp — implementation plan',
    dir: '/Users/demo/shop', session: 'shop-manager',
    created: Date.now() / 1000 - 3600, updatedAt: Date.now() / 1000 - 600,
    content: PLAN_BODY,
  }],
  ['csv-export.md', {
    title: 'CSV export for reports',
    dir: '/Users/demo/acme', session: '',
    created: Date.now() / 1000 - 86400, updatedAt: Date.now() / 1000 - 7200,
    content: '# CSV export for reports\n\n- Add `Export` button to the reports toolbar\n- Stream rows server-side, no in-memory join\n- RFC 4180 quoting, UTF-8 BOM for Excel\n',
  }],
]);

function planMetaList() {
  return [...plans.entries()]
    .map(([id, p]) => ({
      id, title: p.title, dir: p.dir,
      folder: p.dir ? p.dir.split('/').pop() : '',
      session: p.session,
      preview: p.content.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join(' ').slice(0, 180),
      created: p.created, updatedAt: p.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function planTitle(body) {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) return t.replace(/^#+\s*/, '').slice(0, 90);
    return t.slice(0, 90);
  }
  return 'Untitled plan';
}

function sendPlan(id) {
  const p = plans.get(id);
  if (!p) return false;
  send({ type: 'plan', id, title: p.title, dir: p.dir, content: p.content, updatedAt: p.updatedAt });
  return true;
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
    plans: planMetaList(),
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

    switch (msg.type) {
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

      case 'planGet': {
        log(`planGet → ${msg.id}`);
        if (!sendPlan(msg.id)) send({ type: 'ack', ok: false, cmd: 'planGet', detail: 'That plan is gone' });
        return;
      }

      case 'planSave': {
        const p = plans.get(msg.id);
        log(`planSave → ${msg.id} (${(msg.content ?? '').length} chars)`);
        if (!p || typeof msg.content !== 'string') {
          send({ type: 'ack', ok: false, cmd: 'planSave', detail: "Couldn't save that plan" });
          return;
        }
        p.content = msg.content;
        p.title = planTitle(msg.content);
        p.updatedAt = Date.now() / 1000;
        send({ type: 'ack', ok: true, cmd: 'planSave', detail: 'Plan saved' });
        return;
      }

      case 'planCreate': {
        planSeq += 1;
        const title = msg.title || 'Untitled plan';
        const id = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan'}-${planSeq}.md`;
        const content = msg.content || `# ${title}\n\n`;
        plans.set(id, { title: planTitle(content), dir: msg.dir || '', session: '', created: Date.now() / 1000, updatedAt: Date.now() / 1000, content });
        log(`planCreate → ${id}`);
        send({ type: 'ack', ok: true, cmd: 'planCreate', detail: 'Plan created', id });
        sendPlan(id);
        return;
      }

      case 'planDelete': {
        log(`planDelete → ${msg.id}`);
        const ok = plans.delete(msg.id);
        send({ type: 'ack', ok, cmd: 'planDelete', detail: ok ? 'Plan deleted' : 'That plan is already gone' });
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
