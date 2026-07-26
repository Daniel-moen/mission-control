<script>
  // Agent card: name + status, what it's doing, progress, and the two numbers
  // that matter (cost, tokens). Fixed-slot layout (activity always two lines)
  // so the 1 Hz snapshot never reflows the grid. Process detail lives in the
  // Data tab, not here.
  import { agentStatus, statusLabel, agentName, fmtTokens, fmtInt, sparkOf, mc } from '../lib/store.svelte.js';
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
</script>

<button
  onclick={() => onopen(agent.id)}
  class="panel panel-hover group relative flex w-full flex-col gap-2.5 rounded-2xl p-4 text-left transition duration-150 active:scale-[0.99] {t.ring}">
  <!-- header: dot + name + status -->
  <div class="flex items-center gap-2.5">
    <span class="relative flex h-2 w-2 flex-none">
      {#if cls === 'working'}
        <span class="absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" style="animation:mc-ping 1.6s cubic-bezier(0,0,0.2,1) infinite"></span>
      {/if}
      <span class="relative inline-flex h-2 w-2 rounded-full {t.dot}"></span>
    </span>
    <span class="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight">{agentName(agent)}</span>
    {#if agent.isManager}
      <span class="flex-none rounded-md border border-mgr/40 px-1.5 py-0.5 text-[10px] font-semibold text-mgr">MGR</span>
    {/if}
    <span class="flex-none rounded-full px-2.5 py-1 text-[11px] font-semibold {t.chip}">{statusLabel(cls)}</span>
  </div>

  <!-- folder + branch -->
  <div class="-mt-0.5 flex min-w-0 items-center gap-2 text-[12px] text-ink3">
    {#if agent.name && agent.folder}<span class="truncate">{agent.folder}</span>{/if}
    {#if agent.branch}
      <span class="flex min-w-0 flex-none items-center gap-1 text-ink3">
        <Icon name="branch" size={11} /><span class="max-w-[140px] truncate font-mono text-[11px]">{agent.branch}</span>
      </span>
    {/if}
  </div>

  <!-- current activity (fixed two-line slot) -->
  <p class="line-clamp-2 min-h-[2.7em] break-words [overflow-wrap:anywhere] text-[13px] leading-snug {cls === 'working' ? 'text-ink' : cls === 'waiting' ? 'text-warn' : 'text-ink3'}">
    {agent.activity || '—'}
  </p>

  <!-- todo progress -->
  {#if pct !== null}
    <div class="flex items-center gap-3">
      <div class="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div class="h-full rounded-full bg-accent transition-[width] duration-500" style="width:{pct}%"></div>
      </div>
      <span class="font-mono text-[11px] tabular-nums text-ink3">{doneCount}/{todos.length}</span>
    </div>
  {/if}

  <!-- meta: runtime / cost / burn + sparkline -->
  <div class="flex items-center gap-3 font-mono text-[12px] tabular-nums text-ink3">
    {#if agent.uptime}<span>{agent.uptime}</span>{/if}
    <span class="text-ink2">${(agent.cost ?? 0).toFixed(2)}</span>
    <span class="min-w-0 flex-1"></span>
    {#if cls === 'working'}
      <Sparkline data={spark} width={54} height={16} color="var(--color-accent)" />
      <span class="text-accent">{fmtInt(Math.round(agent.tokensPerSec ?? 0))} tok/s</span>
    {:else}
      <span>{fmtTokens(agent.tokens ?? 0)} tok</span>
    {/if}
  </div>
</button>
