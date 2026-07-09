<script>
  import { dictate, speechSupported } from '../lib/speech.js';
  import Icon from './Icon.svelte';

  let { value = $bindable(''), placeholder = 'Message…', onsubmit } = $props();

  let session = $state(null);
  const recording = $derived(!!session);

  function toggleMic() {
    if (session) {
      session.stop();
      return;
    }
    session = dictate({
      base: value,
      onText: (t) => (value = t),
      onEnd: () => (session = null),
      onError: () => (session = null),
    });
  }

  function submit() {
    if (session) session.stop();
    onsubmit && onsubmit();
  }
</script>

<div class="flex items-end gap-2">
  <textarea
    bind:value
    rows="1"
    {placeholder}
    onkeydown={(e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    }}
    class="max-h-32 min-h-[52px] flex-1 resize-none rounded-2xl border bg-inset px-4 py-3.5 text-[16px] leading-snug text-ink outline-none transition placeholder:text-ink3 noscroll {recording ? 'border-accent/50 shadow-[0_0_0_1px_rgba(34,217,238,0.2),inset_0_0_28px_-14px_rgba(34,217,238,0.35)]' : 'border-line focus:border-accent/70 focus:shadow-[0_0_0_1px_rgba(34,217,238,0.25)]'}"></textarea>

  {#if speechSupported}
    <!-- glassy mic tile — glows + pulses while listening -->
    <button
      onclick={toggleMic}
      aria-label="Dictate"
      class="relative grid h-[52px] w-[52px] flex-none place-items-center rounded-2xl border backdrop-blur transition active:scale-95 {recording
        ? 'border-crit bg-crit/15 text-crit glow-crit'
        : 'border-line bg-raised/70 text-ink2'}"
      style={recording ? 'animation: mc-ring 1.4s ease-out infinite' : ''}>
      {#if recording}
        <span class="absolute inset-0 rounded-2xl border border-crit/50" style="animation:mc-pulse 1.4s ease-in-out infinite"></span>
      {/if}
      <Icon name="mic" size={22} />
    </button>
  {/if}

  <button
    onclick={submit}
    disabled={!value.trim()}
    aria-label="Send"
    class="grid h-[52px] w-[52px] flex-none place-items-center rounded-2xl bg-accent text-accent-ink shadow-[0_0_24px_-6px_rgba(34,217,238,0.55)] transition active:scale-95 disabled:opacity-40 disabled:shadow-none">
    <Icon name="send" size={20} />
  </button>
</div>
