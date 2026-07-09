<script>
  // v8 terminal mirror. Renders the best-available screen (streamed watch-lease
  // buffer with scrollback, else the snapshot tail), scrubbed by cleanScreen.
  // Auto-follows the tail; scrolling up detaches with a "↓ live" jump pill.
  // NEVER blanks on a missed frame — last-known text stays, with an honest
  // staleness age in the chrome.
  import { cleanScreen, mc } from '../lib/store.svelte.js';
  import Icon from './Icon.svelte';

  let {
    text = '', // raw screen text
    at = 0, // timestamp of the last frame (for the staleness age)
    streamed = false, // true when fed by the watch-lease stream
    controllable = true,
    fill = false, // fill parent height (workspace) vs capped height (peek)
  } = $props();

  const MAX_LINES = 500; // render cap — keeps 50-agent boards smooth

  const shown = $derived.by(() => {
    const cleaned = cleanScreen(text) || '';
    if (!cleaned) return '';
    const lines = cleaned.split('\n');
    return lines.length > MAX_LINES ? lines.slice(-MAX_LINES).join('\n') : cleaned;
  });

  const age = $derived(at ? Math.max(0, Math.round((mc.now - at) / 1000)) : null);
  const live = $derived(age !== null && age <= 5);

  let pre = $state();
  let follow = $state(true);

  function onScroll() {
    if (!pre) return;
    follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 48;
  }
  function jumpLive() {
    follow = true;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }

  // Stick to the bottom while new output streams in, unless the user scrolled up.
  $effect(() => {
    shown; // track
    if (!pre || !follow) return;
    requestAnimationFrame(() => pre && follow && (pre.scrollTop = pre.scrollHeight));
  });
</script>

<div
  class="relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-inset {fill ? 'h-full' : ''}"
  style="box-shadow: inset 0 0 60px rgba(8,149,172,0.05), inset 0 1px 0 rgba(147,200,255,0.06)">
  <!-- chrome: staleness, always honest -->
  <div class="flex flex-none items-center gap-2 border-b border-line/60 bg-white/[0.02] px-3.5 py-2">
    <span class="flex items-center gap-1.5">
      <span class="h-2.5 w-2.5 rounded-full border border-line2 bg-raised"></span>
      <span class="h-2.5 w-2.5 rounded-full border border-line2 bg-raised"></span>
      <span class="h-2.5 w-2.5 rounded-full border border-line2 {live ? 'border-accent/60 bg-accent/70' : 'bg-raised'}"></span>
    </span>
    <span class="hud ml-1.5">Terminal</span>
    {#if streamed}<span class="hud rounded border border-line px-1.5 py-px !tracking-[0.12em]">scrollback</span>{/if}
    <span class="flex-1"></span>
    {#if age !== null && shown}
      {#if live}
        <span class="flex items-center gap-1.5 font-mono text-[11px] font-bold tracking-widest text-accent" style="text-shadow:0 0 10px rgba(34,217,238,0.6)">
          <span class="h-1.5 w-1.5 rounded-full bg-accent glow-accent" style="animation:mc-pulse 1.4s steps(2) infinite"></span>LIVE
        </span>
      {:else}
        <span class="font-mono text-[11px] tabular-nums text-ink3">{age < 120 ? `${age}s ago` : `${Math.round(age / 60)}m ago`}</span>
      {/if}
    {/if}
  </div>

  {#if shown}
    <pre
      bind:this={pre}
      onscroll={onScroll}
      class="crt noscroll m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-relaxed text-[#cbd5e3] {fill ? '' : 'max-h-[44vh] min-h-[140px]'}">{shown}</pre>

    {#if !follow}
      <button
        onclick={jumpLive}
        class="absolute bottom-3 left-1/2 flex h-10 -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-bold text-accent-ink shadow-[0_6px_20px_-4px_rgba(34,217,238,0.5)] transition active:scale-95">
        <Icon name="down" size={15} stroke={2.4} /> live
      </button>
    {/if}
  {:else}
    <div class="flex-1 p-4 font-mono text-[13px] text-ink3">
      {#if controllable}Mirror warming up…{:else}This terminal can’t be mirrored (only iTerm2, Terminal.app and WezTerm can).{/if}
    </div>
  {/if}
</div>
