<script>
  // Unmissable but non-modal connection banner. Shown whenever the panel is not
  // fully linked (host streaming), with an honest seconds-since-last-data count.
  import { mc, dataAge } from '../lib/store.svelte.js';
  import Icon from './Icon.svelte';

  const age = $derived(dataAge());
  const state = $derived(
    mc.link === 'offline'
      ? { cls: 'border-crit/40 bg-crit/12 text-crit', msg: 'Offline — reconnecting…' }
      : { cls: 'border-warn/40 bg-warn/12 text-warn', msg: 'Relay connected — your Mac is quiet or offline' },
  );
</script>

{#if mc.link !== 'linked'}
  <div class="border-b px-4 py-2.5 sm:px-6 {state.cls}" role="status">
    <div class="mx-auto flex max-w-[1400px] items-center gap-2.5">
      <Icon name="alert" size={17} class="flex-none" />
      <span class="min-w-0 flex-1 truncate text-[14px] font-semibold">{state.msg}</span>
      {#if age !== null}
        <span class="flex-none font-mono text-[13px] tabular-nums opacity-90">last data {age}s ago</span>
      {:else}
        <span class="flex-none font-mono text-[13px] opacity-90">no data yet</span>
      {/if}
    </div>
  </div>
{/if}
