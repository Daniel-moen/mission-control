import { useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useMC, miaOpenQuestions } from '../../lib/store.js';
import { spring, press, fadeUp, reduced } from '../../lib/motion.js';
import { useHQ, useHQSync, useHQView, hqControl, useBusy, refreshHQ } from '../../lib/hq.js';
import { companyInfo, boardSummary, feedOf, fmtWhen, pitchLabel } from '../../lib/hqModel.js';
import IconButton from '../../ui/IconButton.jsx';
import Button from '../../ui/Button.jsx';
import Icon from '../../ui/Icon.jsx';
import Segmented from '../../ui/Segmented.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import Spinner from '../../ui/Spinner.jsx';
import Company from './Company.jsx';
import { Photo, photoSrc, HealthChip, HealthDot, LevelChip, Num, FeedList, FEED_FILTERS, filterFeed, SectionTitle } from './parts.jsx';

// HQ — Jarvis's control centre (task 0199). Every company Mia looks after as a
// photo card: live health, the numbers that matter, how much she may do on her
// own, what she's doing now, what she last found, what she's asking. Tap a
// card for the company's page. The Jarvis switches (pause, pitch volume) sit
// in the header strip because they're global.
//
// Data: lib/hq.js polls the relay for what the Mac's `mia jarvis sync` pushed
// (registry.json + findings + tasks); every control goes to Mia as an [MC]
// chat line and into the relay's queue for the Mac. A CHROMELESS window: the
// header row is ours.

function SyncChip({ view }) {
  const error = useHQ((s) => s.error);
  const loading = useHQ((s) => s.loading);
  const pending = view?.pending?.length || 0;
  const at = view?.pushedAt;
  const stale = at && Date.now() - Date.parse(at) > 10 * 60e3;
  const label = error && !view ? 'Offline' : pending ? `Syncing ${pending}` : at ? `Mac ${fmtWhen(at)}` : 'Waiting for the Mac';
  const tone = error || stale ? 'text-warn' : 'text-ink2';
  return (
    <button
      onClick={() => refreshHQ()}
      title={error || (at ? `Last pushed by the Mac ${new Date(at).toLocaleString()}` : '')}
      className={`pill glass-soft glass-soft-hover inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] ${tone}`}
      data-sync
    >
      {loading ? <Spinner size={10} /> : <span className={`h-1.5 w-1.5 flex-none rounded-full ${error || stale ? 'bg-warn' : pending ? 'bg-ink3' : 'bg-accent'}`} />}
      {label}
    </button>
  );
}

// Pause/resume + pitch volume. Global, so it lives above the board.
function JarvisStrip({ registry }) {
  const j = registry.jarvis || {};
  const paused = !!j.paused;
  const busyP = useBusy({ action: paused ? 'resume' : 'pause' });
  const busyQ = useBusy({ action: 'pitch' });
  const syncing = registry.sync || {};
  return (
    <div className="glass-soft rounded-xl2 flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:gap-4" data-jarvis={paused ? 'paused' : 'on'}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className={`grid h-9 w-9 flex-none place-items-center rounded-full ${paused ? 'bg-white/[0.08] text-ink3' : 'bg-accent/15 text-accent'}`}>
          <Icon name={paused ? 'pause' : 'mia'} size={17} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold tracking-tight text-ink">
            Jarvis {paused ? 'paused' : 'on'}
            {syncing.paused && <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-ink3" title="Syncing to the Mac" />}
          </div>
          <div className="truncate text-[12px] text-ink3">
            {paused ? 'Nothing proactive until you resume' : 'Watching, scouting and pitching by each project’s level'}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="pill glass-soft flex flex-1 items-center justify-between gap-0.5 p-0.5 sm:flex-none" data-pitch={j.pitchesPerDay}>
          <IconButton
            icon="quieter"
            label="Quieter: pitch less often"
            size="sm"
            variant="ghost"
            disabled={busyQ}
            onClick={() => hqControl({ action: 'pitch', value: 'quieter' }, registry)}
          />
          <span className="min-w-[96px] px-1 text-center text-[11.5px] leading-tight text-ink2">
            <span className="block text-[10.5px] text-ink3">Pitches{syncing.pitch ? ' ·' : ''}</span>
            {pitchLabel(j.pitchesPerDay)}
          </span>
          <IconButton
            icon="louder"
            label="Louder: pitch more often"
            size="sm"
            variant="ghost"
            disabled={busyQ}
            onClick={() => hqControl({ action: 'pitch', value: 'louder' }, registry)}
          />
        </div>
        <Button
          variant={paused ? 'accent' : 'secondary'}
          size="md"
          icon={paused ? 'play' : 'pause'}
          loading={busyP}
          data-pause
          onClick={() => hqControl({ action: paused ? 'resume' : 'pause' }, registry)}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>
    </div>
  );
}

function ProjectLine({ info }) {
  const p = info.project;
  return (
    <div className="py-2.5" data-project={p.id}>
      <div className="flex items-center gap-2">
        <HealthDot status={info.health.status} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{p.name}</span>
        {info.questions.length > 0 && (
          <span className="pill bg-warn/14 px-1.5 py-0.5 text-[10.5px] font-semibold text-warn" title="Questions for you">
            {info.questions.length}?
          </span>
        )}
        <LevelChip level={p.autonomy} syncing={!!info.syncing?.level} />
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 pl-4">
        {info.numbers.map((n) => (
          <Num key={n.key} n={n} />
        ))}
      </div>
      {info.running.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-4 text-[12px] text-ink2">
          <span className="anim-pulse h-1.5 w-1.5 flex-none rounded-full bg-accent" />
          <span className="truncate">
            Now: {info.running[0].title}
            {info.running.length > 1 ? ` +${info.running.length - 1}` : ''}
          </span>
        </div>
      )}
      {info.finding && (
        <div className="mt-1 line-clamp-1 pl-4 text-[12px] text-ink3">
          <Icon name="scout" size={11} className="mr-1 inline -translate-y-px" />
          {info.finding.text}
        </div>
      )}
    </div>
  );
}

function CompanyCard({ info, onOpen, index }) {
  const c = info.company;
  const reduce = useReducedMotion();
  return (
    <motion.article
      layout
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...spring.smooth, delay: Math.min(index, 8) * 0.035 }}
      className="glass-soft overflow-hidden rounded-[20px]"
      data-company={c.id}
    >
      <motion.button {...press} onClick={() => onOpen(c.id)} className="block w-full text-left" aria-label={`Open ${c.name}`}>
        <Photo src={photoSrc(c.photo)} className="h-36 sm:h-40">
          <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
            <HealthChip health={info.health} />
            <span className="flex items-center gap-1.5">
              {info.questions > 0 && (
                <span className="pill bg-warn px-2 py-1 text-[11px] font-bold leading-none text-[#241a02]">
                  {info.questions} for you
                </span>
              )}
              {info.running > 0 && (
                <span className="pill inline-flex items-center gap-1 bg-black/45 px-2 py-1 text-[11px] font-medium leading-none text-ink backdrop-blur-md">
                  <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />
                  {info.running} running
                </span>
              )}
            </span>
          </div>
          <div className="absolute inset-x-0 bottom-0 p-3.5">
            <div className="flex items-center gap-1.5 text-[19px] font-semibold leading-tight tracking-tight text-white">
              {c.name}
              <Icon name="chevronRight" size={17} className="text-white/60" />
            </div>
            {c.tagline && <div className="mt-0.5 line-clamp-1 text-[12px] text-white/70">{c.tagline}</div>}
          </div>
        </Photo>
      </motion.button>
      <div className="divide-y divide-white/[0.06] px-3.5 pb-1">
        {info.projects.map((p) => (
          <ProjectLine key={p.project.id} info={p} />
        ))}
        {!info.projects.length && <div className="py-3 text-[12.5px] text-ink3">No projects yet.</div>}
      </div>
    </motion.article>
  );
}

function Board({ view, companies, onOpen, onOpenTask }) {
  const [filter, setFilter] = useState('all');
  const sum = boardSummary(companies);
  const names = useMemo(() => Object.fromEntries(view.registry.projects.map((p) => [p.id, p.name])), [view.registry.projects]);
  const feed = useMemo(() => feedOf({ findings: view.findings, tasks: view.tasks, limit: 80 }), [view.findings, view.tasks]);
  const shown = filterFeed(feed, filter).slice(0, 30);
  return (
    <motion.div {...fadeUp} key="board" className="noscroll min-h-0 flex-1 overflow-y-auto px-3 pb-8 sm:px-5">
      <JarvisStrip registry={view.registry} />
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[12.5px] text-ink3" data-summary>
        <span>
          <span className="tnum text-ink">{sum.up}</span> of {sum.watched} live services up
        </span>
        {sum.down > 0 && (
          <span className="text-crit">
            <span className="tnum">{sum.down}</span> down
          </span>
        )}
        <span>
          <span className="tnum text-ink">{sum.running}</span> task{sum.running === 1 ? '' : 's'} running
        </span>
        {sum.questions > 0 && (
          <span className="text-warn">
            <span className="tnum">{sum.questions}</span> question{sum.questions === 1 ? '' : 's'} for you
          </span>
        )}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {companies.map((c, i) => (
          <CompanyCard key={c.company.id} info={c} index={i} onOpen={onOpen} />
        ))}
      </div>
      <SectionTitle right={<Segmented options={FEED_FILTERS} value={filter} onChange={setFilter} />}>Activity</SectionTitle>
      <div className="glass-soft rounded-xl2 px-3.5">
        <FeedList items={shown} projectName={(id) => names[id] || id} onOpenTask={onOpenTask} empty="Nothing found, fixed or shipped yet." />
      </div>
    </motion.div>
  );
}

export default function HQ({ onClose, onOpenDoc, onOpenTask, companyId = null, onCompany }) {
  useHQSync();
  const view = useHQView();
  const error = useHQ((s) => s.error);
  const fetchedAt = useHQ((s) => s.fetchedAt);
  const mia = useMC((s) => s.mia);
  const miaLocal = useMC((s) => s.miaLocal);
  const docs = useMC((s) => s.docs);
  const [localSel, setLocalSel] = useState(null);
  const sel = onCompany ? companyId : localSel;
  const open = onCompany || setLocalSel;
  const reduce = useReducedMotion();

  const questions = useMemo(() => miaOpenQuestions(mia, miaLocal), [mia, miaLocal]);
  const companies = useMemo(() => {
    if (!view) return [];
    const now = Date.now();
    return view.registry.companies.map((c) => companyInfo(c, view, questions, now));
  }, [view, questions]);
  const current = sel ? companies.find((c) => c.company.id === sel) : null;

  const header = (
    <header className="flex flex-none items-center gap-2.5 px-4 pb-3 pt-3.5 sm:px-5">
      {current && <IconButton icon="back" label="All companies" size="sm" variant="glass" onClick={() => open(null)} data-back />}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[17px] font-semibold tracking-tight text-ink">{current ? current.company.name : 'HQ'}</h2>
        <div className="truncate text-[12px] text-ink3">
          {current
            ? `${current.projects.length} project${current.projects.length === 1 ? '' : 's'}`
            : view
              ? `${companies.length} companies Mia looks after`
              : 'Jarvis control centre'}
        </div>
      </div>
      <SyncChip view={view} />
      {onClose && <IconButton icon="close" label="Close" size="sm" variant="glass" onClick={onClose} />}
    </header>
  );

  let body;
  if (!view) {
    body = !fetchedAt && !error ? (
      <div className="grid flex-1 place-items-center">
        <Spinner size={20} />
      </div>
    ) : (
      <EmptyState
        icon="hq"
        title={error ? 'HQ can’t reach the relay' : 'No word from the Mac yet'}
        hint={
          error
            ? `${error}. It retries every 15 seconds.`
            : 'HQ shows what the Mac pushes. On the Mac: mia jarvis seed, then mia jarvis install-agent (or mia jarvis sync once).'
        }
        action={
          <Button size="sm" icon="refresh" onClick={() => refreshHQ()}>
            Try again
          </Button>
        }
      />
    );
  } else {
    body = (
      <AnimatePresence mode="wait" initial={false}>
        {current ? (
          <motion.div
            key={`co:${current.company.id}`}
            {...(reduce ? reduced(fadeUp) : { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: 24 }, transition: spring.smooth })}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Company info={current} view={view} docs={docs} onOpenDoc={onOpenDoc} onOpenTask={onOpenTask} />
          </motion.div>
        ) : (
          <Board key="board" view={view} companies={companies} onOpen={open} onOpenTask={onOpenTask} />
        )}
      </AnimatePresence>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-hq>
      {header}
      {body}
    </div>
  );
}
