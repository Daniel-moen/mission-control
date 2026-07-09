<script>
  // The amber queue pinned to the top of the board: every agent that needs a
  // human, each as a full-width row with INLINE actions — parsed menu options
  // as tappable buttons, or a reply field with mic — so most asks are answered
  // in one tap without opening the workspace.
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
  <section
    class="anim-rise relative overflow-hidden rounded-[22px] border border-warn/45 bg-gradient-to-b from-warn/[0.1] to-warn/[0.04] backdrop-blur-md"
    style="animation: mc-rise 0.28s cubic-bezier(0.2,0.8,0.2,1), mc-alert 2.8s ease-in-out infinite">
    <!-- hazard tape rail -->
    <span class="hazard absolute inset-y-0 left-0 w-[6px]"></span>
    <div class="flex items-center gap-2.5 border-b border-warn/25 px-5 py-3.5 pl-6">
      <span class="grid h-8 w-8 flex-none place-items-center rounded-xl bg-warn/20 text-warn glow-warn">
        <Icon name="alert" size={17} />
      </span>
      <h2 class="display text-[16px] font-bold uppercase tracking-[0.16em] text-warn">Needs you</h2>
      <span class="rounded-full bg-warn px-2.5 py-0.5 font-mono text-[13px] font-bold tabular-nums text-[#2b1a00]">{items.length}</span>
      <span class="hud ml-auto hidden sm:block !text-warn/70">action required</span>
    </div>

    <div class="flex flex-col divide-y divide-warn/15">
      {#each items as it (it.agent.id)}
        {@const a = it.agent}
        <div class="px-5 py-4 pl-6">
          <!-- who + what -->
          <button onclick={() => onopen(a.id)} class="flex w-full items-center gap-3 text-left">
            <span class="relative flex h-2.5 w-2.5 flex-none">
              <span class="absolute inline-flex h-full w-full rounded-full {it.kind === 'exited' ? 'bg-crit' : 'bg-warn'} opacity-50" style="animation:mc-ping 1.8s cubic-bezier(0,0,0.2,1) infinite"></span>
              <span class="relative inline-flex h-2.5 w-2.5 rounded-full {it.kind === 'exited' ? 'bg-crit/80' : 'bg-warn'}"></span>
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-baseline gap-2">
                <span class="display truncate text-[18px] font-bold tracking-tight">{agentName(a)}</span>
                {#if a.name && a.folder}<span class="hidden truncate font-mono text-[12px] text-ink3 sm:inline">{a.folder}</span>{/if}
                {#if a.isManager}<span class="flex-none rounded-md border border-mgr/50 px-1.5 text-[10px] font-extrabold tracking-wider text-mgr">MGR</span>{/if}
              </span>
              <span class="block truncate text-[14px] {it.kind === 'exited' ? 'text-crit' : 'text-ink2'}">
                {it.kind === 'exited' ? 'Process exited unexpectedly' : it.prompt?.question || a.activity || 'Waiting for your input'}
              </span>
            </span>
            <span class="grid h-11 w-11 flex-none place-items-center rounded-xl border border-line bg-surface text-ink2"><Icon name="chevron" size={18} /></span>
          </button>

          <!-- inline actions: answer without leaving the board -->
          <div class="mt-3 pl-[22px]">
            {#if it.kind === 'exited'}
              <button
                onclick={() => tapKill(a.id)}
                class="flex h-11 items-center gap-2 rounded-xl border px-4 text-[14px] font-semibold transition active:scale-95 {armedKill === a.id ? 'border-crit bg-crit text-white' : 'border-crit/45 bg-crit/8 text-crit'}">
                <Icon name="skull" size={16} />{armedKill === a.id ? 'Tap again to clear' : 'Clear session'}
              </button>
            {:else if it.prompt}
              <PromptControls agent={a} prompt={it.prompt} compact />
            {:else if a.controllable}
              <MicField bind:value={() => drafts[a.id] ?? '', (v) => (drafts[a.id] = v)} placeholder="Reply to {agentName(a)}…" onsubmit={() => sendDraft(a.id)} />
              <div class="mt-2 flex gap-2 overflow-x-auto noscroll">
                {#each ['Continue', 'Yes', 'Looks good'] as q (q)}
                  <button onclick={() => reply(a.id, q)} class="h-10 flex-none rounded-xl border border-line bg-surface px-4 text-[13px] font-semibold text-ink2 transition active:scale-95">{q}</button>
                {/each}
                <button onclick={() => sendKey(a.id, 'enter')} class="h-10 flex-none rounded-xl border border-line bg-surface px-4 text-[13px] font-semibold text-ink2 transition active:scale-95">⏎ Enter</button>
                <button onclick={() => sendKey(a.id, 'esc')} class="h-10 flex-none rounded-xl border border-line bg-surface px-4 text-[13px] font-semibold text-ink3 transition active:scale-95">Esc</button>
              </div>
            {:else}
              <p class="text-[13px] italic text-ink3">Read-only terminal — open the workspace to inspect it.</p>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}
