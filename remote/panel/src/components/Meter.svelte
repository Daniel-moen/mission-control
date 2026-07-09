<script>
  // Compact utilization meter (dataviz "meter" spec): the fill carries severity
  // (accent → warn → crit); the unfilled track is a lighter step of the SAME
  // hue so the state reads across the whole bar. Value is text-token ink, never
  // the data color; identity comes from the label beside it.
  let { label = '', pct = 0, detail = '' } = $props();

  const clamped = $derived(Math.max(0, Math.min(100, pct)));
  const color = $derived(
    clamped >= 90 ? 'var(--color-crit)' : clamped >= 70 ? 'var(--color-warn)' : 'var(--color-accent)',
  );
</script>

<div class="flex min-w-[104px] items-center gap-2" title="{label} {Math.round(clamped)}%{detail ? ' · ' + detail : ''}">
  <span class="hud">{label}</span>
  <div class="h-2 w-14 flex-none overflow-hidden rounded-full" style="background:color-mix(in oklab, {color} 16%, transparent)">
    <div
      class="h-full rounded-full transition-[width] duration-700"
      style="width:{clamped}%;background:{color};box-shadow:0 0 8px color-mix(in oklab, {color} 55%, transparent)"></div>
  </div>
  <span class="font-mono text-[12px] font-semibold tabular-nums text-ink2">{Math.round(clamped)}%</span>
</div>
