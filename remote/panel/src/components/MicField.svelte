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
    class="max-h-32 min-h-[48px] flex-1 resize-none rounded-xl border bg-inset px-4 py-3 text-[16px] leading-snug text-ink outline-none transition placeholder:text-ink3 noscroll {recording ? 'border-crit/40' : 'border-line focus:border-line2'}"></textarea>

  {#if speechSupported}
    <button
      onclick={toggleMic}
      aria-label="Dictate"
      class="grid h-12 w-12 flex-none place-items-center rounded-xl border transition active:scale-95 {recording
        ? 'border-crit bg-crit/12 text-crit'
        : 'border-line bg-raised/70 text-ink2'}"
      style={recording ? 'animation: mc-ring 1.4s ease-out infinite' : ''}>
      <Icon name="mic" size={21} />
    </button>
  {/if}

  <button
    onclick={submit}
    disabled={!value.trim()}
    aria-label="Send"
    class="grid h-12 w-12 flex-none place-items-center rounded-xl bg-ink text-bg transition active:scale-95 disabled:opacity-40">
    <Icon name="send" size={19} />
  </button>
</div>
