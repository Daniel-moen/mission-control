<script>
  import { onMount } from 'svelte';
  import { mc, broadcast, reply, agentStatus, agentName } from '../lib/store.svelte.js';
  import { TONE } from '../lib/tone.js';
  import { dictate, speechSupported } from '../lib/speech.js';
  import Icon from './Icon.svelte';

  let { initialTarget = 'all', onclose } = $props();

  // svelte-ignore state_referenced_locally — intentional: the prop only seeds
  // the initial target; the user can retarget freely afterwards.
  let target = $state(initialTarget);
  let text = $state('');
  let session = $state(null);
  const recording = $derived(!!session);

  function start() {
    if (session || !speechSupported) return;
    session = dictate({
      base: text,
      onText: (t) => (text = t),
      onEnd: () => (session = null),
      onError: () => (session = null),
    });
  }
  function stop() {
    if (session) session.stop();
  }
  function toggle() {
    session ? stop() : start();
  }

  function send() {
    stop();
    const t = text.trim();
    if (!t) return;
    const ok = target === 'all' ? broadcast(t) : reply(target, t);
    if (ok) {
      onclose();
    }
  }

  onMount(() => {
    // Open already listening — the point of the button is "tap, then talk".
    start();
    return () => stop();
  });
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-[80] flex flex-col justify-end bg-black/60 backdrop-blur-sm" role="presentation" onclick={onclose}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="panel anim-rise rounded-t-2xl border-x-0 border-b-0 border-t border-t-line px-5 pt-4"
    style="padding-bottom:calc(20px + var(--sab))"
    role="presentation"
    onclick={(e) => e.stopPropagation()}>
    <div class="mx-auto mb-3 h-1 w-10 rounded-full bg-line2"></div>

    <div class="mb-3 flex items-center gap-3">
      <h3 class="flex-1 text-[15px] font-semibold">Voice message</h3>
      {#if recording}<span class="flex items-center gap-1.5 text-[12px] font-medium text-crit"><span class="h-1.5 w-1.5 rounded-full bg-crit" style="animation:mc-pulse 1.2s steps(2) infinite"></span>Listening</span>{/if}
    </div>

    <!-- target selector -->
    <div class="mb-3 flex items-center gap-1.5 overflow-x-auto pb-1 noscroll">
      <button
        onclick={() => (target = 'all')}
        class="min-h-[40px] flex-none rounded-full border px-4 py-2 text-[13px] font-medium transition active:scale-95 {target === 'all' ? 'border-line2 bg-raised text-ink' : 'border-line text-ink2'}">
        All agents
      </button>
      {#each mc.agents as a (a.id)}
        {#if a.controllable}
          <button
            onclick={() => (target = a.id)}
            class="flex min-h-[40px] flex-none items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-medium transition active:scale-95 {target === a.id ? 'border-line2 bg-raised text-ink' : 'border-line text-ink2'}">
            <span class="h-2 w-2 rounded-full {TONE[agentStatus(a)].dot}"></span>{agentName(a)}
          </button>
        {/if}
      {/each}
    </div>

    <!-- live transcript -->
    <textarea
      bind:value={text}
      rows="3"
      placeholder={recording ? 'Listening… speak now' : 'Type or tap the mic to speak'}
      class="mb-4 max-h-[38vh] min-h-[104px] w-full resize-none rounded-xl border bg-inset px-4 py-3.5 text-[16px] leading-relaxed text-ink outline-none transition placeholder:text-ink3 noscroll {recording ? 'border-crit/40' : 'border-line focus:border-line2'}"></textarea>

    <div class="flex items-center gap-4">
      {#if speechSupported}
        <button
          onclick={toggle}
          aria-label={recording ? 'Stop dictation' : 'Start dictation'}
          class="relative grid h-16 w-16 flex-none place-items-center rounded-full border transition active:scale-95 {recording
            ? 'border-crit bg-crit/12 text-crit'
            : 'border-line bg-raised text-ink2'}"
          style={recording ? 'animation: mc-ring 1.5s ease-out infinite' : ''}>
          <Icon name="mic" size={28} stroke={2.2} />
        </button>
      {/if}
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-medium {recording ? 'text-crit' : 'text-ink2'}">
          {recording ? 'Recording' : 'Ready'}
        </div>
        <div class="mt-0.5 truncate text-[12.5px] text-ink3">
          {target === 'all' ? 'Broadcasting to every agent' : 'Sending to ' + (agentName(mc.agents.find((a) => a.id === target)) || 'agent')}
        </div>
      </div>
      <button
        onclick={send}
        disabled={!text.trim()}
        class="flex min-h-[52px] flex-none items-center gap-2 rounded-xl bg-ink px-6 py-3.5 text-[14px] font-semibold text-bg transition active:scale-95 disabled:opacity-40">
        <Icon name="send" size={18} />Send
      </button>
    </div>
  </div>
</div>
