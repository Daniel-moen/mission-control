import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, launch, toast, kindLabel, allDirs, docCreate, research } from '../../src/lib/store.js';
import { mergeModels, DEFAULT_SOLO, DEFAULT_MANAGER, DEFAULT_WORKER } from '../../src/lib/models.js';
import { dictate, speechSupported } from '../../src/lib/speech.js';
import { goView } from '../lib/nav.js';
import { spring, tap } from '../lib/motion.js';
import { Button, Icon, Segmented, Select } from '../ui/kit.jsx';

// The forms that start work: Launch (an agent or a fleet), New document,
// Research (an agent writes a report into the Library), Draft a plan (a
// read-only planning agent). They share three parts: a hero text box you can
// dictate into, a project-folder picker that remembers, and a model picker.

const OTHER = '__other';
const fix = (f) => (f === 'default' ? '' : f);
const toTags = (s) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);

function Label({ children }) {
  return <div className="v-eyebrow mb-2 mt-5 first:mt-0">{children}</div>;
}

export function Hero({ value, onChange, placeholder, rows = 4, autoFocus = false, label }) {
  const ref = useRef(null);
  const [on, setOn] = useState(false);
  useEffect(() => () => ref.current?.stop(), []);
  const toggle = () => {
    if (ref.current) return ref.current.stop();
    const stop = () => {
      ref.current = null;
      setOn(false);
    };
    ref.current = dictate({ base: value, onText: onChange, onEnd: stop, onError: stop });
    setOn(!!ref.current);
  };
  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={label || placeholder}
        className={`v-field v-scroll block min-h-[120px] w-full resize-none px-4 py-3.5 pr-14 text-[1.02rem] leading-relaxed ${on ? '!border-crit/60' : ''}`}
      />
      {speechSupported && (
        <motion.button
          {...tap}
          type="button"
          onClick={toggle}
          aria-label="Dictate"
          aria-pressed={on}
          className={`absolute right-2.5 top-2.5 grid h-10 w-10 place-items-center rounded-full transition-colors ${on ? 'bg-crit text-white' : 'bg-card text-ink2 shadow-sm'}`}
        >
          <Icon name="mic" size={18} strokeWidth={2} />
        </motion.button>
      )}
    </div>
  );
}

export function DirPicker({ value, onChange }) {
  const knownDirs = useMC((s) => s.knownDirs);
  const localDirs = useMC((s) => s.localDirs);
  const dirs = useMemo(() => allDirs(), [knownDirs, localDirs]);
  const [other, setOther] = useState(false);
  const sel = !other && dirs.includes(value) ? value : dirs.length ? OTHER : '';
  return (
    <div className="flex flex-col gap-2">
      {dirs.length > 0 && (
        <Select
          label="Project folder"
          className="w-full font-mono !text-[0.82rem]"
          value={sel}
          onChange={(v) => {
            if (v === OTHER) {
              setOther(true);
              onChange('');
            } else {
              setOther(false);
              onChange(v);
            }
          }}
          options={[...dirs.map((d) => ({ value: d, label: d })), { value: OTHER, label: 'Other folder…' }]}
        />
      )}
      {(sel === OTHER || !dirs.length) && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="~/path/to/project"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Folder path"
          className="v-field h-11 w-full px-4 font-mono text-[0.86rem]"
        />
      )}
    </div>
  );
}

function useModels() {
  const host = useMC((s) => s.models);
  return useMemo(() => mergeModels(host), [host]);
}
const ModelSelect = ({ value, onChange, models, label = 'Model', className = 'w-full' }) => (
  <Select label={label} className={className} value={value} onChange={onChange} options={models.map((m) => ({ value: m.flag, label: m.label }))} />
);

// ---------------------------------------------------------------------------

export function Launch({ attachDoc = null, onDone }) {
  const models = useModels();
  const lastDir = useMC((s) => s.lastDir);
  const [doc, setDoc] = useState(attachDoc);
  const [mode, setMode] = useState('fleet');
  const [mission, setMission] = useState('');
  const [dir, setDir] = useState(attachDoc?.dir || lastDir || '');
  const [solo, setSolo] = useState(DEFAULT_SOLO);
  const [manager, setManager] = useState(DEFAULT_MANAGER);
  const [workers, setWorkers] = useState([DEFAULT_WORKER, DEFAULT_WORKER]);
  const [state, setState] = useState(null); // null | 'sending' | 'sent'
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!dir && lastDir) setDir(lastDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastDir]);

  const step = (d) =>
    setWorkers((ws) => (d > 0 && ws.length < 8 ? [...ws, ws[ws.length - 1] || DEFAULT_WORKER] : d < 0 && ws.length > 1 ? ws.slice(0, -1) : ws));

  const go = () => {
    const m = mission.trim();
    if (!m && !doc) return toast('Describe the mission first');
    const payload =
      mode === 'solo'
        ? { mission: m, dir: dir.trim(), managerModel: null, workerModels: [fix(solo)] }
        : { mission: m, dir: dir.trim(), managerModel: fix(manager) || 'opus', workerModels: workers.map(fix) };
    if (doc) {
      payload.docId = doc.id;
      payload.docMode = doc.mode || (doc.kind === 'plan' ? 'build' : 'continue');
    }
    if (!launch(payload)) return;
    setState('sending');
    timers.current = [
      setTimeout(() => setState('sent'), 900),
      setTimeout(() => {
        onDone?.();
        goView('agents');
      }, 1700),
    ];
  };

  const count = mode === 'solo' ? 1 : 1 + workers.length;

  return (
    <div className="relative" data-launch>
      {doc && (
        <div className="mb-4 flex items-center gap-3 rounded-[16px] bg-fill p-3">
          <span className="grid h-9 w-9 flex-none place-items-center rounded-[11px] bg-card text-ink2">
            <Icon name={doc.kind === 'plan' ? 'plan' : 'doc'} size={17} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.9rem] font-semibold text-ink">{doc.title}</span>
            <span className="block text-[0.76rem] text-ink3">
              {(doc.mode || (doc.kind === 'plan' ? 'build' : 'continue')) === 'build' ? 'Build this plan' : 'Continue this ' + kindLabel(doc.kind).toLowerCase()}
            </span>
          </span>
          <button onClick={() => setDoc(null)} aria-label="Detach document" className="grid h-8 w-8 place-items-center rounded-full text-ink3 hover:text-ink">
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
      <Label>Mission</Label>
      <Hero value={mission} onChange={setMission} placeholder={doc ? 'Anything to add? (optional)' : 'What should the agents do?'} autoFocus={!doc} label="Mission" />
      <Label>Project</Label>
      <DirPicker value={dir} onChange={setDir} />
      <Label>Who runs it</Label>
      <Segmented
        full
        value={mode}
        onChange={setMode}
        options={[
          { value: 'fleet', label: 'Fleet', icon: 'users' },
          { value: 'solo', label: 'One agent', icon: 'user' },
        ]}
      />
      <AnimatePresence mode="popLayout" initial={false}>
        {mode === 'solo' ? (
          <motion.div key="solo" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.snappy} className="mt-3">
            <ModelSelect value={solo} onChange={setSolo} models={models} />
            <p className="mt-2 px-1 text-[0.76rem] text-ink3">{models.find((m) => m.flag === solo)?.blurb}</p>
          </motion.div>
        ) : (
          <motion.div key="fleet" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.snappy} className="mt-3 flex flex-col gap-2.5">
            <div className="flex items-center gap-3">
              <span className="w-20 flex-none text-[0.86rem] font-medium text-ink2">Manager</span>
              <ModelSelect value={manager} onChange={setManager} models={models} label="Manager model" className="min-w-0 flex-1" />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-20 flex-none text-[0.86rem] font-medium text-ink2">Workers</span>
              <div className="flex flex-none items-center gap-1 rounded-full bg-fill p-1">
                <motion.button {...tap} onClick={() => step(-1)} aria-label="Fewer workers" className="grid h-8 w-8 place-items-center rounded-full bg-card text-ink">
                  <Icon name="minus" size={15} />
                </motion.button>
                <span className="v-num w-7 text-center text-[0.95rem] font-semibold text-ink" data-workers={workers.length}>
                  {workers.length}
                </span>
                <motion.button {...tap} onClick={() => step(1)} aria-label="More workers" className="grid h-8 w-8 place-items-center rounded-full bg-card text-ink">
                  <Icon name="plus" size={15} />
                </motion.button>
              </div>
              <ModelSelect
                value={new Set(workers).size === 1 ? workers[0] : ''}
                onChange={(f) => setWorkers((ws) => ws.map(() => f))}
                models={new Set(workers).size === 1 ? models : [{ flag: '', label: 'Mixed' }, ...models]}
                label="Worker model"
                className="min-w-0 flex-1"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-6">
        <Button tone="primary" size="lg" icon="launch" className="w-full" onClick={go} disabled={!!state} data-launch-go>
          {state === 'sent' ? 'Deployed — agents incoming' : state === 'sending' ? 'Launching…' : `Launch ${count} agent${count === 1 ? '' : 's'}`}
        </Button>
      </div>
      <AnimatePresence>
        {state && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 grid place-items-center rounded-[20px] bg-card/80"
          >
            <motion.span
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={spring.sheet}
              className="grid h-20 w-20 place-items-center rounded-full bg-accent text-accent-ink"
            >
              <Icon name={state === 'sent' ? 'check' : 'launch'} size={34} strokeWidth={2.2} />
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function NewDoc({ onDone }) {
  const lastDir = useMC((s) => s.lastDir);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('note');
  const [subject, setSubject] = useState('');
  const [tags, setTags] = useState('');
  const [dir, setDir] = useState(lastDir || '');
  const go = () => {
    const t = title.trim() || `Untitled ${kindLabel(kind).toLowerCase()}`;
    if (!docCreate({ title: t, kind, subject: subject.trim(), tags: toTags(tags), dir: dir.trim() })) return;
    onDone?.();
  };
  return (
    <div data-newdoc>
      <Label>Title</Label>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" aria-label="Title" className="v-field h-12 w-full px-4 text-[1.02rem] font-semibold" />
      <Label>Kind</Label>
      <Segmented full value={kind} onChange={setKind} options={[{ value: 'note', label: 'Note' }, { value: 'plan', label: 'Plan' }, { value: 'research', label: 'Research' }]} />
      <Label>Subject &amp; tags</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject (optional)" aria-label="Subject" className="v-field h-11 min-w-0 flex-1 px-4 text-[0.92rem]" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma separated" aria-label="Tags" className="v-field h-11 min-w-0 flex-1 px-4 font-mono text-[0.84rem]" />
      </div>
      <Label>Project</Label>
      <DirPicker value={dir} onChange={setDir} />
      <Button tone="primary" size="lg" icon="plus" className="mt-6 w-full" onClick={go}>
        Create {kindLabel(kind).toLowerCase()}
      </Button>
    </div>
  );
}

export function Research({ onDone }) {
  const models = useModels();
  const lastDir = useMC((s) => s.lastDir);
  const [topic, setTopic] = useState('');
  const [subject, setSubject] = useState('');
  const [tags, setTags] = useState('');
  const [dir, setDir] = useState(lastDir || '');
  const [model, setModel] = useState(DEFAULT_SOLO);
  const go = () => {
    const t = topic.trim();
    if (!t) return toast('What should the agent research?');
    if (!research({ topic: t, subject: subject.trim(), dir: dir.trim(), model: fix(model), tags: toTags(tags) })) return;
    onDone?.();
  };
  return (
    <div data-research>
      <p className="mb-4 text-[0.86rem] leading-relaxed text-ink3">An agent researches the topic and writes its report straight into a new Library document — you watch it fill in.</p>
      <Label>Topic</Label>
      <Hero value={topic} onChange={setTopic} placeholder="What should it find out?" autoFocus label="Topic" />
      <Label>Subject &amp; tags</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject (optional)" aria-label="Subject" className="v-field h-11 min-w-0 flex-1 px-4 text-[0.92rem]" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma separated" aria-label="Tags" className="v-field h-11 min-w-0 flex-1 px-4 font-mono text-[0.84rem]" />
      </div>
      <Label>Project &amp; model</Label>
      <div className="flex flex-col gap-2">
        <DirPicker value={dir} onChange={setDir} />
        <ModelSelect value={model} onChange={setModel} models={models} />
      </div>
      <Button tone="primary" size="lg" icon="research" className="mt-6 w-full" onClick={go}>
        Start research
      </Button>
    </div>
  );
}

function draftMission(g) {
  return (
    'Research this project and draft a thorough implementation plan for the goal below. Do NOT write any code — you are in plan mode. ' +
    'Explore the codebase first, then produce one complete, well-structured markdown plan: a clear title as a # heading, context, a concrete step-by-step approach naming the exact files to touch, risks, and how to verify. ' +
    'Present the finished plan with ExitPlanMode — Mission Control saves it to the library automatically.\n\nGOAL: ' +
    g
  );
}

export function DraftPlan({ onDone }) {
  const models = useModels();
  const lastDir = useMC((s) => s.lastDir);
  const [goal, setGoal] = useState('');
  const [dir, setDir] = useState(lastDir || '');
  const [model, setModel] = useState(DEFAULT_SOLO);
  const go = () => {
    const g = goal.trim();
    if (!g) return toast('Describe what to plan first');
    if (!launch({ mission: draftMission(g), dir: dir.trim(), managerModel: null, workerModels: [fix(model)], planMode: true })) return;
    toast('Planning agent launched — its plan lands in the Library');
    onDone?.();
  };
  return (
    <div data-draft>
      <p className="mb-4 text-[0.86rem] leading-relaxed text-ink3">A read-only agent explores the project and writes a plan. Nothing is changed; the plan lands in the Library.</p>
      <Label>Goal</Label>
      <Hero value={goal} onChange={setGoal} placeholder="What do you want built?" autoFocus label="Goal" />
      <Label>Project &amp; model</Label>
      <div className="flex flex-col gap-2">
        <DirPicker value={dir} onChange={setDir} />
        <ModelSelect value={model} onChange={setModel} models={models} />
      </div>
      <Button tone="primary" size="lg" icon="bolt" className="mt-6 w-full" onClick={go}>
        Draft the plan
      </Button>
    </div>
  );
}
