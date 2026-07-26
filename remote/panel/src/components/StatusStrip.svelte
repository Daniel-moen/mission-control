<script>
  // The header: one calm row. Connection + name on the left, the status
  // counts (which double as board filters) in the middle, burn + spend on
  // the right. Machine health lives in the Data tab now — not up here.
  import { mc, counts, fmtInt } from '../lib/store.svelte.js';

  const c = $derived(counts(mc.agents));

  const link = $derived(
    mc.link === 'linked'
      ? { dot: 'bg-ok', label: 'Linked', cls: 'text-ink3' }
      : mc.link === 'relay'
        ? { dot: 'bg-warn', label: 'Relay only', cls: 'text-warn' }
        : { dot: 'bg-crit', label: 'Offline', cls: 'text-crit' },
  );

  // Tap a count to filter the board; tap it again to clear.
  function setFilter(k) {
    mc.filter = mc.filter === k ? 'all' : k;
  }
  const blocks = $derived([
    { k: 'working', label: 'Working', n: c.working, tone: 'text-accent', on: 'border-accent/50 bg-accent/10 text-accent' },
    { k: 'waiting', label: 'Needs you', n: c.waiting, tone: 'text-warn', on: 'border-warn/50 bg-warn/10 text-warn' },
    { k: 'done', label: 'Done', n: c.done, tone: 'text-ink2', on: 'border-line2 bg-white/[0.06] text-ink' },
    ...(c.exited ? [{ k: 'exited', label: 'Exited', n: c.exited, tone: 'text-crit', on: 'border-crit/50 bg-crit/10 text-crit' }] : []),
  ]);
</script>

<header class="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-xl" style="padding-top:var(--sat)">
  <div class="mx-auto flex h-14 max-w-[1400px] items-center gap-3 overflow-x-auto px-4 noscroll sm:px-6">
    <!-- identity + link -->
    <div class="flex flex-none items-center gap-2.5">
      <span class="relative flex h-2 w-2 flex-none">
        {#if mc.link !== 'linked'}<span class="absolute inline-flex h-full w-full rounded-full {link.dot} opacity-60" style="animation:mc-ping 1.6s cubic-bezier(0,0,0.2,1) infinite"></span>{/if}
        <span class="relative inline-flex h-2 w-2 rounded-full {link.dot}"></span>
      </span>
      <span class="hidden text-[15px] font-semibold tracking-tight whitespace-nowrap md:block">Mission Control</span>
      <span class="text-[12px] whitespace-nowrap {link.cls} md:hidden">{link.label}</span>
    </div>

    <span class="hidden h-5 w-px flex-none bg-line md:block"></span>

    <!-- status counts = filters -->
    <div class="flex flex-none items-center gap-1.5">
      {#each blocks as b (b.k)}
        <button
          onclick={() => setFilter(b.k)}
          aria-pressed={mc.filter === b.k}
          class="flex h-9 flex-none items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition active:scale-95 {mc.filter === b.k ? b.on : 'border-transparent text-ink2 hover:bg-white/[0.04]'}">
          <span class="font-semibold tabular-nums {b.n > 0 ? b.tone : 'text-ink3'}">{b.n}</span>
          <span class={b.n > 0 ? '' : 'text-ink3'}>{b.label}</span>
        </button>
      {/each}
    </div>

    <span class="min-w-2 flex-1"></span>

    <!-- burn + spend -->
    <div class="flex flex-none items-baseline gap-3 font-mono text-[13px] tabular-nums">
      <span class={(mc.summary.tokensPerSec ?? 0) > 0 ? 'text-accent' : 'text-ink3'}>
        {fmtInt(Math.round(mc.summary.tokensPerSec ?? 0))} <span class="text-[11px] text-ink3">tok/s</span>
      </span>
      <span class="text-ink2">${(mc.summary.totalCost ?? 0).toFixed(2)}</span>
    </div>
  </div>
</header>
