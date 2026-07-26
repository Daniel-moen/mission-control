<script>
  import { mc } from '../lib/store.svelte.js';
</script>

{#if mc.toast}
  <div
    class="anim-rise pointer-events-none fixed left-1/2 z-[95] flex max-w-[92vw] -translate-x-1/2 items-center gap-2.5 break-words rounded-xl border border-line2 bg-raised px-4 py-3 text-[14px] text-ink shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]"
    style="bottom:calc(104px + var(--sab))">
    {mc.toast}
  </div>
{/if}
