<script>
  // Car mode — manage the fleet with your eyes on the road. Hash-routed (#car)
  // like TV mode. Design rules: one thing at a time, giant tap targets, huge
  // type, voice everywhere. New "needs you" items are ANNOUNCED out loud
  // (speech synthesis) so you don't have to look; menu options become a few
  // enormous buttons; the mic is tap-to-talk, tap-again-to-send.
  import { onMount } from 'svelte';
  import { mc, attentionList, agentName, counts, reply, sendKey, kill, broadcast, fmtInt } from '../lib/store.svelte.js';
  import { dictate, speechSupported } from '../lib/speech.js';
  import Icon from './Icon.svelte';

  let { onclose } = $props();

  const items = $derived(attentionList(mc.agents));
  const c = $derived(counts(mc.agents));

  let idx = $state(0);
  const cur = $derived(items.length ? items[Math.min(idx, items.length - 1)] : null);
  $effect(() => {
    if (idx > 0 && idx >= items.length) idx = Math.max(0, items.length - 1);
  });

  const link = $derived(mc.link === 'linked' ? 'bg-ok' : mc.link === 'relay' ? 'bg-warn' : 'bg-crit');

  // ---- spoken announcements -------------------------------------------------
  // Every agent that newly needs you gets read aloud once. The set prunes when
  // an item clears so a RE-ask later announces again.
  let voiceOn = $state(true);
  const announced = new Set();
  function speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch {}
  }
  $effect(() => {
    for (const it of items) {
      if (announced.has(it.agent.id)) continue;
      announced.add(it.agent.id);
      if (voiceOn)
        speak(
          `${agentName(it.agent)} needs you. ` +
            (it.kind === 'exited' ? 'The process exited.' : it.prompt?.question || it.agent.activity || 'Waiting for your input.'),
        );
    }
    const ids = new Set(items.map((i) => i.agent.id));
    for (const id of [...announced]) if (!ids.has(id)) announced.delete(id);
  });

  // ---- tap-to-talk ----------------------------------------------------------
  // Tap mic → listening. Tap again → stop AND send (to the current agent, or
  // broadcast when the road is clear). Discard button for misfires.
  let micSess = $state(null);
  let draft = $state('');
  let discard = false;
  function doSend(text) {
    const t = text.trim();
    if (!t) return;
    if (cur) reply(cur.agent.id, t);
    else broadcast(t);
  }
  function toggleMic() {
    if (micSess) {
      micSess.stop(); // onEnd fires and sends
      return;
    }
    discard = false;
    draft = '';
    micSess = dictate({
      base: '',
      onText: (t) => (draft = t),
      onEnd: () => {
        micSess = null;
        if (!discard) doSend(draft);
        draft = '';
      },
      onError: () => (micSess = null),
    });
  }
  function discardMic() {
    discard = true;
    micSess?.stop();
    draft = '';
  }

  function pick(n) {
    sendKey(cur.agent.id, String(n));
  }

  onMount(() => {
    // Keep the screen awake while driving — best effort.
    let lock = null;
    const acquire = async () => {
      try { lock = await navigator.wakeLock?.request('screen'); } catch {}
    };
    const onVis = () => document.visibilityState === 'visible' && acquire();
    const onKey = (e) => e.key === 'Escape' && onclose?.();
    acquire();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('keydown', onKey);
      try { speechSynthesis.cancel(); } catch {}
      lock?.release?.().catch?.(() => {});
    };
  });
</script>

<div class="fixed inset-0 z-[78] flex flex-col bg-bg" style="padding-top:var(--sat);padding-bottom:var(--sab)">
  <!-- top bar: exit, status, voice toggle — all huge -->
  <header class="flex flex-none items-center gap-3 px-4 pt-3 pb-2">
    <button onclick={onclose} class="flex h-16 items-center gap-2 rounded-2xl border border-line bg-raised px-5 text-[17px] font-semibold text-ink2 transition active:scale-95 landscape:h-12 landscape:px-4 landscape:text-[15px]">
      <Icon name="close" size={22} /> Exit
    </button>
    <div class="min-w-0 flex-1 text-center">
      <div class="flex items-center justify-center gap-2.5 text-[17px] font-semibold tabular-nums">
        <span class="h-2.5 w-2.5 rounded-full {link}"></span>
        {#if c.working}<span class="text-accent">{c.working} working</span>{/if}
        {#if items.length}<span class="text-warn">{items.length} need{items.length === 1 ? 's' : ''} you</span>{/if}
        {#if !c.working && !items.length}<span class="text-ink2">{mc.agents.length ? 'All quiet' : 'No agents'}</span>{/if}
      </div>
      <div class="mt-1 font-mono text-[13px] tabular-nums text-ink3">{fmtInt(Math.round(mc.summary.tokensPerSec ?? 0))} tok/s · ${(mc.summary.totalCost ?? 0).toFixed(2)}</div>
    </div>
    <button
      onclick={() => (voiceOn = !voiceOn)}
      aria-pressed={voiceOn}
      aria-label="Spoken announcements"
      class="grid h-16 w-16 flex-none place-items-center rounded-2xl border transition active:scale-95 landscape:h-12 landscape:w-12 {voiceOn ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line bg-raised text-ink3'}">
      <Icon name={voiceOn ? 'speaker' : 'mute'} size={26} />
    </button>
  </header>

  <!-- one thing at a time -->
  <main class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-3 noscroll">
    {#if cur}
      {@const a = cur.agent}
      <!-- who + navigation between asks -->
      <div class="flex flex-none items-center gap-3 py-2">
        {#if items.length > 1}
          <button onclick={() => (idx = (idx - 1 + items.length) % items.length)} aria-label="Previous" class="grid h-16 w-16 flex-none place-items-center rounded-2xl border border-line bg-raised text-ink2 transition active:scale-95 landscape:h-12 landscape:w-12"><Icon name="back" size={26} /></button>
        {/if}
        <div class="min-w-0 flex-1 text-center">
          <div class="truncate text-[30px] font-bold tracking-tight landscape:text-[22px]">{agentName(a)}</div>
          {#if items.length > 1}<div class="mt-0.5 text-[14px] tabular-nums text-ink3 landscape:mt-0 landscape:text-[12px]">{Math.min(idx, items.length - 1) + 1} of {items.length}</div>{/if}
        </div>
        {#if items.length > 1}
          <button onclick={() => (idx = (idx + 1) % items.length)} aria-label="Next" class="grid h-16 w-16 flex-none place-items-center rounded-2xl border border-line bg-raised text-ink2 transition active:scale-95 landscape:h-12 landscape:w-12"><Icon name="chevron" size={26} /></button>
        {/if}
      </div>

      <p class="flex-none px-1 py-2 text-center text-[22px] font-medium leading-snug text-warn landscape:py-1 landscape:text-[17px]">
        {cur.kind === 'exited' ? 'Process exited unexpectedly' : cur.prompt?.question || a.activity || 'Waiting for your input'}
      </p>

      <div class="mt-2 grid flex-1 content-end gap-3 landscape:grid-cols-2">
        {#if micSess || draft}
          <!-- live transcript while talking -->
          <div class="rounded-2xl border border-crit/40 bg-crit/[0.06] px-5 py-4 text-[20px] leading-snug text-ink landscape:col-span-2">
            {draft || 'Listening…'}
          </div>
        {:else if cur.kind === 'exited'}
          <button onclick={() => kill(a.id)} class="min-h-[84px] rounded-2xl border border-crit/50 bg-crit/10 text-[22px] font-semibold text-crit transition active:scale-[0.98] landscape:col-span-2 landscape:min-h-[64px]">Clear session</button>
        {:else if cur.prompt}
          {#each cur.prompt.options.slice(0, 6) as o (o.n)}
            <button onclick={() => pick(o.n)} class="flex min-h-[76px] items-center gap-4 rounded-2xl border border-line bg-surface px-6 text-left transition hover:border-line2 active:scale-[0.98] landscape:min-h-[60px] landscape:gap-3 landscape:px-4">
              <span class="grid h-11 w-11 flex-none place-items-center rounded-xl bg-raised font-mono text-[20px] font-bold text-ink2 landscape:h-9 landscape:w-9 landscape:text-[16px]">{o.n}</span>
              <span class="min-w-0 flex-1 truncate text-[21px] font-medium landscape:text-[17px]">{o.label}</span>
            </button>
          {/each}
        {:else}
          <button onclick={() => reply(a.id, 'Yes')} class="min-h-[84px] rounded-2xl border border-line bg-surface text-[24px] font-semibold transition active:scale-[0.98] landscape:min-h-[64px] landscape:text-[19px]">Yes</button>
          <button onclick={() => reply(a.id, 'Continue')} class="min-h-[84px] rounded-2xl border border-line bg-surface text-[24px] font-semibold transition active:scale-[0.98] landscape:min-h-[64px] landscape:text-[19px]">Continue</button>
          <button onclick={() => sendKey(a.id, 'enter')} class="min-h-[68px] rounded-2xl border border-line bg-surface text-[20px] font-medium text-ink2 transition active:scale-[0.98] landscape:col-span-2 landscape:min-h-[56px] landscape:text-[17px]">⏎ Enter</button>
        {/if}
      </div>
    {:else}
      <!-- all clear -->
      <div class="flex flex-1 flex-col items-center justify-center gap-5 text-center">
        <span class="grid h-24 w-24 place-items-center rounded-full border border-ok/30 bg-ok/[0.08]">
          <Icon name="check" size={44} class="text-ok" />
        </span>
        <div>
          <div class="text-[32px] font-bold tracking-tight">All clear</div>
          <div class="mt-2 text-[17px] text-ink3">
            {c.working ? `${c.working} agent${c.working === 1 ? '' : 's'} working — you'll hear it if one needs you.` : 'Nothing needs your attention.'}
          </div>
        </div>
        {#if micSess || draft}
          <div class="w-full max-w-md rounded-2xl border border-crit/40 bg-crit/[0.06] px-5 py-4 text-[20px] leading-snug text-ink">
            {draft || 'Listening…'}
          </div>
        {/if}
      </div>
    {/if}
  </main>

  <!-- the mic: the whole bottom of the screen -->
  {#if speechSupported}
    <footer class="flex flex-none items-center gap-3 px-4 pb-4 pt-1">
      {#if micSess}
        <button onclick={discardMic} class="grid h-24 w-24 flex-none place-items-center rounded-2xl border border-line bg-raised text-ink3 transition active:scale-95 landscape:h-[68px] landscape:w-[68px]" aria-label="Discard">
          <Icon name="close" size={30} />
        </button>
      {/if}
      <button
        onclick={toggleMic}
        class="flex h-24 min-w-0 flex-1 items-center justify-center gap-4 rounded-2xl text-[22px] font-bold transition active:scale-[0.98] landscape:h-[68px] landscape:text-[18px] {micSess
          ? 'bg-crit text-white'
          : 'bg-ink text-bg'}"
        style={micSess ? 'animation: mc-ring 1.5s ease-out infinite' : ''}>
        <Icon name="mic" size={32} stroke={2.2} />
        {micSess ? 'Tap to send' : cur ? `Reply to ${agentName(cur.agent)}` : 'Speak to all agents'}
      </button>
    </footer>
  {/if}
</div>
