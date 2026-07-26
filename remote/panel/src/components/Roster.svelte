<script>
  // The agent roster — the app's spine. A compact, scannable list (not cards):
  // agents needing you sort first and wear amber, fleets group with their
  // workers indented under a violet header, everyone else follows by urgency.
  // Used as the desktop sidebar list AND the phone's home list.
  import { mc, agentStatus, statusLabel, agentName, fmtInt, groupFleets, fleetMembers, fleetProgress } from '../lib/store.svelte.js';
  import { TONE } from '../lib/tone.js';
  import Icon from './Icon.svelte';

  let { selectedId = null, onselect } = $props();

  let q = $state('');
  const match = (a) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return [agentName(a), a.folder, a.branch, a.activity].some((v) => String(v || '').toLowerCase().includes(s));
  };

  const ORDER = { waiting: 0, exited: 1, working: 2, done: 3 };

  // Fleets with ≥2 members keep their grouping; smaller "fleets" fold into the
  // flat list. Solo agents sort by how much they need a human.
  const grouped = $derived.by(() => {
    const { groups, solo } = groupFleets(mc.agents, mc.fleets);
    const fleets = [];
    const singles = [...solo];
    for (const g of groups) {
      if (fleetMembers(g).length >= 2) fleets.push(g);
      else singles.push(...fleetMembers(g));
    }
    singles.sort((a, b) => (ORDER[agentStatus(a)] ?? 9) - (ORDER[agentStatus(b)] ?? 9));
    return { fleets, singles };
  });
  const fleets = $derived(grouped.fleets.filter((g) => fleetMembers(g).some(match)));
  const singles = $derived(grouped.singles.filter(match));
  const empty = $derived(!fleets.length && !singles.length);

  const fleetTitle = (g) =>
    g.fleet?.title || (g.manager && agentName(g.manager)) || g.fleet?.dir?.split('/').filter(Boolean).pop() || 'Fleet';
</script>

{#snippet row(a, indent)}
  {@const st = agentStatus(a)}
  {@const t = TONE[st]}
  {@const on = a.id === selectedId}
  <button
    onclick={() => onselect(a.id)}
    class="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition {indent ? 'ml-3 w-[calc(100%-12px)]' : ''} {on
      ? 'bg-raised'
      : st === 'waiting'
        ? 'bg-warn/[0.07] hover:bg-warn/[0.1]'
        : 'hover:bg-white/[0.04]'}">
    <span class="relative flex h-2 w-2 flex-none">
      {#if st === 'working'}
        <span class="absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" style="animation:mc-ping 1.6s cubic-bezier(0,0,0.2,1) infinite"></span>
      {/if}
      <span class="relative inline-flex h-2 w-2 rounded-full {t.dot}"></span>
    </span>
    <span class="min-w-0 flex-1">
      <span class="flex items-baseline gap-1.5">
        <span class="truncate text-[13.5px] font-medium {st === 'done' || st === 'exited' ? 'text-ink2' : 'text-ink'}">{agentName(a)}</span>
        {#if a.isManager}<span class="flex-none text-[9px] font-semibold tracking-wide text-mgr">MGR</span>{/if}
      </span>
      <span class="block truncate text-[11.5px] leading-tight {st === 'waiting' ? 'text-warn' : 'text-ink3'}">
        {st === 'waiting' ? (a.activity || 'Waiting for your input') : st === 'exited' ? 'Process exited' : a.activity || '—'}
      </span>
    </span>
    {#if st === 'working' && (a.tokensPerSec ?? 0) > 0}
      <span class="flex-none font-mono text-[10.5px] tabular-nums text-ink3">{fmtInt(Math.round(a.tokensPerSec))}<span class="opacity-60"> t/s</span></span>
    {:else if st === 'waiting'}
      <span class="grid h-4.5 w-4.5 flex-none place-items-center rounded-full bg-warn/15 text-[10px] font-bold text-warn">!</span>
    {/if}
  </button>
{/snippet}

<div class="flex min-h-0 flex-col">
  {#if mc.agents.length > 6}
    <div class="px-2 pb-2">
      <input
        bind:value={q}
        placeholder="Search…"
        class="h-8 w-full rounded-lg border border-line bg-inset px-3 text-[13px] outline-none transition placeholder:text-ink3 focus:border-line2" />
    </div>
  {/if}

  {#if empty}
    <div class="px-4 py-8 text-center">
      <div class="text-[13px] font-medium text-ink2">{mc.agents.length ? 'No matches' : 'No agents running'}</div>
      <div class="mt-1 text-[12px] text-ink3">{mc.agents.length ? 'Try a different search.' : 'Launch one — it appears here automatically.'}</div>
    </div>
  {/if}

  {#each fleets as g (g.id)}
    {@const prog = fleetProgress(g)}
    <div class="mt-1 mb-0.5 flex items-baseline gap-2 px-2.5 pt-2">
      <span class="truncate text-[11px] font-semibold tracking-wide text-mgr">{fleetTitle(g)}</span>
      {#if prog}<span class="ml-auto flex-none font-mono text-[10px] tabular-nums text-ink3">{prog.done}/{prog.total}</span>{/if}
    </div>
    <div class="flex flex-col gap-px">
      {#if g.manager}{@render row(g.manager, false)}{/if}
      {#each g.workers as w (w.id)}{@render row(w, true)}{/each}
    </div>
  {/each}

  {#if singles.length}
    {#if fleets.length}
      <div class="mt-2 mb-0.5 px-2.5 pt-2 text-[11px] font-semibold tracking-wide text-ink3">Agents</div>
    {/if}
    <div class="flex flex-col gap-px {fleets.length ? '' : 'mt-1'}">
      {#each singles as a (a.id)}{@render row(a, false)}{/each}
    </div>
  {/if}
</div>
