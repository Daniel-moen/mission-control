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
    onexpand = null, // given ⇒ show the button that opens the full-screen console
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

<div class="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-inset {fill ? 'h-full' : ''}">
  <!-- chrome: staleness, always honest -->
  <div class="flex flex-none items-center gap-2 border-b border-line/60 px-3.5 py-2">
    <span class="hud">Terminal</span>
    {#if streamed}<span class="rounded border border-line px-1.5 py-px text-[10px] text-ink3">scrollback</span>{/if}
    <span class="flex-1"></span>
    {#if age !== null && shown}
      {#if live}
        <span class="flex items-center gap-1.5 text-[11px] font-semibold text-accent">
          <span class="h-1.5 w-1.5 rounded-full bg-accent" style="animation:mc-pulse 1.4s steps(2) infinite"></span>Live
        </span>
      {:else}
        <span class="font-mono text-[11px] tabular-nums text-ink3">{age < 120 ? `${age}s ago` : `${Math.round(age / 60)}m ago`}</span>
      {/if}
    {/if}
    {#if onexpand}
      <button
        onclick={onexpand}
        aria-label="Open full-screen console"
        title="Full screen — type straight into this terminal"
        class="-my-1 ml-1 grid h-8 w-8 flex-none place-items-center rounded-lg text-ink3 transition hover:bg-raised hover:text-ink2 active:scale-90">
        <Icon name="expand" size={16} />
      </button>
    {/if}
  </div>

  {#if shown}
    <pre
      bind:this={pre}
      onscroll={onScroll}
      class="noscroll m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-relaxed text-ink2 {fill ? '' : 'max-h-[44vh] min-h-[140px]'}">{shown}</pre>

    {#if !follow}
      <button
        onclick={jumpLive}
        class="absolute bottom-3 left-1/2 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-semibold text-bg shadow-[0_6px_20px_-6px_rgba(0,0,0,0.6)] transition active:scale-95">
        <Icon name="down" size={14} stroke={2.4} /> Live
      </button>
    {/if}
  {:else}
    <div class="flex-1 p-4 font-mono text-[13px] text-ink3">
      {#if controllable}Mirror warming up…{:else}This terminal can’t be mirrored (only iTerm2, Terminal.app and WezTerm can).{/if}
    </div>
  {/if}
</div>
