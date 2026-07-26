<script>
  import { saveToken } from '../lib/store.svelte.js';
  let value = $state('');
</script>

<!-- Sign-in: one quiet card in the dark. -->
<div class="fixed inset-0 z-[100] grid place-items-center bg-bg px-6" style="padding-top:var(--sat);padding-bottom:var(--sab)">
  <div class="anim-rise w-full max-w-sm">
    <div class="panel rounded-2xl px-7 py-9 sm:px-9">
      <div class="mb-8 flex flex-col gap-2">
        <h1 class="display text-[22px] font-semibold tracking-tight">Mission Control</h1>
        <p class="text-[14px] leading-relaxed text-ink2">Enter your access token to connect to your Mac.</p>
      </div>

      <label class="hud mb-2 block" for="gate-token">Access token</label>
      <input
        id="gate-token"
        class="w-full rounded-xl border border-line bg-inset px-4 py-3.5 font-mono text-[16px] text-ink outline-none transition placeholder:text-ink3 focus:border-line2"
        type="password"
        placeholder="••••••••••••"
        autocomplete="off"
        bind:value
        onkeydown={(e) => e.key === 'Enter' && saveToken(value)} />
      <button
        class="mt-4 w-full rounded-xl bg-ink py-3.5 text-[15px] font-semibold text-bg transition active:scale-[0.98] disabled:opacity-40"
        disabled={!value.trim()}
        onclick={() => saveToken(value)}>
        Connect
      </button>
    </div>
  </div>
</div>
