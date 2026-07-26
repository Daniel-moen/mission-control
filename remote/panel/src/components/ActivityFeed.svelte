<script>
  // Live event stream across the whole fleet. The store already records every
  // change to an agent's current activity (see trackActivity); this surfaces it
  // as a scrollable, timestamped feed — the fastest way to see what all your
  // agents are doing without opening each one.
  import { mc, clockOf } from '../lib/store.svelte.js';

  let { onopen } = $props();

  // newest first, cap the render
  const events = $derived(mc.activity.slice(-60).reverse());

  const liveIds = $derived(new Set(mc.agents.map((a) => a.id)));
</script>

<div class="panel overflow-hidden rounded-2xl">
  <div class="flex items-baseline gap-2 border-b border-line px-5 py-3">
    <span class="text-[13px] font-semibold text-ink2">Activity</span>
    <span class="ml-auto text-[12px] tabular-nums text-ink3">{events.length} events</span>
  </div>

  {#if events.length}
    <div class="max-h-[320px] overflow-y-auto noscroll">
      {#each events as e, i (e.t + e.folder + i)}
        {@const live = e.id && liveIds.has(e.id)}
        <button
          onclick={() => live && onopen(e.id)}
          class="flex min-h-[40px] w-full items-baseline gap-3 border-b border-line/50 px-5 py-2 text-left transition last:border-0 hover:bg-white/[0.02] {live ? '' : 'cursor-default'}">
          <span class="flex-none font-mono text-[11px] tabular-nums text-ink3">{clockOf(e.t)}</span>
          <span class="max-w-[34%] flex-none truncate text-[12px] font-medium {live ? 'text-ink' : 'text-ink3'}">{e.who || e.folder}</span>
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink2">{e.text}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="px-5 py-10 text-center">
      <div class="text-[13px] text-ink3">Events appear here as agents work.</div>
    </div>
  {/if}
</div>
