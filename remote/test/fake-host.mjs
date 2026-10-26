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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

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

## Seat pricing by competitor
| Vendor | Plan | Price per seat | Minimum seats | SSO | Audit logs | Notes from the sales call |
|---|---|---|---|---|---|---|
| Acme | Starter | $19 | 3 | No | No | The rep pushed annual prepay hard and offered 15% off without being asked, which suggests the list price is mostly an anchor. |
| Acme | Team | $49 | 3 | Yes | Yes | SSO only on Team and above; SCIM costs extra on top of the seat price. |
| Globex | Flat | $1,900 flat | 1 | Yes | Yes | Flat rate up to 100 seats, which is where Globex undercuts Acme most clearly. |
| Initech | Pro | $39 | 5 | Yes | No | Audit logs are on the roadmap for next quarter, according to their public changelog. |

## Option 3: tell the safety model this work is allowed (narrower)
Only for the three recurring lookups; everything else still asks first.

## Sources
- Acme public pricing page — https://example.com/acme/pricing
- Globex plan comparison — https://example.com/globex/plans
- G2 reviews, "billing" filter — https://example.com/g2/acme
`;

// Two tables that share a phrase and a heading Mia misspells (task 0067) —
// shaped like Daniel's property deep-dive, where "four years unsold" is in a
// listing's notes AND leads the ranking table's reason.
const TARGETS_BODY = `# Oblivion targets — deep dive

## Summary
Sixteen listings checked against the brief; five are worth a call.

### Verdict table
| Rank | Listing | Verdict |
|---|---|---|
| 1 | B1 | Call first |
| 2 | A4 | Call this week |

## Listings
| Ref | Listing | Area | Price | Agent | Listed | Notes |
|---|---|---|---|---|---|---|
| A4 | 9 Kloof Road | Bantry Bay | R38.5m | Pam Golding | Jan 2025 | Price cut twice. |
| B1 | 121 Victoria Road penthouse | Camps Bay | R54.0m | RE/MAX, not sole | May 2022 | Over four years unsold. Over 400 m². Municipal value R34.6m. |

## Ranking
| # | Target | Why |
|---|---|---|
| 1 | B1, 121 Victoria Road penthouse | Four years unsold is the strongest motivation signal in either list |
| 2 | A4, 9 Kloof Road | Two price cuts in a year |
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
  ['oblivion-targets-deep-dive.md', {
    kind: 'research', status: 'done', subject: 'Property', tags: [],
    dir: '', session: '',
    created: nowSec() - 90000, updatedAt: nowSec() - 90000, content: TARGETS_BODY,
  }],
  ['standup-notes.md', {
    kind: 'note', status: 'draft', subject: '', tags: ['meeting'],
    dir: '', session: '',
    created: nowSec() - 7200, updatedAt: nowSec() - 1800, content: NOTE_BODY,
  }],
]);

// FAKE_HOST_LIBRARY=<dir> adds that folder's .md files (e.g. the real
// ~/.mission-control/library) — for checking the panel against real docs.
if (process.env.FAKE_HOST_LIBRARY) {
  for (const f of fs.readdirSync(process.env.FAKE_HOST_LIBRARY)) {
    if (!f.endsWith('.md')) continue;
    const st = fs.statSync(path.join(process.env.FAKE_HOST_LIBRARY, f));
    const raw = fs.readFileSync(path.join(process.env.FAKE_HOST_LIBRARY, f), 'utf8');
    const front = (/^---\n([\s\S]*?)\n---\n/.exec(raw) || [])[1] || '';
    const fv = (k) => ((new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(front) || [])[1] || '').trim();
    // Like DocLibrary.Kind(loose:) in a Mac app from before pages (task 0126):
    // an unknown kind reads as note — FAKE_HOST_PAGE_KIND=1 plays a newer app.
    const kinds = process.env.FAKE_HOST_PAGE_KIND === '1' ? ['plan', 'research', 'note', 'page'] : ['plan', 'research', 'note'];
    docs.set(f, {
      kind: front ? (kinds.includes(fv('kind')) ? fv('kind') : 'note') : 'research',
      status: front ? fv('status') || 'draft' : 'done',
      subject: fv('subject'),
      tags: fv('tags').split(',').map((t) => t.trim()).filter(Boolean),
      dir: '', session: '',
      created: Math.floor(st.mtimeMs / 1000), updatedAt: Math.floor(st.mtimeMs / 1000),
      // The Mac sends the body only (DocLibrary strips the frontmatter).
      content: fs.readFileSync(path.join(process.env.FAKE_HOST_LIBRARY, f), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''),
    });
  }
}

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

// ---------------------------------------------------------------------------
// Mia, the assistant (docs/mia.md). The snapshot carries a `mia` block; the
// mia* commands mutate it and ack the way MiaManager does. `miaPushTest` also
// emits a host `push` frame, which the relay turns into a Web Push.

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const mia = {
  enabled: true,
  online: true,
  sessionId: 'mia-session-0001',
  model: 'claude-opus-5-5',
  runningModel: 'claude-opus-5-5', // what the live session runs on (null when down)
  restarts: 0,
  readUpTo: null,
  pushKey: null, // filled from the relay's {type:'pushKey'} on connect
  messages: [
    { id: 'm_1', at: iso(600000), from: 'daniel', kind: 'chat', text: 'Add dark mode to the settings page in acme' },
    { id: 'm_2', at: iso(590000), from: 'mia', kind: 'question', text: 'Only the settings page, or the whole app?', options: ['Settings only', 'Whole app'], taskId: '0001', questionId: 'q_seed1' },
  ],
  tasks: [
    {
      id: '0001', title: 'Add dark mode to settings', detail: 'Add dark mode to the settings page in acme',
      dir: '/Users/demo/acme', status: 'asking', priority: 2, createdAt: iso(600000), updatedAt: iso(590000),
      questions: [{ id: 'q_seed1', text: 'Only the settings page, or the whole app?', options: ['Settings only', 'Whole app'], askedAt: iso(590000), answer: null, answeredAt: null }],
      executor: null, log: [], result: null,
    },
  ],
  schedule: {
    heartbeats: [{ id: 'hb_inbox', label: 'Inbox check', everyMinutes: 30, prompt: 'Check the inbox.', enabled: true }],
    reminders: [],
  },
};
let miaMsgSeq = 2;
// `mia ask` lines from the real CLI (no task on this host): open until
// answered, like MiaManager's open questions.
const looseQuestions = [];

// Like MiaQuestions.swift: open = unanswered and not dismissed; open ones
// older than questionMaxAgeHours ride as oldQuestions (hidden, not counted).
let questionMaxAgeHours = 48;
const closedQuestions = {}; // qid → 'dismissed' | 'expired'
const isOldQ = (q) => questionMaxAgeHours > 0 && Date.now() - Date.parse(q.askedAt) > questionMaxAgeHours * 3600e3;
function openQuestions() {
  const out = [];
  for (const t of mia.tasks) {
    if (['done', 'failed', 'cancelled'].includes(t.status)) continue;
    for (const q of t.questions || []) {
      if (q.answer == null && !closedQuestions[q.id]) out.push({ q, card: { questionId: q.id, taskId: t.id, text: q.text, options: q.options || [], askedAt: q.askedAt } });
    }
  }
  for (const q of looseQuestions) {
    if (q.answer == null && !closedQuestions[q.id]) out.push({ q, card: { questionId: q.id, taskId: null, text: q.text, options: q.options || [], askedAt: q.askedAt } });
  }
  return out;
}

function miaBlock() {
  const open = openQuestions();
  const pendingQuestions = open.filter((o) => !isOldQ(o.card)).map((o) => o.card);
  const oldQuestions = open.filter((o) => isOldQ(o.card)).map((o) => o.card);
  const block = { ...mia, messages: mia.messages.slice(-200), pendingQuestions, oldQuestions, closedQuestions, questionMaxAgeHours };
  // FAKE_HOST_LEGACY_MIA=1 impersonates a Mac app before 0027 (no runningModel).
  if (process.env.FAKE_HOST_LEGACY_MIA) {
    delete block.runningModel;
    // …and before 0103: no question ages, no miaDismiss.
    delete block.oldQuestions;
    delete block.closedQuestions;
    delete block.questionMaxAgeHours;
  }
  return block;
}

function miaMessage(fields) {
  miaMsgSeq += 1;
  const m = { id: `m_${miaMsgSeq}`, at: iso(), ...fields };
  mia.messages.push(m);
  return m;
}

// Returns the ack to send for a mia* command, or null if `type` isn't one.
function handleMia(type, msg) {
  const ack = (ok, detail, extra = {}) => ({ type: 'ack', cmd: type, ok, detail, ...extra });
  const task = (id) => mia.tasks.find((t) => t.id === String(id));
  if (type.startsWith('mia') && type !== 'miaRead') log(`mia cmd ${type}${msg.model ? ` ${msg.model}` : ''}`);
  switch (type) {
    case 'miaSend': {
      const text = String(msg.text ?? '').trim();
      if (!text) return ack(false, 'Message is empty');
      miaMessage({ from: 'daniel', kind: 'chat', text });
      // Talk mode: a spoken message gets a short spoken-style reply, so the
      // panel's listen → send → speak loop can be exercised end to end.
      if (text.startsWith('(voice) ')) {
        const said = text.slice(8);
        setTimeout(() => miaMessage({ from: 'mia', kind: 'chat', text: `Got it. You said: ${said}` }), 1200);
      }
      return ack(true, 'Sent to Mia');
    }
    case 'miaAnswer': {
      const text = String(msg.text ?? '').trim();
      let hit = null;
      for (const t of mia.tasks) for (const q of t.questions || []) if (q.id === msg.questionId) hit = { t, q };
      const loose = looseQuestions.find((q) => q.id === msg.questionId && q.answer == null);
      if (!hit && loose && text) {
        loose.answer = text;
        miaMessage({ from: 'daniel', kind: 'answer', text, questionId: loose.id });
        log(`mia answer ${loose.id}: ${text}`);
        return ack(true, 'Answer delivered');
      }
      if (!hit) return ack(false, `No question ${msg.questionId}`);
      if (!text) return ack(false, 'Answer is empty');
      hit.q.answer = text;
      hit.q.answeredAt = iso();
      if (hit.t.status === 'asking') hit.t.status = 'queued';
      hit.t.updatedAt = iso();
      miaMessage({ from: 'daniel', kind: 'answer', text, questionId: hit.q.id, taskId: hit.t.id });
      return ack(true, 'Answer delivered');
    }
    case 'miaDismiss': {
      if (process.env.FAKE_HOST_LEGACY_MIA) return ack(false, `Unknown command ${type}`);
      // As MiaManager.dismiss: the ids given, or (old) every open one past the
      // max age; Mia gets one [MC] line (events.jsonl under MIA_DIR).
      const want = new Set([...(msg.questionIds || []), msg.questionId].filter(Boolean));
      const hits = openQuestions().filter((o) => (msg.old ? isOldQ(o.card) : want.has(o.q.id)));
      if (!hits.length) return ack(false, msg.old ? 'No old questions to dismiss' : 'That question is already closed');
      for (const { q, card } of hits) {
        closedQuestions[q.id] = 'dismissed';
        q.dismissedAt = iso();
        const t = card.taskId && task(card.taskId);
        if (t && t.status === 'asking' && !(t.questions || []).some((x) => x.answer == null && !closedQuestions[x.id])) t.status = 'queued';
      }
      const ref = (c) => (c.taskId ? `${c.questionId} (task ${c.taskId})` : c.questionId);
      const line = hits.length === 1
        ? `[MC] Daniel dismissed ${ref(hits[0].card)} — no answer is coming, don't wait on it: "${hits[0].card.text}"`
        : `[MC] Daniel dismissed ${hits.length}${msg.old ? ' old' : ''} questions — no answers are coming, don't wait on them: ${hits.map((h) => ref(h.card)).join(', ')}`;
      log(`mia event ${line}`);
      if (MIA_DIR) fs.appendFileSync(path.join(MIA_DIR, 'events.jsonl'), JSON.stringify({ id: `e_${Date.now()}`, at: iso(), kind: 'dismiss', text: line, delivered: false }) + '\n');
      return ack(true, hits.length === 1 ? 'Question dismissed' : `Dismissed ${hits.length} questions`);
    }
    case 'miaQuestionAge': {
      const h = Number(msg.hours);
      if (!Number.isFinite(h) || h < 0) return ack(false, 'Bad age');
      questionMaxAgeHours = h;
      return ack(true, h === 0 ? 'Old questions stay visible' : `Questions hide after ${h} h`);
    }
    case 'miaRead':
      if (!mia.messages.some((m) => m.id === msg.upTo)) return ack(false, `No message ${msg.upTo}`);
      mia.readUpTo = msg.upTo;
      return ack(true, 'Marked read');
    case 'miaTaskAdd': {
      const title = String(msg.title ?? '').trim();
      if (!title) return ack(false, 'Title is empty');
      const max = mia.tasks.reduce((n, t) => Math.max(n, Number(t.id) || 0), 0);
      const id = String(max + 1).padStart(4, '0');
      mia.tasks.push({
        id, title, detail: msg.detail ?? '', dir: msg.dir ?? null, status: 'queued',
        priority: Number.isInteger(msg.priority) ? msg.priority : 3,
        createdAt: iso(), updatedAt: iso(), questions: [], executor: null, log: [], result: null,
      });
      return ack(true, `Task ${id} queued`, { id });
    }
    case 'miaTaskCancel': {
      const t = task(msg.id);
      if (!t) return ack(false, `No task ${msg.id}`);
      t.status = 'cancelled';
      t.updatedAt = iso();
      return ack(true, `Task ${t.id} cancelled`);
    }
    case 'miaTaskSet': {
      const t = task(msg.id);
      if (!t) return ack(false, `No task ${msg.id}`);
      if (!['status', 'priority', 'dir'].includes(msg.field)) return ack(false, `Can't set ${msg.field}`);
      t[msg.field] = msg.field === 'priority' ? Number(msg.value) : msg.value;
      t.updatedAt = iso();
      return ack(true, `Task ${t.id} ${msg.field} set`);
    }
    case 'miaStart':
      mia.enabled = true;
      mia.online = true;
      mia.runningModel = mia.model;
      return ack(true, 'Mia starting');
    case 'miaStop':
      mia.enabled = false;
      mia.online = false;
      mia.runningModel = null;
      return ack(true, 'Mia stopped');
    case 'miaRestart':
      // Like MiaManager.restart(): a fresh session on the saved model.
      mia.enabled = true;
      mia.online = true;
      mia.runningModel = mia.model;
      mia.restarts += 1;
      mia.sessionId = `mia-session-${String(mia.restarts + 1).padStart(4, '0')}`;
      return ack(true, `Restarting Mia on ${mia.model}`);
    case 'miaSetModel':
      if (!String(msg.model ?? '').trim()) return ack(false, 'Model is empty');
      mia.model = String(msg.model);
      return ack(true, `Model set to ${mia.model}`);
    case 'miaSchedule': {
      const s = mia.schedule;
      const item = msg.item || {};
      switch (msg.op) {
        case 'addReminder': s.reminders.push({ id: item.id || `r_${Date.now()}`, at: item.at, text: item.text, taskId: item.taskId ?? null, fired: false }); break;
        case 'removeReminder': s.reminders = s.reminders.filter((r) => r.id !== (item.id ?? msg.id)); break;
        case 'setHeartbeat': s.heartbeats = [...s.heartbeats.filter((h) => h.id !== item.id), item]; break;
        case 'removeHeartbeat': s.heartbeats = s.heartbeats.filter((h) => h.id !== (item.id ?? msg.id)); break;
        default: return ack(false, `Unknown schedule op ${msg.op}`);
      }
      return ack(true, 'Schedule updated');
    }
    case 'miaPushTest':
      send({ type: 'push', title: 'Mia', body: 'Test notification from Mission Control', tag: 'mia-test', url: '/#mia', urgent: false });
      return ack(true, 'Test push sent');
    default:
      return null;
  }
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
    // What this host can do beyond the base protocol (the relay gates uploads on it).
    // FAKE_HOST_CAPS='' impersonates an older Mac app.
    caps: (process.env.FAKE_HOST_CAPS ?? 'upload,miaRestart,tts').split(',').filter(Boolean),
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
    mia: miaBlock(),
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

// What a viewer would see: the scrollback plus the shell's current input line —
// so characters typed from the remote console echo back the way a real tty does.
function renderLease(lease) {
  return [...lease.lines, `❯ ${lease.input}█`].join('\n');
}

// Grow the buffer the way a working agent would: a couple of lines a second,
// capped at ~120 lines of scrollback.
function growLease(sessionId, lease) {
  const gained = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < gained; i++) {
    lease.grown += 1;
    const chrome = CHROME_LINES[lease.grown % CHROME_LINES.length];
    lease.lines.push(
      lease.grown % 5 === 0 ? chrome : `    [${sessionId}] output line ${lease.grown}: computed chunk ${lease.grown * 7 % 997}`
    );
  }
  if (lease.lines.length > 120) lease.lines = lease.lines.slice(-120);
}

const FULL_SCREEN_EVERY = 8; // …frames, so a viewer joining mid-stream catches up

// Emit a {type:'screen'} frame if the buffer moved, as a prefix delta when most
// of it is unchanged — the same encoding RemoteBridge.sendScreen uses, so the
// panel's delta path gets exercised without the Mac.
function screenFrame(sessionId, lease) {
  const text = renderLease(lease);
  if (text === lease.last) return null;
  const prev = lease.last;
  lease.last = text;
  lease.seq += 1;
  if (prev != null && lease.sinceFull + 1 < FULL_SCREEN_EVERY) {
    let keep = 0;
    while (keep < text.length && keep < prev.length && text[keep] === prev[keep]) keep += 1;
    if (keep > text.length / 2) {
      lease.sinceFull += 1;
      return { type: 'screen', sessionId, seq: lease.seq, keep, text: text.slice(keep) };
    }
  }
  lease.sinceFull = 0;
  return { type: 'screen', sessionId, seq: lease.seq, text };
}

function newLease(sessionId) {
  return { lastSeen: 0, hotUntil: 0, seq: 0, grown: 0, sinceFull: 0, last: null, input: '', lines: seedBuffer(sessionId) };
}

// Apply what the console sent. `text` is literal typing; `key` is a name. Both
// land in the fake shell's input line so the round trip is visible on screen.
function applyInput(sessionId, { text, key }) {
  const lease = leases.get(sessionId);
  if (!lease) return;
  if (text) {
    lease.input += text;
    return;
  }
  switch (key) {
    case 'enter':
      lease.lines.push(`❯ ${lease.input}`, `  ⎿ (fake host) ran ${JSON.stringify(lease.input)}`);
      lease.input = '';
      break;
    case 'backspace':
      lease.input = lease.input.slice(0, -1);
      break;
    case 'esc':
      lease.input = '';
      break;
    case 'tab':
      lease.input += '\t';
      break;
    default:
      lease.lines.push(`  ⎿ (fake host) key ${key}`);
  }
  if (lease.lines.length > 120) lease.lines = lease.lines.slice(-120);
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

      case 'pushKey':
        mia.pushKey = msg.key ?? null;
        log('relay: push key received');
        return;

      case 'upload':
        // A file for Mia: pull it with its one-off key, save it like MiaManager.
        receiveUpload(msg).catch((err) => {
          log(`upload ${msg.id} failed: ${err.message}`);
          send({ type: 'uploadDone', id: msg.id, ok: false, detail: err.message });
        });
        return;

      case 'tts':
        // Announcement audio (tts.js / RemoteBridge.speak): the real Mac runs
        // ~/voice-lab/server/mia-tts. FAKE_HOST_TTS=real does the same here
        // (local e2e with the real voice); otherwise canned bytes, and text
        // starting "FAIL" is a failure. {warm:true} (talk mode opened, 0447)
        // only loads the voice on the real Mac: no answer.
        if (msg.warm) {
          ttsWarms += 1;
          log('tts warm');
          if (process.env.FAKE_HOST_TTS === 'worker') workerAsk({ warm: true });
          return;
        }
        speakTts(msg).then(send, (err) => send({ type: 'ttsDone', id: msg.id, ok: false, detail: err.message }));
        return;

      case 'panelResult':
        // How a `mia panel` command landed — MiaManager.panelResult on the Mac.
        log(`panel ${msg.action} ${msg.arg || ''}: ${msg.ok ? 'ok' : 'FAILED'} ${msg.detail || ''}`);
        if (MIA_DIR) fs.appendFileSync(path.join(MIA_DIR, 'panel-results.jsonl'), JSON.stringify(msg) + '\n');
        return;

      case 'watch': {
        const lease = leases.get(msg.sessionId) ?? newLease(msg.sessionId);
        const fresh = lease.lastSeen === 0;
        lease.lastSeen = Date.now();
        // A hot lease means someone is typing into that terminal from the
        // console — mirror it at ~3 Hz, exactly as the real host does.
        if (msg.hot) lease.hotUntil = Date.now() + 6000;
        leases.set(msg.sessionId, lease);
        if (fresh) log(`watch lease opened for ${msg.sessionId}${msg.hot ? ' (hot)' : ''}`);
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
        // Console passthrough carries `text` (literal, verbatim); the key bar and
        // menu taps carry `key` (a name). Only the latter is worth acking — a
        // per-character ack would be broadcast to every viewer.
        applyInput(msg.sessionId, { text: msg.text, key: msg.key });
        if (msg.text) {
          log(`type → ${msg.sessionId ?? '?'}: ${JSON.stringify(msg.text)}`);
          return;
        }
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
        // RemoteBridge rejects a launch with nothing to do (no mission, no doc).
        if (!String(msg.mission ?? '').trim() && !msg.docId && !msg.planId) {
          send({ type: 'ack', ok: false, cmd: 'launch', detail: 'Mission is empty' });
          return;
        }
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

      default: {
        const miaAck = handleMia(type, msg);
        if (miaAck) {
          log(`${type}: ${miaAck.ok ? 'ok' : 'rejected'} — ${miaAck.detail}`);
          send(miaAck);
          return;
        }
        log(`unhandled message: ${msg.type}`);
      }
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

// 1 Hz: snapshot, buffer growth, and a frame per watched session.
setInterval(() => {
  send(snapshot());
  const now = Date.now();
  for (const [sessionId, lease] of leases) {
    if (now - lease.lastSeen > LEASE_TTL_MS) {
      log(`watch lease expired for ${sessionId}`);
      leases.delete(sessionId);
      continue;
    }
    growLease(sessionId, lease);
    const frame = screenFrame(sessionId, lease);
    if (frame) send(frame);
  }
}, 1000);

// ~3 Hz: hot sessions only, and only when the buffer actually moved — that's
// what makes typing from the console look like typing.
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, lease] of leases) {
    if (lease.hotUntil < now) continue;
    const frame = screenFrame(sessionId, lease);
    if (frame) send(frame);
  }
}, 300);

// With MIA_DIR set, behave like MiaManager for the files the real `mia` CLI
// (scripts/mia) writes: panel.jsonl → {type:'panel'} frames, and Mia's own
// messages.jsonl lines → the snapshot's thread (so `mia say --speak` works).
// Lines already there at start are history, exactly as on the Mac.
const MIA_DIR = process.env.MIA_DIR || '';
const tails = new Map();
function tailLines(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return []; }
  const off = tails.has(file) ? tails.get(file) : size;
  if (size < off) { tails.set(file, size); return []; }
  if (!tails.has(file)) { tails.set(file, size); return []; }
  if (size === off) return [];
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - off);
  fs.readSync(fd, buf, 0, buf.length, off);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const cut = text.lastIndexOf('\n');
  if (cut < 0) return [];
  tails.set(file, off + Buffer.byteLength(text.slice(0, cut + 1)));
  return text.slice(0, cut).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
if (MIA_DIR) {
  fs.mkdirSync(MIA_DIR, { recursive: true });
  for (const f of ['panel.jsonl', 'messages.jsonl']) tailLines(path.join(MIA_DIR, f));
  tails.set(path.join(MIA_DIR, 'panel.jsonl'), tails.get(path.join(MIA_DIR, 'panel.jsonl')) ?? 0);
  tails.set(path.join(MIA_DIR, 'messages.jsonl'), tails.get(path.join(MIA_DIR, 'messages.jsonl')) ?? 0);
  setInterval(() => {
    for (const c of tailLines(path.join(MIA_DIR, 'panel.jsonl'))) {
      const frame = { type: 'panel', id: c.id, action: c.action };
      if (c.arg != null) frame.arg = c.arg;
      if (c.heading != null) frame.heading = c.heading;
      log(`mia panel ${c.action} ${c.arg || ''}`);
      send(frame);
    }
    for (const m of tailLines(path.join(MIA_DIR, 'messages.jsonl'))) {
      if (m.from !== 'mia') continue;
      mia.messages.push(m);
      if (m.kind === 'question' && m.questionId) looseQuestions.push({ id: m.questionId, text: m.text, options: m.options || [], askedAt: m.at, answer: null });
      log(`mia ${m.kind}${m.speak ? ' (speak)' : ''}: ${m.text}`);
    }
  }, 300);
}

// Uploads (upload.js / MiaUploads.swift): the relay offers {type:'upload'};
// fetch the bytes, check them, save to <MIA_DIR>/uploads/<date>/<name>, put the
// file in the thread and the [MC] event in events.jsonl, answer uploadDone.
// FAKE_UPLOAD_IGNORE=1 impersonates a Mac that never collects (queue/TTL tests).
const UPLOAD_ROOT = MIA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fake-mia-'));
const uploaded = new Map(); // relay id → saved path (a re-offer must not duplicate)
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function safeUploadName(raw) {
  let n = String(raw || '').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return n || 'upload';
}
async function receiveUpload(f) {
  if (process.env.FAKE_UPLOAD_IGNORE) return log(`upload ${f.id} offered — ignoring (FAKE_UPLOAD_IGNORE)`);
  if (uploaded.has(f.id)) return send({ type: 'uploadDone', id: f.id, ok: true, path: uploaded.get(f.id) });
  const r = await fetch(`http://localhost:${PORT}/upload/${f.id}`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-MC-Key': f.key } });
  if (!r.ok) throw new Error(`relay answered ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (buf.length !== f.size || sha !== f.sha256) throw new Error('size or checksum mismatch');
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(UPLOAD_ROOT, 'uploads', day);
  fs.mkdirSync(dir, { recursive: true });
  const name = safeUploadName(f.name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let file = path.join(dir, name);
  for (let i = 2; fs.existsSync(file); i += 1) file = path.join(dir, `${stem}-${i}${ext}`);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  uploaded.set(f.id, file);
  const nOfN = f.batch ? ` (${f.batch.replace('/', ' of ')})` : '';
  const line = `[MC] Daniel uploaded a file${nOfN}: ${file} (${f.mime}, ${humanSize(f.size)})${f.caption ? ` — note: ${f.caption.replace(/\s*\n\s*/g, ' ')}` : ''}`;
  const rec = { id: f.id, at: iso(), path: file, name: path.basename(file), originalName: f.name, mime: f.mime, size: f.size, sha256: f.sha256 };
  if (f.caption) rec.caption = f.caption;
  if (f.batch) { rec.batch = f.batch; rec.batchId = f.batchId; }
  miaMessage({ from: 'daniel', kind: 'upload', text: f.caption ? `Uploaded ${rec.name} — ${f.caption}` : `Uploaded ${rec.name}`, caption: f.caption || '', uploadId: f.id, batch: f.batch, batchId: f.batchId, file: { name: rec.name, path: file, mime: f.mime, size: f.size } });
  fs.appendFileSync(path.join(UPLOAD_ROOT, 'uploads.jsonl'), JSON.stringify(rec) + '\n');
  fs.appendFileSync(path.join(UPLOAD_ROOT, 'events.jsonl'), JSON.stringify({ id: `e_${Date.now()}`, at: iso(), kind: 'upload', text: line, delivered: true }) + '\n');
  log(line);
  send({ type: 'uploadDone', id: f.id, ok: true, path: file });
}

connect();
log(`fake host starting (relay port ${PORT}, token ${TOKEN === 'test' ? "'test'" : 'set'})`);

// ---- announcement voice (task 0287) ----------------------------------------------
let ttsWarms = 0;
// FAKE_HOST_TTS=worker: like the real Mac app since 0447 (TtsWorker.swift) —
// one warm ~/voice-lab/server/mia-tts-worker, one JSON line per sentence, in order.
let ttsWorker = null;
function workerAsk(req) {
  if (!ttsWorker) {
    const p = spawn(process.env.MIA_TTS_WORKER || path.join(os.homedir(), 'voice-lab/server/mia-tts-worker'), [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const waiting = [];
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!line.ready) waiting.shift()?.(line);
      }
    });
    ttsWorker = { p, waiting, n: 0 };
  }
  return new Promise((resolve) => {
    const id = `w${++ttsWorker.n}`;
    ttsWorker.waiting.push(resolve);
    ttsWorker.p.stdin.write(JSON.stringify({ ...req, id }) + '\n');
  });
}

async function speakTts(msg) {
  const text = String(msg.text || '');
  if (process.env.FAKE_HOST_TTS === 'worker') {
    const out = path.join(os.tmpdir(), `fakehost-tts-${msg.id}.m4a`);
    const t0 = Date.now();
    const r = await workerAsk({ text, out, format: 'm4a' });
    if (!r.ok) throw new Error(r.error || 'worker failed');
    const audio = fs.readFileSync(out).toString('base64');
    fs.rmSync(out, { force: true });
    log(`tts worker ${Date.now() - t0} ms: ${text.slice(0, 60)}`);
    return { type: 'ttsDone', id: msg.id, ok: true, mime: 'audio/mp4', engine: r.engine, ms: Date.now() - t0, audio };
  }
  if (process.env.FAKE_HOST_TTS === 'real') {
    const { execFile } = await import('node:child_process');
    const out = path.join(os.tmpdir(), `fakehost-tts-${msg.id}.m4a`);
    const cli = process.env.MIA_TTS_CLI || path.join(os.homedir(), 'voice-lab/server/mia-tts');
    const t0 = Date.now();
    const engine = await new Promise((resolve, reject) =>
      execFile(cli, ['--format', 'm4a', text, out], { timeout: 60000 }, (err, _so, se) =>
        err ? reject(new Error(String(se || err.message).trim().split('\n').pop())) : resolve((/engine=(\w+)/.exec(se) || [])[1] || 'mac')));
    const audio = fs.readFileSync(out).toString('base64');
    fs.rmSync(out, { force: true });
    log(`tts ${engine} ${Date.now() - t0} ms: ${text.slice(0, 60)}`);
    return { type: 'ttsDone', id: msg.id, ok: true, mime: 'audio/mp4', engine, ms: Date.now() - t0, audio };
  }
  if (/^FAIL/.test(text)) return { type: 'ttsDone', id: msg.id, ok: false, detail: 'mock refusal' };
  if (/^SLOW/.test(text)) return new Promise(() => {}); // never answers (relay times out)
  return { type: 'ttsDone', id: msg.id, ok: true, mime: 'audio/mp4', engine: 'chatterbox', audio: Buffer.from(`ftypfake-m4a:${text}`).toString('base64') };
}
