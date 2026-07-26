<script>
  import { onDestroy } from 'svelte';
  import { mc, launch, toast, kindLabel } from '../lib/store.svelte.js';
  import { dictate, speechSupported } from '../lib/speech.js';
  import Icon from './Icon.svelte';

  let { onclose, attachDoc = null } = $props();

  // A library document riding along with this launch: a plan to BUILD, or a
  // research/note to CONTINUE. `mode` ('build' | 'continue') tells the Mac how to
  // frame it; it folds the doc's content and file path into the mission, so the
  // doc can stand in for missing mission text and supplies a default working dir.
  let doc = $state(attachDoc);

  const DOC_TONE = {
    plan: { icon: 'plan', text: 'text-accent', edge: 'border-accent/40 bg-accent/8' },
    research: { icon: 'research', text: 'text-mgr', edge: 'border-mgr/40 bg-mgr/8' },
    note: { icon: 'note', text: 'text-ink2', edge: 'border-line2 bg-raised/50' },
  };
  const docTone = $derived(DOC_TONE[doc?.kind] || DOC_TONE.note);
  const docVerb = $derived(doc?.mode === 'continue' ? 'Continuing' : 'Building');

  const FALLBACK = [
    { flag: 'claude-fable-5', label: 'Fable 5', short: 'Fable', blurb: 'Frontier intelligence — the apex model' },
    { flag: 'opus', label: 'Opus 4.8', short: 'Opus', blurb: 'Deepest reasoning — the heavy lifter' },
    { flag: 'claude-sonnet-5', label: 'Sonnet 5', short: 'Sonnet', blurb: 'Near-Opus smarts at Sonnet speed' },
    { flag: 'haiku', label: 'Haiku 4.5', short: 'Haiku', blurb: 'Fast & cheap — quick passes' },
    { flag: 'default', label: 'Default', short: 'Default', blurb: 'Whatever your CLI defaults to' },
  ];
  const models = $derived(mc.models.length ? mc.models : FALLBACK);

  let mode = $state('fleet');
  let mission = $state('');
  let dir = $state('');
  let soloModel = $state('opus');
  let managerModel = $state('opus');
  let workers = $state(['claude-sonnet-5', 'claude-sonnet-5']);

  let dirTouched = false;
  $effect(() => {
    if (!dirTouched && !dir && (doc?.dir || mc.lastDir)) dir = doc?.dir || mc.lastDir;
  });

  // Snap model choices onto the host's actual list — a default flag that the
  // connected Mac doesn't offer would otherwise render as an empty select.
  $effect(() => {
    const flags = new Set(models.map((m) => m.flag));
    const pick = (want) => models.find((m) => m.flag.includes(want))?.flag || models[0]?.flag || '';
    if (!flags.has(soloModel)) soloModel = pick('opus');
    if (!flags.has(managerModel)) managerModel = pick('opus');
    if (workers.some((w) => !flags.has(w))) workers = workers.map((w) => (flags.has(w) ? w : pick('sonnet')));
  });

  const agentCount = $derived(mode === 'solo' ? 1 : 1 + workers.length);
  // "Other folder…" input only shows when the current dir isn't one of the chips.
  const knownDir = $derived(mc.knownDirs.includes(dir));
  let showDirInput = $state(false);

  // dictation for the mission field
  let micSession = $state(null);
  function toggleMic() {
    if (micSession) {
      micSession.stop();
      return;
    }
    micSession = dictate({ base: mission, onText: (t) => (mission = t), onEnd: () => (micSession = null), onError: () => (micSession = null) });
  }

  function step(d) {
    if (d > 0 && workers.length < 8) workers = [...workers, workers[workers.length - 1] || 'claude-sonnet-5'];
    if (d < 0 && workers.length > 1) workers = workers.slice(0, -1);
  }

  // Per-worker model rows are advanced detail — one shared select covers the
  // common case, the list unfolds on demand.
  let perWorker = $state(false);
  function setAllWorkers(flag) {
    workers = workers.map(() => flag);
  }
  const workersUniform = $derived(new Set(workers).size <= 1);

  // The launch overlay is driven by the user's click (optimistic), NOT by a
  // persisted ack — a leftover ack must never re-fire when the sheet reopens.
  let launching = $state(false);
  let launchMsg = $state('Launching…');
  let timers = [];
  onDestroy(() => timers.forEach(clearTimeout));

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
    mission = '';
    launching = true;
    launchMsg = 'Launching…';
    timers.forEach(clearTimeout);
    timers = [
      setTimeout(() => (launchMsg = 'Deployed — agents incoming'), 1400),
      setTimeout(() => {
        launching = false;
        onclose('fleet');
      }, 2400),
    ];
  }
</script>

<div class="fixed inset-0 z-[70] flex flex-col bg-bg">
  <header class="flex flex-none items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur sm:px-6" style="padding-top:calc(12px + var(--sat));padding-bottom:12px">
    <button onclick={() => onclose()} aria-label="Close" class="grid h-10 w-10 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name="close" size={22} /></button>
    <h2 class="text-[18px] font-semibold leading-none tracking-tight">Launch</h2>
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto noscroll">
    <div class="mx-auto flex max-w-[680px] flex-col gap-6 p-4 pb-8 sm:p-6">
      <!-- THE MISSION — the hero. Everything else is a detail. -->
      <section>
        {#if doc}
          <div class="mb-3 flex items-center gap-3 rounded-xl border {docTone.edge} px-3.5 py-2.5">
            <Icon name={docTone.icon} size={17} class="flex-none {docTone.text}" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13.5px] font-semibold {docTone.text}">{doc.title}</div>
              <div class="mt-0.5 text-[11.5px] text-ink3">{docVerb} this {kindLabel(doc.kind).toLowerCase()} — sent to the agents with the mission</div>
            </div>
            <button onclick={() => (doc = null)} aria-label="Detach document" class="grid h-9 w-9 flex-none place-items-center rounded-lg text-ink3 transition hover:text-crit"><Icon name="close" size={16} /></button>
          </div>
        {/if}
        <div class="relative">
          <textarea
            bind:value={mission}
            rows="4"
            placeholder={doc ? 'Optional extra instructions — the document is the mission…' : 'What should get done?'}
            class="min-h-32 w-full resize-y rounded-2xl border bg-inset px-5 py-4 pr-14 text-[17px] leading-relaxed text-ink outline-none transition placeholder:text-ink3 noscroll {micSession ? 'border-crit/40' : 'border-line focus:border-line2'}"></textarea>
          {#if speechSupported}
            <button
              onclick={toggleMic}
              aria-label="Dictate mission"
              class="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-xl border transition active:scale-95 {micSession ? 'border-crit bg-crit/12 text-crit' : 'border-line bg-raised/80 text-ink2'}"
              style={micSession ? 'animation:mc-ring 1.4s ease-out infinite' : ''}><Icon name="mic" size={18} /></button>
          {/if}
        </div>
      </section>

      <!-- WHERE -->
      <section>
        <div class="hud mb-2">Project</div>
        <div class="flex flex-wrap gap-1.5">
          {#each mc.knownDirs as d (d)}
            <button
              onclick={() => { dir = d; dirTouched = true; showDirInput = false; }}
              class="flex min-h-[40px] items-center gap-1.5 rounded-xl border px-3.5 text-[13.5px] transition active:scale-95 {d === dir ? 'border-line2 bg-raised font-medium text-ink' : 'border-line text-ink2 hover:border-line2'}">
              <Icon name="folder" size={14} class={d === dir ? 'text-ink2' : 'text-ink3'} />
              {d.split('/').filter(Boolean).pop() || d}
            </button>
          {/each}
          <button
            onclick={() => (showDirInput = !showDirInput)}
            class="min-h-[40px] rounded-xl border px-3.5 text-[13.5px] transition active:scale-95 {showDirInput || (dir && !knownDir) ? 'border-line2 bg-raised text-ink' : 'border-line text-ink3 hover:border-line2'}">
            Other…
          </button>
        </div>
        {#if showDirInput || (dir && !knownDir)}
          <input bind:value={dir} oninput={() => (dirTouched = true)} placeholder="~/path/to/project" class="mt-2 w-full rounded-xl border border-line bg-inset px-4 py-3 font-mono text-[13px] text-ink outline-none transition placeholder:text-ink3 focus:border-line2" />
        {/if}
      </section>

      <!-- WHO -->
      <section>
        <div class="hud mb-2">Team</div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex overflow-hidden rounded-xl border border-line">
            {#each [['solo', 'Solo'], ['fleet', 'Fleet']] as [m, label] (m)}
              <button onclick={() => (mode = m)} class="min-h-[42px] px-5 text-[14px] font-medium transition {mode === m ? 'bg-raised text-ink' : 'text-ink3 hover:text-ink2'}">{label}</button>
            {/each}
          </div>
          {#if mode === 'fleet'}
            <div class="flex items-center gap-1 rounded-xl border border-line px-1.5 py-1">
              <button onclick={() => step(-1)} aria-label="Fewer workers" class="grid h-8 w-9 place-items-center rounded-lg text-[17px] text-ink2 transition hover:bg-raised active:scale-95">−</button>
              <span class="w-[76px] text-center text-[13.5px] tabular-nums text-ink2"><b class="text-ink">{workers.length}</b> worker{workers.length === 1 ? '' : 's'}</span>
              <button onclick={() => step(1)} aria-label="More workers" class="grid h-8 w-9 place-items-center rounded-lg text-[17px] text-ink2 transition hover:bg-raised active:scale-95">+</button>
            </div>
            <span class="text-[12.5px] text-ink3">+ 1 manager to run them</span>
          {/if}
        </div>
        {#if mode === 'solo'}
          <p class="mt-2 text-[12.5px] text-ink3">One agent takes the whole task itself.</p>
        {:else}
          <p class="mt-2 text-[12.5px] text-ink3">A manager splits the mission into assignments and reconciles the results.</p>
        {/if}
      </section>

      <!-- WITH WHAT -->
      <section>
        <div class="hud mb-2">{mode === 'solo' ? 'Model' : 'Models'}</div>
        {#if mode === 'solo'}
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {#each models as m (m.flag)}
              <button onclick={() => (soloModel = m.flag)} class="flex flex-col gap-1 rounded-xl border p-3.5 text-left transition active:scale-[0.97] {m.flag === soloModel ? 'border-line2 bg-raised' : 'border-line hover:border-line2'}">
                <span class="text-[14px] font-semibold {m.flag === soloModel ? 'text-ink' : 'text-ink2'}">{m.short}</span>
                <span class="text-[12px] leading-snug text-ink3">{m.blurb}</span>
              </button>
            {/each}
          </div>
        {:else}
          <div class="flex flex-col gap-2">
            <label class="flex items-center gap-3">
              <span class="w-[72px] flex-none text-[13px] text-ink3">Manager</span>
              <select bind:value={managerModel} class="min-h-[42px] min-w-0 flex-1 rounded-xl border border-line bg-raised px-3.5 text-[14px] text-ink outline-none transition focus:border-line2">
                {#each models as m (m.flag)}<option value={m.flag}>{m.label}</option>{/each}
              </select>
            </label>
            {#if !perWorker}
              <label class="flex items-center gap-3">
                <span class="w-[72px] flex-none text-[13px] text-ink3">Workers</span>
                <select
                  value={workersUniform ? workers[0] : ''}
                  onchange={(e) => setAllWorkers(e.currentTarget.value)}
                  class="min-h-[42px] min-w-0 flex-1 rounded-xl border border-line bg-raised px-3.5 text-[14px] text-ink outline-none transition focus:border-line2">
                  {#if !workersUniform}<option value="" disabled>Mixed…</option>{/if}
                  {#each models as m (m.flag)}<option value={m.flag}>{m.label}</option>{/each}
                </select>
              </label>
              <button onclick={() => (perWorker = true)} class="self-start text-[12.5px] text-ink3 underline decoration-line2 underline-offset-2 transition hover:text-ink2">Pick a model per worker</button>
            {:else}
              {#each workers as w, i (i)}
                <label class="flex items-center gap-3">
                  <span class="w-[72px] flex-none font-mono text-[12px] tabular-nums text-ink3">Worker {i + 1}</span>
                  <select value={w} onchange={(e) => (workers[i] = e.currentTarget.value)} class="min-h-[42px] min-w-0 flex-1 rounded-xl border border-line bg-raised px-3.5 text-[14px] text-ink outline-none transition focus:border-line2">
                    {#each models as m (m.flag)}<option value={m.flag}>{m.label}</option>{/each}
                  </select>
                </label>
              {/each}
              <button onclick={() => { perWorker = false; setAllWorkers(workers[0]); }} class="self-start text-[12.5px] text-ink3 underline decoration-line2 underline-offset-2 transition hover:text-ink2">Use one model for all workers</button>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  </main>

  <!-- always-visible launch bar -->
  <footer class="flex-none border-t border-line bg-surface/85 px-4 backdrop-blur-xl sm:px-6" style="padding-top:10px;padding-bottom:calc(12px + var(--sab))">
    <div class="mx-auto flex max-w-[680px] items-center gap-4">
      <div class="min-w-0 flex-1 text-[12.5px] leading-snug text-ink3">
        {mode === 'solo' ? '1 agent' : `${agentCount} agents`} · opens in your terminal on the Mac and appears on the board automatically
      </div>
      <button onclick={doLaunch} class="flex h-12 flex-none items-center gap-2 rounded-xl bg-ink px-7 text-[15px] font-semibold text-bg transition active:scale-[0.98]">
        <Icon name="launch" size={17} /> Launch
      </button>
    </div>
  </footer>
</div>

{#if launching}
  <div class="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-6 bg-bg/95 backdrop-blur-sm">
    <div class="relative grid h-16 w-16 place-items-center">
      <div class="absolute inset-0 rounded-full border-2 border-line2 border-t-accent" style="animation:mc-spin .9s linear infinite"></div>
    </div>
    <div class="px-6 text-center">
      <div class="text-[17px] font-semibold {launchMsg.startsWith('Deployed') ? 'text-ok' : 'text-ink'}">{launchMsg}</div>
    </div>
  </div>
{/if}
