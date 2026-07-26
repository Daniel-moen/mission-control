<script>
  // Pinned to the top of the board: every agent that needs a human, each as a
  // full-width row with INLINE actions — parsed menu options as tappable
  // buttons, or a reply field with mic — so most asks are answered in one tap
  // without opening the workspace.
  import { mc, attentionList, agentName, reply, kill, sendKey } from '../lib/store.svelte.js';
  import PromptControls from './PromptControls.svelte';
  import MicField from './MicField.svelte';
  import Icon from './Icon.svelte';

  let { onopen } = $props();

  const items = $derived(attentionList(mc.agents));

  // per-row reply drafts, keyed by agent id (kept across snapshot re-renders)
  let drafts = $state({});
  function sendDraft(id) {
    if (reply(id, drafts[id])) drafts[id] = '';
  }

  // two-tap kill for exited rows
  let armedKill = $state(null);
  let armTimer;
  function tapKill(id) {
    if (armedKill === id) {
      clearTimeout(armTimer);
      armedKill = null;
      kill(id);
    } else {
      armedKill = id;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armedKill = null), 3000);
    }
  }
</script>

{#if items.length}
  <section class="anim-rise overflow-hidden rounded-2xl border border-warn/30 bg-warn/[0.05]">
    <div class="flex items-center gap-2.5 border-b border-warn/20 px-5 py-3">
      <span class="grid h-7 w-7 flex-none place-items-center rounded-lg bg-warn/15 text-warn">
        <Icon name="alert" size={15} />
      </span>
      <h2 class="text-[14px] font-semibold text-warn">Needs you</h2>
      <span class="rounded-full bg-warn/15 px-2 py-0.5 text-[12px] font-semibold tabular-nums text-warn">{items.length}</span>
    </div>

    <div class="flex flex-col divide-y divide-warn/10">
      {#each items as it (it.agent.id)}
        {@const a = it.agent}
        <div class="px-5 py-4">
          <!-- who + what -->
          <button onclick={() => onopen(a.id)} class="flex w-full items-center gap-3 text-left">
            <span class="h-2 w-2 flex-none rounded-full {it.kind === 'exited' ? 'bg-crit/80' : 'bg-warn'}"></span>
            <span class="min-w-0 flex-1">
              <span class="flex items-baseline gap-2">
                <span class="truncate text-[15px] font-semibold tracking-tight">{agentName(a)}</span>
                {#if a.name && a.folder}<span class="hidden truncate text-[12px] text-ink3 sm:inline">{a.folder}</span>{/if}
                {#if a.isManager}<span class="flex-none rounded-md border border-mgr/40 px-1.5 text-[10px] font-semibold text-mgr">MGR</span>{/if}
              </span>
              <span class="block truncate text-[13px] {it.kind === 'exited' ? 'text-crit' : 'text-ink2'}">
                {it.kind === 'exited' ? 'Process exited unexpectedly' : it.prompt?.question || a.activity || 'Waiting for your input'}
              </span>
            </span>
            <span class="grid h-9 w-9 flex-none place-items-center rounded-lg text-ink3"><Icon name="chevron" size={16} /></span>
          </button>

          <!-- inline actions: answer without leaving the board -->
          <div class="mt-3 pl-5">
            {#if it.kind === 'exited'}
              <button
                onclick={() => tapKill(a.id)}
                class="flex h-10 items-center gap-2 rounded-xl border px-4 text-[13px] font-semibold transition active:scale-95 {armedKill === a.id ? 'border-crit bg-crit text-white' : 'border-crit/40 text-crit'}">
                {armedKill === a.id ? 'Tap again to clear' : 'Clear session'}
              </button>
            {:else if it.prompt}
              <PromptControls agent={a} prompt={it.prompt} compact />
            {:else if a.controllable}
              <MicField bind:value={() => drafts[a.id] ?? '', (v) => (drafts[a.id] = v)} placeholder="Reply to {agentName(a)}…" onsubmit={() => sendDraft(a.id)} />
              <div class="mt-2 flex gap-2 overflow-x-auto noscroll">
                {#each ['Continue', 'Yes', 'Looks good'] as q (q)}
                  <button onclick={() => reply(a.id, q)} class="h-9 flex-none rounded-lg border border-line bg-surface px-3.5 text-[13px] font-medium text-ink2 transition active:scale-95">{q}</button>
                {/each}
                <button onclick={() => sendKey(a.id, 'enter')} class="h-9 flex-none rounded-lg border border-line bg-surface px-3.5 text-[13px] font-medium text-ink2 transition active:scale-95">⏎ Enter</button>
                <button onclick={() => sendKey(a.id, 'esc')} class="h-9 flex-none rounded-lg border border-line bg-surface px-3.5 text-[13px] font-medium text-ink3 transition active:scale-95">Esc</button>
              </div>
            {:else}
              <p class="text-[13px] text-ink3">Read-only terminal — open the workspace to inspect it.</p>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}
