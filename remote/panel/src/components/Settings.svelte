<script>
  import { mc, changeToken, forgetToken, dataAge, stopAll, PANEL_BUILD } from '../lib/store.svelte.js';
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

  function confirmStop() {
    if (confirm('Send “Stop” to every agent still running?')) stopAll();
  }

  // Setup snippet for a bot/agent machine (OpenClaw etc.) — outbound HTTPS only,
  // same token as this panel. Copied with the real token filled in.
  let copied = $state(false);
  const apiBase = `${location.origin}/api/v1`;
  function copySetup() {
    const snippet = [
      `export MISSION_CONTROL_URL="${location.origin}"`,
      `export MISSION_CONTROL_TOKEN="${mc.token}"`,
      `curl -sf -H "Authorization: Bearer $MISSION_CONTROL_TOKEN" "$MISSION_CONTROL_URL/api/v1/status"`,
    ].join('\n');
    navigator.clipboard?.writeText(snippet).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 2000);
    });
  }
</script>

<div class="fixed inset-0 z-[70] flex flex-col bg-bg">
  <header class="flex flex-none items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur sm:px-6" style="padding-top:calc(12px + var(--sat));padding-bottom:12px">
    <button onclick={onclose} aria-label="Close" class="grid h-10 w-10 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised"><Icon name="close" size={22} /></button>
    <h2 class="text-[18px] font-semibold leading-none tracking-tight">Settings</h2>
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto noscroll">
    <div class="mx-auto flex max-w-[640px] flex-col gap-4 p-4 sm:p-6">
      <section class="panel rounded-2xl p-5">
        <div class="hud mb-2">Connection</div>
        {#each rows as [k, v]}
          <div class="flex min-h-[44px] items-center justify-between gap-4 border-b border-line/70 py-2.5 last:border-0">
            <span class="text-[13px] text-ink3">{k}</span>
            <span class="max-w-[55%] truncate font-mono text-[13px] text-ink">{v}</span>
          </div>
        {/each}
      </section>

      <section class="panel rounded-2xl p-5">
        <div class="hud mb-2">Actions</div>
        <div class="flex items-center justify-between gap-4 border-b border-line/70 py-3.5">
          <div><div class="text-[14px] font-semibold">TV mode</div><div class="mt-0.5 text-[12.5px] text-ink3">Ambient fleet display for a big screen — or open #tv directly</div></div>
          <button onclick={() => { location.hash = '#tv'; onclose(); }} class="min-h-[40px] rounded-xl border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink2 transition hover:border-line2 active:scale-95">Open</button>
        </div>
        <div class="flex items-center justify-between gap-4 border-b border-line/70 py-3.5">
          <div><div class="text-[14px] font-semibold">Car mode</div><div class="mt-0.5 text-[12.5px] text-ink3">Voice-first driving view: asks read aloud, giant buttons — or open #car</div></div>
          <button onclick={() => { location.hash = '#car'; onclose(); }} class="min-h-[40px] rounded-xl border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink2 transition hover:border-line2 active:scale-95">Open</button>
        </div>
        <div class="flex items-center justify-between gap-4 border-b border-line/70 py-3.5">
          <div><div class="text-[14px] font-semibold">Stop all agents</div><div class="mt-0.5 text-[12.5px] text-ink3">Send “Stop” to every agent still running</div></div>
          <button onclick={confirmStop} class="min-h-[40px] rounded-xl border border-crit/40 px-4 py-2 text-[13px] font-medium text-crit transition hover:border-crit active:scale-95">Stop all</button>
        </div>
        <div class="flex items-center justify-between gap-4 border-b border-line/70 py-3.5">
          <div><div class="text-[14px] font-semibold">Change token</div><div class="mt-0.5 text-[12.5px] text-ink3">Re-enter the access token</div></div>
          <button onclick={() => { changeToken(); onclose(); }} class="min-h-[40px] rounded-xl border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink2 transition hover:border-line2 active:scale-95">Change</button>
        </div>
        <div class="flex items-center justify-between gap-4 py-3.5">
          <div><div class="text-[14px] font-semibold">Disconnect</div><div class="mt-0.5 text-[12.5px] text-ink3">Forget the token on this device</div></div>
          <button onclick={() => confirm('Forget the access token on this device?') && forgetToken()} class="min-h-[40px] rounded-xl border border-crit/40 px-4 py-2 text-[13px] font-medium text-crit transition hover:border-crit active:scale-95">Forget</button>
        </div>
      </section>

      <section class="panel rounded-2xl p-5">
        <div class="hud mb-2">API access</div>
        <p class="py-2 text-[13px] leading-relaxed text-ink3">
          Bots and assistants (OpenClaw, scripts, cron) can drive this fleet over plain HTTPS — no inbound ports
          needed on their side. Auth is <span class="font-mono text-[12px] text-ink2">Authorization: Bearer &lt;token&gt;</span>,
          the same token this panel uses. <span class="font-mono text-[12px] text-ink2">GET /api/v1</span> lists every endpoint.
        </p>
        <div class="flex min-h-[44px] items-center justify-between gap-4 border-b border-line/70 py-2.5">
          <span class="text-[13px] text-ink3">Endpoint</span>
          <span class="max-w-[60%] truncate font-mono text-[13px] text-ink">{apiBase}</span>
        </div>
        <div class="flex items-center justify-between gap-4 py-3.5">
          <div><div class="text-[14px] font-semibold">Machine setup</div><div class="mt-0.5 text-[12.5px] text-ink3">Copy env vars + a test call, token included</div></div>
          <button onclick={copySetup} class="min-h-[40px] rounded-xl border border-line bg-surface px-4 py-2 text-[13px] font-medium text-ink2 transition hover:border-line2 active:scale-95">{copied ? 'Copied ✓' : 'Copy'}</button>
        </div>
      </section>

      <section class="panel rounded-2xl p-5">
        <div class="hud mb-3">About</div>
        <p class="text-[13.5px] leading-relaxed text-ink2">
          Mission Control is the command center for the AI agents running on your Mac. All computation happens on the
          workstation — this panel monitors, directs and launches agents from anywhere. Live data only: every number
          here comes straight from the fleet snapshot.
        </p>
      </section>
    </div>
  </main>
</div>
