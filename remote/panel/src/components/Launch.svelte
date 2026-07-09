<script>
  import { onDestroy } from 'svelte';
  import { mc, launch, toast } from '../lib/store.svelte.js';
  import { dictate, speechSupported } from '../lib/speech.js';
  import Icon from './Icon.svelte';

  let { onclose, attachPlan = null } = $props();

  // A plan from the library riding along with this launch. The Mac folds its
  // content (and file path) into the mission, so it can stand in for a missing
  // mission text and supplies a default working dir.
  let plan = $state(attachPlan);

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
    if (!dirTouched && !dir && (plan?.dir || mc.lastDir)) dir = plan?.dir || mc.lastDir;
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
    if (!m && !plan) return toast('Describe the mission first');
    if (mode === 'fleet' && workers.length === 0) return toast('Add at least one worker');
    const fix = (f) => (f === 'default' ? '' : f);
    const payload =
      mode === 'solo'
        ? { mission: m, dir: dir.trim(), managerModel: null, workerModels: [fix(soloModel)] }
        : { mission: m, dir: dir.trim(), managerModel: fix(managerModel) || 'opus', workerModels: workers.map(fix) };
    if (plan) payload.planId = plan.id;
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
  <header class="flex flex-none items-center gap-3 border-b border-line bg-surface/80 px-4 backdrop-blur sm:px-6" style="padding-top:calc(12px + var(--sat));padding-bottom:12px; box-shadow: 0 1px 0 rgba(147,200,255,0.06)">
    <button onclick={() => onclose()} aria-label="Close" class="grid h-11 w-11 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name="close" size={22} /></button>
    <div>
      <h2 class="display text-[20px] font-bold leading-none tracking-tight">Launch agents</h2>
      <div class="hud mt-1.5">Deployment console</div>
    </div>
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto noscroll">
    <div class="mx-auto flex max-w-[760px] flex-col gap-4 p-4 sm:p-6">
      <!-- mode -->
      <div class="panel grid grid-cols-2 gap-2 rounded-[22px] p-1.5">
        {#each [['solo', 'Solo', 'One agent, one mission'], ['fleet', 'Fleet', 'A manager directs a crew']] as [m, t, s]}
          <button onclick={() => (mode = m)} class="rounded-2xl px-4 py-3 text-center transition {mode === m ? 'bg-raised ring-1 ring-accent/40 glow-accent' : ''}">
            <div class="display text-[16px] font-bold {mode === m ? 'text-accent' : 'text-ink2'}">{t}</div>
            <div class="mt-0.5 font-mono text-[11px] text-ink3">{s}</div>
          </button>
        {/each}
      </div>

      <!-- mission -->
      <section class="panel rounded-[22px] p-5">
        <div class="mb-3 flex items-center gap-3">
          <span class="hud !text-accent">Mission</span>
          <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
          {#if speechSupported}
            <button onclick={toggleMic} aria-label="Dictate mission" class="grid h-11 w-11 flex-none place-items-center rounded-xl border transition active:scale-95 {micSession ? 'border-crit bg-crit/15 text-crit glow-crit' : 'border-line bg-raised/60 text-ink2'}" style={micSession ? 'animation:mc-ring 1.4s ease-out infinite' : ''}><Icon name="mic" size={18} /></button>
          {/if}
        </div>
        {#if plan}
          <div class="mb-3 flex items-center gap-3 rounded-xl border border-accent/40 bg-accent/8 px-3.5 py-2.5">
            <Icon name="plan" size={17} class="flex-none text-accent" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-mono text-[13px] font-semibold text-accent">{plan.title}</div>
              <div class="hud mt-0.5">Plan attached — sent to the agents with the mission</div>
            </div>
            <button onclick={() => (plan = null)} aria-label="Detach plan" class="grid h-9 w-9 flex-none place-items-center rounded-lg text-ink3 transition hover:text-crit"><Icon name="close" size={16} /></button>
          </div>
        {/if}
        <textarea
          bind:value={mission}
          rows="3"
          placeholder={plan ? 'Optional extra instructions — the plan is the mission…' : mode === 'solo' ? 'Describe the task for your agent…' : 'Describe the mission — the manager splits it into assignments…'}
          class="min-h-24 w-full resize-y rounded-xl border border-line bg-inset px-4 py-3 text-[16px] leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-accent/70 focus:shadow-[0_0_0_1px_rgba(34,217,238,0.25)] noscroll"></textarea>
      </section>

      <!-- directory -->
      <section class="panel rounded-[22px] p-5">
        <div class="flex items-center gap-3">
          <span class="hud !text-accent">Working directory</span>
          <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        </div>
        <input bind:value={dir} oninput={() => (dirTouched = true)} placeholder="~/path/to/project" class="mt-3 w-full rounded-xl border border-line bg-inset px-4 py-3 font-mono text-[14px] text-ink outline-none transition placeholder:text-ink3 focus:border-accent/70 focus:shadow-[0_0_0_1px_rgba(34,217,238,0.25)]" />
        {#if mc.knownDirs.length}
          <div class="mt-3 flex flex-wrap gap-2">
            {#each mc.knownDirs as d}
              <button onclick={() => { dir = d; dirTouched = true; }} class="min-h-[44px] rounded-xl border px-3.5 py-2 font-mono text-[13px] transition active:scale-95 {d === dir ? 'border-accent/60 bg-accent/12 text-accent glow-accent' : 'border-line bg-raised/60 text-ink2'}">{d.split('/').filter(Boolean).pop() || d}</button>
            {/each}
          </div>
        {/if}
      </section>

      <!-- models -->
      {#if mode === 'solo'}
        <section class="panel rounded-[22px] p-5">
          <div class="flex items-center gap-3">
            <span class="hud !text-accent">Model</span>
            <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {#each models as m}
              <button onclick={() => (soloModel = m.flag)} class="flex flex-col gap-1 rounded-xl border p-3.5 text-left transition active:scale-[0.97] {m.flag === soloModel ? 'border-accent/60 bg-accent/10 glow-accent' : 'border-line bg-raised/60'}">
                <span class="display text-[15px] font-bold {m.flag === soloModel ? 'text-accent' : 'text-ink'}">{m.short}</span>
                <span class="font-mono text-[11px] leading-snug text-ink3">{m.blurb}</span>
              </button>
            {/each}
          </div>
        </section>
      {:else}
        <section class="panel rounded-[22px] p-5">
          <div class="flex items-center gap-3">
            <span class="hud flex-none rounded-md border border-mgr/50 px-1.5 py-0.5 !text-mgr">MGR</span>
            <div class="min-w-0 flex-1">
              <div class="display text-[16px] font-bold">Manager</div>
              <div class="mt-0.5 font-mono text-[12px] text-ink3">Plans, assigns, reconciles — never touches code itself.</div>
            </div>
          </div>
          <select bind:value={managerModel} class="mt-3 min-h-[48px] w-full rounded-xl border border-line2 bg-raised px-4 py-3 text-[15px] text-ink outline-none transition focus:border-accent/70">
            {#each models as m}<option value={m.flag}>{m.label}</option>{/each}
          </select>
        </section>

        <section class="panel rounded-[22px] p-5">
          <div class="flex items-center gap-3">
            <span class="hud !text-accent">Workers</span>
            <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
            <div class="flex flex-none items-center gap-3">
              <button onclick={() => step(-1)} aria-label="Remove worker" class="grid h-11 w-11 place-items-center rounded-xl border border-line2 bg-raised text-[20px] text-ink2 transition active:scale-95">−</button>
              <b class="display w-5 text-center text-[18px] tabular-nums text-accent">{workers.length}</b>
              <button onclick={() => step(1)} aria-label="Add worker" class="grid h-11 w-11 place-items-center rounded-xl border border-line2 bg-raised text-[20px] text-ink2 transition active:scale-95">+</button>
            </div>
          </div>
          <div class="mt-3 flex flex-col gap-2">
            {#each workers as w, i}
              <div class="flex items-center gap-3 rounded-xl border border-line bg-raised/60 px-3 py-2">
                <span class="hud w-6 flex-none text-center !text-accent">{String(i + 1).padStart(2, '0')}</span>
                <select value={w} onchange={(e) => (workers[i] = e.currentTarget.value)} class="min-h-[44px] min-w-0 flex-1 rounded-lg border border-line2 bg-surface px-3 py-2.5 text-[14px] text-ink outline-none transition focus:border-accent/70">
                  {#each models as m}<option value={m.flag}>{m.label}</option>{/each}
                </select>
                <button onclick={() => (workers = workers.filter((_, j) => j !== i))} aria-label="Remove" class="min-h-[44px] flex-none px-2 text-[18px] text-ink3 transition hover:text-crit">✕</button>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <button onclick={doLaunch} class="w-full rounded-2xl bg-accent py-4 font-mono text-[15px] font-bold uppercase tracking-[0.18em] text-accent-ink shadow-[0_0_32px_-4px_rgba(34,217,238,0.55)] transition active:scale-[0.98]">
        {mode === 'solo' ? 'Launch agent' : `Launch fleet · ${agentCount} agents`}
      </button>
      <p class="pb-2 text-center font-mono text-[12px] text-ink3">Agents open in your chosen terminal on the Mac and appear on the fleet board automatically.</p>
    </div>
  </main>
</div>

{#if launching}
  <div class="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-6 bg-bg/95 backdrop-blur-sm">
    <div class="relative grid h-20 w-20 place-items-center">
      <div class="absolute inset-0 rounded-full border-[3px] border-line2 border-t-accent" style="animation:mc-spin .9s linear infinite"></div>
      <span class="h-2.5 w-2.5 rounded-full bg-accent glow-accent" style="animation:mc-pulse 1.2s ease-in-out infinite"></span>
    </div>
    <div class="px-6 text-center">
      <div class="display text-[19px] font-bold {launchMsg.startsWith('Deployed') ? 'text-ok' : 'text-ink'}">{launchMsg}</div>
      <div class="hud mt-2">{launchMsg.startsWith('Deployed') ? 'Fleet inbound' : 'Stand by'}</div>
    </div>
  </div>
{/if}
