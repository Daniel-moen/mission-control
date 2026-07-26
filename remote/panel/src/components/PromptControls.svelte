<script>
  // Interactive-menu controls: when parsePrompt() finds a numbered menu on an
  // agent's RAW screen, render the question + options as big tappable buttons
  // that send single keystrokes. Used full-size in the workspace and compact
  // inside attention-queue rows.
  //   `prompt`  — an already-parsed prompt (the caller ran parsePrompt), or
  //   `screen`  — a raw screen to parse here; falls back to agent.screen.
  import { parsePrompt, sendKey } from '../lib/store.svelte.js';
  import Icon from './Icon.svelte';

  let { agent, screen = null, prompt: given = null, compact = false } = $props();

  const prompt = $derived(given ?? (agent ? parsePrompt(screen ?? agent.screen) : null));

  function pick(n) {
    sendKey(agent.id, String(n));
  }
  function nav(k) {
    sendKey(agent.id, k);
  }
</script>

{#if prompt}
  <section class="anim-rise {compact ? '' : 'rounded-2xl border border-warn/30 bg-warn/[0.05] p-4'}">
    {#if !compact}
      <div class="mb-2.5 flex items-center gap-2">
        <span class="text-[12px] font-semibold text-warn">Waiting on you</span>
      </div>
      {#if prompt.question}
        <p class="mb-3 break-words [overflow-wrap:anywhere] text-[15px] font-semibold leading-snug text-ink">{prompt.question}</p>
      {/if}
    {/if}

    <div class="flex flex-col gap-2">
      {#each prompt.options as o (o.n)}
        {@const chosen = prompt.multi ? o.checked : o.selected}
        {@const cursor = o.selected && !chosen}
        <button
          onclick={() => pick(o.n)}
          class="flex min-h-[46px] items-start gap-3 rounded-xl border px-4 py-3 text-left transition active:scale-[0.99] {chosen ? 'border-accent/60 bg-accent/[0.08]' : cursor ? 'border-line2 bg-raised/50' : 'border-line bg-surface hover:border-line2'}">
          {#if prompt.multi}
            <span class="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-md border text-[13px] font-bold {o.checked ? 'border-accent bg-accent text-accent-ink' : 'border-line2 text-transparent'}">✓</span>
          {:else}
            <span class="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-md font-mono text-[13px] font-semibold {chosen ? 'bg-accent text-accent-ink' : 'bg-raised text-ink2'}">{o.n}</span>
          {/if}
          <span class="min-w-0 flex-1">
            <span class="break-words [overflow-wrap:anywhere] text-[14px] font-medium {chosen ? 'text-accent' : 'text-ink'}">{o.label}</span>
            {#if o.desc && !compact}<span class="mt-0.5 block break-words [overflow-wrap:anywhere] text-[13px] leading-snug text-ink3">{o.desc}</span>{/if}
          </span>
          {#if cursor}<span class="mt-1 flex-none text-[11px] font-medium text-ink3">cursor</span>{/if}
          {#if chosen}<Icon name="chevron" size={16} class="mt-1 flex-none text-accent" />{/if}
        </button>
      {/each}
    </div>

    {#if !compact}
      <p class="mt-2.5 text-[12px] leading-snug text-ink3">
        {#if prompt.multi}Tap options to tick them, then <b class="text-ink2">Submit</b>.{:else}Tap an option to choose it. If it doesn't confirm on its own, press <b class="text-ink2">Select</b>.{/if}
      </p>
    {/if}

    <!-- manual navigation, for multi-select / prompts that need explicit confirm -->
    <div class="mt-2 flex items-center gap-2">
      <button onclick={() => nav('up')} aria-label="Up" class="grid h-10 w-10 place-items-center rounded-lg border border-line bg-surface text-[15px] text-ink2 transition active:scale-90">↑</button>
      <button onclick={() => nav('down')} aria-label="Down" class="grid h-10 w-10 place-items-center rounded-lg border border-line bg-surface text-[15px] text-ink2 transition active:scale-90">↓</button>
      {#if prompt.multi}
        <button onclick={() => nav('space')} class="h-10 rounded-lg border border-line bg-surface px-4 text-[13px] font-medium text-ink2 transition active:scale-95">Toggle</button>
      {/if}
      <button onclick={() => nav('enter')} class="h-10 flex-1 rounded-lg bg-ink px-3 text-[13px] font-semibold text-bg transition active:scale-95">{prompt.multi ? 'Submit ⏎' : 'Select ⏎'}</button>
      <button onclick={() => nav('esc')} class="h-10 rounded-lg border border-line bg-surface px-4 text-[13px] font-medium text-ink3 transition active:scale-95">Esc</button>
    </div>
  </section>
{/if}
