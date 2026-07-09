<script>
  // Plan library — every plan an agent proposes (plan mode / ExitPlanMode) is
  // saved by the Mac as a markdown file in ~/.mission-control/plans and listed
  // here. Plans are viewable, editable, and buildable: attach one to a launch
  // and the agents get it as their marching orders.
  import { mc, planCreate, launch, toast } from '../lib/store.svelte.js';
  import { dictate, speechSupported } from '../lib/speech.js';
  import { ago } from '../lib/md.js';
  import Icon from './Icon.svelte';

  let { onopen } = $props(); // onopen(planId)

  // Older Mac hosts don't ship the `plans` snapshot field at all.
  const hostTooOld = $derived(!!mc.snapshot && !('plans' in mc.snapshot));

  // ---- draft-with-agent sheet -------------------------------------------------
  let drafting = $state(false);
  let goal = $state('');
  let dir = $state('');
  let model = $state('opus');
  let dirTouched = false;
  $effect(() => {
    if (!dirTouched && !dir && mc.lastDir) dir = mc.lastDir;
  });

  let micSession = $state(null);
  function toggleMic() {
    if (micSession) {
      micSession.stop();
      return;
    }
    micSession = dictate({ base: goal, onText: (t) => (goal = t), onEnd: () => (micSession = null), onError: () => (micSession = null) });
  }

  const FALLBACK_MODELS = [
    { flag: 'claude-fable-5', label: 'Fable 5' },
    { flag: 'opus', label: 'Opus 4.8' },
    { flag: 'claude-sonnet-5', label: 'Sonnet 5' },
  ];
  const models = $derived(mc.models.length ? mc.models : FALLBACK_MODELS);

  function draftMission(g) {
    return (
      'Research this project and draft a thorough implementation plan for the goal below. Do NOT write any code — you are in plan mode. ' +
      'Explore the codebase first, then produce one complete, well-structured markdown plan: a clear title as a # heading, context, a concrete step-by-step approach naming the exact files to touch, risks, and how to verify. ' +
      'Present the finished plan with ExitPlanMode — Mission Control saves it to the plan library automatically.\n\nGOAL: ' +
      g
    );
  }

  function launchDraft() {
    const g = goal.trim();
    if (!g) return toast('Describe what to plan first');
    const fix = (f) => (f === 'default' ? '' : f);
    if (!launch({ mission: draftMission(g), dir: dir.trim(), managerModel: null, workerModels: [fix(model)], planMode: true })) return;
    drafting = false;
    goal = '';
    toast('Planning agent launched — its plan lands here when ready');
  }

  function newPlan() {
    // Created on the Mac; the planCreate ack carries the id and App opens it.
    planCreate({ title: 'Untitled plan', dir: mc.lastDir || '' });
  }
</script>

<div class="mx-auto w-full max-w-[1400px] px-4 pt-4 sm:px-6">
  <div class="mb-3 flex items-center gap-3">
    <span class="hud !text-accent">Plan library</span>
    <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
    <button onclick={() => (drafting = true)} class="flex min-h-[44px] items-center gap-2 rounded-xl border border-mgr/50 bg-mgr/10 px-3.5 py-2 font-mono text-[12px] font-semibold text-mgr transition active:scale-95">
      <Icon name="bolt" size={15} /> Draft with agent
    </button>
    <button onclick={newPlan} class="flex min-h-[44px] items-center gap-2 rounded-xl border border-accent/50 bg-accent/10 px-3.5 py-2 font-mono text-[12px] font-semibold text-accent transition active:scale-95">
      <Icon name="plan" size={15} /> New plan
    </button>
  </div>

  {#if hostTooOld}
    <div class="panel rounded-[22px] p-8 text-center">
      <div class="display text-[17px] font-bold">Your Mac app is out of date</div>
      <p class="mx-auto mt-2 max-w-[440px] font-mono text-[12.5px] leading-relaxed text-ink3">The plan library lives on your Mac. Rebuild and relaunch Mission Control there to start syncing plans.</p>
    </div>
  {:else if !mc.plans.length}
    <div class="panel rounded-[22px] p-8 text-center">
      <div class="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-line bg-raised/60 text-accent"><Icon name="plan" size={26} /></div>
      <div class="display text-[17px] font-bold">No plans yet</div>
      <p class="mx-auto mt-2 max-w-[460px] font-mono text-[12.5px] leading-relaxed text-ink3">
        Whenever an agent proposes a plan, it's saved here as a markdown file (<span class="text-ink2">~/.mission-control/plans</span>) — review it, edit it, then launch agents to build it. Or draft one now.
      </p>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {#each mc.plans as p (p.id)}
        <button onclick={() => onopen(p.id)} class="panel panel-hover anim-rise relative flex flex-col gap-2 overflow-hidden rounded-[22px] p-5 text-left transition active:scale-[0.99]">
          <span class="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-accent/70 via-accent/25 to-transparent"></span>
          <div class="flex items-start gap-3">
            <div class="grid h-9 w-9 flex-none place-items-center rounded-xl border border-line bg-raised/60 text-accent"><Icon name="plan" size={18} /></div>
            <div class="min-w-0 flex-1">
              <div class="display truncate text-[16px] font-bold leading-tight">{p.title}</div>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink3">
                {#if p.folder}<span class="flex items-center gap-1"><Icon name="folder" size={12} />{p.folder}</span>{/if}
                <span>{ago(p.updatedAt, mc.now)}</span>
                <span class="rounded-md border px-1.5 py-px {p.session ? 'border-mgr/40 text-mgr' : 'border-line2 text-ink3'}">{p.session ? 'agent' : 'you'}</span>
              </div>
            </div>
          </div>
          {#if p.preview}
            <p class="line-clamp-2 font-mono text-[12px] leading-relaxed text-ink3">{p.preview}</p>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

{#if drafting}
  <div class="fixed inset-0 z-[80] flex items-end justify-center bg-bg/80 backdrop-blur-sm sm:items-center" onclick={(e) => e.target === e.currentTarget && (drafting = false)} role="presentation">
    <div class="panel anim-rise w-full max-w-[560px] rounded-t-[26px] p-5 sm:rounded-[26px]" style="padding-bottom:calc(20px + var(--sab))">
      <div class="mb-3 flex items-center gap-3">
        <span class="hud !text-mgr">Draft a plan with an agent</span>
        <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        {#if speechSupported}
          <button onclick={toggleMic} aria-label="Dictate goal" class="grid h-11 w-11 flex-none place-items-center rounded-xl border transition active:scale-95 {micSession ? 'border-crit bg-crit/15 text-crit glow-crit' : 'border-line bg-raised/60 text-ink2'}" style={micSession ? 'animation:mc-ring 1.4s ease-out infinite' : ''}><Icon name="mic" size={18} /></button>
        {/if}
        <button onclick={() => (drafting = false)} aria-label="Close" class="grid h-11 w-11 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name="close" size={20} /></button>
      </div>
      <textarea bind:value={goal} rows="3" placeholder="What should the plan achieve?" class="min-h-20 w-full resize-y rounded-xl border border-line bg-inset px-4 py-3 text-[16px] leading-relaxed text-ink outline-none transition placeholder:text-ink3 focus:border-mgr/70 noscroll"></textarea>
      <input bind:value={dir} oninput={() => (dirTouched = true)} placeholder="~/path/to/project" class="mt-3 w-full rounded-xl border border-line bg-inset px-4 py-3 font-mono text-[14px] text-ink outline-none transition placeholder:text-ink3 focus:border-mgr/70" />
      {#if mc.knownDirs.length}
        <div class="mt-2 flex flex-wrap gap-2">
          {#each mc.knownDirs as d}
            <button onclick={() => { dir = d; dirTouched = true; }} class="min-h-[40px] rounded-xl border px-3 py-1.5 font-mono text-[12px] transition active:scale-95 {d === dir ? 'border-mgr/60 bg-mgr/12 text-mgr' : 'border-line bg-raised/60 text-ink2'}">{d.split('/').filter(Boolean).pop() || d}</button>
          {/each}
        </div>
      {/if}
      <div class="mt-3 flex items-center gap-3">
        <select bind:value={model} class="min-h-[48px] flex-1 rounded-xl border border-line2 bg-raised px-4 py-3 text-[15px] text-ink outline-none transition focus:border-mgr/70">
          {#each models as m}<option value={m.flag}>{m.label}</option>{/each}
        </select>
        <button onclick={launchDraft} class="min-h-[48px] rounded-xl bg-mgr px-5 font-mono text-[13px] font-bold uppercase tracking-[0.14em] text-[#160f2e] transition active:scale-95">Draft</button>
      </div>
      <p class="mt-3 font-mono text-[11.5px] leading-relaxed text-ink3">Launches one agent in read-only plan mode. It explores the project, drafts the plan, and the plan file appears here — nothing gets built until you say so.</p>
    </div>
  </div>
{/if}
