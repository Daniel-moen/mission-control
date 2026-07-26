<script>
  // Desktop sidebar: brand + link state, section nav, the live agent roster,
  // and the actions that must always be in reach (Launch, voice, settings).
  // The roster IS the navigation — selecting an agent fills the main pane.
  import { mc, fmtInt } from '../lib/store.svelte.js';
  import Roster from './Roster.svelte';
  import Icon from './Icon.svelte';

  let { view, selectedId, onnav, onselect, onLaunch, onSettings, onMic } = $props();

  const link = $derived(
    mc.link === 'linked'
      ? { dot: 'bg-ok', label: 'Linked' }
      : mc.link === 'relay'
        ? { dot: 'bg-warn', label: 'Relay only' }
        : { dot: 'bg-crit', label: 'Offline' },
  );

  const navCls = (on) =>
    `flex h-9 flex-1 items-center justify-center gap-2 rounded-lg text-[13px] font-medium transition ${on ? 'bg-raised text-ink' : 'text-ink2 hover:bg-white/[0.04] hover:text-ink'}`;
</script>

<aside class="flex h-full w-[300px] flex-none flex-col border-r border-line bg-surface/50" style="padding-top:var(--sat)">
  <!-- brand + link -->
  <div class="flex items-center gap-2.5 px-4 pt-4 pb-3">
    <span class="relative flex h-2 w-2 flex-none">
      {#if mc.link !== 'linked'}<span class="absolute inline-flex h-full w-full rounded-full {link.dot} opacity-60" style="animation:mc-ping 1.6s cubic-bezier(0,0,0.2,1) infinite"></span>{/if}
      <span class="relative inline-flex h-2 w-2 rounded-full {link.dot}"></span>
    </span>
    <span class="text-[15px] font-semibold tracking-tight">Mission Control</span>
    <span class="ml-auto text-[11px] text-ink3">{link.label}</span>
  </div>

  <!-- section nav -->
  <div class="flex gap-1 px-3 pb-3">
    <button onclick={() => onnav('overview')} class={navCls(view === 'overview' && !selectedId)}>
      <Icon name="pulse" size={16} /> Overview
    </button>
    <button onclick={() => onnav('library')} class={navCls(view === 'library' && !selectedId)}>
      <Icon name="book" size={16} /> Library
    </button>
  </div>

  <div class="mx-3 border-t border-line"></div>

  <!-- roster -->
  <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 noscroll">
    <Roster {selectedId} {onselect} />
  </div>

  <!-- bottom: burn/spend + actions -->
  <div class="border-t border-line px-3 pb-3 pt-2.5" style="padding-bottom:calc(12px + var(--sab))">
    <div class="mb-2.5 flex items-baseline justify-between px-1 font-mono text-[12px] tabular-nums">
      <span class={(mc.summary.tokensPerSec ?? 0) > 0 ? 'text-accent' : 'text-ink3'}>
        {fmtInt(Math.round(mc.summary.tokensPerSec ?? 0))} <span class="text-[10px] text-ink3">tok/s</span>
      </span>
      <span class="text-ink2">${(mc.summary.totalCost ?? 0).toFixed(2)}</span>
    </div>
    <div class="flex items-center gap-1.5">
      <button onclick={onLaunch} class="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-[13.5px] font-semibold text-bg transition active:scale-[0.98]">
        <Icon name="launch" size={16} /> Launch
      </button>
      <button onclick={onMic} aria-label="Voice command" class="grid h-10 w-10 flex-none place-items-center rounded-xl border border-line bg-raised text-ink2 transition hover:text-ink active:scale-95">
        <Icon name="mic" size={18} />
      </button>
      <button onclick={() => (location.hash = '#car')} aria-label="Car mode" class="grid h-10 w-10 flex-none place-items-center rounded-xl border border-line bg-raised text-ink2 transition hover:text-ink active:scale-95">
        <Icon name="car" size={18} />
      </button>
      <button onclick={onSettings} aria-label="Settings" class="grid h-10 w-10 flex-none place-items-center rounded-xl border border-line bg-raised text-ink2 transition hover:text-ink active:scale-95">
        <Icon name="settings" size={17} />
      </button>
    </div>
  </div>
</aside>
