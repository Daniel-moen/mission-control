<script>
  // Information-rich fleet card, flight-deck styling: glass panel, luminous
  // status rail, display-type name, mono telemetry. Fixed-slot layout
  // (activity always two lines, meta rows always present) so the 1 Hz
  // snapshot never reflows the grid.
  import { agentStatus, statusLabel, agentName, fmtTokens, fmtInt, fmtMem, sparkOf, mc } from '../lib/store.svelte.js';
  import { TONE } from '../lib/tone.js';
  import Sparkline from './Sparkline.svelte';
  import Icon from './Icon.svelte';

  let { agent, onopen } = $props();

  const cls = $derived(agentStatus(agent));
  const t = $derived(TONE[cls]);
  const todos = $derived(agent.todos || []);
  const doneCount = $derived(todos.filter((td) => td.status === 'completed').length);
  const pct = $derived(todos.length ? Math.round((100 * doneCount) / todos.length) : null);
  // reads refresh with each snapshot tick
  const spark = $derived((mc.lastSnapshotAt, sparkOf(agent.id)));
  const hasSys = $derived(typeof agent.cpu === 'number');
</script>

<button
  onclick={() => onopen(agent.id)}
  class="panel panel-hover group relative flex w-full flex-col gap-3 overflow-hidden rounded-[22px] p-5 pl-7 text-left transition duration-150 active:scale-[0.985] {t.ring} {t.halo}">
  <!-- luminous status rail -->
  <span class="absolute inset-y-0 left-0 w-[4px] {t.edge}"></span>

  <!-- header: dot + name + status -->
  <div class="flex items-center gap-2.5">
    <span class="relative flex h-2.5 w-2.5 flex-none">
      {#if cls === 'working'}
        <span class="absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" style="animation:mc-ping 1.5s cubic-bezier(0,0,0.2,1) infinite"></span>
      {/if}
      <span class="relative inline-flex h-2.5 w-2.5 rounded-full {t.dot}"></span>
    </span>
    <span class="display min-w-0 flex-1 truncate text-[19px] font-bold leading-tight tracking-tight">{agentName(agent)}</span>
    {#if agent.isManager}
      <span class="hud flex-none rounded-md border border-mgr/50 px-1.5 py-0.5 !text-mgr">MGR</span>
    {/if}
    <span class="flex-none rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] {t.chip}">{statusLabel(cls)}</span>
  </div>

  <!-- folder + branch -->
  <div class="-mt-1 flex min-w-0 items-center gap-2 font-mono text-[12px] text-ink3">
    {#if agent.name && agent.folder}<span class="truncate">{agent.folder}</span>{/if}
    {#if agent.branch}
      <span class="flex min-w-0 flex-none items-center gap-1 rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 text-ink2">
        <Icon name="branch" size={11} /><span class="max-w-[140px] truncate">{agent.branch}</span>
      </span>
    {/if}
  </div>

  <!-- current activity (fixed two-line slot) -->
  <p class="line-clamp-2 min-h-[2.6em] break-words [overflow-wrap:anywhere] font-mono text-[13px] leading-snug {cls === 'working' ? 'text-ink' : cls === 'waiting' ? 'text-warn' : 'text-ink3'}">
    {agent.activity || '—'}
  </p>

  <!-- todo progress: glowing head on the fill -->
  {#if pct !== null}
    <div class="flex items-center gap-3">
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-inset">
        <div class="h-full rounded-full bg-gradient-to-r from-accent/40 to-accent transition-[width] duration-500" style="width:{pct}%; box-shadow: 0 0 10px rgba(34,217,238,0.5)"></div>
      </div>
      <span class="font-mono text-[11px] tabular-nums text-ink3">{doneCount}/{todos.length}</span>
    </div>
  {/if}

  <!-- meta: runtime / last-active / cost / burn + sparkline -->
  <div class="flex items-center gap-3 font-mono text-[12px] tabular-nums text-ink3">
    {#if agent.uptime}<span class="flex items-center gap-1"><Icon name="clock" size={12} />{agent.uptime}</span>{/if}
    {#if agent.lastActive && cls !== 'working'}<span class="hidden truncate xl:inline">{agent.lastActive}</span>{/if}
    <span class="text-ink2">${(agent.cost ?? 0).toFixed(2)}</span>
    <span class="min-w-0 flex-1"></span>
    {#if cls === 'working'}
      <Sparkline data={spark} width={54} height={18} color="var(--color-s1)" />
      <span class="text-accent">{fmtInt(Math.round(agent.tokensPerSec ?? 0))} tok/s</span>
    {:else}
      <span>{fmtTokens(agent.tokens ?? 0)} tok</span>
    {/if}
  </div>

  <!-- process chips (newer hosts only) -->
  {#if hasSys}
    <div class="flex items-center gap-2 font-mono text-[11px] tabular-nums text-ink3">
      <span class="flex items-center gap-1 rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5"><Icon name="chip" size={11} />{Math.round(agent.cpu)}%</span>
      {#if typeof agent.mem === 'number'}<span class="rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5">{fmtMem(agent.mem)}</span>{/if}
      {#if agent.pid}<span class="hud hidden opacity-80 sm:inline">pid {agent.pid}</span>{/if}
    </div>
  {/if}
</button>
