import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { spring, press } from '../../lib/motion.js';
import { hqControl, useBusy } from '../../lib/hq.js';
import { docsFor, feedOf, fmtWhen, uptimeOf, latencySeries, trendOf, fmtNum, isOpenTask } from '../../lib/hqModel.js';
import Button from '../../ui/Button.jsx';
import Icon from '../../ui/Icon.jsx';
import Sparkline from '../../ui/Sparkline.jsx';
import Segmented from '../../ui/Segmented.jsx';
import { Photo, photoSrc, HealthChip, LevelPicker, Num, FeedList, FEED_FILTERS, filterFeed, SectionTitle, shapeOf } from './parts.jsx';

// A company's page in HQ (task 0199): the photo, then one panel per project —
// health with its response-time line, every number with its history, the
// autonomy level (with undo), Scout now, links, tasks, Library docs and the
// standing permissions — and the company's own activity feed. No sidebar: it
// replaces the board inside the same window, the back arrow returns.

const STATUS_WORD = { queued: 'Queued', asking: 'Asking you', running: 'Running', checking: 'Checking', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const STATUS_TONE = { running: 'text-accent', checking: 'text-accent', asking: 'text-warn', queued: 'text-ink2', failed: 'text-crit' };

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

function TaskRow({ t, onOpenTask }) {
  return (
    <button
      onClick={() => onOpenTask?.(t.id)}
      className="flex w-full items-center gap-2.5 py-2 text-left hover:bg-white/[0.03]"
      data-task={t.id}
    >
      <span className={`w-[68px] flex-none text-[11.5px] font-medium ${STATUS_TONE[t.status] || 'text-ink3'}`}>{STATUS_WORD[t.status] || t.status}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{t.title}</span>
      <span className="flex-none font-mono text-[11px] text-ink3">#{t.id}</span>
    </button>
  );
}

function ProjectPanel({ info, registry, docs, findings, onOpenDoc, onOpenTask, index }) {
  const p = info.project;
  const [allTasks, setAllTasks] = useState(false);
  const pdocs = useMemo(() => docsFor(p, docs).slice(0, 6), [p, docs]);
  const metrics = (p.metrics || [])
    .filter((m) => m.value != null)
    .map((m) => ({ key: m.name, label: m.label || m.name, value: fmtNum(m.value, m.unit), trend: trendOf(m), spark: (m.history || []).map((x) => Number(x.v)) }));
  const tasks = allTasks ? info.tasks : info.tasks.filter((t) => isOpenTask(t)).concat(info.tasks.filter((t) => !isOpenTask(t)).slice(0, 4));
  const feed = feedOf({ findings, tasks: [], projectIds: new Set([p.id]), limit: 4 });
  const links = (p.links || []).filter((l) => /^https?:\/\//.test(l.url || ''));

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
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

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
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
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {metrics.map((n) => (
            <Num key={n.key} n={n} big />
          ))}
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="label flex items-center">
            <span className="flex-1">Tasks</span>
            {info.tasks.length > tasks.length || allTasks ? (
              <button onClick={() => setAllTasks((v) => !v)} className="text-[11.5px] text-ink2 hover:text-ink">
                {allTasks ? 'Fewer' : `All ${info.tasks.length}`}
              </button>
            ) : null}
          </div>
          {tasks.length ? (
            <div className="divide-y divide-white/[0.06]">
              {tasks.map((t) => (
                <TaskRow key={t.id} t={t} onOpenTask={onOpenTask} />
              ))}
            </div>
          ) : (
            <div className="py-2 text-[12.5px] text-ink3">No tasks in the last 45 days.</div>
          )}
        </div>
        <div>
          <div className="label">Library</div>
          {pdocs.length ? (
            <div className="divide-y divide-white/[0.06]">
              {pdocs.map((d) => (
                <button
                  key={d.id}
                  onClick={() => onOpenDoc?.(d.id)}
                  className="flex w-full items-center gap-2.5 py-2 text-left hover:bg-white/[0.03]"
                  data-doc={d.id}
                >
                  <Icon name={d.pinned ? 'shield' : 'doc'} size={14} className="flex-none text-ink3" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{d.title || d.id}</span>
                  <span className="flex-none text-[11px] text-ink3">{fmtWhen(d.updatedAt)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="py-2 text-[12.5px] text-ink3">No Library docs match yet.</div>
          )}
        </div>
      </div>
      {p.notes && <div className="mt-4 text-[12px] leading-relaxed text-ink3">{p.notes}</div>}
    </motion.section>
  );
}

export default function Company({ info, view, docs, onOpenDoc, onOpenTask }) {
  const c = info.company;
  const [filter, setFilter] = useState('all');
  const ids = useMemo(() => new Set(info.projects.map((p) => p.project.id)), [info.projects]);
  const names = useMemo(() => Object.fromEntries(info.projects.map((p) => [p.project.id, p.project.name])), [info.projects]);
  const feed = useMemo(() => feedOf({ findings: view.findings, tasks: view.tasks, projectIds: ids, limit: 60 }), [view.findings, view.tasks, ids]);
  const shown = filterFeed(feed, filter).slice(0, 25);
  return (
    <div className="noscroll min-h-0 flex-1 overflow-y-auto px-3 pb-8 sm:px-5" data-company-page={c.id}>
      <Photo src={photoSrc(c.photo)} className="h-44 rounded-[20px] sm:h-56">
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end gap-3 p-4 sm:p-5">
          <div className="min-w-0 flex-1">
            <div className="text-[24px] font-semibold leading-tight tracking-tight text-white sm:text-[28px]">{c.name}</div>
            {c.tagline && <div className="mt-1 text-[13px] text-white/75">{c.tagline}</div>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <HealthChip health={info.health} className="bg-black/40 backdrop-blur-md" />
            {info.running > 0 && (
              <span className="pill inline-flex items-center gap-1 bg-black/45 px-2.5 py-1 text-[11.5px] font-medium leading-none text-ink backdrop-blur-md">
                <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />
                {info.running} running
              </span>
            )}
            {info.questions > 0 && (
              <span className="pill bg-warn px-2.5 py-1 text-[11.5px] font-bold leading-none text-[#241a02]">{info.questions} for you</span>
            )}
          </div>
        </div>
      </Photo>

      <div className="mt-3 space-y-3">
        {info.projects.map((p, i) => (
          <ProjectPanel
            key={p.project.id}
            index={i}
            info={p}
            registry={view.registry}
            docs={docs}
            findings={view.findings}
            onOpenDoc={onOpenDoc}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>

      <SectionTitle right={<Segmented options={FEED_FILTERS} value={filter} onChange={setFilter} />}>Activity</SectionTitle>
      <div className="glass-soft rounded-xl2 px-3.5">
        <FeedList items={shown} projectName={info.projects.length > 1 ? (id) => names[id] || id : null} onOpenTask={onOpenTask} empty={`Nothing logged for ${c.name} yet.`} />
      </div>
    </div>
  );
}
