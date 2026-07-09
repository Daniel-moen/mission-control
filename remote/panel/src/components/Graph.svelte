<script>
  // Fleet telemetry over time. One live series at a time (Burn / Spend / Active)
  // so no legend is needed — the toggle names the series. Area + line, a soft
  // grid, a peak marker, and a hover crosshair with a value tooltip.
  import { mc, fmtInt, fmtTokens, clockOf } from '../lib/store.svelte.js';

  const METRICS = {
    burn: { label: 'Burn', unit: 'tok/s', color: 'var(--color-s1)', pick: (s) => s.tps, fmt: (v) => fmtInt(Math.round(v)) },
    spend: { label: 'Spend', unit: 'USD', color: 'var(--color-s3)', pick: (s) => s.cost, fmt: (v) => '$' + v.toFixed(2) },
    active: { label: 'Active', unit: 'agents', color: 'var(--color-s4)', pick: (s) => s.active, fmt: (v) => fmtInt(Math.round(v)) },
  };

  let metric = $state('burn');
  let w = $state(640); // measured plot width; bound to the container
  const H = 168;
  const PAD = { t: 14, r: 12, b: 18, l: 12 };

  const M = $derived(METRICS[metric]);
  const samples = $derived(mc.history.slice(-180));

  const geom = $derived.by(() => {
    const d = samples;
    if (d.length < 2) return null;
    const plotW = Math.max(1, w - PAD.l - PAD.r);
    const plotH = H - PAD.t - PAD.b;
    const vals = d.map(M.pick);
    const max = Math.max(...vals, M.unit === 'USD' ? 0.01 : 1);
    const n = d.length;
    const x = (i) => PAD.l + plotW * (i / (n - 1));
    const y = (v) => PAD.t + plotH * (1 - v / max);
    const pts = vals.map((v, i) => [x(i), y(v)]);
    const line = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${pts[0][0].toFixed(1)},${(PAD.t + plotH).toFixed(1)} ${line} ${pts[n - 1][0].toFixed(1)},${(PAD.t + plotH).toFixed(1)}`;
    let peak = 0;
    for (let i = 1; i < n; i++) if (vals[i] > vals[peak]) peak = i;
    return { pts, line, area, max, peak, x, plotH, plotW, vals, n };
  });

  // hover
  let hover = $state(-1);
  function onMove(e) {
    const g = geom;
    if (!g) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(((px - PAD.l) / g.plotW) * (g.n - 1));
    hover = Math.max(0, Math.min(g.n - 1, i));
  }
  const cur = $derived(samples.length ? samples[samples.length - 1] : null);
</script>

<div class="panel rounded-[22px] p-5">
  <div class="mb-3 flex items-center gap-3">
    <div class="min-w-0 flex-1">
      <div class="hud">{M.label} over time</div>
      <!-- value wears ink, not the series color; the swatch beside it carries identity -->
      <div class="display mt-1.5 flex items-baseline gap-2 text-[26px] font-bold leading-none tracking-tight text-ink">
        <span class="h-2.5 w-2.5 flex-none self-center rounded-sm" style="background:{M.color}"></span>
        {cur ? M.fmt(M.pick(cur)) : '—'}<span class="hud !tracking-[0.1em]">{M.unit}</span>
      </div>
    </div>
    <div class="flex flex-none gap-1 rounded-full border border-line bg-inset p-1">
      {#each Object.entries(METRICS) as [k, m]}
        <button
          onclick={() => (metric = k)}
          class="min-h-[32px] rounded-full px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] transition {metric === k ? 'bg-raised text-ink shadow-[inset_0_1px_0_rgba(147,200,255,0.1)]' : 'text-ink3 hover:text-ink2'}">
          {m.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="relative" bind:clientWidth={w}>
    {#if geom}
      <svg viewBox="0 0 {w} {H}" width="100%" height={H} class="block" role="img" aria-label="{M.label} over time"
           onpointermove={onMove} onpointerleave={() => (hover = -1)}>
        <defs>
          <linearGradient id="g-{metric}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={M.color} stop-opacity="0.28" />
            <stop offset="100%" stop-color={M.color} stop-opacity="0.02" />
          </linearGradient>
        </defs>

        <!-- baseline + midline grid (recessive, solid hairlines) -->
        {#each [0.5, 1] as f}
          <line x1={PAD.l} x2={w - PAD.r} y1={PAD.t + geom.plotH * f} y2={PAD.t + geom.plotH * f}
                stroke="var(--color-line)" stroke-width="1" />
        {/each}
        <!-- peak tick -->
        <text x={geom.x(geom.peak)} y={geom.pts[geom.peak][1] - 5} fill="var(--color-ink3)"
              font-size="10" text-anchor="middle" class="tabular-nums">{M.fmt(geom.max)}</text>

        <polygon points={geom.area} fill="url(#g-{metric})" />
        <polyline points={geom.line} fill="none" stroke={M.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx={geom.pts[geom.n - 1][0]} cy={geom.pts[geom.n - 1][1]} r="4" fill={M.color} stroke="var(--color-surface)" stroke-width="2" />

        {#if hover >= 0}
          {@const hx = geom.pts[hover][0]}
          {@const hy = geom.pts[hover][1]}
          <line x1={hx} x2={hx} y1={PAD.t} y2={PAD.t + geom.plotH} stroke="var(--color-line2)" stroke-width="1" />
          <circle cx={hx} cy={hy} r="4" fill={M.color} stroke="var(--color-surface)" stroke-width="2" />
        {/if}
      </svg>

      {#if hover >= 0}
        {@const s = samples[hover]}
        <div class="pointer-events-none absolute top-1 rounded-lg border border-line2 bg-raised px-2.5 py-1.5 text-[11px] shadow-lg"
             style="left:clamp(4px, {(geom.pts[hover][0] / w) * 100}%, calc(100% - 96px));transform:translateX(-50%)">
          <div class="flex items-center gap-1.5 font-semibold tabular-nums text-ink">
            <span class="h-2 w-2 flex-none rounded-sm" style="background:{M.color}"></span>{M.fmt(M.pick(s))} {M.unit}
          </div>
          <div class="font-mono text-ink3">{clockOf(s.t)}</div>
        </div>
      {/if}
    {:else}
      <div class="grid h-[168px] place-items-center">
        <span class="hud flex items-center gap-2"><span class="h-1.5 w-1.5 rounded-full bg-accent" style="animation:mc-pulse 1.4s ease-in-out infinite"></span>Collecting telemetry…</span>
      </div>
    {/if}
  </div>
</div>
