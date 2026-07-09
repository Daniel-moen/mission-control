<script>
  // Home = mission control. Order of importance, top to bottom:
  //   attention queue (answer in one tap) → fleets + solo grid → telemetry →
  //   live activity. The status strip above (in App) carries the filter chips.
  import { mc, agentStatus, groupFleets, fleetMembers, agentName } from '../lib/store.svelte.js';
  import AttentionQueue from './AttentionQueue.svelte';
  import AgentCard from './AgentCard.svelte';
  import FleetGroup from './FleetGroup.svelte';
  import Graph from './Graph.svelte';
  import TokenMix from './TokenMix.svelte';
  import ActivityFeed from './ActivityFeed.svelte';
  import Icon from './Icon.svelte';

  let { onopen } = $props();

  let query = $state('');

  function match(a) {
    if (mc.filter !== 'all' && agentStatus(a) !== mc.filter) return false;
    const q = query.trim().toLowerCase();
    if (
      q &&
      !agentName(a).toLowerCase().includes(q) &&
      !String(a.folder).toLowerCase().includes(q) &&
      !String(a.branch || '').toLowerCase().includes(q) &&
      !String(a.activity || '').toLowerCase().includes(q)
    )
      return false;
    return true;
  }

  // Split the fleet into grouped units (manager + workers) and solo agents.
  // A group with a single member is folded back into the solo grid — the fleet
  // chrome only earns its keep once there are ≥2 agents to relate.
  const grouped = $derived.by(() => {
    const { groups, solo } = groupFleets(mc.agents, mc.fleets);
    const fleets = [];
    const singles = [...solo];
    for (const g of groups) {
      if (fleetMembers(g).length >= 2) fleets.push(g);
      else singles.push(...fleetMembers(g));
    }
    return { fleets, singles };
  });

  // Filter: fleets show whole if ANY member matches (keeps the tree coherent);
  // solo agents filter individually.
  const fleets = $derived(grouped.fleets.filter((g) => fleetMembers(g).some(match)));
  const solo = $derived(grouped.singles.filter(match));
  const anyResults = $derived(fleets.length + solo.length > 0);

  // Telemetry earns its space once there's a session to chart.
  const hasSession = $derived((mc.summary.total ?? 0) > 0 || mc.history.length > 1);
</script>

<div class="mx-auto w-full max-w-[1400px] px-4 pt-4 sm:px-6">
  <!-- ATTENTION: pinned above everything -->
  <AttentionQueue {onopen} />

  <!-- search (only useful once the board is busy) -->
  {#if mc.agents.length > 6}
    <div class="mt-4 flex items-center gap-2">
      <input
        bind:value={query}
        placeholder="Search agents, branches, activity…"
        class="panel h-11 w-full max-w-sm rounded-full px-5 font-mono text-[14px] outline-none transition focus:border-accent" />
      {#if mc.filter !== 'all'}
        <button onclick={() => (mc.filter = 'all')} class="h-11 flex-none rounded-full border border-line bg-surface px-4 text-[13px] font-semibold text-ink2">Clear filter ✕</button>
      {/if}
    </div>
  {/if}

  <!-- fleets then solo agents, under HUD section rules -->
  {#if anyResults}
    {#if fleets.length}
      <div class="mt-5 mb-3 flex items-center gap-3">
        <span class="hud">Fleets — {fleets.length}</span>
        <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
      </div>
      <div class="flex flex-col gap-4">
        {#each fleets as g (g.id)}
          <FleetGroup group={g} {onopen} />
        {/each}
      </div>
    {/if}
    {#if solo.length}
      <div class="mt-5 mb-3 flex items-center gap-3">
        <span class="hud">Agents — {solo.length}</span>
        <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
      </div>
      <div class="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {#each solo as agent (agent.id)}
          <AgentCard {agent} {onopen} />
        {/each}
      </div>
    {/if}
  {:else}
    <div class="mt-16 flex flex-col items-center gap-3 text-center">
      <div class="grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface text-ink3">
        <Icon name="fleet" size={26} />
      </div>
      <div class="text-[17px] font-semibold text-ink2">
        {mc.agents.length ? 'No agents match' : 'No agents on the board'}
      </div>
      <div class="max-w-xs text-[14px] text-ink3">
        {mc.agents.length ? 'Try a different filter or search.' : 'Launch one from the dock — it appears here automatically.'}
      </div>
    </div>
  {/if}

  <!-- telemetry: burn timeseries + token economics -->
  {#if hasSession}
    <div class="mt-7 mb-3 flex items-center gap-3">
      <span class="hud">Telemetry</span>
      <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
    </div>
    <div class="grid grid-cols-1 gap-3.5 lg:grid-cols-3">
      <div class="lg:col-span-2"><Graph /></div>
      <div><TokenMix /></div>
    </div>
  {/if}

  {#if mc.activity.length}
    <div class="mt-5">
      <ActivityFeed {onopen} />
    </div>
  {/if}
</div>
