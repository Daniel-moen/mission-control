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
<div class="fixed inset-0 z-[80] flex flex-col justify-end bg-black/55 backdrop-blur-sm" role="presentation" onclick={onclose}>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="panel anim-rise rounded-t-[28px] border-x-0 border-b-0 border-t border-t-line2 px-5 pt-4"
    style="padding-bottom:calc(20px + var(--sab))"
    role="presentation"
    onclick={(e) => e.stopPropagation()}>
    <div class="mx-auto mb-3 h-1.5 w-11 rounded-full bg-line2"></div>

    <div class="mb-3 flex items-center gap-3">
      <span class="hud !text-accent">Voice uplink</span>
      <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
      {#if recording}<span class="hud flex items-center gap-1.5 !text-crit"><span class="h-1.5 w-1.5 rounded-full bg-crit" style="animation:mc-pulse 1.2s steps(2) infinite"></span>Live</span>{/if}
    </div>

    <!-- target selector -->
    <div class="mb-3 flex items-center gap-2 overflow-x-auto pb-1 noscroll">
      <button
        onclick={() => (target = 'all')}
        class="min-h-[44px] flex-none rounded-full border px-4 py-2 font-mono text-[13px] font-semibold transition active:scale-95 {target === 'all' ? 'border-accent/60 bg-accent/15 text-accent glow-accent' : 'border-line text-ink2'}">
        All agents
      </button>
      {#each mc.agents as a (a.id)}
        {#if a.controllable}
          <button
            onclick={() => (target = a.id)}
            class="flex min-h-[44px] flex-none items-center gap-2 rounded-full border px-4 py-2 font-mono text-[13px] font-semibold transition active:scale-95 {target === a.id ? 'border-accent/60 bg-accent/15 text-accent glow-accent' : 'border-line text-ink2'}">
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
      class="mb-4 max-h-[38vh] min-h-[104px] w-full resize-none rounded-2xl border bg-inset px-4 py-3.5 font-mono text-[17px] leading-relaxed text-ink outline-none transition placeholder:text-ink3 noscroll {recording ? 'border-accent/50 shadow-[0_0_0_1px_rgba(34,217,238,0.2),inset_0_0_36px_-18px_rgba(34,217,238,0.35)]' : 'border-line focus:border-accent/70'}"></textarea>

    <div class="flex items-center gap-4">
      {#if speechSupported}
        <!-- the mic: glassy disc that pulses + glows while listening -->
        <button
          onclick={toggle}
          aria-label={recording ? 'Stop dictation' : 'Start dictation'}
          class="relative grid h-[68px] w-[68px] flex-none place-items-center rounded-full border-2 backdrop-blur transition active:scale-95 {recording
            ? 'border-crit bg-crit/15 text-crit glow-crit'
            : 'border-accent/60 bg-accent/10 text-accent glow-accent'}"
          style={recording ? 'animation: mc-ring 1.5s ease-out infinite' : 'animation: mc-glow 2.6s ease-in-out infinite'}>
          {#if recording}
            <span class="absolute inset-[-2px] rounded-full border-2 border-crit/60" style="animation:mc-ping 1.5s cubic-bezier(0,0,0.2,1) infinite"></span>
          {/if}
          <span class={recording ? 'inline-grid place-items-center' : ''} style={recording ? 'animation:mc-pulse 1.5s ease-in-out infinite' : ''}>
            <Icon name="mic" size={30} stroke={2.2} />
          </span>
        </button>
      {/if}
      <div class="min-w-0 flex-1">
        <div class="hud {recording ? '!text-crit' : '!text-ink2'}">
          {recording ? 'Recording' : 'Ready'}
        </div>
        <div class="mt-1 truncate font-mono text-[12px] text-ink3">
          {target === 'all' ? 'Broadcasting to every agent' : 'Sending to ' + (agentName(mc.agents.find((a) => a.id === target)) || 'agent')}
        </div>
      </div>
      <button
        onclick={send}
        disabled={!text.trim()}
        class="flex min-h-[56px] flex-none items-center gap-2 rounded-2xl bg-accent px-6 py-4 font-mono text-[14px] font-bold uppercase tracking-[0.14em] text-accent-ink shadow-[0_0_28px_-4px_rgba(34,217,238,0.55)] transition active:scale-95 disabled:opacity-40 disabled:shadow-none">
        <Icon name="send" size={19} />Send
      </button>
    </div>
  </div>
</div>
