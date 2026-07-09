<script>
  // Token economics for the session. The headline is the cache-hit rate — the
  // single biggest cost lever when developing with Claude: input tokens served
  // from cache are ~10× cheaper than fresh ones. The bar shows where every token
  // went (output / fresh input / cache read / cache write) using the design
  // system's validated telemetry series colors.
  import { mc, fmtTokens, fmtInt } from '../lib/store.svelte.js';

  const s = $derived(mc.summary || {});

  const parts = $derived([
    { key: 'output', label: 'Output', color: 'var(--color-s1)', v: s.outputTokens ?? 0 },
    { key: 'input', label: 'Fresh input', color: 'var(--color-s2)', v: s.inputTokens ?? 0 },
    { key: 'cacheRead', label: 'Cache read', color: 'var(--color-s3)', v: s.cacheReadTokens ?? 0 },
    { key: 'cacheWrite', label: 'Cache write', color: 'var(--color-s4)', v: s.cacheCreateTokens ?? 0 },
  ]);
  const total = $derived(parts.reduce((a, p) => a + p.v, 0));

  // Of every input-side token, what fraction was served from cache rather than
  // paid for fresh. Higher = cheaper, faster context.
  const cacheHit = $derived.by(() => {
    const read = s.cacheReadTokens ?? 0;
    const denom = read + (s.inputTokens ?? 0) + (s.cacheCreateTokens ?? 0);
    return denom ? Math.round((100 * read) / denom) : null;
  });
  const hitTone = $derived(cacheHit === null ? 'text-ink3' : cacheHit >= 80 ? 'text-ok' : cacheHit >= 50 ? 'text-warn' : 'text-crit');
</script>

<div class="panel flex flex-col rounded-[22px] p-5">
  <div class="flex items-start justify-between">
    <div>
      <div class="hud">Cache hit rate</div>
      <div class="display mt-1.5 text-[26px] font-bold leading-none tracking-tight tabular-nums {hitTone}">
        {cacheHit === null ? '—' : cacheHit + '%'}
      </div>
    </div>
    <div class="text-right">
      <div class="hud">Tokens</div>
      <div class="mt-1.5 font-mono text-[15px] tabular-nums text-ink">{fmtTokens(total)}</div>
    </div>
  </div>

  <!-- composition bar: 2px surface gaps do the separating (no strokes) -->
  <div class="mt-3 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-inset">
    {#each parts as p}
      {#if total && p.v}
        <div class="h-full" style="width:{(100 * p.v) / total}%;background:{p.color}"></div>
      {/if}
    {/each}
  </div>

  <!-- legend + values (identity is never colour-alone: each has a label) -->
  <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
    {#each parts as p}
      <div class="flex items-center gap-2 font-mono text-[12px]">
        <span class="h-2 w-2 flex-none rounded-sm" style="background:{p.color}"></span>
        <span class="min-w-0 flex-1 truncate text-ink2">{p.label}</span>
        <span class="flex-none tabular-nums text-ink3">{fmtTokens(p.v)}</span>
      </div>
    {/each}
  </div>
</div>
