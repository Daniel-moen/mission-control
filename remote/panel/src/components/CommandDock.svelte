<script>
  import Icon from './Icon.svelte';

  let { active = 'fleet', onFleet, onLibrary, onData, onLaunch, onSettings, onMic, onConsole } = $props();

  const navCls = (on) =>
    `relative flex flex-1 flex-col items-center gap-1 rounded-xl py-1.5 transition ${on ? 'text-ink' : 'text-ink3 hover:text-ink2'}`;
</script>

<nav class="fixed inset-x-0 bottom-0 z-50" style="padding-bottom:var(--sab)">
  <div
    class="mx-auto flex max-w-[520px] items-end gap-1 border-t border-line bg-surface/90 px-3 pb-2 pt-2 backdrop-blur-xl sm:mb-4 sm:rounded-2xl sm:border"
    style="box-shadow: 0 12px 40px -12px rgba(0,0,0,0.7)">
    <button onclick={onFleet} class={navCls(active === 'fleet')} aria-label="Fleet">
      <Icon name="fleet" size={22} />
      <span class="text-[10px] font-medium">Fleet</span>
    </button>
    <button onclick={onLibrary} class={navCls(active === 'library')} aria-label="Library">
      <Icon name="book" size={22} />
      <span class="text-[10px] font-medium">Library</span>
    </button>
    <button onclick={onData} class={navCls(active === 'data')} aria-label="Data">
      <Icon name="pulse" size={22} />
      <span class="text-[10px] font-medium">Data</span>
    </button>

    <!-- voice: the primary action, centered and unmissable but calm -->
    <div class="flex flex-1 justify-center">
      <button
        onclick={onMic}
        aria-label="Voice command"
        class="grid h-14 w-14 -translate-y-4 place-items-center rounded-full bg-ink text-bg shadow-[0_8px_24px_-6px_rgba(0,0,0,0.6)] ring-1 ring-white/10 transition active:scale-90">
        <Icon name="mic" size={26} stroke={2.2} />
      </button>
    </div>

    <!-- straight into a terminal: pick one, full screen, type into it -->
    <button onclick={onConsole} class={navCls(active === 'console')} aria-label="Terminal">
      <Icon name="terminal" size={22} />
      <span class="text-[10px] font-medium">Terminal</span>
    </button>
    <button onclick={onLaunch} class={navCls(active === 'launch')} aria-label="Launch">
      <Icon name="launch" size={22} />
      <span class="text-[10px] font-medium">Launch</span>
    </button>
    <button onclick={onSettings} class={navCls(active === 'settings')} aria-label="Settings">
      <Icon name="settings" size={22} />
      <span class="text-[10px] font-medium">Settings</span>
    </button>
  </div>
</nav>
