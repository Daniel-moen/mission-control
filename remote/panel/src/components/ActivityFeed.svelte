<script>
  // Live event stream across the whole fleet. The store already records every
  // change to an agent's current activity (see trackActivity); this surfaces it
  // as a scrollable, timestamped feed — the fastest way to see what all your
  // agents are doing without opening each one.
  import { mc, clockOf } from '../lib/store.svelte.js';
  import Icon from './Icon.svelte';

  let { onopen } = $props();

  // newest first, cap the render
  const events = $derived(mc.activity.slice(-60).reverse());

  const liveIds = $derived(new Set(mc.agents.map((a) => a.id)));
</script>

<div class="panel overflow-hidden rounded-[22px]">
  <div class="flex items-center gap-3 border-b border-line/70 px-5 py-3.5">
    <span class="grid h-8 w-8 flex-none place-items-center rounded-xl border border-accent/30 bg-inset text-accent">
      <Icon name="pulse" size={15} />
    </span>
    <span class="hud !text-accent">Live activity</span>
    <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
    <span class="hud flex-none !text-ink2">{events.length} events</span>
  </div>

  {#if events.length}
    <!-- terminal-flavored log: mono rows, hud timestamp gutter -->
    <div class="crt max-h-[320px] overflow-y-auto noscroll">
      {#each events as e, i (e.t + e.folder + i)}
        {@const live = e.id && liveIds.has(e.id)}
        <button
          onclick={() => live && onopen(e.id)}
          class="flex min-h-[44px] w-full items-baseline gap-3 border-b border-line/40 px-5 py-2 text-left transition last:border-0 hover:bg-white/[0.03] {live ? '' : 'cursor-default'}">
          <span class="hud flex-none tabular-nums !tracking-[0.08em]">{clockOf(e.t)}</span>
          <span class="max-w-[34%] flex-none truncate rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 font-mono text-[11px] {live ? 'text-accent' : 'text-ink2'}">{e.who || e.folder}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{e.text}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="px-5 py-10 text-center">
      <div class="hud">Channel quiet</div>
      <div class="mt-2 font-mono text-[12px] text-ink3">Events appear here as agents work.</div>
    </div>
  {/if}
</div>
