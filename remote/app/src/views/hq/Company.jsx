import { useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { spring, press } from '../../lib/motion.js';
import { hqControl, useBusy } from '../../lib/hq.js';
import { toast } from '../../lib/store.js';
import {
  docsFor,
  feedOf,
  fmtWhen,
  uptimeOf,
  latencySeries,
  trendOf,
  fmtNum,
  isOpenTask,
  companyDocs,
  groupDocs,
  filterTasks,
  TASK_FILTERS,
  companyKnowledge,
  filterFacts,
  groupFacts,
  sourceLabel,
  actionsOf,
  actionHistory,
  missingInputs,
  renderPrompt,
  TIER_LABEL,
} from '../../lib/hqModel.js';
import Button from '../../ui/Button.jsx';
import Icon from '../../ui/Icon.jsx';
import Sparkline from '../../ui/Sparkline.jsx';
import Segmented from '../../ui/Segmented.jsx';
import Sheet from '../../ui/Sheet.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import { Photo, photoSrc, HealthChip, LevelPicker, Num, FeedList, FEED_FILTERS, filterFeed, SectionTitle, shapeOf, HistoryChart, Tabs } from './parts.jsx';

// A company's page, v2 (task 0204). The photo grows out of its HQ tile, then
// five sections under one tab bar — no sidebar:
//   Overview   health and every number with its history, autonomy, links
//   Knowledge  what Mia knows about the company, each fact with its source
//   Library    every report and plan filed under it, by project
//   Tasks      Mia's workforce on it: running, done
//   Actions    buttons that give Mia a job (defined per company in the registry)
// The most-used actions also sit right under the photo.

const STATUS_WORD = { queued: 'Queued', asking: 'Asking you', running: 'Running', checking: 'Checking', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const STATUS_TONE = { running: 'text-accent', checking: 'text-accent', asking: 'text-warn', queued: 'text-ink2', failed: 'text-crit' };
const KIND_ICON = { plan: 'plan', research: 'research', note: 'note', page: 'page' };
const TAB_ORDER = ['overview', 'knowledge', 'library', 'tasks', 'actions'];

// ---- Overview ------------------------------------------------------------------

function HealthBlock({ project, health }) {
  const h = project.health;
  const up = uptimeOf(h);
  const lat = latencySeries(h, 60);
  const shape = shapeOf(lat, 60);
  return (
    <div className="glass-soft rounded-xl2 p-3" data-healthblock>
      <div className="flex items-center gap-2">
        <HealthChip health={health} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink3">
          {health.status === 'none'
            ? 'No live link to check'
            : h?.checkedAt
              ? `${health.label} · checked ${fmtWhen(h.checkedAt)}${health.since ? ` · since ${fmtWhen(health.since)}` : ''}`
              : health.label}
        </span>
      </div>
      {up && (
        <div className="mt-2 flex items-end gap-3">
          <div>
            <div className="text-[11px] text-ink3">Uptime ({up.n} checks)</div>
            <div className="tnum text-[18px] font-semibold text-ink">{up.pct >= 99.95 ? '100' : up.pct.toFixed(1)}%</div>
          </div>
          {shape && (
            <div className="min-w-0 flex-1">
              <div className="text-right text-[11px] text-ink3">Response time</div>
              <Sparkline data={shape} width={220} height={30} tone="neutral" className="h-[30px] w-full" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScoutButton({ project, registry }) {
  const busy = useBusy({ action: 'scout', project: project.id });
  const asked = project.scoutRequestedAt && Date.now() - Date.parse(project.scoutRequestedAt) < 30 * 60e3;
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={asked ? 'check' : 'scout'}
      loading={busy}
      data-scout={project.id}
      onClick={() => hqControl({ action: 'scout', project: project.id }, registry)}
    >
      {asked ? `Scout asked ${fmtWhen(project.scoutRequestedAt)}` : 'Scout this now'}
    </Button>
  );
}

function TaskRow({ t, onOpenTask, projectName }) {
  return (
    <button onClick={() => onOpenTask?.(t.id)} className="flex w-full items-center gap-2.5 py-2 text-left hover:bg-white/[0.03]" data-task={t.id}>
      <span className={`w-[68px] flex-none text-[11.5px] font-medium ${STATUS_TONE[t.status] || 'text-ink3'}`}>
        {(t.status === 'running' || t.status === 'checking') && <span className="anim-pulse mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" />}
        {STATUS_WORD[t.status] || t.status}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{t.title}</span>
        {(projectName || t.tier || t.model) && (
          <span className="mt-0.5 flex gap-2 truncate text-[11px] text-ink3">
            {projectName && t.project && <span>{projectName(t.project)}</span>}
            {t.tier && <span data-tier={t.tier}>{TIER_LABEL[t.tier] || t.tier}</span>}
            {!t.tier && t.model && <span>{String(t.model).replace(/^claude-/, '')}</span>}
            <span>{fmtWhen(t.updatedAt || t.createdAt)}</span>
          </span>
        )}
      </span>
      <span className="flex-none font-mono text-[11px] text-ink3">#{t.id}</span>
    </button>
  );
}

function ProjectPanel({ info, registry, docs, findings, onOpenDoc, onOpenTask, index }) {
  const p = info.project;
  const metrics = (p.metrics || []).filter((m) => m.value != null);
  const feed = feedOf({ findings, tasks: [], projectIds: new Set([p.id]), limit: 4 });
  const links = (p.links || []).filter((l) => /^https?:\/\//.test(l.url || ''));
  const pdocs = useMemo(() => docsFor(p, docs).slice(0, 3), [p, docs]);
  const tasks = info.tasks.filter(isOpenTask).concat(info.tasks.filter((t) => !isOpenTask(t)).slice(0, 3));
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring.smooth, delay: Math.min(index, 6) * 0.04 }}
      className="glass-soft rounded-[20px] p-4"
      data-project-panel={p.id}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold tracking-tight text-ink">{p.name}</h3>
          {p.summary && <div className="mt-0.5 text-[12.5px] leading-snug text-ink3">{p.summary}</div>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {links.map((l) => (
            <motion.a
              {...press}
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pill glass-soft glass-soft-hover inline-flex h-8 items-center gap-1.5 px-3 text-[12.5px] font-medium text-ink"
              data-link={l.kind || 'live'}
            >
              <Icon name="external" size={13} />
              {l.label || 'Open'}
            </motion.a>
          ))}
          <ScoutButton project={p} registry={registry} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <HealthBlock project={p} health={info.health} />
        {info.running.length > 0 || info.questions.length > 0 ? (
          <div className="glass-soft rounded-xl2 p-3">
            {info.running.map((t) => (
              <div key={t.id} className="flex items-center gap-1.5 text-[12.5px] text-ink2">
                <span className="anim-pulse h-1.5 w-1.5 flex-none rounded-full bg-accent" />
                <span className="truncate">Mia is on: {t.title}</span>
              </div>
            ))}
            {info.questions.map((q) => (
              <div key={q.questionId} className="mt-1 flex items-start gap-1.5 text-[12.5px] text-warn" data-question={q.questionId}>
                <span className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-warn" />
                <span className="line-clamp-2">{q.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="glass-soft rounded-xl2 grid place-items-center p-3 text-[12.5px] text-ink3">Nothing running, nothing asked.</div>
        )}
      </div>

      {metrics.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-3" data-metrics>
          {metrics.map((m) =>
            (m.history || []).length >= 2 ? (
              <div key={m.name} data-num={m.name}>
                <HistoryChart metric={m} />
              </div>
            ) : (
              <Num key={m.name} n={{ key: m.name, label: m.label || m.name, value: fmtNum(m.value, m.unit), trend: trendOf(m), spark: [] }} big />
            ),
          )}
        </div>
      )}

      <div className="mt-4">
        <div className="label mb-1.5">How much Mia does on her own</div>
        <LevelPicker project={p} registry={registry} />
      </div>

      {(p.permissions || []).length > 0 && (
        <div className="mt-4">
          <div className="label mb-1.5">Standing permissions</div>
          <ul className="space-y-1">
            {p.permissions.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px] text-ink2">
                <Icon name="shield" size={13} className="mt-0.5 flex-none text-accent" />
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {feed.length > 0 && (
        <div className="mt-4">
          <div className="label">Latest</div>
          <FeedList items={feed} />
        </div>
      )}

      {(tasks.length > 0 || pdocs.length > 0) && (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {tasks.length > 0 && (
            <div>
              <div className="label">Tasks</div>
              <div className="divide-y divide-white/[0.06]">
                {tasks.map((t) => (
                  <TaskRow key={t.id} t={t} onOpenTask={onOpenTask} />
                ))}
              </div>
            </div>
          )}
          {pdocs.length > 0 && (
            <div>
              <div className="label">Library</div>
              <div className="divide-y divide-white/[0.06]">
                {pdocs.map((d) => (
                  <button key={d.id} onClick={() => onOpenDoc?.(d.id)} className="flex w-full items-center gap-2.5 py-2 text-left hover:bg-white/[0.03]" data-doc={d.id}>
                    <Icon name={KIND_ICON[d.kind] || 'doc'} size={14} className="flex-none text-ink3" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{d.title || d.id}</span>
                    <span className="flex-none text-[11px] text-ink3">{fmtWhen(d.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {p.notes && <div className="mt-4 text-[12px] leading-relaxed text-ink3">{p.notes}</div>}
    </motion.section>
  );
}

function Overview({ info, view, docs, onOpenDoc, onOpenTask }) {
  const [filter, setFilter] = useState('all');
  const c = info.company;
  const ids = useMemo(() => new Set(info.projects.map((p) => p.project.id)), [info.projects]);
  const names = useMemo(() => Object.fromEntries(info.projects.map((p) => [p.project.id, p.project.name])), [info.projects]);
  const feed = useMemo(() => feedOf({ findings: view.findings, tasks: view.tasks, projectIds: ids, companyId: c.id, limit: 60 }), [view.findings, view.tasks, ids, c.id]);
  const shown = filterFeed(feed, filter).slice(0, 25);
  return (
    <div data-section="overview">
      <div className="space-y-3">
        {info.projects.map((p, i) => (
          <ProjectPanel key={p.project.id} index={i} info={p} registry={view.registry} docs={docs} findings={view.findings} onOpenDoc={onOpenDoc} onOpenTask={onOpenTask} />
        ))}
      </div>
      <SectionTitle right={<Segmented options={FEED_FILTERS} value={filter} onChange={setFilter} />}>Activity</SectionTitle>
      <div className="glass-soft rounded-xl2 px-3.5">
        <FeedList items={shown} projectName={info.projects.length > 1 ? (id) => names[id] || id : null} onOpenTask={onOpenTask} empty={`Nothing logged for ${c.name} yet.`} />
      </div>
    </div>
  );
}

// ---- Knowledge -----------------------------------------------------------------

function Knowledge({ company, facts, onOpenDoc }) {
  const [q, setQ] = useState('');
  if (facts == null) {
    return (
      <EmptyState
        icon="knowledge"
        title="Knowledge arrives with the next Mac update"
        hint="The Mac’s sync agent doesn’t send what Mia knows yet. It will after the 0204 release."
      />
    );
  }
  const shown = filterFacts(facts, q);
  const groups = groupFacts(shown);
  return (
    <div data-section="knowledge">
      <label className="glass-soft pill flex h-10 items-center gap-2 px-3.5">
        <Icon name="search" size={15} className="text-ink3" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search what Mia knows about ${company.name}`}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink3"
          data-knowledge-search
        />
        {q && (
          <button onClick={() => setQ('')} aria-label="Clear search" className="text-ink3 hover:text-ink">
            <Icon name="close" size={14} />
          </button>
        )}
      </label>
      <div className="mt-1.5 px-1 text-[11.5px] text-ink3">
        {facts.length} fact{facts.length === 1 ? '' : 's'} from memory and the Library. Contact details and secrets stay on the Mac.
      </div>
      {!shown.length && <div className="px-1 py-6 text-[12.5px] text-ink3">{facts.length ? 'Nothing matches.' : `Mia hasn’t written anything down about ${company.name} yet.`}</div>}
      {groups.map((g) => (
        <div key={g.id} className="mt-4" data-fact-group={g.id}>
          <div className="mb-1.5 flex items-baseline gap-2 px-1">
            <span className="text-[12.5px] font-semibold tracking-tight text-ink2">{g.label}</span>
            {g.file && <span className="font-mono text-[10.5px] text-ink3">{g.file}</span>}
          </div>
          <ul className="glass-soft rounded-xl2 divide-y divide-white/[0.06] px-3.5">
            {g.facts.map((f, i) => (
              <li key={i} className="py-2.5" data-fact={f.source?.kind}>
                <div className="text-[13px] leading-snug text-ink">{f.text}</div>
                {f.source?.kind === 'doc' ? (
                  <button onClick={() => onOpenDoc?.(f.source.id)} className="mt-1 inline-flex max-w-full items-center gap-1 text-[11.5px] text-accent hover:underline" data-source-doc={f.source.id}>
                    <Icon name="doc" size={11.5} className="flex-none" />
                    <span className="truncate">{sourceLabel(f.source)}</span>
                  </button>
                ) : (
                  <div className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-ink3" data-source-memory={f.source?.file}>
                    <Icon name="source" size={11} />
                    {sourceLabel(f.source)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---- Library -------------------------------------------------------------------

function Library({ company, docs, projects, onOpenDoc }) {
  const [q, setQ] = useState('');
  const s = q.trim().toLowerCase();
  const shown = s ? docs.filter((d) => `${d.title} ${d.summary || ''} ${(d.tags || []).join(' ')}`.toLowerCase().includes(s)) : docs;
  const groups = groupDocs(shown, projects);
  if (!docs.length) return <EmptyState icon="library" title={`Nothing filed under ${company.name} yet`} hint="Reports Mia writes for this company land here (mc-doc new --company)." />;
  return (
    <div data-section="library">
      <label className="glass-soft pill flex h-10 items-center gap-2 px-3.5">
        <Icon name="search" size={15} className="text-ink3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${docs.length} docs`} className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink3" />
      </label>
      {groups.map((g) => (
        <div key={g.id || 'company'} className="mt-4" data-doc-group={g.id || 'company'}>
          <div className="mb-1.5 flex items-baseline gap-2 px-1">
            <span className="text-[12.5px] font-semibold tracking-tight text-ink2">{g.label}</span>
            <span className="tnum text-[11px] text-ink3">{g.docs.length}</span>
          </div>
          <div className="glass-soft rounded-xl2 divide-y divide-white/[0.06] px-1.5">
            {g.docs.map((d) => (
              <motion.button
                key={d.id}
                whileTap={{ scale: 0.99 }}
                transition={spring.snappy}
                onClick={() => onOpenDoc?.(d.id)}
                className="flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-white/[0.03]"
                data-doc={d.id}
              >
                <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg bg-white/[0.06] text-ink2">
                  <Icon name={KIND_ICON[d.kind] || 'doc'} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-ink">{d.title || d.id}</span>
                  {d.summary && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink3">{d.summary}</span>}
                </span>
                <span className="flex-none pt-0.5 text-right text-[11px] text-ink3">
                  {fmtWhen(d.updatedAt)}
                  {d.kind && <span className="mt-0.5 block capitalize">{d.kind}</span>}
                </span>
              </motion.button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Tasks ---------------------------------------------------------------------

function Tasks({ company, tasks, projects, onOpenTask }) {
  const open = tasks.filter(isOpenTask).length;
  const [f, setF] = useState(open ? 'open' : 'all');
  const shown = filterTasks(tasks, f).slice(0, 80);
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  return (
    <div data-section="tasks">
      <div className="flex items-center gap-2 px-1">
        <span className="flex-1 text-[12px] text-ink3">
          {open} running · {tasks.length} in the last 45 days
        </span>
        <Segmented options={TASK_FILTERS} value={f} onChange={setF} />
      </div>
      <div className="glass-soft rounded-xl2 mt-2 divide-y divide-white/[0.06] px-3.5">
        {shown.map((t) => (
          <TaskRow key={t.id} t={t} onOpenTask={onOpenTask} projectName={projects.length > 1 ? (id) => names[id] || id : null} />
        ))}
        {!shown.length && <div className="py-5 text-[12.5px] text-ink3">{f === 'open' ? `Nothing running for ${company.name}.` : 'No tasks yet.'}</div>}
      </div>
    </div>
  );
}

// ---- Actions -------------------------------------------------------------------

function ActionSheet({ company, action, registry, onClose }) {
  const [vals, setVals] = useState({});
  const busy = useBusy({ action: 'action', company: company.id, actionId: action?.id });
  if (!action) return <Sheet open={false} onClose={onClose} />;
  const missing = missingInputs(action, vals);
  const send = async () => {
    if (missing.length) return;
    const inputs = Object.fromEntries((action.inputs || []).map((i) => [i.name, String(vals[i.name] || '').trim()]));
    const ok = await hqControl({ action: 'action', company: company.id, actionId: action.id, inputs, label: action.label }, registry);
    if (ok) {
      toast(`Sent to Mia: ${action.label}`);
      onClose();
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={action.label}
      size="sm"
      footer={
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink3">
            {action.tier ? `Mia dispatches it on ${TIER_LABEL[action.tier] || action.tier}` : 'Mia picks the model'}
          </span>
          <Button variant="accent" icon="send" loading={busy} disabled={missing.length > 0} onClick={send} data-action-send>
            Send to Mia
          </Button>
        </div>
      }
    >
      <div data-action-sheet={action.id}>
        {action.hint && <div className="text-[12.5px] text-ink3">{action.hint}</div>}
        {(action.inputs || []).map((i, k) => (
          <label key={i.name} className="mt-3 block">
            <span className="label mb-1 block">{i.label || i.name}</span>
            <input
              autoFocus={k === 0}
              value={vals[i.name] || ''}
              onChange={(e) => setVals((v) => ({ ...v, [i.name]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder={i.placeholder || ''}
              data-action-input={i.name}
              className="glass-soft h-11 w-full rounded-xl2 px-3.5 text-[14px] text-ink outline-none placeholder:text-ink3 focus:bg-white/[0.09]"
            />
          </label>
        ))}
        <div className="label mb-1 mt-4">What Mia gets</div>
        <div className="glass-soft rounded-xl2 p-3 text-[12.5px] leading-relaxed text-ink2" data-action-preview>
          {renderPrompt(action, vals)}
        </div>
      </div>
    </Sheet>
  );
}

function ActionButton({ a, last, onPick, compact = false }) {
  return (
    <motion.button
      {...press}
      onClick={() => onPick(a)}
      data-action={a.id}
      className={
        compact
          ? 'pill glass-soft glass-soft-hover inline-flex h-9 max-w-full items-center gap-1.5 px-3.5 text-[12.5px] font-medium text-ink'
          : 'glass-soft glass-soft-hover flex w-full items-start gap-3 rounded-xl2 p-3 text-left'
      }
    >
      {compact ? (
        <>
          <Icon name={a.icon || 'action'} size={14} className="flex-none text-accent" />
          <span className="truncate">{a.label}</span>
        </>
      ) : (
        <>
          <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-accent/12 text-accent">
            <Icon name={a.icon || 'action'} size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold tracking-tight text-ink">{a.label}</span>
            {a.hint && <span className="mt-0.5 block text-[12px] text-ink3">{a.hint}</span>}
            <span className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-ink3">
              {a.tier && <span>{TIER_LABEL[a.tier] || a.tier}</span>}
              {(a.inputs || []).length > 0 && <span>asks for {(a.inputs || []).map((i) => (i.label || i.name).toLowerCase()).join(', ')}</span>}
              {last && <span className={last.pending ? 'text-ink2' : 'text-accent'}>{last.pending ? 'sending…' : `sent ${fmtWhen(last.at)}`}</span>}
            </span>
          </span>
          <Icon name="chevronRight" size={16} className="mt-2.5 flex-none text-ink3" />
        </>
      )}
    </motion.button>
  );
}

function Actions({ company, actions, history, onPick }) {
  if (!actions.length) {
    return <EmptyState icon="action" title="No actions yet" hint={`Mia can add some: mia jarvis action add ${company.id} <id> --label … --prompt …`} />;
  }
  return (
    <div data-section="actions">
      <div className="px-1 text-[12px] text-ink3">Each button sends Mia a job. She plans it, picks the model and reports back here.</div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {actions.map((a) => (
          <ActionButton key={a.id} a={a} last={history[a.id]} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

// ---- the page ------------------------------------------------------------------

export default function Company({ info, view, docs, onOpenDoc, onOpenTask }) {
  const c = info.company;
  const reduce = useReducedMotion();
  const [tab, setTab] = useState('overview');
  const [dir, setDir] = useState(1);
  const [picked, setPicked] = useState(null);
  const projects = useMemo(() => info.projects.map((p) => p.project), [info.projects]);
  const cdocs = useMemo(() => companyDocs(c.id, projects, view.docs, docs), [c.id, projects, view.docs, docs]);
  const facts = useMemo(() => companyKnowledge(c.id, view.knowledge), [c.id, view.knowledge]);
  const actions = actionsOf(c);
  const history = actionHistory(c.id, view.findings, view.registry.sync);
  const open = info.tasks.filter(isOpenTask).length;

  const tabs = [
    { value: 'overview', label: 'Overview', icon: 'overview' },
    { value: 'knowledge', label: 'Knowledge', icon: 'knowledge', count: facts?.length || 0 },
    { value: 'library', label: 'Library', icon: 'library', count: cdocs.length },
    { value: 'tasks', label: 'Tasks', icon: 'tasks', count: open },
    { value: 'actions', label: 'Actions', icon: 'action', count: actions.length },
  ];
  const go = (t) => {
    setDir(TAB_ORDER.indexOf(t) >= TAB_ORDER.indexOf(tab) ? 1 : -1);
    setTab(t);
  };

  let section;
  if (tab === 'knowledge') section = <Knowledge company={c} facts={facts} onOpenDoc={onOpenDoc} />;
  else if (tab === 'library') section = <Library company={c} docs={cdocs} projects={projects} onOpenDoc={onOpenDoc} />;
  else if (tab === 'tasks') section = <Tasks company={c} tasks={info.tasks} projects={projects} onOpenTask={onOpenTask} />;
  else if (tab === 'actions') section = <Actions company={c} actions={actions} history={history} onPick={setPicked} />;
  else section = <Overview info={info} view={view} docs={docs} onOpenDoc={onOpenDoc} onOpenTask={onOpenTask} />;

  return (
    <div className="noscroll min-h-0 flex-1 overflow-y-auto px-3 pb-28 sm:px-5" data-company-page={c.id}>
      <motion.div layoutId={reduce ? undefined : `hq-photo-${c.id}`} transition={spring.smooth} style={{ borderRadius: 22 }} className="overflow-hidden">
        <Photo src={photoSrc(c.photo)} className="h-40 sm:h-52">
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end gap-3 p-4 sm:p-5">
            <div className="min-w-0 flex-1">
              <motion.div layoutId={reduce ? undefined : `hq-name-${c.id}`} transition={spring.smooth} className="text-[24px] font-semibold leading-tight tracking-tight text-white sm:text-[28px]">
                {c.name}
              </motion.div>
              {c.tagline && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.12, duration: 0.3 }} className="mt-1 text-[13px] text-white/75">
                  {c.tagline}
                </motion.div>
              )}
            </div>
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.smooth, delay: 0.08 }} className="flex flex-wrap gap-1.5">
              <HealthChip health={info.health} className="bg-black/40 backdrop-blur-md" />
              {info.running > 0 && (
                <span className="pill inline-flex items-center gap-1 bg-black/45 px-2.5 py-1 text-[11.5px] font-medium leading-none text-ink backdrop-blur-md">
                  <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />
                  {info.running} running
                </span>
              )}
              {info.questions > 0 && <span className="pill bg-warn px-2.5 py-1 text-[11.5px] font-bold leading-none text-[#241a02]">{info.questions} for you</span>}
            </motion.div>
          </div>
        </Photo>
      </motion.div>

      {actions.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring.smooth, delay: 0.1 }}
          className="mt-3 flex flex-wrap gap-1.5"
          data-quick-actions
        >
          {actions.slice(0, 4).map((a) => (
            <ActionButton key={a.id} a={a} compact onPick={setPicked} />
          ))}
        </motion.div>
      )}

      <div className="sticky top-0 z-10 -mx-3 mt-3 bg-black/45 px-3 pb-2 pt-2 backdrop-blur-2xl sm:-mx-5 sm:px-5" data-tabs>
        <Tabs tabs={tabs} value={tab} onChange={go} />
      </div>

      <AnimatePresence mode="wait" initial={false} custom={dir}>
        <motion.div
          key={tab}
          custom={dir}
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 18 * dir }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: -12 * dir }}
          transition={spring.smooth}
          className="mt-1"
        >
          {section}
        </motion.div>
      </AnimatePresence>

      <ActionSheet key={picked?.id || 'none'} company={c} action={picked} registry={view.registry} onClose={() => setPicked(null)} />
    </div>
  );
}
