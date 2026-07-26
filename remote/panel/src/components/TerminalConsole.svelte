<script>
  // Full-screen terminal console. Pick one of the fleet's terminals and drive it
  // as if you were sitting at the Mac: every character you type is forwarded to
  // that tty verbatim, and the mirror comes back at ~3 Hz (a "hot" watch lease,
  // vs the 1 Hz a passive workspace gets).
  //
  // Two input paths, because one isn't enough:
  //   • keydown  — desktop keyboards. Named keys (arrows, esc, tab, ⌃C …) are
  //     preventDefault'd and sent by NAME; printable characters are queued.
  //   • beforeinput — soft keyboards, which mostly report keydown as
  //     "Unidentified". insertText carries the characters, deleteContent* means
  //     backspace, insertLineBreak means return.
  // Printable characters are batched for a beat so fast typing costs one frame,
  // not one per letter. Named keys flush the queue first so order is preserved.
  //
  // The screen is shown RAW — no cleanScreen() — because in a console the TUI
  // chrome, the input box and the cursor line are exactly what you're steering.
  import { mc, rawScreenFor, watchAgent, sendKey, sendText, agentName, agentStatus, statusLabel } from '../lib/store.svelte.js';
  import { TONE } from '../lib/tone.js';
  import Icon from './Icon.svelte';

  let { agentId = null, onclose, onselect = null } = $props();

  let sel = $state(agentId);
  let picking = $state(!agentId);
  let ctrlArmed = $state(false);
  let sizeIdx = $state(1);
  const SIZES = [10.5, 12.5, 15];

  const terminals = $derived(mc.agents);
  const agent = $derived(mc.agents.find((a) => a.id === sel) || null);
  const cls = $derived(agent ? agentStatus(agent) : 'done');
  const t = $derived(TONE[cls]);
  const screen = $derived(agent ? rawScreenFor(agent) : '');
  const scr = $derived(sel ? mc.screens[sel] : null);
  const age = $derived(scr?.at ? Math.max(0, Math.round((mc.now - scr.at) / 1000)) : null);
  const live = $derived(age !== null && age <= 3);

  // Hot lease — held for as long as a terminal is open in here.
  $effect(() => {
    if (!sel) return;
    return watchAgent(sel, { hot: true });
  });

  // The chosen terminal left the fleet — fall back to the picker.
  $effect(() => {
    if (sel && !agent) {
      sel = null;
      picking = true;
    }
  });

  function choose(a) {
    if (!a.controllable) return;
    sel = a.id;
    picking = false;
    onselect?.(a.id);
    startTyping();
  }

  // ---- input ---------------------------------------------------------------
  // `typing` is the user's INTENT, not the focus state: tapping a key-bar button
  // blurs the hidden field (and would drop an iPad's soft keyboard), so a blur
  // while the intent stands simply takes focus back.
  let field = $state();
  let typing = $state(false);
  let pending = '';
  let flushTimer = null;

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    const text = pending;
    pending = '';
    if (text && sel) sendText(sel, text);
  }
  function queue(chars) {
    if (!chars) return;
    // An armed Ctrl turns the next letter into a control key instead.
    if (ctrlArmed) {
      ctrlArmed = false;
      const c = chars[0];
      if (/[a-zA-Z]/.test(c)) {
        key('c-' + c.toLowerCase());
        return queue(chars.slice(1));
      }
    }
    pending += chars;
    if (!flushTimer) flushTimer = setTimeout(flush, 45);
  }
  function key(k) {
    flush(); // keep ordering: queued characters land before the named key
    ctrlArmed = false;
    if (sel) sendKey(sel, k);
  }

  const NAMED = {
    Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'esc',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  };

  function onkeydown(e) {
    if (e.metaKey) return; // leave ⌘C/⌘V and browser shortcuts to the browser
    if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) {
      e.preventDefault();
      key('c-' + e.key.toLowerCase());
      return;
    }
    const named = NAMED[e.key];
    if (named) {
      e.preventDefault();
      key(named === 'tab' && e.shiftKey ? 'shift-tab' : named);
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      queue(e.key);
    }
  }

  // Soft keyboards: the characters arrive here, not on keydown.
  function onbeforeinput(e) {
    e.preventDefault();
    const type = e.inputType || '';
    if (type === 'insertLineBreak' || type === 'insertParagraph') return key('enter');
    if (type.startsWith('delete')) return key('backspace');
    if (e.data) queue(e.data);
  }

  function onpaste(e) {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    flush();
    if (sel) sendText(sel, text);
  }

  function startTyping() {
    if (!sel) return;
    typing = true;
    queueMicrotask(() => field?.focus());
  }
  function stopTyping() {
    typing = false;
    field?.blur();
  }
  // A blur with the intent still set means focus was stolen by a key-bar tap —
  // take it straight back so the keyboard never drops mid-session.
  function onblur() {
    if (typing) setTimeout(() => typing && field?.focus(), 0);
  }
  // Every key-bar press routes through here so the field keeps focus.
  function tap(k) {
    key(k);
    if (typing) field?.focus();
  }

  // ---- follow-the-tail scrolling -------------------------------------------
  let pre = $state();
  let follow = $state(true);
  function onScroll() {
    if (!pre) return;
    follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
  }
  $effect(() => {
    screen; // track
    if (!pre || !follow) return;
    requestAnimationFrame(() => pre && follow && (pre.scrollTop = pre.scrollHeight));
  });

  const KEYS = [
    ['esc', 'esc'], ['tab', 'tab'], ['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'], ['enter', '⏎'],
  ];
</script>

<div class="anim-slide fixed inset-0 z-[80] flex flex-col bg-bg">
  <!-- header: which terminal, and how fresh the mirror is -->
  <header
    class="relative flex flex-none items-center gap-2 border-b border-line bg-surface/70 px-3 backdrop-blur-2xl sm:px-5"
    style="padding-top:calc(8px + var(--sat));padding-bottom:8px">
    <span class="absolute inset-x-0 top-0 h-[2px] {agent ? t.edge : 'bg-line2'}"></span>
    <button onclick={onclose} aria-label="Close console" class="grid h-10 w-10 flex-none place-items-center rounded-xl text-ink2 transition hover:bg-raised">
      <Icon name="back" size={22} />
    </button>

    <button
      onclick={() => (picking = !picking)}
      class="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left transition hover:bg-raised">
      <Icon name="terminal" size={17} class="flex-none text-ink3" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[16px] font-semibold leading-tight">{agent ? agentName(agent) : 'Choose a terminal'}</span>
        {#if agent}
          <span class="block truncate font-mono text-[11px] text-ink3">{agent.dir || agent.folder || ''}</span>
        {/if}
      </span>
      <Icon name="chevron" size={16} class="flex-none rotate-90 text-ink3" />
    </button>

    {#if agent}
      <span class="hidden flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold sm:flex {t.chip}">{statusLabel(cls)}</span>
      {#if live}
        <span class="flex flex-none items-center gap-1.5 text-[11px] font-semibold text-accent">
          <span class="h-1.5 w-1.5 rounded-full bg-accent" style="animation:mc-pulse 1.4s steps(2) infinite"></span>Live
        </span>
      {:else if age !== null}
        <span class="flex-none font-mono text-[11px] tabular-nums text-ink3">{age < 120 ? `${age}s ago` : `${Math.round(age / 60)}m ago`}</span>
      {/if}
    {/if}

    <button
      onclick={() => (sizeIdx = (sizeIdx + 1) % SIZES.length)}
      aria-label="Text size"
      class="grid h-10 w-10 flex-none place-items-center rounded-xl font-mono text-[13px] font-bold text-ink3 transition hover:bg-raised">
      A{sizeIdx === 0 ? '⁻' : sizeIdx === 2 ? '⁺' : ''}
    </button>
  </header>

  <!-- terminal picker -->
  {#if picking}
    <div class="flex-none border-b border-line bg-inset/60 px-3 py-3 sm:px-5">
      <div class="hud mb-2">Terminals · {terminals.length}</div>
      <div class="flex max-h-[46vh] flex-col gap-1.5 overflow-y-auto noscroll">
        {#each terminals as a (a.id)}
          {@const st = agentStatus(a)}
          <button
            onclick={() => choose(a)}
            disabled={!a.controllable}
            class="flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition {a.id === sel
              ? 'border-line2 bg-raised'
              : 'border-line bg-raised/60'} {a.controllable ? 'active:scale-[0.99]' : 'opacity-45'}">
            <span class="h-2 w-2 flex-none rounded-full {TONE[st].dot}"></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[14px] font-semibold">{agentName(a)}</span>
              <span class="block truncate font-mono text-[11px] text-ink3">{a.dir || a.folder || ''}</span>
            </span>
            {#if !a.controllable}
              <span class="flex-none text-[11px] text-ink3">no mirror</span>
            {:else}
              <span class="flex-none text-[11px] text-ink3">{statusLabel(st)}</span>
            {/if}
          </button>
        {:else}
          <p class="py-3 text-[14px] italic text-ink3">No agents are running, so there are no terminals to drive.</p>
        {/each}
      </div>
    </div>
  {/if}

  <!-- the screen, raw -->
  <main class="relative min-h-0 flex-1 bg-inset">
    {#if agent}
      <pre
        bind:this={pre}
        onscroll={onScroll}
        onclick={startTyping}
        class="noscroll m-0 h-full overflow-auto whitespace-pre p-3 font-mono leading-[1.35] text-ink2"
        style="font-size:{SIZES[sizeIdx]}px">{screen || 'Mirror warming up…'}</pre>

      {#if !follow}
        <button
          onclick={() => { follow = true; if (pre) pre.scrollTop = pre.scrollHeight; }}
          class="absolute bottom-3 left-1/2 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-bg shadow-[0_6px_20px_-6px_rgba(0,0,0,0.6)]">
          <Icon name="down" size={14} stroke={2.4} /> Live
        </button>
      {/if}
    {:else}
      <div class="grid h-full place-items-center p-6 text-center">
        <div>
          <Icon name="terminal" size={34} class="mx-auto text-ink3" />
          <p class="mt-3 text-[15px] text-ink2">Pick a terminal above to take it over.</p>
          <p class="mt-1 text-[13px] text-ink3">Everything you type goes straight to that tty.</p>
        </div>
      </div>
    {/if}
  </main>

  <!-- key bar: the keys a browser keyboard can't send, plus the typing toggle -->
  <footer
    class="relative flex-none border-t border-line bg-surface/80 px-2 backdrop-blur-2xl sm:px-4"
    style="padding-top:8px;padding-bottom:calc(8px + var(--sab))">
    <div class="mx-auto flex max-w-[1100px] items-center gap-1.5 overflow-x-auto noscroll">
      <button
        onclick={() => (typing ? stopTyping() : startTyping())}
        disabled={!agent}
        aria-pressed={typing}
        class="flex h-11 flex-none items-center gap-1.5 rounded-xl border px-3 text-[13px] font-bold transition active:scale-95 {typing
          ? 'border-line2 bg-raised text-ink'
          : 'border-line bg-raised text-ink2'} {agent ? '' : 'opacity-40'}">
        <Icon name="keyboard" size={17} />{typing ? 'Typing' : 'Type'}
      </button>
      <span class="h-6 w-px flex-none bg-line2"></span>
      <button
        onclick={() => { ctrlArmed = !ctrlArmed; if (typing) field?.focus(); }}
        disabled={!agent}
        aria-pressed={ctrlArmed}
        class="h-11 flex-none rounded-xl border px-3 text-[13px] font-bold transition active:scale-90 {ctrlArmed
          ? 'border-line2 bg-raised text-ink'
          : 'border-line bg-raised text-ink2'}">ctrl</button>
      <button
        onclick={() => tap('c-c')}
        disabled={!agent}
        class="h-11 flex-none rounded-xl border border-crit/45 bg-crit/8 px-3 text-[13px] font-bold text-crit transition active:scale-90">^C</button>
      <!-- shift+tab — what Claude Code cycles its permission mode with -->
      <button
        onclick={() => tap('shift-tab')}
        disabled={!agent}
        title="Cycle permission mode (shift+tab)"
        class="flex h-11 flex-none items-center gap-1 rounded-xl border border-line bg-raised px-3 text-[13px] font-bold text-ink2 transition active:scale-90">
        mode <span class="text-[11px] text-ink3">⇧⇥</span>
      </button>
      {#each KEYS as [k, lbl] (k)}
        <button
          onclick={() => tap(k)}
          disabled={!agent}
          aria-label={k}
          class="grid h-11 w-11 flex-none place-items-center rounded-xl border border-line bg-raised text-[15px] font-semibold text-ink2 transition active:scale-90">{lbl}</button>
      {/each}
      <span class="min-w-1 flex-1"></span>
      {#if agent && !agent.controllable}
        <span class="flex-none whitespace-nowrap text-[12px] italic text-ink3">Read-only — this terminal can’t be driven.</span>
      {/if}
    </div>

    <!-- the real input target: invisible, but focused whenever typing is on -->
    <textarea
      bind:this={field}
      onkeydown={onkeydown}
      onbeforeinput={onbeforeinput}
      onpaste={onpaste}
      onblur={onblur}
      rows="1"
      autocapitalize="off"
      autocorrect="off"
      autocomplete="off"
      spellcheck="false"
      aria-label="Terminal input"
      class="pointer-events-none absolute bottom-2 left-2 h-px w-px resize-none border-0 bg-transparent p-0 text-transparent opacity-0"
    ></textarea>
  </footer>
</div>
