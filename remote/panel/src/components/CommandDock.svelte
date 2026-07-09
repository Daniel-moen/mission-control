<script>
  import { stopAll } from '../lib/store.svelte.js';
  import Icon from './Icon.svelte';

  let { active = 'fleet', onFleet, onPlans, onData, onLaunch, onSettings, onMic } = $props();

  function confirmStop() {
    if (confirm('Send “Stop” to every agent still running?')) stopAll();
  }

  const navCls = (on) =>
    `relative flex flex-1 flex-col items-center gap-1 rounded-2xl py-1.5 transition ${on ? 'text-accent bg-accent/10' : 'text-ink3'}`;
</script>

<nav class="fixed inset-x-0 bottom-0 z-50" style="padding-bottom:var(--sab)">
  <div
    class="mx-auto flex max-w-[560px] items-end gap-1 border-t border-line bg-surface/75 px-3 pb-2 pt-2 backdrop-blur-2xl sm:mb-4 sm:rounded-[26px] sm:border"
    style="box-shadow: inset 0 1px 0 rgba(147,200,255,0.08), 0 18px 50px -12px rgba(0,0,0,0.85)">
    <button onclick={onFleet} class={navCls(active === 'fleet')} aria-label="Fleet">
      <Icon name="fleet" size={23} />
      <span class="hud !text-inherit">Fleet</span>
    </button>
    <button onclick={onPlans} class={navCls(active === 'plans')} aria-label="Plans">
      <Icon name="plan" size={23} />
      <span class="hud !text-inherit">Plans</span>
    </button>
    <button onclick={onData} class={navCls(active === 'data')} aria-label="Data">
      <Icon name="pulse" size={23} />
      <span class="hud !text-inherit">Data</span>
    </button>
    <button onclick={onLaunch} class={navCls(active === 'launch')} aria-label="Launch">
      <Icon name="launch" size={23} />
      <span class="hud !text-inherit">Launch</span>
    </button>

    <!-- hero mic: ringed, glowing, unmistakably THE button -->
    <div class="flex flex-1 justify-center">
      <button
        onclick={onMic}
        aria-label="Voice command"
        class="relative grid h-16 w-16 -translate-y-5 place-items-center rounded-full bg-gradient-to-b from-accent-bright to-accent text-accent-ink shadow-[0_10px_34px_-6px_rgba(34,217,238,0.65)] transition active:scale-90"
        style="animation:mc-glow 3.4s ease-in-out infinite">
        <span class="absolute -inset-1.5 rounded-full border border-accent/35"></span>
        <span class="absolute -inset-3 rounded-full border border-accent/15"></span>
        <Icon name="mic" size={28} stroke={2.2} />
      </button>
    </div>

    <button onclick={confirmStop} class="{navCls(false)} !text-crit/80" aria-label="Stop all">
      <Icon name="stop" size={22} fill={true} />
      <span class="hud !text-inherit">Stop all</span>
    </button>
    <button onclick={onSettings} class={navCls(active === 'settings')} aria-label="Settings">
      <Icon name="settings" size={22} />
      <span class="hud !text-inherit">Settings</span>
    </button>
  </div>
</nav>
