<script>
  import { saveToken } from '../lib/store.svelte.js';
  let value = $state('');
</script>

<!-- The airlock: an opaque void that recreates the room's dot-grid + aurora
     (the global body layers sit at z -1/-2, beneath this overlay), with a
     single glass authorization panel floating in the middle. -->
<div class="fixed inset-0 z-[100] grid place-items-center overflow-hidden bg-bg px-6" style="padding-top:var(--sat);padding-bottom:var(--sab)">
  <!-- aurora -->
  <span
    class="pointer-events-none absolute inset-0"
    style="background:
      radial-gradient(1100px 640px at 72% -8%, rgba(34,217,238,0.14), transparent 62%),
      radial-gradient(900px 700px at 4% 110%, rgba(138,104,236,0.11), transparent 58%)"></span>
  <!-- dot grid, pooled around the panel -->
  <span
    class="pointer-events-none absolute inset-0"
    style="background-image:radial-gradient(rgba(147,162,186,0.15) 1px, transparent 1.5px); background-size:26px 26px;
      -webkit-mask-image:radial-gradient(900px 700px at 50% 45%, black 25%, transparent 78%);
      mask-image:radial-gradient(900px 700px at 50% 45%, black 25%, transparent 78%)"></span>

  <div class="anim-rise relative w-full max-w-md">
    <div class="panel rounded-[28px] px-7 py-10 sm:px-10">
      <!-- radar mark -->
      <div class="mb-7 flex justify-center">
        <div class="relative grid h-20 w-20 place-items-center overflow-hidden rounded-full border border-accent/40 bg-inset glow-accent">
          <span class="absolute inset-0 origin-center opacity-80" style="background:conic-gradient(from 0deg, transparent 0 300deg, rgba(34,217,238,0.85) 355deg, transparent 360deg); animation:mc-sweep 4s linear infinite"></span>
          <span class="absolute inset-[12px] rounded-full border border-accent/30"></span>
          <span class="absolute inset-[24px] rounded-full border border-accent/20"></span>
          <span class="relative h-2 w-2 rounded-full bg-accent glow-accent"></span>
        </div>
      </div>

      <div class="mb-8 flex flex-col items-center text-center">
        <h1 class="display text-[26px] font-bold leading-none tracking-[0.14em] whitespace-nowrap">MISSION CONTROL</h1>
        <div class="mt-3.5 flex w-full items-center gap-3">
          <span class="h-px flex-1 bg-gradient-to-r from-transparent to-line2"></span>
          <span class="hud !text-warn">Authorization required</span>
          <span class="h-px flex-1 bg-gradient-to-l from-transparent to-line2"></span>
        </div>
        <p class="mt-4 max-w-[34ch] text-[14px] leading-relaxed text-ink2">Present your access token to link this station to the fleet.</p>
      </div>

      <label class="hud mb-2 block" for="gate-token">Access token</label>
      <input
        id="gate-token"
        class="w-full rounded-2xl border border-line bg-inset px-5 py-4 font-mono text-lg tracking-[0.12em] text-ink outline-none transition placeholder:tracking-normal placeholder:text-ink3 focus:border-accent/70 focus:shadow-[0_0_0_1px_rgba(34,217,238,0.3),0_0_24px_-6px_rgba(34,217,238,0.4)]"
        type="password"
        placeholder="••••••••••••"
        autocomplete="off"
        bind:value
        onkeydown={(e) => e.key === 'Enter' && saveToken(value)} />
      <button
        class="mt-4 w-full rounded-2xl bg-accent py-4 font-mono text-[15px] font-bold uppercase tracking-[0.22em] text-accent-ink shadow-[0_0_32px_-4px_rgba(34,217,238,0.55)] transition active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
        disabled={!value.trim()}
        onclick={() => saveToken(value)}>
        Authorize
      </button>
    </div>

    <p class="hud mt-5 text-center !text-ink3">All systems standing by</p>
  </div>
</div>
