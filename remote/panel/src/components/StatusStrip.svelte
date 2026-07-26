<script>
  // Phone header: connection, name, a compact status readout, settings.
  // (Desktop has the sidebar instead — this only renders on phones.)
  import { mc, counts, fmtInt } from '../lib/store.svelte.js';
  import Icon from './Icon.svelte';

  let { onSettings } = $props();

  const c = $derived(counts(mc.agents));

  const link = $derived(
    mc.link === 'linked' ? 'bg-ok' : mc.link === 'relay' ? 'bg-warn' : 'bg-crit',
  );
</script>

<header class="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-xl" style="padding-top:var(--sat)">
  <div class="flex h-13 items-center gap-2.5 px-4">
    <span class="relative flex h-2 w-2 flex-none">
      {#if mc.link !== 'linked'}<span class="absolute inline-flex h-full w-full rounded-full {link} opacity-60" style="animation:mc-ping 1.6s cubic-bezier(0,0,0.2,1) infinite"></span>{/if}
      <span class="relative inline-flex h-2 w-2 rounded-full {link}"></span>
    </span>
    <span class="text-[15px] font-semibold tracking-tight">Mission Control</span>

    <span class="min-w-2 flex-1"></span>

    <!-- compact status readout -->
    <span class="flex items-baseline gap-2.5 text-[12px] tabular-nums">
      {#if c.working}<span class="font-semibold text-accent">{c.working}<span class="ml-1 font-normal text-ink3">working</span></span>{/if}
      {#if c.waiting}<span class="font-semibold text-warn">{c.waiting}<span class="ml-1 font-normal text-ink3">need you</span></span>{/if}
      {#if !c.working && !c.waiting}<span class="text-ink3">{mc.agents.length ? 'all quiet' : 'no agents'}</span>{/if}
    </span>

    <button onclick={onSettings} aria-label="Settings" class="grid h-9 w-9 flex-none place-items-center rounded-lg text-ink3 transition hover:bg-raised hover:text-ink2">
      <Icon name="settings" size={18} />
    </button>
  </div>
</header>
