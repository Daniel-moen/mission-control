<script>
  import { mc } from '../lib/store.svelte.js';
</script>

{#if mc.toast}
  <!-- glass pill with a luminous accent edge, floating above the dock -->
  <div
    class="panel anim-rise pointer-events-none fixed left-1/2 z-[95] flex max-w-[92vw] -translate-x-1/2 items-center gap-2.5 break-words rounded-full !border-accent/45 py-3.5 pl-5 pr-6 text-[15px] text-ink glow-accent"
    style="bottom:calc(112px + var(--sab))">
    <span class="h-1.5 w-1.5 flex-none rounded-full bg-accent" style="animation:mc-pulse 1.4s ease-in-out infinite; box-shadow:0 0 8px rgba(34,217,238,0.8)"></span>
    {mc.toast}
  </div>
{/if}
