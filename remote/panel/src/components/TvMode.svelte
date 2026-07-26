<script>
  // TV mode — the ambient wall display. Opened via #tv (Settings → TV mode, or
  // just append #tv to the URL on the TV's browser). Design brief: a lot of
  // dark space, a few precise numbers, a quiet list of who's doing what — a
  // room presence, not a workstation. Everything rides the same 1 Hz snapshot;
  // there is no interaction beyond exit/fullscreen (revealed on pointer move).
  //
  // Sizing: the root sets font-size from vw and EVERYTHING inside is em-based,
  // so the composition holds from a 1080p TV to a 4K panel.
  import { onMount } from 'svelte';
  import {
    mc, counts, agentStatus, statusLabel, agentName, fmtTokens, fmtInt, fmtMem,
    dataAge, clockOf,
  } from '../lib/store.svelte.js';
  import { TONE } from '../lib/tone.js';

  let { onclose } = $props();

  const s = $derived(mc.summary || {});
  const c = $derived(counts(mc.agents));
  const sys = $derived(mc.system);
  const age = $derived(dataAge());

  // ---- clock ----
  const time = $derived.by(() => {
    const d = new Date(mc.now || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return { hm: `${p(d.getHours())}:${p(d.getMinutes())}`, s: p(d.getSeconds()) };
  });
  const dateLine = $derived(
    new Date(mc.now || Date.now()).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
  );

  const link = $derived(
    mc.link === 'linked'
      ? { word: 'linked', cls: 'text-ink3', dot: 'bg-ok' }
      : mc.link === 'relay'
        ? { word: 'mac offline', cls: 'text-warn', dot: 'bg-warn' }
        : { word: 'reconnecting', cls: 'text-crit', dot: 'bg-crit' },
  );

  // Roster: needs-you first, then working, then the rest — capped so a huge
  // fleet still fits on one wall.
  const ORDER = { waiting: 0, exited: 1, working: 2, done: 3 };
  const roster = $derived.by(() => {
    const rows = [...mc.agents].sort((a, b) => (ORDER[agentStatus(a)] ?? 9) - (ORDER[agentStatus(b)] ?? 9));
    return rows.slice(0, 9);
  });
  const overflow = $derived(Math.max(0, mc.agents.length - 9));

  // ---- footer figures ----
  const spendRate = $derived.by(() => {
    const h = mc.history;
    if (h.length < 2) return null;
    const dt = h[h.length - 1].t - h[0].t;
    if (dt < 30_000) return null;
    return Math.max(0, ((h[h.length - 1].cost - h[0].cost) / dt) * 3_600_000);
  });
  const stats = $derived([
    {
      label: 'burn', value: fmtInt(Math.round(s.tokensPerSec ?? 0)), unit: 'tok/s',
      live: (s.tokensPerSec ?? 0) > 0,
    },
    {
      label: 'spend', value: '$' + (s.totalCost ?? 0).toFixed(2), unit: '',
      sub: spendRate === null ? null : `$${spendRate.toFixed(2)}/hr`,
    },
    {
      label: 'tokens', value: fmtTokens(s.totalTokens ?? 0), unit: '',
    },
    {
      label: 'agents', value: String(c.working), unit: `/ ${mc.agents.length}`,
      sub: c.waiting ? `${c.waiting} need${c.waiting === 1 ? 's' : ''} you` : null,
      live: c.working > 0, warn: c.waiting > 0,
    },
  ]);
  const memPct = $derived(sys && sys.memTotalMB ? (100 * sys.memUsedMB) / sys.memTotalMB : 0);

  const recent = $derived([...mc.activity].slice(-4).reverse());

  // ---- chart geometry (em-fluid SVG: viewBox space, stretched to fit) ----
  // The burn horizon along the bottom edge — the room's slow heartbeat.
  const horizon = $derived.by(() => {
    const d = mc.tps.slice(-150);
    if (d.length < 2) return null;
    const W = 1000, H = 120;
    const max = Math.max(...d, 1);
    const p = d.map((v, i) => `${((W * i) / (d.length - 1)).toFixed(1)},${(H - 6 - (H - 18) * (v / max)).toFixed(1)}`);
    return { line: p.join(' '), area: `0,${H} ${p.join(' ')} ${W},${H}` };
  });

  // ---- controls: hidden until the pointer moves; cursor sleeps with them ----
  let showUi = $state(false);
  let hideTimer;
  function poke() {
    showUi = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (showUi = false), 3200);
  }
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  onMount(() => {
    // Keep the TV awake while the display is up — best effort, Safari may decline.
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
      clearTimeout(hideTimer);
      lock?.release?.().catch?.(() => {});
    };
  });
</script>

<div class="fixed inset-0 z-[75] overflow-hidden bg-bg {showUi ? '' : 'tv-nocursor'}" onpointermove={poke} role="presentation">
  <!-- everything scales off this font-size; the slow orbit guards OLEDs -->
  <div class="tv-shift relative flex h-full flex-col" style="font-size:clamp(11px, 1.05vw, 30px)">
    <!-- ---- header ---------------------------------------------------- -->
    <header class="flex flex-none items-start justify-between px-[3.4em] pt-[2.6em]">
      <div>
        <div class="text-[1em] font-semibold tracking-[0.02em] text-ink/85">Mission Control</div>
        <div class="thud mt-[0.75em] flex items-center gap-[0.7em] {link.cls}">
          <span class="relative flex h-[0.42em] w-[0.42em]">
            {#if mc.link !== 'linked'}<span class="absolute inline-flex h-full w-full rounded-full {link.dot} opacity-60" style="animation:mc-ping 1.8s cubic-bezier(0,0,0.2,1) infinite"></span>{/if}
            <span class="relative inline-flex h-[0.42em] w-[0.42em] rounded-full {link.dot}"></span>
          </span>
          {link.word}{#if mc.link === 'linked' && age !== null && age > 5}<span class="text-ink3">· {age}s</span>{/if}
        </div>
      </div>
      <div class="text-right">
        <div class="text-[3.1em] font-medium leading-none tracking-[0.01em] tabular-nums text-ink/90">
          {time.hm}<span class="ml-[0.28em] text-[0.4em] font-normal text-ink3">{time.s}</span>
        </div>
        <div class="thud mt-[0.8em]">{dateLine}</div>
      </div>
    </header>

    <!-- ---- roster ------------------------------------------------------ -->
    <main class="flex min-h-0 flex-1 items-center justify-center px-[4em] py-[1.5em]">
      {#if roster.length}
        <div class="grid w-full max-w-[72em] gap-[0.7em] {roster.length > 3 ? 'grid-cols-2 xl:grid-cols-3' : 'grid-cols-1'}">
          {#each roster as a (a.id)}
            {@const st = agentStatus(a)}
            <div class="flex items-center gap-[0.9em] rounded-[0.7em] border border-line/70 bg-surface/50 px-[1.1em] py-[0.9em] {st === 'waiting' ? '!border-warn/40' : ''}">
              <span class="relative flex h-[0.55em] w-[0.55em] flex-none">
                {#if st === 'working'}<span class="absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" style="animation:mc-ping 1.8s cubic-bezier(0,0,0.2,1) infinite"></span>{/if}
                <span class="relative inline-flex h-[0.55em] w-[0.55em] rounded-full {TONE[st].dot}"></span>
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-[0.6em]">
                  <span class="truncate text-[1em] font-semibold text-ink/90">{agentName(a)}</span>
                  <span class="flex-none text-[0.62em] {TONE[st].text}">{statusLabel(st)}</span>
                </div>
                <div class="mt-[0.25em] truncate text-[0.72em] text-ink3">{a.activity || '—'}</div>
              </div>
              <span class="flex-none font-mono text-[0.62em] tabular-nums text-ink3">{fmtTokens(a.tokens ?? 0)}</span>
            </div>
          {/each}
          {#if overflow}
            <div class="flex items-center justify-center rounded-[0.7em] border border-line/40 px-[1.1em] py-[0.9em] text-[0.72em] text-ink3">
              +{overflow} more
            </div>
          {/if}
        </div>
      {:else}
        <div class="text-center">
          <div class="text-[1.3em] font-medium tracking-[0.3em] text-ink2">ALL QUIET</div>
          <div class="thud mt-[1.1em]">no agents running</div>
        </div>
      {/if}
    </main>

    <!-- ---- footer ------------------------------------------------------ -->
    <footer class="relative flex-none px-[3.4em] pb-[2.4em] pt-[1em]">
      {#if horizon}
        <svg viewBox="0 0 1000 120" preserveAspectRatio="none" class="pointer-events-none absolute inset-x-0 bottom-0 h-[6.5em] w-full" aria-hidden="true">
          <defs>
            <linearGradient id="tv-horizon" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--color-accent)" stop-opacity="0.1" />
              <stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <polygon points={horizon.area} fill="url(#tv-horizon)" />
          <polyline points={horizon.line} fill="none" stroke="var(--color-accent)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" opacity="0.35" />
        </svg>
      {/if}

      <div class="relative grid grid-cols-[1fr_auto_1fr] items-end gap-[3em]">
        <!-- recent activity, whispering -->
        <div class="min-w-0 self-end">
          {#if recent.length}
            <div class="thud mb-[0.9em]">recent</div>
            <div class="space-y-[0.55em]">
              {#each recent as r, i (r.t + r.id)}
                <div class="truncate font-mono text-[0.66em] text-ink2" style="opacity:{1 - i * 0.21}">
                  <span class="text-ink3">{clockOf(r.t).slice(0, 5)}</span>
                  <span class="text-ink/75">{r.who}</span>
                  <span class="text-ink3">·</span>
                  {r.text}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- headline figures -->
        <div class="flex items-start gap-[3.6em]">
          {#each stats as t (t.label)}
            <div class="min-w-[5.5em]">
              <div class="thud flex items-center gap-[0.6em]">
                {t.label}
                {#if t.live}<span class="h-[0.32em] w-[0.32em] rounded-full bg-accent" style="animation:mc-pulse 1.6s steps(2) infinite"></span>{/if}
              </div>
              <div class="mt-[0.5em] flex items-baseline gap-[0.3em] text-[1.75em] font-semibold leading-none tracking-tight tabular-nums {t.warn ? 'text-warn' : 'text-ink/90'}">
                {t.value}{#if t.unit}<span class="thud !tracking-[0.12em]">{t.unit}</span>{/if}
              </div>
              {#if t.sub}<div class="mt-[0.55em] whitespace-nowrap font-mono text-[0.62em] {t.warn ? 'text-warn/85' : 'text-ink3'}">{t.sub}</div>{/if}
            </div>
          {/each}
        </div>

        <!-- machine, in two quiet threads -->
        <div class="flex min-w-0 flex-col items-end gap-[0.9em] self-end">
          {#if sys}
            {#each [{ label: 'cpu', pct: sys.cpu ?? 0, detail: `${sys.cores ?? '—'} cores` }, { label: 'mem', pct: memPct, detail: fmtMem(sys.memUsedMB) }] as b (b.label)}
              {@const pct = Math.max(0, Math.min(100, b.pct))}
              <div class="flex w-[15em] max-w-full items-center gap-[1em]">
                <span class="thud w-[2.4em] flex-none">{b.label}</span>
                <div class="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-line/60">
                  <div class="h-full rounded-full transition-[width] duration-1000" style="width:{pct}%;background:var(--color-ink3);opacity:0.9"></div>
                </div>
                <span class="flex-none font-mono text-[0.62em] tabular-nums text-ink3">{Math.round(pct)}% · {b.detail}</span>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </footer>
  </div>

  <!-- pointer-revealed controls -->
  <div class="absolute right-5 top-5 z-10 flex gap-2 transition-opacity duration-500 {showUi ? 'opacity-100' : 'pointer-events-none opacity-0'}">
    <button onclick={fullscreen} aria-label="Toggle fullscreen" class="tv-btn">⛶</button>
    <button onclick={onclose} aria-label="Exit TV mode" class="tv-btn">✕</button>
  </div>
</div>

<style>
  .tv-nocursor,
  .tv-nocursor * {
    cursor: none !important;
  }

  /* Burn-in guard: the whole composition orbits a few px over 8 minutes. */
  .tv-shift {
    animation: tv-shift 480s ease-in-out infinite;
  }
  @keyframes tv-shift {
    0%, 100% { transform: translate(0, 0); }
    25% { transform: translate(5px, -4px); }
    50% { transform: translate(-4px, 5px); }
    75% { transform: translate(-5px, -5px); }
  }

  /* Quiet label at TV scale (the app's .hud is fixed 11px). */
  .thud {
    font-size: 0.62em;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--color-ink3);
  }

  .tv-btn {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 1px solid var(--color-line2);
    background: var(--color-raised);
    color: var(--color-ink2);
    font-size: 18px;
    transition: color 0.15s, border-color 0.15s;
  }
  .tv-btn:hover {
    color: var(--color-ink);
    border-color: var(--color-line2);
  }
</style>
