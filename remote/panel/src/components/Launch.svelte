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

  const agentCount = $derived(mode === 'solo' ? 1 : 1 + workers.length);

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
    if (d < 0 && workers.length > 0) workers = workers.slice(0, -1);
  }

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
    <h2 class="text-[18px] font-semibold leading-none tracking-tight">Launch agents</h2>
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto noscroll">
    <div class="mx-auto flex max-w-[760px] flex-col gap-4 p-4 sm:p-6">
      <!-- mode -->
      <div class="panel grid grid-cols-2 gap-1 rounded-2xl p-1">
        {#each [['solo', 'Solo', 'One agent, one mission'], ['fleet', 'Fleet', 'A manager directs a crew']] as [m, t, s]}
          <button onclick={() => (mode = m)} class="rounded-xl px-4 py-3 text-center transition {mode === m ? 'bg-raised' : 'hover:bg-white/[0.02]'}">
            <div class="text-[15px] font-semibold {mode === m ? 'text-ink' : 'text-ink2'}">{t}</div>
            <div class="mt-0.5 text-[12px] text-ink3">{s}</div>
          </button>
        {/each}
      </div>

      <!-- mission -->
      <section class="panel rounded-2xl p-5">
        <div class="mb-3 flex items-center gap-3">
          <span class="hud">Mission</span>
          <span class="flex-1"></span>
          {#if speechSupported}
            <button onclick={toggleMic} aria-label="Dictate mission" class="grid h-10 w-10 flex-none place-items-center rounded-xl border transition active:scale-95 {micSession ? 'border-crit bg-crit/12 text-crit' : 'border-line bg-raised/60 text-ink2'}" style={micSession ? 'animation:mc-ring 1.4s ease-out infinite' : ''}><Icon name="mic" size={18} /></button>
          {/if}
        </div>
        {#if doc}
          <div class="mb-3 flex items-center gap-3 rounded-xl border {docTone.edge} px-3.5 py-2.5">
            <Icon name={docTone.icon} size={17} class="flex-none {docTone.text}" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-mono text-[13px] font-semibold {docTone.text}">{doc.title}</div>
              <div class="hud mt-0.5">{docVerb} this {kindLabel(doc.kind).toLowerCase()} — sent to the agents with the mission</div>
            </div>
            <button onclick={() => (doc = null)} aria-label="Detach document" class="grid h-9 w-9 flex-none place-items-center rounded-lg text-ink3 transition hover:text-crit"><Icon name="close" size={16} /></button>
          </div>
        {/if}
        <textarea
          bind:value={mission}
          rows="3"
          placeholder={doc ? 'Optional extra instructions — the document is the mission…' : mode === 'solo' ? 'Describe the task for your agent…' : 'Describe the mission — the manager splits it into assignments…'}
          class="min-h-24 w-full resize-y rounded-xl border border-line bg-inset px-4 py-3 text-[16px] leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-line2 noscroll"></textarea>
      </section>

      <!-- directory -->
      <section class="panel rounded-2xl p-5">
        <span class="hud">Working directory</span>
        <input bind:value={dir} oninput={() => (dirTouched = true)} placeholder="~/path/to/project" class="mt-3 w-full rounded-xl border border-line bg-inset px-4 py-3 font-mono text-[13px] text-ink outline-none transition placeholder:text-ink3 focus:border-line2" />
        {#if mc.knownDirs.length}
          <div class="mt-3 flex flex-wrap gap-1.5">
            {#each mc.knownDirs as d}
              <button onclick={() => { dir = d; dirTouched = true; }} class="min-h-[38px] rounded-lg border px-3.5 py-2 text-[13px] transition active:scale-95 {d === dir ? 'border-line2 bg-raised text-ink' : 'border-line text-ink2 hover:border-line2'}">{d.split('/').filter(Boolean).pop() || d}</button>
            {/each}
          </div>
        {/if}
      </section>

      <!-- models -->
      {#if mode === 'solo'}
        <section class="panel rounded-2xl p-5">
          <span class="hud">Model</span>
          <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {#each models as m}
              <button onclick={() => (soloModel = m.flag)} class="flex flex-col gap-1 rounded-xl border p-3.5 text-left transition active:scale-[0.97] {m.flag === soloModel ? 'border-line2 bg-raised' : 'border-line hover:border-line2'}">
                <span class="text-[14px] font-semibold {m.flag === soloModel ? 'text-ink' : 'text-ink2'}">{m.short}</span>
                <span class="text-[12px] leading-snug text-ink3">{m.blurb}</span>
              </button>
            {/each}
          </div>
        </section>
      {:else}
        <section class="panel rounded-2xl p-5">
          <div class="flex items-center gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-[15px] font-semibold">Manager</span>
                <span class="flex-none rounded-md border border-mgr/40 px-1.5 py-0.5 text-[10px] font-semibold text-mgr">MGR</span>
              </div>
              <div class="mt-0.5 text-[12.5px] text-ink3">Plans, assigns, reconciles — never touches code itself.</div>
            </div>
          </div>
          <select bind:value={managerModel} class="mt-3 min-h-[46px] w-full rounded-xl border border-line bg-raised px-4 py-3 text-[14px] text-ink outline-none transition focus:border-line2">
            {#each models as m}<option value={m.flag}>{m.label}</option>{/each}
          </select>
        </section>

        <section class="panel rounded-2xl p-5">
          <div class="flex items-center gap-3">
            <span class="hud">Workers</span>
            <span class="flex-1"></span>
            <div class="flex flex-none items-center gap-2.5">
              <button onclick={() => step(-1)} aria-label="Remove worker" class="grid h-10 w-10 place-items-center rounded-xl border border-line bg-raised text-[18px] text-ink2 transition active:scale-95">−</button>
              <b class="w-5 text-center text-[16px] font-semibold tabular-nums">{workers.length}</b>
              <button onclick={() => step(1)} aria-label="Add worker" class="grid h-10 w-10 place-items-center rounded-xl border border-line bg-raised text-[18px] text-ink2 transition active:scale-95">+</button>
            </div>
          </div>
          <div class="mt-3 flex flex-col gap-2">
            {#each workers as w, i}
              <div class="flex items-center gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2">
                <span class="w-6 flex-none text-center font-mono text-[12px] tabular-nums text-ink3">{i + 1}</span>
                <select value={w} onchange={(e) => (workers[i] = e.currentTarget.value)} class="min-h-[42px] min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-[14px] text-ink outline-none transition focus:border-line2">
                  {#each models as m}<option value={m.flag}>{m.label}</option>{/each}
                </select>
                <button onclick={() => (workers = workers.filter((_, j) => j !== i))} aria-label="Remove" class="min-h-[42px] flex-none px-2 text-[16px] text-ink3 transition hover:text-crit">✕</button>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <button onclick={doLaunch} class="w-full rounded-xl bg-ink py-4 text-[15px] font-semibold text-bg transition active:scale-[0.98]">
        {mode === 'solo' ? 'Launch agent' : `Launch fleet · ${agentCount} agents`}
      </button>
      <p class="pb-2 text-center text-[12.5px] text-ink3">Agents open in your chosen terminal on the Mac and appear on the fleet board automatically.</p>
    </div>
  </main>
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
