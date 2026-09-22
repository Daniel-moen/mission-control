import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useMC, launch, toast, kindLabel, allDirs } from '../../lib/store.js';
import { mergeModels, DEFAULT_SOLO, DEFAULT_MANAGER, DEFAULT_WORKER } from '../../lib/models.js';
import { dictate, speechSupported } from '../../lib/speech.js';
import { spring, fadeUp, fadeIn, press } from '../../lib/motion.js';
import Sheet from '../../ui/Sheet.jsx';
import Field from '../../ui/Field.jsx';
import Select from '../../ui/Select.jsx';
import Segmented from '../../ui/Segmented.jsx';
import Button from '../../ui/Button.jsx';
import Icon from '../../ui/Icon.jsx';

// The launch sheet: one mission, one project, who runs it, with what.
// Everything below the mission box is a detail — the textarea is the hero.
// This view owns its own overlay (the Sheet primitive) — App renders it bare.
//
// A library document can ride along: a plan to BUILD, or a research/note to
// CONTINUE. `docMode` tells the Mac how to frame it; the host folds the doc's
// content and file path into the mission, so the doc can stand in for missing
// mission text and supplies a default working dir.

const OTHER = '__other';
const MAX_WORKERS = 8;

// Glass form field — soft white fill, 12% hairline, accent focus ring.
const INPUT =
  'glass-soft w-full rounded-xl2 px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors ' +
  'placeholder:text-ink3 focus:border-accent/60 focus:ring-1 focus:ring-accent/40';

const DOC_TONE = {
  plan: { icon: 'plan', text: 'text-accent', edge: 'border-accent/35 bg-accent/[0.09]' },
  research: { icon: 'research', text: 'text-mgr', edge: 'border-mgr/35 bg-mgr/[0.09]' },
  note: { icon: 'note', text: 'text-ink2', edge: 'border-glass-line bg-white/[0.06]' },
};

export default function Launch({ attachDoc = null, onClose }) {
  // The attached doc is local state — it can be detached without closing.
  const [doc, setDoc] = useState(attachDoc);
  useEffect(() => setDoc(attachDoc), [attachDoc]);

  const hostModels = useMC((s) => s.models);
  const models = useMemo(() => mergeModels(hostModels), [hostModels]);
  const lastDir = useMC((s) => s.lastDir);
  // allDirs() reads the store imperatively — subscribe to both slices it folds
  // together so the picker re-renders when either moves.
  const knownDirs = useMC((s) => s.knownDirs);
  const localDirs = useMC((s) => s.localDirs);
  const dirs = useMemo(() => allDirs(), [knownDirs, localDirs]);

  const [mode, setMode] = useState('fleet');
  const [mission, setMission] = useState('');
  const [dir, setDir] = useState('');
  const [soloModel, setSoloModel] = useState(DEFAULT_SOLO);
  const [managerModel, setManagerModel] = useState(DEFAULT_MANAGER);
  const [workers, setWorkers] = useState([DEFAULT_WORKER, DEFAULT_WORKER]);

  // Default the working dir once — from the attached doc, else the last launch.
  // A user edit sticks: `dirTouched` keeps the default from creeping back.
  const dirTouched = useRef(false);
  useEffect(() => {
    if (dirTouched.current || dir) return;
    const want = doc?.dir || lastDir;
    if (want) setDir(want);
  }, [dir, doc, lastDir]);

  // Snap model choices onto the host's actual list — a default flag that the
  // connected Mac doesn't offer would otherwise render as an empty select.
  // (mergeModels keeps every KNOWN flag present, so this is the safety net for
  // a host that advertises a list with nothing familiar in it.)
  useEffect(() => {
    if (!models.length) return;
    const flags = new Set(models.map((m) => m.flag));
    const pick = (want) => models.find((m) => m.flag.includes(want))?.flag || models[0].flag;
    if (!flags.has(soloModel)) setSoloModel(pick('fable'));
    if (!flags.has(managerModel)) setManagerModel(pick('fable'));
    setWorkers((ws) => (ws.some((w) => !flags.has(w)) ? ws.map((w) => (flags.has(w) ? w : pick('sonnet'))) : ws));
  }, [models, soloModel, managerModel]);

  // Labels only: the blurb rides under the solo picker as a caption instead of
  // bloating every option in a native picker.
  const modelOptions = useMemo(() => models.map((m) => ({ value: m.flag, label: m.label })), [models]);
  const soloBlurb = models.find((m) => m.flag === soloModel)?.blurb || '';

  const knownDir = dirs.includes(dir);
  const [showDirInput, setShowDirInput] = useState(false);
  const dirSel = !showDirInput && knownDir ? dir : OTHER;
  const manualDir = dirSel === OTHER || !dirs.length;

  // ---- dictation for the mission field ---------------------------------------
  const [mic, setMic] = useState(null);
  const micRef = useRef(null);
  useEffect(() => () => micRef.current?.stop(), []);
  function toggleMic() {
    if (micRef.current) {
      micRef.current.stop();
      return;
    }
    const stop = () => {
      micRef.current = null;
      setMic(null);
    };
    const s = dictate({ base: mission, onText: setMission, onEnd: stop, onError: stop });
    micRef.current = s;
    setMic(s);
  }

  function step(d) {
    setWorkers((ws) => {
      if (d > 0 && ws.length < MAX_WORKERS) return [...ws, ws[ws.length - 1] || DEFAULT_WORKER];
      if (d < 0 && ws.length > 1) return ws.slice(0, -1);
      return ws;
    });
  }

  // Per-worker model rows are advanced detail — one shared select covers the
  // common case, the list unfolds on demand.
  const [perWorker, setPerWorker] = useState(false);
  const workersUniform = new Set(workers).size <= 1;
  const setAllWorkers = (flag) => setWorkers((ws) => ws.map(() => flag));

  const agentCount = mode === 'solo' ? 1 : 1 + workers.length;

  // The launch overlay is driven by the user's click (optimistic), NOT by a
  // persisted ack — a leftover ack must never re-fire when the sheet reopens.
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState('Launching…');
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  function doLaunch() {
    const m = mission.trim();
    if (!m && !doc) return toast('Describe the mission first');
    if (mode === 'fleet' && workers.length === 0) return toast('Add at least one worker');
    const fix = (f) => (f === 'default' ? '' : f);
    const payload =
      mode === 'solo'
        ? { mission: m, dir: dir.trim(), managerModel: null, workerModels: [fix(soloModel)] }
        : { mission: m, dir: dir.trim(), managerModel: fix(managerModel) || 'opus', workerModels: workers.map(fix) };
    if (doc) {
      payload.docId = doc.id;
      payload.docMode = doc.mode || (doc.kind === 'plan' ? 'build' : 'continue');
    }
    if (!launch(payload)) return; // send() already toasted the reason
    setMission('');
    setLaunching(true);
    setLaunchMsg('Launching…');
    timers.current.forEach(clearTimeout);
    timers.current = [
      setTimeout(() => setLaunchMsg('Deployed — agents incoming'), 1400),
      setTimeout(() => {
        setLaunching(false);
        onClose?.('fleet');
      }, 2400),
    ];
  }

  const tone = DOC_TONE[doc?.kind] || DOC_TONE.note;
  const docVerb = doc?.mode === 'continue' ? 'Continuing' : 'Building';

  const footer = (
    <div className="flex items-center gap-4">
      <p className="min-w-0 flex-1 text-[12px] leading-snug text-ink3">
        {agentCount === 1 ? '1 agent' : `${agentCount} agents`} · opens in your terminal on the Mac
        <span className="hidden sm:inline"> and appears on the board automatically</span>
      </p>
      <Button variant="primary" size="lg" icon="launch" onClick={doLaunch} className="flex-none">
        Launch
      </Button>
    </div>
  );

  return (
    <>
      <Sheet open onClose={() => onClose?.()} title="Launch" size="md" footer={footer}>
        <div className="flex flex-col gap-5 pt-1">
          {/* THE MISSION — the hero. Everything else is a detail. */}
          <section>
            <AnimatePresence initial={false}>
              {doc && (
                <motion.div
                  {...fadeUp}
                  className={`mb-2.5 flex items-center gap-3 rounded-xl2 border px-3.5 py-2.5 ${tone.edge}`}
                >
                  <Icon name={tone.icon} size={17} className={`flex-none ${tone.text}`} />
                  <div className="min-w-0 flex-1">
                    <div className={`truncate text-[13px] font-semibold ${tone.text}`}>{doc.title}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-ink3">
                      {docVerb} this {kindLabel(doc.kind).toLowerCase()} — sent to the agents with the mission
                    </div>
                  </div>
                  <motion.button
                    {...press}
                    onClick={() => setDoc(null)}
                    aria-label="Detach document"
                    className="grid h-8 w-8 flex-none place-items-center rounded-full text-ink3 transition-colors hover:bg-white/10 hover:text-crit"
                  >
                    <Icon name="close" size={15} />
                  </motion.button>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="relative">
              <textarea
                value={mission}
                onChange={(e) => setMission(e.target.value)}
                rows={4}
                placeholder={doc ? 'Optional extra instructions — the document is the mission…' : 'What should get done?'}
                className={`noscroll min-h-[124px] w-full resize-y rounded-xl3 px-4 py-3.5 pr-14 text-[16px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink3 ${
                  mic ? 'glass-soft border-crit/50 ring-1 ring-crit/30' : INPUT
                }`}
              />
              {speechSupported && (
                <motion.button
                  {...press}
                  onClick={toggleMic}
                  aria-label="Dictate mission"
                  className={`absolute right-2.5 top-2.5 grid h-10 w-10 place-items-center rounded-full border transition-colors ${
                    mic
                      ? 'border-crit/60 bg-crit/15 text-crit'
                      : 'border-glass-line bg-white/[0.08] text-ink2 hover:text-ink'
                  }`}
                >
                  {mic && <span className="anim-ping absolute inset-0 rounded-full bg-crit/40" />}
                  <Icon name="mic" size={17} className="relative" />
                </motion.button>
              )}
            </div>
          </section>

          {/* WHERE */}
          <Field label="Project">
            {dirs.length > 0 && (
              <Select
                value={dirSel}
                onChange={(v) => {
                  dirTouched.current = true;
                  if (v === OTHER) {
                    setShowDirInput(true);
                    setDir(''); // picking "Other" clears the bound dir
                  } else {
                    setDir(v);
                    setShowDirInput(false);
                  }
                }}
                options={[...dirs.map((d) => ({ value: d, label: d })), { value: OTHER, label: 'Other folder…' }]}
                className="font-mono"
                aria-label="Project folder"
              />
            )}
            {manualDir && (
              <input
                value={dir}
                onChange={(e) => {
                  dirTouched.current = true;
                  setDir(e.target.value);
                }}
                placeholder="~/path/to/project"
                className={`${INPUT} mt-2 font-mono text-[13px]`}
              />
            )}
          </Field>

          {/* WHO */}
          <section>
            <span className="label mb-1.5 block">Team</span>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'solo', label: 'Solo' },
                  { value: 'fleet', label: 'Fleet' },
                ]}
              />
              <AnimatePresence initial={false}>
                {mode === 'fleet' && (
                  <motion.div {...fadeIn} className="glass-soft pill flex items-center gap-1 px-1 py-0.5">
                    <motion.button
                      {...press}
                      onClick={() => step(-1)}
                      aria-label="Fewer workers"
                      disabled={workers.length <= 1}
                      className="grid h-8 w-8 place-items-center rounded-full text-ink2 transition-colors hover:bg-white/10 hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                    >
                      <Icon name="minus" size={15} />
                    </motion.button>
                    <span className="tnum w-[74px] text-center text-[12.5px] text-ink3">
                      <b className="font-semibold text-ink">{workers.length}</b> worker{workers.length === 1 ? '' : 's'}
                    </span>
                    <motion.button
                      {...press}
                      onClick={() => step(1)}
                      aria-label="More workers"
                      disabled={workers.length >= MAX_WORKERS}
                      className="grid h-8 w-8 place-items-center rounded-full text-ink2 transition-colors hover:bg-white/10 hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                    >
                      <Icon name="plus" size={15} />
                    </motion.button>
                  </motion.div>
                )}
              </AnimatePresence>
              {mode === 'fleet' && <span className="text-[12px] text-ink3">+ 1 manager to run them</span>}
            </div>
            <p className="mt-2 text-[12px] leading-snug text-ink3">
              {mode === 'solo'
                ? 'One agent takes the whole task itself.'
                : 'A manager splits the mission into assignments and reconciles the results.'}
            </p>
          </section>

          {/* WITH WHAT */}
          <section>
            <span className="label mb-1.5 block">{mode === 'solo' ? 'Model' : 'Models'}</span>
            <AnimatePresence mode="wait" initial={false}>
              {mode === 'solo' ? (
                <motion.div key="solo" {...fadeUp}>
                  <Select options={modelOptions} value={soloModel} onChange={setSoloModel} aria-label="Model" />
                  {soloBlurb && <p className="mt-2 text-[12px] leading-snug text-ink3">{soloBlurb}</p>}
                </motion.div>
              ) : (
                <motion.div key="fleet" {...fadeUp} className="flex flex-col gap-2">
                  <label className="flex items-center gap-3">
                    <span className="w-[68px] flex-none text-[12.5px] text-ink3">Manager</span>
                    <Select
                      options={modelOptions}
                      value={managerModel}
                      onChange={setManagerModel}
                      className="min-w-0 flex-1"
                      aria-label="Manager model"
                    />
                  </label>
                  {!perWorker ? (
                    <>
                      <label className="flex items-center gap-3">
                        <span className="w-[68px] flex-none text-[12.5px] text-ink3">Workers</span>
                        <Select
                          // A mixed set has no single value — show the sentinel
                          // rather than silently claiming worker 1's model.
                          options={workersUniform ? modelOptions : [{ value: '', label: 'Mixed…' }, ...modelOptions]}
                          value={workersUniform ? workers[0] : ''}
                          onChange={setAllWorkers}
                          className="min-w-0 flex-1"
                          aria-label="Worker model"
                        />
                      </label>
                      <button
                        onClick={() => setPerWorker(true)}
                        className="self-start text-[12px] text-ink3 underline decoration-white/20 underline-offset-2 transition-colors hover:text-ink2"
                      >
                        Pick a model per worker
                      </button>
                    </>
                  ) : (
                    <>
                      {workers.map((w, i) => (
                        <label key={i} className="flex items-center gap-3">
                          <span className="tnum w-[68px] flex-none text-[12px] text-ink3">Worker {i + 1}</span>
                          <Select
                            options={modelOptions}
                            value={w}
                            onChange={(v) => setWorkers((ws) => ws.map((x, j) => (j === i ? v : x)))}
                            className="min-w-0 flex-1"
                            aria-label={`Worker ${i + 1} model`}
                          />
                        </label>
                      ))}
                      <button
                        onClick={() => {
                          setPerWorker(false);
                          setAllWorkers(workers[0]);
                        }}
                        className="self-start text-[12px] text-ink3 underline decoration-white/20 underline-offset-2 transition-colors hover:text-ink2"
                      >
                        Use one model for all workers
                      </button>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>
      </Sheet>

      {createPortal(
        <AnimatePresence>
          {launching && (
            <motion.div
              {...fadeIn}
              className="fixed inset-0 z-[110] flex flex-col items-center justify-center gap-6 bg-overlay backdrop-blur-xl"
            >
              <span className="anim-spin h-14 w-14 rounded-full border-2 border-white/15 border-t-accent" />
              <AnimatePresence mode="wait">
                <motion.div
                  key={launchMsg}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={spring.smooth}
                  className={`px-6 text-center text-[17px] font-semibold tracking-tight ${
                    launchMsg.startsWith('Deployed') ? 'text-accent' : 'text-ink'
                  }`}
                >
                  {launchMsg}
                </motion.div>
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
