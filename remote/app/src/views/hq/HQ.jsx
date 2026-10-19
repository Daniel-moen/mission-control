import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup, useReducedMotion } from 'motion/react';
import { useMC, miaOpenQuestions } from '../../lib/store.js';
import { spring } from '../../lib/motion.js';
import { useMedia } from '../../lib/hooks.js';
import { useHQ, useHQSync, useHQView, hqControl, useBusy, refreshHQ } from '../../lib/hq.js';
import { companyInfo, boardSummary, feedOf, fmtWhen, pitchLabel, isOpenTask } from '../../lib/hqModel.js';
import IconButton from '../../ui/IconButton.jsx';
import Button from '../../ui/Button.jsx';
import Icon from '../../ui/Icon.jsx';
import Segmented from '../../ui/Segmented.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import Spinner from '../../ui/Spinner.jsx';
import Company from './Company.jsx';
import Channels from '../channels/Channels.jsx';
import { Photo, photoSrc, HealthChip, HealthDot, Trend, FeedList, FEED_FILTERS, filterFeed, SectionTitle } from './parts.jsx';

// HQ — Mia's control centre (task 0199; never "Jarvis" on screen, 0290). Every company Mia looks after as a
// photo card: live health, the numbers that matter, how much she may do on her
// own, what she's doing now, what she last found, what she's asking. Tap a
// card for the company's page. The global switches (pause, pitch volume) sit
// in the header strip because they're global. Channels (task 0260) is HQ's
// second section since 0290 — a Companies | Channels switch in the header.
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

// Pause/resume + pitch volume. Global, so it sits above the board — one slim
// row, not a card: it's a switch, the companies are the content.
function ControlStrip({ registry }) {
  const j = registry.jarvis || {};
  const paused = !!j.paused;
  const busyP = useBusy({ action: paused ? 'resume' : 'pause' });
  const busyQ = useBusy({ action: 'pitch' });
  const syncing = registry.sync || {};
  return (
    <div className="glass-soft rounded-xl2 flex items-center gap-2 p-1.5 pl-2.5" data-jarvis={paused ? 'paused' : 'on'}>
      <motion.span
        layout
        className={`grid h-7 w-7 flex-none place-items-center rounded-full ${paused ? 'bg-white/[0.08] text-ink3' : 'bg-accent/15 text-accent'}`}
      >
        <Icon name={paused ? 'pause' : 'mia'} size={14} />
      </motion.span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-ink">
          {paused ? 'Mia paused' : 'Mia is on watch'}
          {syncing.paused && <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-ink3" title="Syncing to the Mac" />}
        </div>
        <div className="hidden truncate text-[11.5px] text-ink3 sm:block">
          {paused ? 'Nothing proactive until you resume' : 'Watching, scouting and pitching by each project’s level'}
        </div>
      </div>
      <div className="pill flex flex-none items-center gap-0.5 bg-white/[0.04] p-0.5" data-pitch={j.pitchesPerDay}>
        <IconButton icon="quieter" label="Quieter: pitch less often" size="sm" variant="ghost" disabled={busyQ} onClick={() => hqControl({ action: 'pitch', value: 'quieter' }, registry)} />
        <span className="min-w-[78px] px-0.5 text-center text-[11px] leading-tight text-ink2">
          <span className="block text-[10px] text-ink3">Pitches{syncing.pitch ? ' ·' : ''}</span>
          {pitchLabel(j.pitchesPerDay)}
        </span>
        <IconButton icon="louder" label="Louder: pitch more often" size="sm" variant="ghost" disabled={busyQ} onClick={() => hqControl({ action: 'pitch', value: 'louder' }, registry)} />
      </div>
      <Button
        variant={paused ? 'accent' : 'secondary'}
        size="sm"
        icon={paused ? 'play' : 'pause'}
        loading={busyP}
        data-pause
        aria-label={paused ? 'Resume Mia' : 'Pause Mia'}
        onClick={() => hqControl({ action: paused ? 'resume' : 'pause' }, registry)}
      >
        <span className="hidden sm:inline">{paused ? 'Resume' : 'Pause'}</span>
      </Button>
    </div>
  );
}

// The one number a project row leads with: Mia's first metric, else uptime,
// else response time — whatever keyNumbers() put first.
function ProjectLine({ info }) {
  const p = info.project;
  const n = info.numbers[0];
  return (
    <div className="flex items-center gap-1.5 py-[3px]" data-project={p.id}>
      <HealthDot status={info.health.status} size={6} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink2">{p.name}</span>
      {info.questions.length > 0 && (
        <span className="pill bg-warn/14 px-1 text-[10px] font-semibold leading-[15px] text-warn" title="Questions for you">
          {info.questions.length}?
        </span>
      )}
      {n && (
        <span className="tnum flex flex-none items-center gap-1 text-[11.5px] font-medium text-ink" data-num={n.key} title={n.label}>
          {n.value}
          <Trend trend={n.trend} />
        </span>
      )}
    </div>
  );
}

// A company as a compact photo tile: health, what's running, what's asked,
// a line per project. The photo is a shared element — tapping a tile grows it
// into the company page's hero (layoutId), and back shrinks it home.
const MAX_LINES = 3;
function CompanyCard({ info, onOpen, index }) {
  const c = info.company;
  const reduce = useReducedMotion();
  const extra = info.projects.length - MAX_LINES;
  const now = info.tasks.find(isOpenTask);
  return (
    <motion.article
      // Opacity only: a transform here would skew the shared photo's
      // measurements (layoutId) and leave it off its card mid-flight.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1], delay: Math.min(index, 10) * 0.035 }}
      className="min-w-0"
      data-company={c.id}
    >
      <motion.button
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.975 }}
        transition={spring.snappy}
        onClick={() => onOpen(c.id)}
        className="glass-soft glass-soft-hover block h-full w-full overflow-hidden rounded-[18px] text-left"
        aria-label={`Open ${c.name}`}
      >
        <motion.div layoutId={reduce ? undefined : `hq-photo-${c.id}`} transition={spring.smooth} style={{ borderRadius: 0 }} className="relative">
          <Photo src={photoSrc(c.photo)} className="h-[84px] sm:h-[96px]">
            <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-1 p-2">
              <HealthChip health={info.health} className="!px-1.5 !py-[3px] !text-[10.5px] bg-black/35 backdrop-blur-md" />
              <span className="flex items-center gap-1">
                {info.questions > 0 && (
                  <span className="pill bg-warn px-1.5 py-[3px] text-[10.5px] font-bold leading-none text-[#241a02]" title="Questions for you">
                    {info.questions}?
                  </span>
                )}
                {info.running > 0 && (
                  <span className="pill inline-flex items-center gap-1 bg-black/45 px-1.5 py-[3px] text-[10.5px] font-medium leading-none text-ink backdrop-blur-md" title="Tasks running">
                    <span className="anim-pulse h-1.5 w-1.5 rounded-full bg-accent" />
                    {info.running}
                  </span>
                )}
              </span>
            </div>
            <div className="absolute inset-x-0 bottom-0 px-2.5 pb-2">
              <motion.div layoutId={reduce ? undefined : `hq-name-${c.id}`} transition={spring.smooth} className="truncate text-[15px] font-semibold leading-tight tracking-tight text-white">
                {c.name}
              </motion.div>
            </div>
          </Photo>
        </motion.div>
        <div className="px-2.5 pb-2 pt-1.5">
          {info.projects.slice(0, MAX_LINES).map((p) => (
            <ProjectLine key={p.project.id} info={p} />
          ))}
          {extra > 0 && <div className="py-[3px] text-[11px] text-ink3">+{extra} more</div>}
          {!info.projects.length && <div className="py-1 text-[11.5px] text-ink3">No projects yet.</div>}
          {now && (
            <div className="mt-1 flex items-center gap-1.5 border-t border-white/[0.06] pt-1.5 text-[11px] text-ink2" data-now>
              <span className="anim-pulse h-1.5 w-1.5 flex-none rounded-full bg-accent" />
              <span className="truncate">Now: {now.title}</span>
            </div>
          )}
        </div>
      </motion.button>
    </motion.article>
  );
}

function Board({ view, companies, onOpen, onOpenTask, scrollRef }) {
  const [filter, setFilter] = useState('all');
  const sum = boardSummary(companies);
  const names = useMemo(() => Object.fromEntries(view.registry.projects.map((p) => [p.id, p.name])), [view.registry.projects]);
  const feed = useMemo(() => feedOf({ findings: view.findings, tasks: view.tasks, limit: 80 }), [view.findings, view.tasks]);
  const shown = filterFeed(feed, filter).slice(0, 30);
  const el = useRef(null);
  // Back from a company lands where you left the board, not at the top.
  useLayoutEffect(() => {
    if (el.current && scrollRef.current) el.current.scrollTop = scrollRef.current;
  }, [scrollRef]);
  return (
    <motion.div
      ref={el}
      onScroll={(e) => (scrollRef.current = e.currentTarget.scrollTop)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="noscroll min-h-0 flex-1 overflow-y-auto px-3 pb-28 sm:px-5"
      data-board
    >
      <ControlStrip registry={view.registry} />
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[12px] text-ink3" data-summary>
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
      <div className="mt-2.5 grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5" data-grid>
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

export default function HQ({ onClose, onOpenDoc, onOpenTask, companyId = null, onCompany, section = 'companies', onSection, channelKey = null, onChannel }) {
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
  const boardScroll = useRef(0);
  const wideHead = useMedia('(min-width: 640px)');

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
        <h2 className={`truncate text-[17px] font-semibold tracking-tight text-ink ${!current && onSection && !wideHead ? 'sr-only' : ''}`}>{current ? current.company.name : 'HQ'}</h2>
        <div className={`truncate text-[12px] text-ink3 ${!current && section === 'channels' ? 'hidden' : !current && onSection && !wideHead ? 'hidden' : ''}`}>
          {current
            ? `${current.projects.length} project${current.projects.length === 1 ? '' : 's'}`
            : view
              ? `${companies.length} companies Mia looks after`
              : 'Mia’s control centre'}
        </div>
      </div>
      {!current && onSection && (
        <Segmented
          value={section}
          onChange={onSection}
          options={[
            { value: 'companies', label: wideHead ? 'Companies' : 'HQ', icon: 'hq' },
            { value: 'channels', label: 'Channels', icon: 'video' },
          ]}
        />
      )}
      {/* Phone overview: the HQ/Channels switch needs the room; a company page has it. */}
      {(current || section !== 'channels') && <span className={current || wideHead ? 'inline-flex' : 'hidden'}><SyncChip view={view} /></span>}
      {onClose && <IconButton icon="close" label="Close" size="sm" variant="glass" onClick={onClose} />}
    </header>
  );

  if (section === 'channels' && !current) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-hq data-hq-section="channels">
        {header}
        <Channels embedded channelKey={channelKey} onChannel={onChannel || (() => {})} />
      </div>
    );
  }

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
            : 'HQ shows what the Mac pushes. On the Mac, Mia runs the HQ sync (mia jarvis sync).'
        }
        action={
          <Button size="sm" icon="refresh" onClick={() => refreshHQ()}>
            Try again
          </Button>
        }
      />
    );
  } else {
    // No mode="wait": the board and the company page overlap for a moment so
    // the shared photo can fly from the tile into the hero.
    body = (
      <LayoutGroup id="hq">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <AnimatePresence initial={false} mode="popLayout">
            {current ? (
              <motion.div
                key={`co:${current.company.id}`}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
                transition={spring.smooth}
                className="flex min-h-0 flex-1 flex-col"
              >
                <Company info={current} view={view} docs={docs} questions={questions} onOpenDoc={onOpenDoc} onOpenTask={onOpenTask} />
              </motion.div>
            ) : (
              <Board key="board" view={view} companies={companies} onOpen={open} onOpenTask={onOpenTask} scrollRef={boardScroll} />
            )}
          </AnimatePresence>
        </div>
      </LayoutGroup>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-hq>
      {header}
      {body}
    </div>
  );
}
