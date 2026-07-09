<script>
  // The flight deck: one glance = link state, mission clock, fleet status
  // (counts double as filters), machine health as arc gauges, burn + spend.
  import { mc, counts, fmtInt, fmtMem } from '../lib/store.svelte.js';

  const c = $derived(counts(mc.agents));

  const link = $derived(
    mc.link === 'linked'
      ? { dot: 'bg-ok', label: 'LINKED', cls: 'text-ok/90 border-ok/30' }
      : mc.link === 'relay'
        ? { dot: 'bg-warn', label: 'RELAY', cls: 'text-warn border-warn/40' }
        : { dot: 'bg-crit', label: 'OFFLINE', cls: 'text-crit border-crit/40' },
  );

  // Mission clock — mc.now already ticks at 1 Hz for staleness math.
  const clock = $derived.by(() => {
    const d = new Date(mc.now || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  });

  // Tap a block to filter the board; tap it again to clear.
  function setFilter(k) {
    mc.filter = mc.filter === k ? 'all' : k;
  }
  const blocks = $derived([
    { k: 'working', label: 'WORKING', n: c.working, tone: 'text-accent', bar: 'bg-accent', on: 'border-accent/60 glow-accent', live: c.working > 0 },
    { k: 'waiting', label: 'NEEDS YOU', n: c.waiting, tone: 'text-warn', bar: 'bg-warn', on: 'border-warn/60 glow-warn', live: false },
    { k: 'done', label: 'DONE', n: c.done, tone: 'text-ok', bar: 'bg-ok', on: 'border-ok/60 glow-ok', live: false },
    ...(c.exited ? [{ k: 'exited', label: 'EXITED', n: c.exited, tone: 'text-crit', bar: 'bg-crit', on: 'border-crit/60 glow-crit', live: false }] : []),
  ]);

  const sys = $derived(mc.system);
  const memPct = $derived(sys && sys.memTotalMB ? (100 * sys.memUsedMB) / sys.memTotalMB : 0);

  // Arc gauge geometry: 270° sweep, r=15.5 in a 44px box.
  const CIRC = 2 * Math.PI * 15.5;
  const SWEEP = CIRC * 0.75;
  const arc = (pct) => SWEEP * Math.max(0, Math.min(1, (pct ?? 0) / 100));
  const gaugeTone = (pct) => (pct >= 90 ? 'var(--color-crit)' : pct >= 75 ? 'var(--color-warn)' : 'var(--color-accent)');
</script>

<header
  class="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-2xl"
  style="padding-top:var(--sat); box-shadow: 0 1px 0 rgba(147,200,255,0.06), 0 18px 40px -28px rgba(0,0,0,0.9)">
  <div class="mx-auto flex h-[72px] max-w-[1400px] items-center gap-4 overflow-x-auto px-4 noscroll sm:px-6">
    <!-- brand: radar sweep in a ring -->
    <div class="flex flex-none items-center gap-3">
      <div class="relative grid h-11 w-11 flex-none place-items-center overflow-hidden rounded-2xl border border-accent/40 bg-inset">
        <span class="absolute inset-0 origin-center opacity-80" style="background:conic-gradient(from 0deg, transparent 0 300deg, rgba(34,217,238,0.85) 355deg, transparent 360deg); animation:mc-sweep 4s linear infinite"></span>
        <span class="absolute inset-[7px] rounded-full border border-accent/30"></span>
        <span class="absolute inset-[14px] rounded-full border border-accent/20"></span>
        <span class="relative h-1.5 w-1.5 rounded-full bg-accent glow-accent"></span>
      </div>
      <div class="hidden min-w-0 lg:block">
        <div class="display text-[16px] font-bold leading-none tracking-[0.08em] whitespace-nowrap">MISSION CONTROL</div>
        <div class="hud mt-1.5 flex items-center gap-2 whitespace-nowrap">
          <span class="flex items-center gap-1.5 {link.cls.split(' ')[0]}">
            <span class="relative flex h-1.5 w-1.5">
              {#if mc.link !== 'linked'}<span class="absolute inline-flex h-full w-full rounded-full {link.dot} opacity-60" style="animation:mc-ping 1.6s cubic-bezier(0,0,0.2,1) infinite"></span>{/if}
              <span class="relative inline-flex h-1.5 w-1.5 rounded-full {link.dot}"></span>
            </span>
            {link.label}
          </span>
          <span class="text-line2">/</span>
          <span class="text-ink3">{clock}</span>
        </div>
      </div>
      <!-- compact link pill when the wordmark is hidden -->
      <div class="flex flex-none items-center gap-1.5 rounded-full border px-2.5 py-1 lg:hidden {link.cls}">
        <span class="relative flex h-2 w-2">
          {#if mc.link !== 'linked'}<span class="absolute inline-flex h-full w-full rounded-full {link.dot} opacity-60" style="animation:mc-ping 1.6s cubic-bezier(0,0,0.2,1) infinite"></span>{/if}
          <span class="relative inline-flex h-2 w-2 rounded-full {link.dot}"></span>
        </span>
        <span class="font-mono text-[11px] font-bold whitespace-nowrap">{link.label}</span>
      </div>
    </div>

    <!-- fleet status blocks: the counts ARE the filters -->
    <div class="flex flex-none items-stretch gap-2">
      {#each blocks as b (b.k)}
        <button
          onclick={() => setFilter(b.k)}
          aria-pressed={mc.filter === b.k}
          class="panel relative flex h-[52px] min-w-[86px] flex-none flex-col items-start justify-center overflow-hidden rounded-xl px-3.5 transition active:scale-95 {mc.filter === b.k ? b.on : ''}">
          <span class="absolute inset-x-0 top-0 h-[2px] {b.bar} {b.live ? '' : 'opacity-60'}"></span>
          <span class="display text-[22px] font-bold leading-none tabular-nums {b.n > 0 ? b.tone : 'text-ink3'}">{b.n}</span>
          <span class="hud mt-1 whitespace-nowrap">{b.label}</span>
        </button>
      {/each}
    </div>

    <span class="min-w-2 flex-1"></span>

    <!-- machine health: arc gauges (absent on older hosts → hidden) -->
    {#if sys}
      <div class="hidden flex-none items-center gap-1 sm:flex">
        {#each [{ label: 'CPU', pct: sys.cpu ?? 0, sub: `${sys.cores ?? '—'}C` }, { label: 'MEM', pct: memPct, sub: fmtMem(sys.memUsedMB) }] as g (g.label)}
          <div class="flex flex-col items-center px-1.5">
            <div class="relative h-11 w-11">
              <svg viewBox="0 0 44 44" class="h-11 w-11 -rotate-[225deg]">
                <circle cx="22" cy="22" r="15.5" fill="none" stroke="var(--color-line)" stroke-width="4" stroke-linecap="round" stroke-dasharray="{SWEEP} {CIRC}" />
                <circle cx="22" cy="22" r="15.5" fill="none" stroke={gaugeTone(g.pct)} stroke-width="4" stroke-linecap="round" stroke-dasharray="{arc(g.pct)} {CIRC}" style="transition:stroke-dasharray 0.6s ease, stroke 0.6s ease" />
              </svg>
              <span class="absolute inset-0 grid place-items-center pt-1 font-mono text-[11px] font-semibold tabular-nums text-ink2">{Math.round(g.pct)}</span>
            </div>
            <span class="hud -mt-0.5">{g.label}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- burn + spend -->
    <div class="flex flex-none flex-col items-end justify-center">
      <div class="flex items-baseline gap-1.5">
        <span class="display text-[24px] font-bold leading-none tabular-nums {(mc.summary.tokensPerSec ?? 0) > 0 ? 'text-accent-bright' : 'text-ink3'}" style={(mc.summary.tokensPerSec ?? 0) > 0 ? 'text-shadow:0 0 18px rgba(34,217,238,0.45)' : ''}>{fmtInt(Math.round(mc.summary.tokensPerSec ?? 0))}</span>
        <span class="hud">tok/s</span>
      </div>
      <div class="hud mt-1">spend <span class="text-ink2">${(mc.summary.totalCost ?? 0).toFixed(2)}</span></div>
    </div>
  </div>
</header>
