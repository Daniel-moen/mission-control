<script>
  import { mc, changeToken, forgetToken, dataAge, PANEL_BUILD } from '../lib/store.svelte.js';
  import Icon from './Icon.svelte';

  let { onclose } = $props();

  const linkLabel = $derived(mc.link === 'linked' ? 'Mac linked' : mc.link === 'relay' ? 'Relay only' : 'Offline');
  const age = $derived(dataAge());

  const rows = $derived([
    ['Relay', location.host],
    ['Mac host', linkLabel],
    ['Last snapshot', age === null ? 'never' : age <= 2 ? 'just now' : `${age}s ago`],
    ['Access token', mc.token ? mc.token.slice(0, 4) + '••••••••' : '—'],
    ['Panel build', PANEL_BUILD],
  ]);
</script>

<div class="fixed inset-0 z-[70] flex flex-col bg-bg">
  <header class="flex flex-none items-center gap-3 border-b border-line bg-surface/80 px-4 backdrop-blur sm:px-6" style="padding-top:calc(12px + var(--sat));padding-bottom:12px; box-shadow: 0 1px 0 rgba(147,200,255,0.06)">
    <button onclick={onclose} aria-label="Close" class="grid h-11 w-11 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name="close" size={22} /></button>
    <div>
      <h2 class="display text-[20px] font-bold leading-none tracking-tight">Settings</h2>
      <div class="hud mt-1.5">Station configuration</div>
    </div>
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto noscroll">
    <div class="mx-auto flex max-w-[640px] flex-col gap-5 p-4 sm:p-6">
      <section class="panel rounded-[22px] p-5">
        <div class="mb-2 flex items-center gap-3">
          <span class="hud !text-accent">Connection</span>
          <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        </div>
        {#each rows as [k, v]}
          <div class="flex min-h-[48px] items-center justify-between gap-4 border-b border-line/70 py-3 last:border-0">
            <span class="hud">{k}</span>
            <span class="max-w-[55%] truncate font-mono text-[13px] text-ink">{v}</span>
          </div>
        {/each}
      </section>

      <section class="panel rounded-[22px] p-5">
        <div class="mb-2 flex items-center gap-3">
          <span class="hud !text-accent">Actions</span>
          <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        </div>
        <div class="flex items-center justify-between gap-4 border-b border-line/70 py-3.5">
          <div><div class="display text-[15px] font-bold">Change token</div><div class="mt-0.5 font-mono text-[12px] text-ink3">re-enter the access token</div></div>
          <button onclick={() => { changeToken(); onclose(); }} class="min-h-[44px] rounded-xl border border-line2 bg-raised px-5 py-2.5 text-[14px] font-semibold text-ink2 transition hover:border-accent/50 hover:text-ink active:scale-95">Change</button>
        </div>
        <div class="flex items-center justify-between gap-4 py-3.5">
          <div><div class="display text-[15px] font-bold">Disconnect</div><div class="mt-0.5 font-mono text-[12px] text-ink3">forget the token on this device</div></div>
          <button onclick={() => confirm('Forget the access token on this device?') && forgetToken()} class="min-h-[44px] rounded-xl border border-crit/45 bg-crit/8 px-5 py-2.5 text-[14px] font-semibold text-crit transition hover:border-crit active:scale-95">Forget</button>
        </div>
      </section>

      <section class="panel rounded-[22px] p-5">
        <div class="mb-3 flex items-center gap-3">
          <span class="hud !text-accent">About</span>
          <span class="h-px flex-1 bg-gradient-to-r from-line2 to-transparent"></span>
        </div>
        <p class="text-[14px] leading-relaxed text-ink2">
          Mission Control is the command center for the AI agents running on your Mac. All computation happens on the
          workstation — this panel monitors, directs and launches agents from anywhere. Live data only: every number
          here comes straight from the fleet snapshot.
        </p>
      </section>
    </div>
  </main>
</div>
