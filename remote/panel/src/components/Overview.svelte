<script>
  // Overview — the one dashboard. Order of importance, top to bottom:
  // things that need YOU (answerable inline) → headline numbers → burn over
  // time → token economics + machine health → per-agent table → live activity.
  // This replaced both the old home telemetry section and the Data tab.
  import {
    mc, fmtTokens, fmtInt, fmtMem, counts, agentStatus, statusLabel,
    agentName, sparkOf,
  } from '../lib/store.svelte.js';
  import AttentionQueue from './AttentionQueue.svelte';
  import ActivityFeed from './ActivityFeed.svelte';
  import Graph from './Graph.svelte';
  import TokenMix from './TokenMix.svelte';
  import Sparkline from './Sparkline.svelte';
  import Icon from './Icon.svelte';

  let { onopen } = $props();

  const s = $derived(mc.summary || {});
  const c = $derived(counts(mc.agents));
  const hasData = $derived(mc.agents.length > 0 || mc.history.length > 1 || (s.total ?? 0) > 0);

  // Spend velocity: $/hr over the rolling history window (needs ≥30s of data
  // to say anything honest).
  const spendRate = $derived.by(() => {
    const h = mc.history;
    if (h.length < 2) return null;
    const dt = h[h.length - 1].t - h[0].t;
    if (dt < 30_000) return null;
    const dc = h[h.length - 1].cost - h[0].cost;
    return Math.max(0, (dc / dt) * 3_600_000);
  });

  const outputShare = $derived.by(() => {
    const total = s.totalTokens ?? 0;
    return total ? Math.round((100 * (s.outputTokens ?? 0)) / total) : null;
  });

  const tiles = $derived([
    {
      label: 'Burn', value: fmtInt(Math.round(s.tokensPerSec ?? 0)), unit: 'tok/s',
      sub: 'fleet output rate', spark: mc.tps, live: (s.tokensPerSec ?? 0) > 0,
    },
    {
      label: 'Spend', value: '$' + (s.totalCost ?? 0).toFixed(2), unit: '',
      sub: spendRate === null ? 'this session' : `$${spendRate.toFixed(2)}/hr right now`,
      spark: mc.history.map((h) => h.cost), live: false,
    },
    {
      label: 'Tokens', value: fmtTokens(s.totalTokens ?? 0), unit: '',
      sub: outputShare === null ? 'session total' : `${outputShare}% output · ${fmtInt(s.totalTurns ?? 0)} turns`,
      spark: null, live: false,
    },
    {
      label: 'Fleet', value: String(c.working), unit: `/ ${mc.agents.length}`,
      sub: c.waiting ? `${c.waiting} need${c.waiting === 1 ? 's' : ''} you` : 'agents working',
      spark: mc.history.map((h) => h.active), live: c.working > 0, warn: c.waiting > 0,
    },
  ]);

  // Machine health bars: host CPU/MEM from the snapshot, plus what the fleet's
  // own processes are eating (summed per-agent cpu/mem — absent on older hosts).
  const sys = $derived(mc.system);
  const fleetLoad = $derived.by(() => {
    let cpu = 0, mem = 0, n = 0;
    for (const a of mc.agents) {
      if (typeof a.cpu === 'number') { cpu += a.cpu; n++; }
      if (typeof a.mem === 'number') mem += a.mem;
    }
    return n ? { cpu, mem, n } : null;
  });
  const bars = $derived.by(() => {
    const out = [];
    if (sys) {
      out.push({ label: 'Host CPU', pct: sys.cpu ?? 0, detail: `${sys.cores ?? '—'} cores` });
      if (sys.memTotalMB) out.push({ label: 'Host memory', pct: (100 * sys.memUsedMB) / sys.memTotalMB, detail: `${fmtMem(sys.memUsedMB)} of ${fmtMem(sys.memTotalMB)}` });
    }
    if (fleetLoad) {
      out.push({ label: 'Agents CPU', pct: sys?.cores ? fleetLoad.cpu / sys.cores : fleetLoad.cpu, detail: `${fleetLoad.cpu.toFixed(0)}% across ${fleetLoad.n} proc${fleetLoad.n === 1 ? '' : 's'}` });
      if (sys?.memTotalMB) out.push({ label: 'Agents memory', pct: (100 * fleetLoad.mem) / sys.memTotalMB, detail: fmtMem(fleetLoad.mem) });
    }
    return out;
  });
  const barTone = (pct) => (pct >= 90 ? 'var(--color-crit)' : pct >= 70 ? 'var(--color-warn)' : 'var(--color-accent)');

  // Agent table: heaviest sessions first. Token share drives the row bar.
  const board = $derived.by(() => {
    const rows = [...mc.agents].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
    const top = Math.max(...rows.map((a) => a.tokens ?? 0), 1);
    return rows.map((a) => ({ a, share: (100 * (a.tokens ?? 0)) / top }));
  });
  const dotCls = { working: 'bg-accent', waiting: 'bg-warn', done: 'bg-ink3', exited: 'bg-crit' };
</script>

<div class="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-4 pt-5 pb-8 sm:px-6">
  <!-- what needs you, answerable right here. Desktop only — on the phone the
       Agents tab already leads with this queue. -->
  <div class="hidden lg:block empty:hidden"><AttentionQueue {onopen} /></div>

  {#if hasData}
    <!-- headline stat tiles -->
    <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {#each tiles as t (t.label)}
        <div class="panel anim-rise relative overflow-hidden rounded-2xl p-4">
          <div class="hud flex items-center gap-2">
            {t.label}
            {#if t.live}<span class="h-1.5 w-1.5 rounded-full bg-accent" style="animation:mc-pulse 1.4s steps(2) infinite"></span>{/if}
          </div>
          <div class="display mt-2 flex items-baseline gap-1.5 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-ink">
            {t.value}{#if t.unit}<span class="text-[13px] font-normal text-ink3">{t.unit}</span>{/if}
          </div>
          <div class="mt-1.5 truncate text-[12px] {t.warn ? 'text-warn' : 'text-ink3'}">{t.sub}</div>
          <!-- hidden on narrow tiles where it would collide with the caption -->
          {#if t.spark && t.spark.length > 1}
            <div class="pointer-events-none absolute bottom-0 right-0 hidden opacity-70 sm:block">
              <Sparkline data={t.spark} width={110} height={30} />
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- burn / spend / active over time -->
    <Graph />

    <!-- token economics + machine health -->
    <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
      <TokenMix />

      <div class="panel flex flex-col rounded-2xl p-5">
        <div class="hud">Machine health</div>
        {#if bars.length}
          <div class="mt-4 flex flex-1 flex-col justify-center gap-4">
            {#each bars as b (b.label)}
              {@const pct = Math.max(0, Math.min(100, b.pct))}
              <div>
                <div class="mb-1.5 flex items-baseline justify-between gap-3">
                  <span class="text-[12.5px] text-ink2">{b.label}</span>
                  <span class="font-mono text-[12px] tabular-nums text-ink3">{b.detail} · <span class="font-semibold text-ink2">{Math.round(pct)}%</span></span>
                </div>
                <div class="h-2 w-full overflow-hidden rounded-full" style="background:color-mix(in oklab, {barTone(pct)} 14%, transparent)">
                  <div class="h-full rounded-full transition-[width] duration-700" style="width:{pct}%;background:{barTone(pct)}"></div>
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <div class="grid flex-1 place-items-center py-8">
            <span class="text-[13px] text-ink3">No host telemetry — older Mac host</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- per-agent table -->
    {#if board.length}
      <div class="panel overflow-hidden rounded-2xl">
        <div class="flex items-baseline gap-2 border-b border-line px-5 py-3">
          <h2 class="text-[13px] font-semibold text-ink2">Agents</h2>
          <span class="text-[13px] tabular-nums text-ink3">{board.length}</span>
        </div>
        <div class="overflow-x-auto noscroll">
          <table class="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr class="border-b border-line">
                <th class="hud px-5 py-3">Agent</th>
                <th class="hud px-3 py-3">Burn</th>
                <th class="hud px-3 py-3 text-right">tok/s</th>
                <th class="hud px-3 py-3 text-right">Tokens</th>
                <th class="hud px-3 py-3 text-right">Cost</th>
                <th class="hud px-3 py-3 text-right">CPU</th>
                <th class="hud px-5 py-3 text-right">Mem</th>
              </tr>
            </thead>
            <tbody>
              {#each board as { a, share } (a.id)}
                {@const st = agentStatus(a)}
                <tr class="cursor-pointer border-b border-line/60 transition last:border-0 hover:bg-raised/50" onclick={() => onopen?.(a.id)}>
                  <td class="max-w-[220px] px-5 py-3">
                    <div class="flex items-center gap-2.5">
                      <span class="h-2 w-2 flex-none rounded-full {dotCls[st]}" title={statusLabel(st)}></span>
                      <div class="min-w-0">
                        <div class="truncate text-[13px] font-semibold text-ink">{agentName(a)}</div>
                        <div class="truncate text-[11.5px] text-ink3">{statusLabel(st)}{a.branch ? ` · ${a.branch}` : ''}</div>
                      </div>
                    </div>
                    <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-inset">
                      <div class="h-full rounded-full bg-accent/60" style="width:{share}%"></div>
                    </div>
                  </td>
                  <td class="px-3 py-3"><Sparkline data={sparkOf(a.id)} width={96} height={26} /></td>
                  <td class="px-3 py-3 text-right font-mono text-[13px] tabular-nums {(a.tokensPerSec ?? 0) > 0 ? 'text-accent' : 'text-ink3'}">{fmtInt(Math.round(a.tokensPerSec ?? 0))}</td>
                  <td class="px-3 py-3 text-right font-mono text-[13px] tabular-nums text-ink2">{fmtTokens(a.tokens)}</td>
                  <td class="px-3 py-3 text-right font-mono text-[13px] tabular-nums text-ink2">${(a.cost ?? 0).toFixed(2)}</td>
                  <td class="px-3 py-3 text-right font-mono text-[13px] tabular-nums text-ink3">{typeof a.cpu === 'number' ? a.cpu.toFixed(0) + '%' : '—'}</td>
                  <td class="px-5 py-3 text-right font-mono text-[13px] tabular-nums text-ink3">{typeof a.mem === 'number' ? fmtMem(a.mem) : '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    <!-- live activity -->
    {#if mc.activity.length}
      <ActivityFeed {onopen} />
    {/if}
  {:else}
    <div class="mt-14 flex flex-col items-center gap-3 text-center">
      <div class="grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface text-ink3">
        <Icon name="pulse" size={26} />
      </div>
      <div class="text-[16px] font-semibold text-ink2">Nothing to show yet</div>
      <div class="max-w-xs text-[14px] text-ink3">Launch an agent and this overview lights up with live status, burn and spend.</div>
    </div>
  {/if}
</div>
