<script>
  // Car mode — run the fleet with your eyes on the road. Hash-routed (#car).
  // Three screens, one at a time, giant type:
  //   • asks   — an agent needs you: question + enormous numbered buttons
  //   • list   — every agent as a big row; the mic LAUNCHES a new agent by
  //              voice into the selected project chip
  //   • agent  — one agent focused: what it's doing, Stop, mic to reply
  // New "needs you" items are announced out loud (speech synthesis).
  import { onMount, untrack } from 'svelte';
  import {
    mc, attentionList, agentName, agentStatus, statusLabel, counts,
    reply, sendKey, kill, launch, toast, fmtInt, fmtTokens,
  } from '../lib/store.svelte.js';
  import { TONE } from '../lib/tone.js';
  import { dictate, speechSupported } from '../lib/speech.js';
  import { extractDir, dirBase } from '../lib/dirmatch.js';
  import Icon from './Icon.svelte';

  let { onclose } = $props();

  const items = $derived(attentionList(mc.agents));
  const c = $derived(counts(mc.agents));

  let idx = $state(0);
  const cur = $derived(items.length ? items[Math.min(idx, items.length - 1)] : null);
  $effect(() => {
    if (idx > 0 && idx >= items.length) idx = Math.max(0, items.length - 1);
  });

  // ---- which screen ---------------------------------------------------------
  let focus = $state(null); // focused agent id
  let showList = $state(false); // user chose the list over pending asks
  const focused = $derived(focus ? mc.agents.find((a) => a.id === focus) || null : null);
  $effect(() => {
    if (focus && !focused) focus = null; // it left the board
  });
  const screen = $derived(focused ? 'agent' : items.length && !showList ? 'ask' : 'list');
  // When the last ask clears, fall back to the list naturally.
  $effect(() => {
    if (!items.length) showList = false;
  });

  const ORDER = { waiting: 0, exited: 1, working: 2, done: 3 };
  const roster = $derived([...mc.agents].sort((a, b) => (ORDER[agentStatus(a)] ?? 9) - (ORDER[agentStatus(b)] ?? 9)));

  const link = $derived(mc.link === 'linked' ? 'bg-ok' : mc.link === 'relay' ? 'bg-warn' : 'bg-crit');

  // ---- launch target --------------------------------------------------------
  // The project the mic launches into — big chips, remembered across drives.
  const LS_DIR = 'mc_car_dir';
  let dir = $state(untrack(() => {
    try { return localStorage.getItem(LS_DIR) || ''; } catch { return ''; }
  }));
  $effect(() => {
    if (!dir && mc.lastDir) dir = mc.lastDir;
    // A remembered dir the host no longer knows falls back to the last used.
    if (dir && mc.knownDirs.length && !mc.knownDirs.includes(dir)) dir = mc.lastDir || mc.knownDirs[0];
  });
  function setDir(d) {
    dir = d;
    try { localStorage.setItem(LS_DIR, d); } catch {}
  }
  const dirName = $derived(dir ? dir.split('/').filter(Boolean).pop() : '');

  // ---- spoken announcements -------------------------------------------------
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
  // Tap mic → listening. Tap again → stop AND send. What "send" means depends
  // on the screen: reply to the focused agent / the current ask, or LAUNCH a
  // new agent with the spoken mission on the list screen.
  let micSess = $state(null);
  let draft = $state('');
  let discard = false;

  const micTarget = $derived(
    focused ? { kind: 'reply', agent: focused } : screen === 'ask' && cur ? { kind: 'reply', agent: cur.agent } : { kind: 'launch' },
  );

  function doSend(text) {
    const t = text.trim();
    if (!t) return;
    const target = micTarget;
    if (target.kind === 'reply') {
      reply(target.agent.id, t);
      return;
    }
    // The dispatcher: a spoken "… in the cover v3 directory" picks the project
    // itself — fuzzy-matched against the host's known dirs, since dictation
    // garbles folder names. No reference → the selected chip.
    let mission = t;
    let launchDir = dir;
    const ref = extractDir(t, mc.knownDirs);
    if (ref) {
      if (!ref.ok) {
        const msg = `Couldn't find a project called “${ref.phrase}”`;
        toast(msg);
        if (voiceOn) speak(`Couldn't find a project called ${ref.phrase}. Try again.`);
        return;
      }
      launchDir = ref.dir;
      if (ref.cleaned) mission = ref.cleaned;
      setDir(ref.dir); // the chip follows, so the next launch lands there too
    }
    if (!launch({ mission, dir: (launchDir || '').trim(), managerModel: null, workerModels: [''] })) return;
    const name = dirBase(launchDir);
    toast(`Launching agent${name ? ' in ' + name : ''}`);
    if (voiceOn) speak(`Launching agent${name ? ' in ' + name : ''}.`);
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

{#snippet askControls(it)}
  {@const a = it.agent}
  {#if it.kind === 'exited'}
    <button onclick={() => kill(a.id)} class="min-h-[84px] rounded-2xl border border-crit/50 bg-crit/10 text-[22px] font-semibold text-crit transition active:scale-[0.98] landscape:col-span-2 landscape:min-h-[64px]">Clear session</button>
  {:else if it.prompt}
    {#each it.prompt.options.slice(0, 6) as o (o.n)}
      <button onclick={() => sendKey(a.id, String(o.n))} class="flex min-h-[76px] items-center gap-4 rounded-2xl border border-line bg-surface px-6 text-left transition hover:border-line2 active:scale-[0.98] landscape:min-h-[60px] landscape:gap-3 landscape:px-4">
        <span class="grid h-11 w-11 flex-none place-items-center rounded-xl bg-raised font-mono text-[20px] font-bold text-ink2 landscape:h-9 landscape:w-9 landscape:text-[16px]">{o.n}</span>
        <span class="min-w-0 flex-1 truncate text-[21px] font-medium landscape:text-[17px]">{o.label}</span>
      </button>
    {/each}
  {:else}
    <button onclick={() => reply(a.id, 'Yes')} class="min-h-[84px] rounded-2xl border border-line bg-surface text-[24px] font-semibold transition active:scale-[0.98] landscape:min-h-[64px] landscape:text-[19px]">Yes</button>
    <button onclick={() => reply(a.id, 'Continue')} class="min-h-[84px] rounded-2xl border border-line bg-surface text-[24px] font-semibold transition active:scale-[0.98] landscape:min-h-[64px] landscape:text-[19px]">Continue</button>
    <button onclick={() => sendKey(a.id, 'enter')} class="min-h-[68px] rounded-2xl border border-line bg-surface text-[20px] font-medium text-ink2 transition active:scale-[0.98] landscape:col-span-2 landscape:min-h-[56px] landscape:text-[17px]">⏎ Enter</button>
  {/if}
{/snippet}

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

  <main class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-3 noscroll">
    {#if screen === 'ask'}
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
          <div class="rounded-2xl border border-crit/40 bg-crit/[0.06] px-5 py-4 text-[20px] leading-snug text-ink landscape:col-span-2">
            {draft || 'Listening…'}
          </div>
        {:else}
          {@render askControls(cur)}
          <button onclick={() => (showList = true)} class="min-h-[56px] rounded-2xl text-[16px] font-medium text-ink3 transition hover:text-ink2 active:scale-[0.98] landscape:col-span-2 landscape:min-h-[48px]">
            All agents ›
          </button>
        {/if}
      </div>
    {:else if screen === 'agent'}
      {@const st = agentStatus(focused)}
      {@const todos = focused.todos || []}
      {@const done = todos.filter((td) => td.status === 'completed').length}
      <!-- one agent, focused -->
      <div class="flex flex-none items-center gap-3 py-2">
        <button onclick={() => (focus = null)} aria-label="Back to agents" class="grid h-16 w-16 flex-none place-items-center rounded-2xl border border-line bg-raised text-ink2 transition active:scale-95 landscape:h-12 landscape:w-12"><Icon name="back" size={26} /></button>
        <div class="min-w-0 flex-1 text-center">
          <div class="truncate text-[30px] font-bold tracking-tight landscape:text-[22px]">{agentName(focused)}</div>
          <div class="mt-0.5 text-[15px] font-semibold {TONE[st].text} landscape:mt-0 landscape:text-[13px]">{statusLabel(st)}</div>
        </div>
        <span class="w-16 flex-none landscape:w-12"></span>
      </div>

      <p class="flex-none px-1 py-2 text-center text-[20px] font-medium leading-snug landscape:py-1 landscape:text-[16px] {st === 'waiting' ? 'text-warn' : 'text-ink2'}">
        {st === 'exited' ? 'Process exited unexpectedly' : focused.activity || '—'}
      </p>

      {#if todos.length}
        <div class="mx-1 flex flex-none items-center gap-3 py-2">
          <div class="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div class="h-full rounded-full bg-accent transition-[width] duration-500" style="width:{Math.round((100 * done) / todos.length)}%"></div>
          </div>
          <span class="font-mono text-[14px] tabular-nums text-ink3">{done}/{todos.length}</span>
        </div>
      {/if}
      <div class="flex-none py-1 text-center font-mono text-[14px] tabular-nums text-ink3">
        {(st === 'working' ? `${fmtInt(Math.round(focused.tokensPerSec ?? 0))} tok/s · ` : '') + `${fmtTokens(focused.tokens ?? 0)} tok · $${(focused.cost ?? 0).toFixed(2)}`}
      </div>

      <div class="mt-2 grid flex-1 content-end gap-3 landscape:grid-cols-2">
        {#if micSess || draft}
          <div class="rounded-2xl border border-crit/40 bg-crit/[0.06] px-5 py-4 text-[20px] leading-snug text-ink landscape:col-span-2">
            {draft || 'Listening…'}
          </div>
        {:else if st === 'waiting' || st === 'exited'}
          {@render askControls(items.find((i) => i.agent.id === focused.id) || { agent: focused, kind: st === 'exited' ? 'exited' : 'waiting', prompt: null })}
        {:else if st === 'working'}
          <button onclick={() => reply(focused.id, 'Stop')} class="min-h-[76px] rounded-2xl border border-warn/40 bg-warn/[0.08] text-[21px] font-semibold text-warn transition active:scale-[0.98] landscape:col-span-2 landscape:min-h-[60px] landscape:text-[18px]">■ Stop this agent</button>
        {:else}
          <button onclick={() => kill(focused.id)} class="min-h-[68px] rounded-2xl border border-line bg-surface text-[18px] font-medium text-ink2 transition active:scale-[0.98] landscape:col-span-2 landscape:min-h-[56px]">Clear session</button>
        {/if}
      </div>
    {:else}
      <!-- the fleet, big rows -->
      {#if items.length}
        <button onclick={() => { showList = false; focus = null; }} class="mb-2 flex min-h-[60px] flex-none items-center justify-center gap-2 rounded-2xl border border-warn/40 bg-warn/[0.08] text-[18px] font-semibold text-warn transition active:scale-[0.98]">
          {items.length} need{items.length === 1 ? 's' : ''} you ›
        </button>
      {/if}

      {#if roster.length}
        <div class="flex flex-col gap-2">
          {#each roster as a (a.id)}
            {@const st = agentStatus(a)}
            <button
              onclick={() => (focus = a.id)}
              class="flex min-h-[72px] items-center gap-4 rounded-2xl border px-5 py-3 text-left transition active:scale-[0.99] landscape:min-h-[60px] {st === 'waiting' ? 'border-warn/40 bg-warn/[0.06]' : 'border-line bg-surface hover:border-line2'}">
              <span class="relative flex h-3 w-3 flex-none">
                {#if st === 'working'}<span class="absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" style="animation:mc-ping 1.6s cubic-bezier(0,0,0.2,1) infinite"></span>{/if}
                <span class="relative inline-flex h-3 w-3 rounded-full {TONE[st].dot}"></span>
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[20px] font-semibold tracking-tight landscape:text-[17px]">{agentName(a)}</span>
                <span class="block truncate text-[14px] landscape:text-[13px] {st === 'waiting' ? 'text-warn' : 'text-ink3'}">{st === 'exited' ? 'Process exited' : a.activity || statusLabel(st)}</span>
              </span>
              <span class="flex-none text-right">
                <span class="block text-[13px] font-semibold {TONE[st].text}">{statusLabel(st)}</span>
                {#if st === 'working' && (a.tokensPerSec ?? 0) > 0}
                  <span class="block font-mono text-[12px] tabular-nums text-ink3">{fmtInt(Math.round(a.tokensPerSec))} t/s</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div class="text-[28px] font-bold tracking-tight">No agents running</div>
          <div class="max-w-[340px] text-[16px] leading-relaxed text-ink3">Pick a project and speak a mission — or just say it: “fix the login page in the shop project”.</div>
        </div>
      {/if}

      {#if micSess || draft}
        <div class="mt-3 rounded-2xl border border-crit/40 bg-crit/[0.06] px-5 py-4 text-[20px] leading-snug text-ink">
          {draft || 'Listening…'}
        </div>
      {/if}
    {/if}
  </main>

  <!-- launch target chips: only where the mic means "new agent" -->
  {#if screen === 'list' && mc.knownDirs.length && !micSess}
    <div class="flex flex-none gap-2 overflow-x-auto px-4 pb-2 noscroll">
      {#each mc.knownDirs as d (d)}
        <button
          onclick={() => setDir(d)}
          class="flex min-h-[52px] flex-none items-center gap-2 rounded-2xl border px-5 text-[16px] font-medium transition active:scale-95 landscape:min-h-[44px] landscape:text-[14px] {d === dir ? 'border-line2 bg-raised text-ink' : 'border-line text-ink3'}">
          <Icon name="folder" size={16} class={d === dir ? 'text-ink2' : 'text-ink3'} />
          {d.split('/').filter(Boolean).pop() || d}
        </button>
      {/each}
    </div>
  {/if}

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
        <Icon name={micTarget.kind === 'launch' ? 'launch' : 'mic'} size={30} stroke={2.2} />
        <span class="truncate">
          {micSess ? 'Tap to send' : micTarget.kind === 'reply' ? `Reply to ${agentName(micTarget.agent)}` : `New agent${dirName ? ' · ' + dirName : ''}`}
        </span>
      </button>
    </footer>
  {/if}
</div>
