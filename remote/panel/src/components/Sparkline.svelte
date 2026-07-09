<script>
  // Tiny inline sparkline. `data` = numbers; draws a soft line + accent end dot.
  let { data = [], width = 120, height = 34, color = 'var(--color-accent)', class: cls = '' } = $props();

  const pts = $derived.by(() => {
    const d = (data || []).slice(-24);
    if (d.length < 2) return null;
    const P = 3;
    const max = Math.max(...d, 1);
    const p = d.map((v, i) => [
      P + (width - 2 * P) * (i / (d.length - 1)),
      height - P - (height - 2 * P) * (v / max),
    ]);
    return {
      line: p.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' '),
      area: `${P},${height} ${p.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ')} ${p[p.length - 1][0].toFixed(1)},${height}`,
      end: p[p.length - 1],
    };
  });
</script>

<svg viewBox="0 0 {width} {height}" preserveAspectRatio="none" class={cls} width={width} height={height} aria-hidden="true">
  {#if pts}
    <polygon points={pts.area} fill={color} opacity="0.12" />
    <polyline points={pts.line} fill="none" stroke={color} stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" opacity="0.9" />
    <circle cx={pts.end[0]} cy={pts.end[1]} r="2.6" fill={color} />
  {/if}
</svg>
